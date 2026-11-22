'use strict';
// Śniadania: zamawiane i odbierane tylko do określonej godziny (domyślnie 13:00).
// Nie da się zamówić śniadania o 9:00 z odbiorem o 14:00 ani złożyć zamówienia ze śniadaniem po 13:00.
const { isHm, hmToMin } = require('./time');

const DEFAULT_BREAKFAST_UNTIL = '13:00';
const isBreakfastCategory = (categoryId) => /^sniadania/.test(String(categoryId || ''));
const breakfastUntil = (settings) => (settings && isHm(settings.breakfastUntil) ? settings.breakfastUntil : DEFAULT_BREAKFAST_UNTIL);

// Zwraca komunikat błędu albo null, gdy termin jest w porządku.
// nowMin: minuty od północy (czas polski); readyMin: na kiedy klient chce zamówienie (minuty od północy).
function breakfastProblem({ until = DEFAULT_BREAKFAST_UNTIL, nowMin, readyMin }) {
  const limit = hmToMin(until);
  if (nowMin >= limit) return `Śniadania zamawiamy do ${until}. Usuń je z koszyka albo zamów jutro rano.`;
  if (readyMin > limit) return `Śniadania wydajemy do ${until}. Wybierz odbiór najpóźniej o ${until} albo usuń śniadania z koszyka.`;
  return null;
}

module.exports = { DEFAULT_BREAKFAST_UNTIL, isBreakfastCategory, breakfastUntil, breakfastProblem };
