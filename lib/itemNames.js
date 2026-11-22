'use strict';
// Pełna nazwa pozycji dla obsługi i klienta: „Burger Prostak”, „Shake Kinder Bueno + malina”,
// „Pancake z Kinder Bueno i malinami”. Sama nazwa z karty („Prostak”, „Z Kinder Bueno i malinami”)
// nie mówi kuchni, co to za produkt.
//
// Reguła: przedrostek kategorii + nazwa produktu. Gdy nazwa już mówi, co to jest
// (np. „Lemoniada malinowa”, „Croissant z…”, „Fajita z kurczakiem”), zostaje bez zmian.

const PREFIX = {
  burgery: 'Burger',
  hotdogi: 'Hot-dog',
  kanapki: 'Kanapka',
  lunch_kanapki: 'Kanapka',
  sniadania_kanapki: 'Kanapka',
  sniadania_usa: 'Śniadanie',
  sniadania_keto: 'Śniadanie keto:',
  salaty: 'Sałatka',
  pasta: 'Makaron',
  mexico_quesadillas: 'Quesadilla',
  mexico_burrito: 'Burrito',
  mexico_fajita: 'Fajita',
  shakes_klasyczne: 'Shake',
  shakes_best: 'Shake',
  shakes_owocowe: 'Shake',
  shakes_vip: 'Shake',
  desery_wloskie: 'Lody włoskie',
  desery_lodowe: 'Deser lodowy',
  desery_gofry: 'Gofr',
  desery_pancakes: 'Pancake',
  smoothie: 'Smoothie',
  proteiny: 'Shake proteinowy',
  soki: 'Sok',
  herbata: 'Herbata'
};

// Słowa, po których widać, co to za produkt: wtedy bez przedrostka
const SELF_DESCRIBING = /\b(burger|hot-?dog|kanapk|sandwich|bagietk|croissant|tost|sałat|makaron|pasta|tagliatelle|quesadill|burrit|buritto|fajit|shake|lody|lód|deser|gofr|pancake|naleśnik|smoothie|sok|herbat|lemoniad|kawa|churros|śniadani)/i;

function fullItemName(categoryId, name) {
  const base = String(name || '').trim();
  const prefix = PREFIX[String(categoryId || '')];
  if (!base || !prefix) return base;
  if (SELF_DESCRIBING.test(base)) return base;
  // „Z Kinder Bueno i malinami” → „Pancake z Kinder Bueno i malinami”
  const rest = /^(z|ze|na|w|bez)\s/i.test(base) ? base.charAt(0).toLowerCase() + base.slice(1) : base;
  return `${prefix} ${rest}`;
}

module.exports = { fullItemName, PREFIX };
