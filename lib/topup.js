'use strict';
// Doładowanie salda vPLN online (PayU): zasady, bonus procentowy i promocje w wybrane dni i godziny.
// Bez bazy danych, żeby dało się to łatwo przetestować.
const { toGr, fromGr } = require('./money');
const { warsawParts } = require('./time');

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_TOPUP = {
  enabled: true, // klient może doładować saldo online
  bonusPercent: 10, // stały bonus do każdego doładowania
  minForBonus: 0, // bonus od tej kwoty doładowania (0 = od każdej)
  maxBonus: 0, // najwyższy bonus w vPLN za jedno doładowanie (0 = bez limitu)
  amounts: [20, 50, 100, 150, 200], // kafelki z kwotami w aplikacji
  min: 20,
  max: 1000,
  // Promocje (jak happy hours): w te dni i godziny bonus jest wyższy.
  // { id, name, days: [1..7], from: 'HH:MM', to: 'HH:MM', dateFrom?: 'RRRR-MM-DD', dateTo?: 'RRRR-MM-DD', bonusPercent, active }
  promos: []
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const int = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : fallback;
};

function mergeTopup(saved = {}) {
  const d = clone(DEFAULT_TOPUP);
  return {
    ...d, ...saved,
    amounts: Array.isArray(saved.amounts) && saved.amounts.length ? saved.amounts : d.amounts,
    promos: Array.isArray(saved.promos) ? saved.promos : []
  };
}

// Sprawdza i czyści ustawienia z panelu. Zwraca { config } albo { error }.
function cleanTopupConfig(b = {}, prev = DEFAULT_TOPUP) {
  const p = mergeTopup(prev);
  const min = int(b.min !== undefined ? b.min : p.min, 1, 5000, 20);
  const max = int(b.max !== undefined ? b.max : p.max, 1, 5000, 1000);
  if (min > max) return { error: 'Najmniejsza kwota nie może być większa od największej.' };
  const amounts = [...new Set((Array.isArray(b.amounts) ? b.amounts : p.amounts).map((a) => int(a, 1, 5000, 0)).filter((a) => a >= min && a <= max))]
    .sort((a, c) => a - c).slice(0, 8);
  if (!amounts.length) return { error: `Dodaj co najmniej jedną kwotę od ${min} do ${max} zł.` };
  const promos = [];
  for (const h of (Array.isArray(b.promos) ? b.promos : p.promos).slice(0, 20)) {
    const name = String((h && h.name) || 'Promocja').trim().slice(0, 40) || 'Promocja';
    const days = [...new Set((Array.isArray(h.days) ? h.days : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (!days.length || !HM.test(String(h.from)) || !HM.test(String(h.to)) || h.from >= h.to) {
      return { error: `Sprawdź dni i godziny w „${name}” (koniec musi być po początku).` };
    }
    const dateFrom = DATE.test(String(h.dateFrom || '')) ? h.dateFrom : '';
    const dateTo = DATE.test(String(h.dateTo || '')) ? h.dateTo : '';
    if (dateFrom && dateTo && dateFrom > dateTo) return { error: `W „${name}” data końca jest przed datą początku.` };
    promos.push({
      id: String(h.id || Math.random().toString(16).slice(2, 10)).slice(0, 20), name, days, from: h.from, to: h.to,
      dateFrom, dateTo, bonusPercent: num(h.bonusPercent, 0, 100, 20), active: h.active !== false
    });
  }
  return {
    config: {
      enabled: b.enabled !== undefined ? Boolean(b.enabled) : Boolean(p.enabled),
      bonusPercent: num(b.bonusPercent !== undefined ? b.bonusPercent : p.bonusPercent, 0, 100, 10),
      minForBonus: num(b.minForBonus !== undefined ? b.minForBonus : p.minForBonus, 0, 5000, 0),
      maxBonus: num(b.maxBonus !== undefined ? b.maxBonus : p.maxBonus, 0, 5000, 0),
      amounts, min, max, promos
    }
  };
}

const ymd = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// Promocja trwająca teraz (czas polski). Kilka naraz: wygrywa najwyższy procent.
function activeTopupPromo(config, at = new Date()) {
  const p = warsawParts(at);
  const today = ymd(p);
  const matching = (config.promos || []).filter((h) => h.active !== false
    && Array.isArray(h.days) && h.days.map(Number).includes(p.wd)
    && h.from <= p.hm && p.hm < h.to
    && (!h.dateFrom || h.dateFrom <= today) && (!h.dateTo || today <= h.dateTo));
  return matching.sort((a, b) => Number(b.bonusPercent) - Number(a.bonusPercent))[0] || null;
}

// Procent bonusu teraz: promocja zastępuje stały bonus, gdy daje więcej
function currentBonusPercent(config, at = new Date()) {
  const promo = activeTopupPromo(config, at);
  const base = Number(config.bonusPercent) || 0;
  if (promo && Number(promo.bonusPercent) > base) return { percent: Number(promo.bonusPercent), promo };
  return { percent: base, promo: null };
}

// Bonus w vPLN za doładowanie (w groszach w środku, zaokrąglony w dół do grosza)
function topupBonus(config, amount, at = new Date()) {
  const { percent, promo } = currentBonusPercent(config, at);
  const amountGr = toGr(amount);
  if (!(percent > 0) || amountGr < toGr(config.minForBonus || 0)) return { bonus: 0, percent: 0, promo: null };
  let bonusGr = Math.floor((amountGr * percent) / 100);
  if (Number(config.maxBonus) > 0) bonusGr = Math.min(bonusGr, toGr(config.maxBonus));
  return { bonus: fromGr(bonusGr), percent, promo };
}

function topupAmountProblem(config, amount) {
  if (!config.enabled) return 'Doładowanie online jest teraz wyłączone. Saldo doładujesz w lokalu.';
  if (!Number.isInteger(amount) || amount < config.min || amount > config.max) return `Wybierz kwotę od ${config.min} do ${config.max} zł.`;
  return null;
}

module.exports = { DEFAULT_TOPUP, mergeTopup, cleanTopupConfig, activeTopupPromo, currentBonusPercent, topupBonus, topupAmountProblem };
