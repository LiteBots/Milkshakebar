'use strict';
// Reguła śniadań (do 13:00) i czas polski.
const test = require('node:test');
const assert = require('node:assert/strict');
const { breakfastProblem, isBreakfastCategory, breakfastUntil } = require('../lib/breakfast');
const { warsawParts, scheduledDate, hmToMin } = require('../lib/time');
const { sniffImage } = require('../lib/storage');

test('śniadanie o 9:00 z odbiorem o 12:45 jest w porządku', () => {
  assert.equal(breakfastProblem({ until: '13:00', nowMin: hmToMin('09:00'), readyMin: hmToMin('12:45') }), null);
  assert.equal(breakfastProblem({ until: '13:00', nowMin: hmToMin('12:30'), readyMin: hmToMin('13:00') }), null);
});

test('śniadanie o 9:00 z odbiorem o 14:00 jest odrzucane', () => {
  assert.match(breakfastProblem({ until: '13:00', nowMin: hmToMin('09:00'), readyMin: hmToMin('14:00') }), /wydajemy do 13:00/);
});

test('po 13:00 śniadania nie da się zamówić', () => {
  assert.match(breakfastProblem({ until: '13:00', nowMin: hmToMin('13:00'), readyMin: hmToMin('13:20') }), /zamawiamy do 13:00/);
  assert.match(breakfastProblem({ until: '13:00', nowMin: hmToMin('15:10'), readyMin: hmToMin('15:30') }), /zamawiamy do 13:00/);
});

test('kategorie śniadań i godzina z ustawień', () => {
  assert.ok(isBreakfastCategory('sniadania'));
  assert.ok(isBreakfastCategory('sniadania_keto'));
  assert.ok(!isBreakfastCategory('burgery'));
  assert.equal(breakfastUntil({ breakfastUntil: '12:30' }), '12:30');
  assert.equal(breakfastUntil({ breakfastUntil: 'zła' }), '13:00');
  assert.equal(breakfastUntil(null), '13:00');
});

test('czas polski: zima +1 h, lato +2 h', () => {
  assert.equal(warsawParts(new Date('2026-01-15T11:30:00Z')).hm, '12:30');
  assert.equal(warsawParts(new Date('2026-07-15T11:30:00Z')).hm, '13:30');
  const winter = scheduledDate('today', '13:00', new Date('2026-01-15T08:00:00Z'));
  assert.equal(winter.toISOString(), '2026-01-15T12:00:00.000Z');
  const summer = scheduledDate('today', '13:00', new Date('2026-07-15T08:00:00Z'));
  assert.equal(summer.toISOString(), '2026-07-15T11:00:00.000Z');
  assert.equal(scheduledDate('today', '25:00'), null);
});

test('rozpoznawanie zdjęć po zawartości pliku', () => {
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');
  assert.equal(sniffImage(png).ext, '.png');
  assert.equal(sniffImage(Buffer.from('FFD8FFE000104A4649460001', 'hex')).ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('<script>alert(1)</script>')), null);
});
