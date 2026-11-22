'use strict';
// Doładowanie salda online: bonus, promocje w godzinach, blokada i sprawdzanie ustawień z panelu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_TOPUP, mergeTopup, cleanTopupConfig, activeTopupPromo, topupBonus, topupAmountProblem } = require('../lib/topup');

// Piątek 20.11.2026, 12:00 i 18:00 w Polsce (UTC+1)
const FRI_NOON = new Date('2026-11-20T11:00:00Z');
const FRI_EVENING = new Date('2026-11-20T17:00:00Z');

test('domyślnie +10% do każdego doładowania', () => {
  const c = mergeTopup();
  assert.equal(DEFAULT_TOPUP.bonusPercent, 10);
  assert.deepEqual(topupBonus(c, 100, FRI_NOON), { bonus: 10, percent: 10, promo: null });
  assert.equal(topupBonus(c, 55, FRI_NOON).bonus, 5.5);
  assert.equal(topupBonus(c, 33, FRI_NOON).bonus, 3.3);
});

test('bonus od kwoty i limit bonusu', () => {
  const c = mergeTopup({ minForBonus: 50, maxBonus: 15 });
  assert.equal(topupBonus(c, 40, FRI_NOON).bonus, 0);
  assert.equal(topupBonus(c, 50, FRI_NOON).bonus, 5);
  assert.equal(topupBonus(c, 500, FRI_NOON).bonus, 15);
});

test('promocja w godzinach daje wyższy procent, poza nimi stały', () => {
  const c = mergeTopup({ promos: [{ id: 'p', name: 'Weekendowy bonus', days: [5, 6, 7], from: '16:00', to: '20:00', bonusPercent: 25, active: true }] });
  assert.equal(activeTopupPromo(c, FRI_NOON), null);
  assert.equal(topupBonus(c, 100, FRI_NOON).bonus, 10);
  const evening = topupBonus(c, 100, FRI_EVENING);
  assert.equal(evening.bonus, 25);
  assert.equal(evening.promo.name, 'Weekendowy bonus');
});

test('promocja z datami działa tylko w tych dniach, wyłączona wcale', () => {
  const base = { id: 'p', name: 'Start sezonu', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59', bonusPercent: 20 };
  assert.equal(topupBonus(mergeTopup({ promos: [{ ...base, dateFrom: '2026-11-20', dateTo: '2026-11-22' }] }), 100, FRI_NOON).bonus, 20);
  assert.equal(topupBonus(mergeTopup({ promos: [{ ...base, dateFrom: '2026-11-21' }] }), 100, FRI_NOON).bonus, 10);
  assert.equal(topupBonus(mergeTopup({ promos: [{ ...base, active: false }] }), 100, FRI_NOON).bonus, 10);
});

test('promocja niższa od stałego bonusu go nie obniża', () => {
  const c = mergeTopup({ bonusPercent: 15, promos: [{ id: 'p', name: 'Mała', days: [5], from: '00:00', to: '23:59', bonusPercent: 5 }] });
  assert.equal(topupBonus(c, 100, FRI_NOON).bonus, 15);
});

test('blokada i zakres kwot', () => {
  const c = mergeTopup();
  assert.equal(topupAmountProblem(c, 100), null);
  assert.match(topupAmountProblem(c, 5), /od 20 do 1000/);
  assert.match(topupAmountProblem(c, 12.5), /od 20 do 1000/);
  assert.match(topupAmountProblem({ ...c, enabled: false }, 100), /wyłączone/);
});

test('ustawienia z panelu są sprawdzane', () => {
  const ok = cleanTopupConfig({ enabled: false, bonusPercent: 12.5, amounts: [200, 50, 50, 5], min: 20, max: 500 });
  assert.equal(ok.config.enabled, false);
  assert.equal(ok.config.bonusPercent, 12.5);
  assert.deepEqual(ok.config.amounts, [50, 200]);
  assert.match(cleanTopupConfig({ min: 600, max: 500 }).error, /Najmniejsza/);
  assert.match(cleanTopupConfig({ promos: [{ name: 'Zła', days: [1], from: '18:00', to: '16:00' }] }).error, /„Zła”/);
  assert.match(cleanTopupConfig({ promos: [{ name: 'Daty', days: [1], from: '10:00', to: '12:00', dateFrom: '2026-12-02', dateTo: '2026-12-01' }] }).error, /data końca/);
  assert.equal(cleanTopupConfig({ bonusPercent: 500 }).config.bonusPercent, 100);
});
