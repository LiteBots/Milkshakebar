'use strict';
// Kwoty liczymy w groszach (liczby całkowite), a do bazy i API oddajemy złote z dwoma miejscami po przecinku.
// Dzięki temu 0,1 + 0,2 daje 0,30 zł, a nie 0,30000000000000004.

const toGr = (zl) => {
  const n = Number(zl);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fromGr = (gr) => Math.round(Number(gr) || 0) / 100;
// Zaokrąglenie do pełnych groszy (zamiennik dawnego round2)
const round2 = (zl) => fromGr(toGr(zl));
const sumGr = (list, pick = (x) => x) => list.reduce((s, x) => s + toGr(pick(x)), 0);

module.exports = { toGr, fromGr, round2, sumGr };
