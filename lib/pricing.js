'use strict';
// Wycena koszyka po stronie serwera. Bez bazy danych: produkty i ustawienia przychodzą jako argumenty,
// więc logikę cen da się przetestować bez serwera. Wszystkie sumy w groszach.
const { toGr, fromGr } = require('./money');
const { isBreakfastCategory } = require('./breakfast');

const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

/**
 * @param {object} p
 * @param {Array}  p.rawItems   pozycje koszyka z zamawiarki
 * @param {string} p.deliveryMethod 'delivery' albo 'pickup'
 * @param {Map}    p.products   productId -> produkt z bazy
 * @param {Array}  p.upsell     szybkie dodatki z panelu
 * @param {object} p.settings   ustawienia lokalu (mealSetPrice, packagingFee, deliveryFee, ...)
 * @param {object} p.setConfig  { categories, sides: [{name, extra}], drinks: [{name, price}] }
 */
function priceCart({ rawItems, deliveryMethod, products, upsell = [], settings = {}, setConfig }) {
  const raw = Array.isArray(rawItems) ? rawItems : [];
  if (!raw.length || raw.length > 100) throw fail('Koszyk jest pusty.');
  const isDelivery = deliveryMethod === 'delivery';
  const setPriceGr = toGr(settings.mealSetPrice);

  const items = [];
  const pickupOnly = [];
  let setsGr = 0;
  let addonsGr = 0;
  for (const item of raw) {
    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw fail('Nieprawidłowa ilość w koszyku.');

    if (item.type === 'upsell') {
      const u = upsell.find((x) => String(x.id) === String(item.productId));
      if (!u) throw fail('Jeden z dodatków nie jest już dostępny. Odśwież koszyk.', 409);
      const unit = toGr(u.price);
      items.push({
        id: item.id, productId: item.productId, type: 'upsell', name: u.name, productName: u.name, variant: null, category: 'upsell',
        breakfast: false, basePrice: fromGr(unit), set: null, addons: [], addonIds: [],
        price: fromGr(unit), quantity, lineTotal: fromGr(unit * quantity), desc: ''
      });
      continue;
    }

    const p = products.get(String(item.productId));
    if (!p || p.isAvailable === false || p.archived) throw fail(`Produkt „${item.name || ''}” jest niedostępny. Odśwież menu.`, 409);
    if (isDelivery && p.pickupOnly) pickupOnly.push(p.name);

    let baseGr;
    let variantName = null;
    if (p.variants && p.variants.length) {
      const variant = item.variant ? p.variants.find((v) => v.name === item.variant) : p.variants[0];
      if (!variant) throw fail(`Wariant produktu „${p.name}” się zmienił. Odśwież menu.`, 409);
      baseGr = toGr(variant.price);
      variantName = variant.name || null;
    } else {
      baseGr = toGr(p.price);
    }
    let unitGr = baseGr;

    // Zestaw: gdy w panelu zaznaczono „zestaw”, albo domyślnie dla burgerów, kanapek, hot-dogów i burrito
    let set = null;
    const setAllowed = p.allowSet === true || (setConfig.categories.includes(p.categoryId) && p.allowSet !== false);
    if (item.set) {
      if (!setAllowed) throw fail(`Do „${p.name}” nie można dobrać zestawu.`, 409);
      const side = setConfig.sides.find((s) => s.name === String(item.set.side || ''));
      const noDrink = !item.set.drink || item.set.drink === 'Bez napoju';
      const drink = noDrink ? null : setConfig.drinks.find((d) => d.name === String(item.set.drink));
      if (!side || (!noDrink && !drink)) throw fail(`Zestaw do „${p.name}” się zmienił. Odśwież menu.`, 409);
      const sideExtraGr = toGr(side.extra);
      const drinkGr = drink ? toGr(drink.price) : 0;
      const setTotalGr = setPriceGr + sideExtraGr + drinkGr;
      unitGr += setTotalGr;
      setsGr += setTotalGr * quantity;
      set = {
        side: side.name, drink: drink ? drink.name : '',
        setPrice: fromGr(setPriceGr), sideExtra: fromGr(sideExtraGr), drinkPrice: fromGr(drinkGr), price: fromGr(setTotalGr)
      };
    }

    const productAddons = (p.addons || []).map((a, i) => ({ id: String(a.id || a._id || `a${i}`), name: a.name, price: a.price }));
    const addons = [];
    for (const id of (Array.isArray(item.addonIds) ? item.addonIds : [])) {
      const addon = productAddons.find((a) => a.id === String(id));
      if (!addon) throw fail(`Dodatek do „${p.name}” jest niedostępny. Odśwież menu.`, 409);
      const g = toGr(addon.price);
      unitGr += g;
      addonsGr += g * quantity;
      addons.push({ id: addon.id, name: addon.name, price: fromGr(g) });
    }

    // Opis dla kuchni i paragonu: zestaw i dodatki słowami
    const desc = [
      set ? `Zestaw: ${set.side.toLowerCase()}${set.drink ? `, ${set.drink.toLowerCase()}` : ''}` : '',
      ...addons.map((a) => `+ ${a.name}`)
    ].filter(Boolean).join(', ');

    items.push({
      id: item.id, productId: String(p._id || item.productId), type: 'product',
      name: variantName ? `${p.name} (${variantName})` : p.name, productName: p.name, variant: variantName,
      category: p.categoryId, breakfast: isBreakfastCategory(p.categoryId),
      basePrice: fromGr(baseGr), set, addons, addonIds: addons.map((a) => a.id),
      price: fromGr(unitGr), quantity, lineTotal: fromGr(unitGr * quantity), desc
    });
  }
  if (pickupOnly.length) {
    throw fail(`Tylko z odbiorem osobistym: ${[...new Set(pickupOnly)].join(', ')}.`, 409, 'pickup_only');
  }

  const subtotalGr = items.reduce((s, i) => s + toGr(i.price) * i.quantity, 0);
  const minGr = toGr(settings.minOrderDelivery);
  if (isDelivery && minGr > 0 && subtotalGr < minGr) {
    throw fail(`Minimalne zamówienie z dostawą to ${fromGr(minGr).toFixed(2).replace('.', ',')} zł.`, 400, 'min_order');
  }
  const packagingGr = toGr(settings.packagingFee);
  const thresholdGr = toGr(settings.freeDeliveryThreshold);
  const deliveryGr = isDelivery && !(thresholdGr > 0 && subtotalGr >= thresholdGr) ? toGr(settings.deliveryFee) : 0;
  return {
    items,
    subtotal: fromGr(subtotalGr),
    packagingFee: fromGr(packagingGr),
    deliveryFee: fromGr(deliveryGr),
    totalAmount: fromGr(subtotalGr + packagingGr + deliveryGr),
    hasBreakfast: items.some((i) => i.breakfast),
    // Ile z kwoty produktów to dopłaty do zestawów i dodatki (do podsumowania i statystyk)
    breakdown: { products: fromGr(subtotalGr - setsGr - addonsGr), sets: fromGr(setsGr), addons: fromGr(addonsGr) },
    freeDeliveryFrom: fromGr(thresholdGr)
  };
}

module.exports = { priceCart, fail };
