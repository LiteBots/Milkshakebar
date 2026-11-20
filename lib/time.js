'use strict';
// Czas polski. Serwer na Railway działa w UTC, a godziny otwarcia, śniadania i statystyki liczymy w Polsce.

function warsawParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday],
    hm: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour), minute: Number(parts.minute)
  };
}

// Północ w Polsce dla daty (y, m, d), jako data UTC. Dzień może wyjść poza miesiąc (Date.UTC to wyrówna).
function warsawMidnight(y, m, d) {
  const utc = Date.UTC(y, m - 1, d);
  return new Date(utc - warsawParts(new Date(utc)).hour * 3600e3);
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHm = (v) => HM.test(String(v || ''));
const hmToMin = (hm) => {
  const [h, m] = String(hm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const minToHm = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
// Minuty od północy w Polsce
const warsawMinutes = (date = new Date()) => {
  const p = warsawParts(date);
  return p.hour * 60 + p.minute;
};

// Godzina „HH:MM” dziś albo jutro (czas polski) jako konkretna data
function scheduledDate(day, time, now = new Date()) {
  if (!isHm(time)) return null;
  const base = warsawParts(new Date(now.getTime() + (day === 'tomorrow' ? 864e5 : 0)));
  const [h, m] = time.split(':').map(Number);
  const guess = Date.UTC(base.y, base.m - 1, base.d, h, m);
  const p = warsawParts(new Date(guess));
  const asWarsaw = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return new Date(guess - (asWarsaw - guess)); // odejmij przesunięcie strefy (zima +1 h, lato +2 h)
}

module.exports = { warsawParts, warsawMidnight, isHm, hmToMin, minToHm, warsawMinutes, scheduledDate };
