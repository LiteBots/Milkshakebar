const test = require('node:test');
const assert = require('node:assert/strict');
const { fullItemName } = require('../lib/itemNames');

test('pełna nazwa pozycji mówi obsłudze, co to za produkt', () => {
  assert.equal(fullItemName('burgery', 'Prostak'), 'Burger Prostak');
  assert.equal(fullItemName('shakes_best', 'Kinder Bueno + malina'), 'Shake Kinder Bueno + malina');
  assert.equal(fullItemName('desery_pancakes', 'Z Kinder Bueno i malinami'), 'Pancake z Kinder Bueno i malinami');
  assert.equal(fullItemName('hotdogi', 'Classic'), 'Hot-dog Classic');
});

test('nazwa, która już mówi, co to jest, zostaje bez zmian', () => {
  assert.equal(fullItemName('lemoniady', 'Lemoniada malinowa'), 'Lemoniada malinowa');
  assert.equal(fullItemName('kanapki', 'Club sandwich'), 'Club sandwich');
  assert.equal(fullItemName('mexico_fajita', 'Fajita z kurczakiem'), 'Fajita z kurczakiem');
  assert.equal(fullItemName('startery', 'Frytki 150 g'), 'Frytki 150 g');
  assert.equal(fullItemName(undefined, 'Coca-Cola'), 'Coca-Cola');
});
