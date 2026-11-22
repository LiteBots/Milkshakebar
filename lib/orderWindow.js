'use strict';
// Kiedy można zamawiać online i na które godziny. Liczone na serwerze w czasie polskim,
// zamawiarka dostaje gotowe terminy (te same reguły sprawdza serwer przy składaniu zamówienia).
//
// Ustawienia (panel → Zamówienia → Ustawienia zamawiarki → Godziny zamówień online):
//   orderHoursMode        'opening' = jak godziny otwarcia, 'custom' = własne godziny zamówień, 'always' = całą dobę
//   orderSchedule         własne godziny na każdy dzień: { mon: { isOpen, from, to }, ... }
//   lastOrderBeforeClose  ile minut przed końcem przestajemy przyjmować zamówienia (np. 30: zamykamy 21:00 → ostatnie 20:30)
//   lastReadyBeforeClose  ile minut przed końcem jest najpóźniejszy odbiór / dostawa (np. 0: odbiór do 21:00)
//   maxAheadMinutes       na ile do przodu można zamówić (0 = na dowolną godzinę do końca dnia)
//   ordersBeforeOpen      czy przed otwarciem można zamówić na później (np. o 9:00 na 12:30)
const { warsawParts, hmToMin, minToHm, isHm } = require('./time');

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SLOT = 15; // terminy co 15 minut

function dayRange(settings, hours, dayKey) {
  const mode = settings.orderHoursMode || 'opening';
  if (mode === 'always') return { from: 0, to: 24 * 60 - 1, always: true };
  const src = mode === 'custom' ? (settings.orderSchedule || {}) : hours;
  // Brak zapisanych godzin otwarcia: bez ograniczeń (jak dotąd)
  if (!src) return { from: 0, to: 24 * 60 - 1, always: true };
  const d = src[dayKey];
  if (!d || !d.isOpen || !isHm(d.from) || !isHm(d.to)) return null;
  const from = hmToMin(d.from);
  let to = hmToMin(d.to);
  if (to <= from) to = 24 * 60 - 1; // zamknięcie po północy liczymy do 23:59
  return { from, to };
}

/**
 * @param {object} p
 * @param {object} p.settings  ustawienia lokalu (już z trybem „dużo zamówień”)
 * @param {object|null} p.hours  godziny otwarcia z panelu (schedule) albo null
 * @param {Date} [p.now]
 */
function orderWindow({ settings, hours, now = new Date() }) {
  const p = warsawParts(now);
  const nowMin = p.hour * 60 + p.minute;
  const range = dayRange(settings, hours, DAY_KEYS[p.wd - 1]);
  const base = { nowMin, mode: settings.orderHoursMode || 'opening' };
  const empty = { slots: [], asap: false, enabled: false, prep: 0 };
  if (!range) {
    return { ...base, open: false, accepting: false, today: null, lastOrder: null, latestReady: null, modes: { pickup: empty, delivery: empty }, reason: 'Dziś nie przyjmujemy zamówień online.' };
  }
  const lastOrderMin = range.always ? range.to : range.to - Math.max(0, Number(settings.lastOrderBeforeClose) || 0);
  const latestReadyMin = range.always ? range.to : range.to - Math.max(0, Number(settings.lastReadyBeforeClose) || 0);
  const beforeOpenOk = settings.ordersBeforeOpen !== false;
  const open = nowMin >= range.from && nowMin <= range.to;
  const accepting = nowMin < lastOrderMin && (beforeOpenOk || nowMin >= range.from);
  const maxAhead = Math.max(0, Number(settings.maxAheadMinutes) || 0);
  const modes = {};
  for (const [mode, on, prepKey] of [['pickup', settings.pickupEnabled, 'pickupPrepMinutes'], ['delivery', settings.deliveryEnabled, 'deliveryPrepMinutes']]) {
    const prep = Math.max(0, Number(settings[prepKey]) || 0);
    if (!on || !settings.ordersEnabled || !accepting) { modes[mode] = { ...empty, prep }; continue; }
    const first = Math.ceil(Math.max(nowMin + prep, range.from + prep) / SLOT) * SLOT;
    const last = Math.min(latestReadyMin, maxAhead ? nowMin + maxAhead : Infinity);
    const slots = [];
    for (let t = first; t <= last; t += SLOT) slots.push(minToHm(t));
    const asap = open && nowMin + prep <= latestReadyMin;
    modes[mode] = { slots, asap, enabled: asap || slots.length > 0, prep };
  }
  let reason = '';
  if (!accepting) {
    reason = nowMin >= lastOrderMin
      ? `Zamówienia online przyjmujemy dziś do ${minToHm(Math.max(0, lastOrderMin))}. Zapraszamy jutro!`
      : `Zamówienia online przyjmujemy od ${minToHm(range.from)}.`;
  }
  return {
    ...base, open, accepting, reason,
    today: [minToHm(range.from), minToHm(range.to)],
    lastOrder: minToHm(Math.max(0, lastOrderMin)),
    latestReady: minToHm(Math.max(0, latestReadyMin)),
    maxAheadMinutes: maxAhead,
    modes
  };
}

// Czy wybrany termin mieści się w oknie (sprawdzane przy składaniu zamówienia). Zwraca komunikat albo null.
function timeProblem(win, { mode, asap, readyMin }) {
  if (!win.accepting) return win.reason || 'Zamówienia online są teraz wyłączone.';
  const m = win.modes[mode];
  if (!m || !m.enabled) return 'Na dziś nie ma już wolnych terminów.';
  if (asap) return m.asap ? null : `Najbliższy termin to ${m.slots[0] || '–'}. Wybierz godzinę z listy.`;
  if (readyMin > hmToMin(win.latestReady)) return `Najpóźniejszy termin dziś to ${win.latestReady}.`;
  if (win.maxAheadMinutes && readyMin > win.nowMin + win.maxAheadMinutes + SLOT) return 'Tak daleko do przodu nie przyjmujemy zamówień. Wybierz wcześniejszą godzinę.';
  if (readyMin < win.nowMin + m.prep - SLOT) return 'Ta godzina jest za wcześnie: nie zdążymy przygotować zamówienia.';
  return null;
}

// Własne godziny zamówień z panelu: tylko poprawne wpisy
function cleanSchedule(raw) {
  const out = {};
  for (const d of DAY_KEYS) {
    const day = (raw || {})[d] || {};
    out[d] = { isOpen: Boolean(day.isOpen), from: isHm(day.from) ? day.from : '12:00', to: isHm(day.to) ? day.to : '20:30' };
  }
  return out;
}

module.exports = { orderWindow, timeProblem, cleanSchedule, DAY_KEYS };
