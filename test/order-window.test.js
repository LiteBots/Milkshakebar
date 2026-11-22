'use strict';
// Godziny zamówień online: do której zamawiać, na którą najpóźniej, na ile do przodu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderWindow, timeProblem } = require('../lib/orderWindow');

// 19.11.2026 to czwartek; w listopadzie Polska = UTC+1
const at = (hm) => new Date(`2026-11-19T${String(Number(hm.slice(0, 2)) - 1).padStart(2, '0')}:${hm.slice(3)}:00Z`);
const day = { isOpen: true, from: '10:00', to: '21:00' };
const hours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
const base = { ordersEnabled: true, pickupEnabled: true, deliveryEnabled: true, pickupPrepMinutes: 20, deliveryPrepMinutes: 45, lastOrderBeforeClose: 30, lastReadyBeforeClose: 0, maxAheadMinutes: 0, ordersBeforeOpen: true };

test('zamykamy o 21:00: zamówienia do 20:30, odbiór najpóźniej 21:00', () => {
  const w = orderWindow({ settings: base, hours, now: at('20:10') });
  assert.equal(w.accepting, true);
  assert.equal(w.lastOrder, '20:30');
  assert.equal(w.latestReady, '21:00');
  assert.deepEqual(w.modes.pickup.slots, ['20:30', '20:45', '21:00']);
  assert.equal(w.modes.pickup.asap, true);
  const late = orderWindow({ settings: base, hours, now: at('20:31') });
  assert.equal(late.accepting, false);
  assert.match(late.reason, /do 20:30/);
  assert.match(timeProblem(late, { mode: 'pickup', asap: true, readyMin: 0 }), /do 20:30/);
});

test('najpóźniejszy odbiór 15 min przed końcem i limit do przodu', () => {
  const w = orderWindow({ settings: { ...base, lastReadyBeforeClose: 15, maxAheadMinutes: 120 }, hours, now: at('12:00') });
  assert.equal(w.latestReady, '20:45');
  assert.equal(w.modes.pickup.slots.at(-1), '14:00'); // 12:00 + 2 h
  assert.equal(timeProblem(w, { mode: 'pickup', asap: false, readyMin: 16 * 60 }) !== null, true);
  assert.equal(timeProblem(w, { mode: 'pickup', asap: false, readyMin: 13 * 60 }), null);
  assert.match(timeProblem(w, { mode: 'pickup', asap: false, readyMin: 12 * 60 }), /za wcześnie/);
});

test('przed otwarciem: zamówienie na później albo blokada', () => {
  const w = orderWindow({ settings: base, hours, now: at('08:00') });
  assert.equal(w.accepting, true);
  assert.equal(w.modes.pickup.asap, false);
  assert.equal(w.modes.pickup.slots[0], '10:30'); // 10:00 + 20 min, zaokrąglone do 15 min
  const no = orderWindow({ settings: { ...base, ordersBeforeOpen: false }, hours, now: at('08:00') });
  assert.equal(no.accepting, false);
  assert.match(no.reason, /od 10:00/);
});

test('własne godziny zamówień i tryb całą dobę', () => {
  const custom = { ...base, orderHoursMode: 'custom', lastOrderBeforeClose: 0, orderSchedule: { thu: { isOpen: true, from: '12:00', to: '20:00' } } };
  const w = orderWindow({ settings: custom, hours, now: at('19:50') });
  assert.equal(w.today[1], '20:00');
  assert.equal(w.accepting, true);
  const closed = orderWindow({ settings: { ...custom, orderSchedule: { thu: { isOpen: false } } }, hours, now: at('15:00') });
  assert.equal(closed.accepting, false);
  const always = orderWindow({ settings: { ...base, orderHoursMode: 'always' }, hours, now: at('23:10') });
  assert.equal(always.accepting, true);
  assert.equal(always.modes.pickup.asap, true);
});
