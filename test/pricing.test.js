'use strict';
// Wycena koszyka bez bazy danych: zestawy, dodatki, opakowania, dostawa, grosze.
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceCart } = require('../lib/pricing');
const { toGr, fromGr, round2 } = require('../lib/money');

const setConfig = {
  categories: ['burgery', 'kanapki', 'sniadania_kanapki'],
  sides: [{ name: 'Frytki', extra: 0 }, { name: 'Krążki cebulowe', extra: 4 }],
  drinks: [{ name: 'Lemoniada cytrusowa', price: 10 }]
};
const burger = {
  _id: 'b1', name: 'Prostak', categoryId: 'burgery', isAvailable: true,
  variants: [{ name: 'Mały 85 g', price: 33 }, { name: 'Duży 160 g', price: 39 }],
  addons: [{ id: 'bacon', name: '2 sztuki bekonu', price: 5 }, { id: 'egg', name: 'Jajko sadzone', price: 2 }]
};
const shake = { _id: 's1', name: 'Shake waniliowy', categoryId: 'shakes_klasyczne', price: 21.9, pickupOnly: true, isAvailable: true };
const toast = { _id: 't1', name: 'Tost francuski', categoryId: 'sniadania', price: 41, isAvailable: true };
const products = new Map([burger, shake, toast].map((p) => [p._id, p]));
const settings = { mealSetPrice: 12, packagingFee: 0, deliveryFee: 8, freeDeliveryThreshold: 80, minOrderDelivery: 0 };

test('kwoty w groszach nie gubią groszy', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(toGr(21.9) * 3, 6570);
  assert.equal(fromGr(6570), 65.7);
});

test('burger w zestawie z napojem i dodatkami: każda dopłata osobno', () => {
  const r = priceCart({
    rawItems: [{ productId: 'b1', quantity: 2, variant: 'Duży 160 g', set: { side: 'Krążki cebulowe', drink: 'Lemoniada cytrusowa' }, addonIds: ['bacon'] }],
    deliveryMethod: 'pickup', products, settings, setConfig
  });
  const [item] = r.items;
  assert.equal(item.basePrice, 39);
  assert.deepEqual(item.set, { side: 'Krążki cebulowe', drink: 'Lemoniada cytrusowa', setPrice: 12, sideExtra: 4, drinkPrice: 10, price: 26 });
  assert.deepEqual(item.addons, [{ id: 'bacon', name: '2 sztuki bekonu', price: 5 }]);
  assert.equal(item.price, 70); // 39 + 12 + 4 + 10 + 5
  assert.equal(item.lineTotal, 140);
  assert.equal(r.subtotal, 140);
  assert.deepEqual(r.breakdown, { products: 78, sets: 52, addons: 10 });
  assert.equal(r.deliveryFee, 0);
  assert.equal(r.totalAmount, 140);
  assert.match(item.desc, /Zestaw: krążki cebulowe, lemoniada cytrusowa/);
});

test('dostawa: opłata poniżej progu, gratis od progu, opakowania zawsze widoczne', () => {
  const small = priceCart({ rawItems: [{ productId: 'b1', quantity: 1, variant: 'Mały 85 g' }], deliveryMethod: 'delivery', products, settings: { ...settings, packagingFee: 2 }, setConfig });
  assert.equal(small.subtotal, 33);
  assert.equal(small.packagingFee, 2);
  assert.equal(small.deliveryFee, 8);
  assert.equal(small.totalAmount, 43);
  const big = priceCart({ rawItems: [{ productId: 'b1', quantity: 3, variant: 'Duży 160 g' }], deliveryMethod: 'delivery', products, settings, setConfig });
  assert.equal(big.subtotal, 117);
  assert.equal(big.deliveryFee, 0);
});

test('shake tylko z odbiorem nie przejdzie w dostawie', () => {
  assert.throws(
    () => priceCart({ rawItems: [{ productId: 's1', quantity: 1 }], deliveryMethod: 'delivery', products, settings, setConfig }),
    (e) => e.code === 'pickup_only' && e.status === 409
  );
});

test('minimum na dostawę', () => {
  assert.throws(
    () => priceCart({ rawItems: [{ productId: 'b1', quantity: 1 }], deliveryMethod: 'delivery', products, settings: { ...settings, minOrderDelivery: 50 }, setConfig }),
    (e) => e.code === 'min_order'
  );
});

test('zestaw do produktu, który go nie ma, i nieznany dodatek są odrzucane', () => {
  assert.throws(() => priceCart({ rawItems: [{ productId: 't1', quantity: 1, set: { side: 'Frytki' } }], deliveryMethod: 'pickup', products, settings, setConfig }), /nie można dobrać zestawu/);
  assert.throws(() => priceCart({ rawItems: [{ productId: 'b1', quantity: 1, addonIds: ['xxx'] }], deliveryMethod: 'pickup', products, settings, setConfig }), /niedostępny/);
});

test('śniadania są oznaczone w koszyku', () => {
  const r = priceCart({ rawItems: [{ productId: 't1', quantity: 1 }, { productId: 'b1', quantity: 1 }], deliveryMethod: 'pickup', products, settings, setConfig });
  assert.equal(r.hasBreakfast, true);
  assert.deepEqual(r.items.map((i) => i.breakfast), [true, false]);
  assert.equal(r.items[0].category, 'sniadania');
});

test('pusty koszyk i zła ilość', () => {
  assert.throws(() => priceCart({ rawItems: [], products, settings, setConfig }), /pusty/);
  assert.throws(() => priceCart({ rawItems: [{ productId: 'b1', quantity: 0 }], products, settings, setConfig }), /ilość/);
});
