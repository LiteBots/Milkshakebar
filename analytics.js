// Analityka panelu: wykresy, produkty, godziny szczytu, klienci, rachunek wyników i eksport CSV.
// Rejestrowane w server.js: require('./analytics')(app, ctx). Wszystkie daty liczone w czasie polskim.
'use strict';
const mongoose = require('mongoose');

module.exports = function registerAnalytics(app, ctx) {
  const { requireAdmin, asyncRoute, round2, audit, warsawParts, warsawMidnight } = ctx;
  const M = ctx.models;
  const TZ = 'Europe/Warsaw';
  const DAY = 864e5;
  const PURCHASE = ['kasa', 'zamowienie'];
  const VALID_ORDER = { $nin: ['awaiting_payment', 'cancelled'] };
  const REAL_TOPUP = { action: 'add', actor: { $nin: ['system', 'klient'] } }; // wpłaty pieniędzy na prepaid
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const pad = (n) => String(n).padStart(2, '0');
  const oid = (v) => new mongoose.Types.ObjectId(String(v));

  // ---------- daty ----------
  const keyParts = (key) => key.split('-').map(Number);
  const dayStart = (key) => { const [y, m, d] = keyParts(key); return warsawMidnight(y, m, d); };
  const shiftKey = (key, n) => { const [y, m, d] = keyParts(key); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const todayKey = () => { const p = warsawParts(new Date()); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };

  function dateFilter(field, from, to) {
    const f = {};
    if (YMD.test(from || '')) f.$gte = dayStart(from);
    if (YMD.test(to || '')) f.$lt = dayStart(shiftKey(to, 1));
    return Object.keys(f).length ? { [field]: f } : {};
  }
  function searchRegex(q) {
    const s = String(q || '').trim().slice(0, 60);
    return s ? new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  }
  // Zakres z zapytania (domyślnie ostatnie 30 dni, maks. 366) i poprzedni okres tej samej długości
  function range(q) {
    let toKey = YMD.test(q.to || '') ? q.to : todayKey();
    let fromKey = YMD.test(q.from || '') ? q.from : shiftKey(toKey, -29);
    if (fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
    if (Math.round((dayStart(toKey) - dayStart(fromKey)) / DAY) > 365) fromKey = shiftKey(toKey, -365);
    const from = dayStart(fromKey);
    const to = dayStart(shiftKey(toKey, 1));
    const days = [];
    for (let k = fromKey; k <= toKey; k = shiftKey(k, 1)) days.push(k);
    return { fromKey, toKey, from, to, days, prevFrom: new Date(from - (to - from)), prevTo: from };
  }
  const between = (from, to) => ({ $gte: from, $lt: to });
  const byDay = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: TZ } });

  // ---------- klienci ----------
  // Stali klienci, którzy przestali przychodzić: min. 3 zakupy w ostatnim roku, ostatni ponad 30 dni temu
  async function churnedCustomers() {
    const now = Date.now();
    const rows = await M.PointTransaction.aggregate([
      { $match: { source: { $in: PURCHASE }, reverted: { $ne: true }, userId: { $ne: null }, date: { $gte: new Date(now - 365 * DAY) } } },
      { $group: { _id: '$userId', purchases: { $sum: 1 }, spent: { $sum: '$amountSpent' }, last: { $max: '$date' } } },
      { $match: { purchases: { $gte: 3 }, last: { $lt: new Date(now - 30 * DAY) } } },
      { $sort: { spent: -1 } },
      { $limit: 500 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $unwind: '$u' },
      { $match: { 'u.blocked': { $ne: true } } }
    ]);
    return rows.map((r) => ({
      userId: r._id, name: r.u.name || r.u.username, phone: r.u.phone, purchases: r.purchases,
      spent: round2(r.spent), lastPurchase: r.last, daysSince: Math.floor((now - r.last) / DAY), points: r.u.points || 0
    }));
  }
  // Klienci, którym w ciągu 30 dni wygasną Milkosy
  const expiringMatch = () => ({ remaining: { $gt: 0 }, expired: { $ne: true }, expiresAt: { $gt: new Date(), $lte: new Date(Date.now() + 30 * DAY) } });
  const expiringPointsUserIds = () => M.PointLot.distinct('userId', expiringMatch());

  async function topCustomers(from, to, limit = 20) {
    const rows = await M.PointTransaction.aggregate([
      { $match: { source: { $in: PURCHASE }, reverted: { $ne: true }, userId: { $ne: null }, date: between(from, to) } },
      { $group: { _id: '$userId', spent: { $sum: '$amountSpent' }, visits: { $sum: 1 }, last: { $max: '$date' } } },
      { $sort: { spent: -1 } }, { $limit: limit },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } }
    ]);
    return rows.map((r) => ({ userId: r._id, name: r.u ? (r.u.name || r.u.username) : '(usunięty)', phone: r.u ? r.u.phone : '', spent: round2(r.spent), visits: r.visits, last: r.last }));
  }

  async function tierCounts() {
    const program = ctx.program();
    const levels = [...((program.tiers && program.tiers.levels) || [])].sort((a, b) => a.minSpent - b.minSpent);
    if (!levels.length) return [];
    const since = new Date(); since.setMonth(since.getMonth() - ((program.tiers && program.tiers.windowMonths) || 12));
    const [spends, totalUsers] = await Promise.all([
      M.PointTransaction.aggregate([
        { $match: { source: { $in: PURCHASE }, reverted: { $ne: true }, userId: { $ne: null }, date: { $gte: since } } },
        { $group: { _id: '$userId', s: { $sum: '$amountSpent' } } }
      ]),
      M.User.countDocuments()
    ]);
    const counts = levels.map((l) => ({ key: l.key, name: l.name, minSpent: l.minSpent, multiplier: l.multiplier, count: 0 }));
    for (const s of spends) {
      let idx = 0;
      levels.forEach((l, i) => { if (s.s >= l.minSpent) idx = i; });
      counts[idx].count += 1;
    }
    // Klienci bez zakupów w okresie są na najniższym poziomie
    counts[0].count += Math.max(0, totalUsers - spends.length);
    return counts;
  }

  async function referralStats(from, to) {
    const referred = await M.User.find({ referredBy: { $ne: null } }, '_id referredBy referralRewarded');
    const ids = referred.map((u) => u._id);
    const [spentAll, spentRange, topRef] = await Promise.all([
      M.PointTransaction.aggregate([{ $match: { userId: { $in: ids }, source: { $in: PURCHASE }, reverted: { $ne: true } } }, { $group: { _id: null, s: { $sum: '$amountSpent' } } }]),
      M.PointTransaction.aggregate([{ $match: { userId: { $in: ids }, source: { $in: PURCHASE }, reverted: { $ne: true }, date: between(from, to) } }, { $group: { _id: null, s: { $sum: '$amountSpent' } } }]),
      M.User.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 }, rewarded: { $sum: { $cond: ['$referralRewarded', 1, 0] } } } },
        { $sort: { count: -1 } }, { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } }
      ])
    ]);
    return {
      referred: referred.length,
      rewarded: referred.filter((u) => u.referralRewarded).length,
      inRange: await M.User.countDocuments({ referredBy: { $ne: null }, createdAt: between(from, to) }),
      spentAll: round2((spentAll[0] || {}).s || 0),
      spentRange: round2((spentRange[0] || {}).s || 0),
      topReferrers: topRef.map((r) => ({ name: r.u ? (r.u.name || r.u.username) : '(usunięty)', phone: r.u ? r.u.phone : '', count: r.count, rewarded: r.rewarded }))
    };
  }

  async function upcomingBirthdays(days = 7) {
    const pairs = [];
    const labels = {};
    for (let i = 0; i < days; i += 1) {
      const p = warsawParts(new Date(Date.now() + i * DAY));
      pairs.push({ 'birthday.month': p.m, 'birthday.day': p.d });
      labels[`${p.m}-${p.d}`] = i;
    }
    const users = await M.User.find({ $or: pairs, blocked: { $ne: true } }, 'name username phone birthday points').limit(300);
    return users
      .map((u) => ({ name: u.name || u.username, phone: u.phone, day: u.birthday.day, month: u.birthday.month, inDays: labels[`${u.birthday.month}-${u.birthday.day}`], points: u.points || 0 }))
      .sort((a, b) => a.inDays - b.inDays);
  }

  // ---------- zamówienia ----------
  async function periodSummary(location, from, to) {
    const [orders, users, reservations, milkosy, prepaid] = await Promise.all([
      M.Order.aggregate([
        { $match: { location, status: VALID_ORDER, createdAt: between(from, to) } },
        { $group: { _id: '$deliveryMethod', count: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } }
      ]),
      M.User.countDocuments({ createdAt: between(from, to) }),
      M.Reservation.countDocuments({ createdAt: between(from, to) }),
      M.PointTransaction.aggregate([{ $match: { pointsAwarded: { $gt: 0 }, reverted: { $ne: true }, date: between(from, to) } }, { $group: { _id: null, s: { $sum: '$pointsAwarded' } } }]),
      M.WalletTransaction.aggregate([{ $match: { ...REAL_TOPUP, date: between(from, to) } }, { $group: { _id: null, s: { $sum: '$amount' } } }])
    ]);
    const part = (key) => {
      const r = orders.filter((o) => (key === 'delivery' ? o._id === 'delivery' : o._id !== 'delivery'));
      const count = r.reduce((s, o) => s + o.count, 0);
      const revenue = round2(r.reduce((s, o) => s + o.revenue, 0));
      return { count, revenue, avg: count ? round2(revenue / count) : 0 };
    };
    const pickup = part('pickup');
    const delivery = part('delivery');
    const count = pickup.count + delivery.count;
    const revenue = round2(pickup.revenue + delivery.revenue);
    return {
      orders: count, revenue, avgOrder: count ? round2(revenue / count) : 0, pickup, delivery,
      users, reservations, milkosy: (milkosy[0] || {}).s || 0, prepaid: round2((prepaid[0] || {}).s || 0)
    };
  }

  async function topProducts(location, from, to) {
    const rows = await M.Order.aggregate([
      { $match: { location, status: VALID_ORDER, createdAt: between(from, to) } },
      { $unwind: '$items' },
      { $group: {
        _id: { $ifNull: ['$items.productId', '$items.name'] }, name: { $first: '$items.name' },
        qty: { $sum: { $ifNull: ['$items.quantity', 1] } },
        revenue: { $sum: { $multiply: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.quantity', 1] }] } },
        orders: { $sum: 1 }
      } },
      { $sort: { qty: -1 } }
    ]);
    const products = await M.Product.find({ location, archived: { $ne: true } }, 'name isAvailable categoryId');
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const sold = rows.map((r) => {
      const p = byId.get(String(r._id));
      return { id: String(r._id), name: p ? p.name : String(r.name || '').replace(/ \([^)]*\)$/, ''), qty: r.qty, revenue: round2(r.revenue), orders: r.orders };
    });
    const soldIds = new Set(sold.map((s) => s.id));
    const notSold = products.filter((p) => p.isAvailable !== false && !soldIds.has(String(p._id))).map((p) => p.name).sort((a, b) => a.localeCompare(b, 'pl'));
    return { top: sold.slice(0, 15), slow: sold.slice(-10).reverse().filter((s) => !sold.slice(0, 15).includes(s)), notSold };
  }

  async function heatmap(location, from, to) {
    const group = (dateField) => ({ $group: { _id: { d: { $isoDayOfWeek: { date: `$${dateField}`, timezone: TZ } }, h: { $hour: { date: `$${dateField}`, timezone: TZ } } }, n: { $sum: 1 } } });
    const [orders, kasa] = await Promise.all([
      M.Order.aggregate([{ $match: { location, status: VALID_ORDER, createdAt: between(from, to) } }, group('createdAt')]),
      M.PointTransaction.aggregate([{ $match: { source: 'kasa', reverted: { $ne: true }, date: between(from, to), ...(location === 'rowy' ? { location: 'rowy' } : { location: { $ne: 'rowy' } }) } }, group('date')])
    ]);
    const flat = (rows) => rows.map((r) => ({ d: r._id.d, h: r._id.h, n: r.n }));
    return { orders: flat(orders), kasa: flat(kasa) };
  }

  async function prepTimes(location, from, to) {
    const start = { $ifNull: ['$statusAt.pending', '$createdAt'] };
    const mins = (a, b) => ({ $divide: [{ $subtract: [a, b] }, 60000] });
    const rows = await M.Order.aggregate([
      { $match: { location, 'statusAt.ready': between(from, to) } },
      { $project: {
        deliveryMethod: 1,
        toReady: mins('$statusAt.ready', start),
        toAccept: { $cond: [{ $ifNull: ['$statusAt.preparing', false] }, mins('$statusAt.preparing', start), null] }
      } },
      { $match: { toReady: { $gte: 0, $lte: 24 * 60 } } },
      { $group: { _id: '$deliveryMethod', n: { $sum: 1 }, ready: { $avg: '$toReady' }, accept: { $avg: '$toAccept' } } }
    ]);
    const all = rows.reduce((s, r) => ({ n: s.n + r.n, ready: s.ready + r.ready * r.n, accept: s.accept + (r.accept || 0) * r.n }), { n: 0, ready: 0, accept: 0 });
    const fmt = (r) => (r ? { count: r.n, toReady: Math.round(r.ready), toAccept: r.accept == null ? null : Math.round(r.accept) } : null);
    return {
      all: all.n ? { count: all.n, toReady: Math.round(all.ready / all.n), toAccept: Math.round(all.accept / all.n) } : null,
      pickup: fmt(rows.find((r) => r._id !== 'delivery')),
      delivery: fmt(rows.find((r) => r._id === 'delivery'))
    };
  }

  async function statusRates(location, from, to) {
    const [res, ord] = await Promise.all([
      M.Reservation.aggregate([{ $match: { createdAt: between(from, to) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      M.Order.aggregate([{ $match: { location, createdAt: between(from, to) } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);
    const obj = (rows) => Object.fromEntries(rows.map((r) => [r._id || 'brak', r.n]));
    return { reservations: obj(res), orders: obj(ord) };
  }

  // Skuteczność push: ilu odbiorców kupiło coś w 24 h po wysłaniu (i dla porównania w tych samych godzinach tydzień wcześniej)
  async function pushEffect() {
    const campaigns = await M.PushCampaign.find().sort({ at: -1 }).limit(15);
    const buyers = async (ids, from, to) => {
      const [a, b, rev] = await Promise.all([
        M.PointTransaction.distinct('userId', { userId: { $in: ids }, source: 'kasa', reverted: { $ne: true }, date: between(from, to) }),
        M.Order.distinct('userId', { userId: { $in: ids }, status: VALID_ORDER, createdAt: between(from, to) }),
        M.Order.aggregate([{ $match: { userId: { $in: ids }, status: VALID_ORDER, createdAt: between(from, to) } }, { $group: { _id: null, s: { $sum: '$totalAmount' }, n: { $sum: 1 } } }])
      ]);
      return { buyers: new Set([...a, ...b].map(String)).size, orders: (rev[0] || {}).n || 0, revenue: round2((rev[0] || {}).s || 0) };
    };
    return Promise.all(campaigns.map(async (c) => {
      const base = { id: c._id, title: c.title, audience: c.audience, at: c.at, sent: c.sent || 0, failed: c.failed || 0 };
      const ids = (c.userIds || []).map(oid);
      if (!ids.length) return { ...base, tracked: false };
      const at = new Date(c.at);
      const [after, before] = await Promise.all([
        buyers(ids, at, new Date(at.getTime() + DAY)),
        buyers(ids, new Date(at.getTime() - 7 * DAY), new Date(at.getTime() - 6 * DAY))
      ]);
      return { ...base, tracked: true, recipients: ids.length, after, before, conversion: round2((after.buyers / ids.length) * 100) };
    }));
  }

  // ---------- GŁÓWNY ENDPOINT ----------
  app.get('/api/admin/analytics', requireAdmin('manager'), asyncRoute(async (req, res) => {
    const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
    const r = range(req.query);
    const now = Date.now();
    const loyalty = ctx.loyalty();
    const dailyMatch = (field, extra = {}) => ({ ...extra, [field]: between(r.from, r.to) });
    const [
      cur, prev, dOrders, dUsers, dRes, dPrepaid, products, heat, payments,
      seen7, seen30, buy7, buy30, totalUsers, churned, top, tiers, expiring, referrals, birthdays,
      gcSold, gcOut, gcLife, userAgg, prep, rates, push
    ] = await Promise.all([
      periodSummary(location, r.from, r.to),
      periodSummary(location, r.prevFrom, r.prevTo),
      M.Order.aggregate([{ $match: dailyMatch('createdAt', { location, status: VALID_ORDER }) }, { $group: { _id: byDay('createdAt'), n: { $sum: 1 }, s: { $sum: '$totalAmount' } } }]),
      M.User.aggregate([{ $match: dailyMatch('createdAt') }, { $group: { _id: byDay('createdAt'), n: { $sum: 1 } } }]),
      M.Reservation.aggregate([{ $match: dailyMatch('createdAt') }, { $group: { _id: byDay('createdAt'), n: { $sum: 1 } } }]),
      M.WalletTransaction.aggregate([{ $match: dailyMatch('date', REAL_TOPUP) }, { $group: { _id: byDay('date'), s: { $sum: '$amount' } } }]),
      topProducts(location, r.from, r.to),
      heatmap(location, r.from, r.to),
      M.Order.aggregate([
        { $match: { location, status: VALID_ORDER, createdAt: between(r.from, r.to) } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$totalAmount' }, wallet: { $sum: { $ifNull: ['$walletUsed', 0] } } } },
        { $sort: { total: -1 } }
      ]),
      M.User.countDocuments({ lastSeenAt: { $gte: new Date(now - 7 * DAY) } }),
      M.User.countDocuments({ lastSeenAt: { $gte: new Date(now - 30 * DAY) } }),
      M.PointTransaction.distinct('userId', { source: { $in: PURCHASE }, reverted: { $ne: true }, date: { $gte: new Date(now - 7 * DAY) } }),
      M.PointTransaction.distinct('userId', { source: { $in: PURCHASE }, reverted: { $ne: true }, date: { $gte: new Date(now - 30 * DAY) } }),
      M.User.countDocuments(),
      churnedCustomers(),
      topCustomers(r.from, r.to),
      tierCounts(),
      M.PointLot.aggregate([{ $match: expiringMatch() }, { $group: { _id: null, points: { $sum: '$remaining' }, users: { $addToSet: '$userId' } } }]),
      referralStats(r.from, r.to),
      upcomingBirthdays(7),
      M.GiftCard.aggregate([{ $match: { status: { $in: ['active', 'used'] }, paidAt: between(r.from, r.to) } }, { $group: { _id: '$source', n: { $sum: 1 }, s: { $sum: '$amount' } } }]),
      M.GiftCard.aggregate([{ $match: { status: 'active', expiresAt: { $gt: new Date() } } }, { $group: { _id: null, n: { $sum: 1 }, s: { $sum: '$balance' } } }]),
      M.GiftCard.aggregate([{ $match: { status: { $in: ['active', 'used'] } } }, { $group: { _id: null, sold: { $sum: '$amount' }, used: { $sum: { $subtract: ['$amount', { $ifNull: ['$balance', 0] }] } } } }]),
      M.User.aggregate([{ $group: { _id: null, wallet: { $sum: '$walletBalance' }, points: { $sum: '$points' } } }]),
      prepTimes(location, r.from, r.to),
      statusRates(location, r.from, r.to),
      pushEffect()
    ]);

    const map = (rows, f) => new Map(rows.map((x) => [x._id, f(x)]));
    const mo = map(dOrders, (x) => x); const mu = map(dUsers, (x) => x.n); const mr = map(dRes, (x) => x.n); const mp = map(dPrepaid, (x) => x.s);
    const daily = r.days.map((day) => ({
      day, orders: (mo.get(day) || {}).n || 0, revenue: round2((mo.get(day) || {}).s || 0),
      users: mu.get(day) || 0, reservations: mr.get(day) || 0, prepaid: round2(mp.get(day) || 0)
    }));
    const ex = expiring[0] || {};
    const ua = userAgg[0] || {};
    const gco = gcOut[0] || {};
    const pointsVpln = round2((ua.points || 0) * loyalty.vplnPerPoint);

    res.json({
      success: true,
      data: {
        range: { from: r.fromKey, to: r.toKey, days: r.days.length },
        current: cur, previous: prev, daily,
        products, heatmap: heat,
        payments: payments.map((p) => ({ method: p._id || 'brak', count: p.count, total: round2(p.total), wallet: round2(p.wallet) })),
        activity: { seen7, seen30, buyers7: buy7.length, buyers30: buy30.length, totalUsers },
        churned: { count: churned.length, list: churned.slice(0, 50) },
        topCustomers: top,
        tiers,
        expiring: { points: ex.points || 0, users: (ex.users || []).length, value: round2((ex.points || 0) * loyalty.vplnPerPoint) },
        referrals,
        birthdays,
        giftCards: {
          soldInRange: gcSold.map((g) => ({ source: g._id || 'online', count: g.n, amount: round2(g.s) })),
          outstanding: { count: gco.n || 0, amount: round2(gco.s || 0) },
          lifetime: { sold: round2((gcLife[0] || {}).sold || 0), used: round2((gcLife[0] || {}).used || 0) }
        },
        liability: {
          prepaid: round2(ua.wallet || 0), points: ua.points || 0, pointsVpln, giftCards: round2(gco.s || 0),
          total: round2((ua.wallet || 0) + pointsVpln + (gco.s || 0))
        },
        prepTimes: prep,
        rates,
        push
      }
    });
  }));

  // ---------- RACHUNEK WYNIKÓW (miesiąc) ----------
  const monthKeyOk = (m) => /^\d{4}-\d{2}$/.test(m || '');
  function monthBounds(month) {
    const p = warsawParts(new Date());
    const [y, m] = monthKeyOk(month) ? month.split('-').map(Number) : [p.y, p.m];
    return { key: `${y}-${pad(m)}`, from: warsawMidnight(y, m, 1), to: warsawMidnight(y, m + 1, 1), prevKey: m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}` };
  }
  async function manualEntries(key) {
    const doc = await M.AppConfig.findOne({ key: `pnl:${key}` });
    const v = (doc && doc.value) || {};
    return { incomes: Array.isArray(v.incomes) ? v.incomes : [], costs: Array.isArray(v.costs) ? v.costs : [] };
  }
  async function pnl(month) {
    const b = monthBounds(month);
    const [orders, topups, gift, kasa, grants, shifts, staff, manual] = await Promise.all([
      M.Order.aggregate([
        { $match: { status: VALID_ORDER, createdAt: between(b.from, b.to) } },
        { $group: { _id: '$location', total: { $sum: '$totalAmount' }, wallet: { $sum: { $ifNull: ['$walletUsed', 0] } }, n: { $sum: 1 } } }
      ]),
      M.WalletTransaction.aggregate([{ $match: { ...REAL_TOPUP, date: between(b.from, b.to) } }, { $group: { _id: null, s: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      M.GiftCard.aggregate([{ $match: { status: { $in: ['active', 'used'] }, paidAt: between(b.from, b.to) } }, { $group: { _id: null, s: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      M.PointTransaction.aggregate([{ $match: { source: 'kasa', reverted: { $ne: true }, date: between(b.from, b.to) } }, { $group: { _id: null, s: { $sum: '$amountSpent' }, n: { $sum: 1 } } }]),
      M.WalletTransaction.aggregate([{ $match: { action: 'add', actor: 'system', reason: { $regex: /^(Misja|Prezent)/ }, date: between(b.from, b.to) } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
      M.Shift.find({ start: between(b.from, b.to) }),
      M.StaffMember.find({}, 'name hourlyRate'),
      manualEntries(b.key)
    ]);
    const rates = new Map(staff.map((s) => [String(s._id), s.hourlyRate || 0]));
    let wages = 0;
    let hours = 0;
    for (const s of shifts) {
      const h = Math.max(0, ((s.end || new Date()) - s.start) / 3600000);
      hours += h;
      wages += h * (rates.get(s.staffId) || 0) + (s.bonus || 0);
    }
    const ordersPaid = orders.reduce((s, o) => s + o.total - o.wallet, 0);
    const sum = (rows) => rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const income = {
      orders: round2(ordersPaid),
      ordersByLocation: orders.map((o) => ({ location: o._id, count: o.n, paid: round2(o.total - o.wallet) })),
      prepaid: round2((topups[0] || {}).s || 0),
      giftCards: round2((gift[0] || {}).s || 0),
      manual: round2(sum(manual.incomes))
    };
    const costs = { wages: round2(wages), hours: round2(hours), manual: round2(sum(manual.costs)) };
    const totalIncome = round2(income.orders + income.prepaid + income.giftCards + income.manual);
    const totalCosts = round2(costs.wages + costs.manual);
    return {
      month: b.key, prevMonth: b.prevKey, income, costs, totalIncome, totalCosts, result: round2(totalIncome - totalCosts),
      info: { kasaRegistered: round2((kasa[0] || {}).s || 0), kasaTransactions: (kasa[0] || {}).n || 0, vplnGranted: round2((grants[0] || {}).s || 0) },
      manual
    };
  }
  app.get('/api/admin/analytics/pnl', requireAdmin('owner'), asyncRoute(async (req, res) => {
    const current = await pnl(req.query.month);
    const previous = await pnl(current.prevMonth);
    res.json({ success: true, data: { current, previous } });
  }));
  app.put('/api/admin/analytics/pnl', requireAdmin('owner'), asyncRoute(async (req, res) => {
    const { month } = req.body || {};
    if (!monthKeyOk(month)) return res.status(400).json({ success: false, message: 'Nieprawidłowy miesiąc.' });
    const clean = (list) => (Array.isArray(list) ? list : [])
      .map((e) => ({ name: String((e && e.name) || '').trim().slice(0, 80), amount: round2(Number(e && e.amount)) }))
      .filter((e) => e.name && Number.isFinite(e.amount) && e.amount >= 0 && e.amount <= 10000000)
      .slice(0, 50);
    const value = { incomes: clean(req.body.incomes), costs: clean(req.body.costs) };
    await M.AppConfig.updateOne({ key: `pnl:${month}` }, { value }, { upsert: true });
    await audit(req, 'rachunek wyników', month, `${value.incomes.length} przychodów, ${value.costs.length} kosztów`);
    res.json({ success: true, data: await pnl(month) });
  }));

  // ---------- EKSPORT CSV ----------
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('pl-PL', { timeZone: TZ }) : '');
  const num = (n) => (n == null || n === '' ? '' : String(round2(n)).replace('.', ','));
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const EXPORTS = {
    zamowienia: {
      title: 'zamowienia',
      head: ['Numer', 'Data', 'Lokal', 'Status', 'Klient', 'Telefon', 'E-mail', 'Odbiór/dostawa', 'Adres', 'Płatność', 'Wartość', 'Saldem vPLN', 'Do zapłaty', 'Opłata za dostawę', 'Pozycje', 'Milkosy'],
      rows: async (q) => (await M.Order.find({ ...(q.location ? { location: q.location } : {}), ...dateFilter('createdAt', q.from, q.to) }).sort({ createdAt: 1 }).limit(50000).lean())
        .map((o) => [o.orderNumber, fmtDate(o.createdAt), o.location, o.status, o.customerName, o.customerPhone, o.customerEmail, o.deliveryMethod, o.deliveryAddress,
          o.paymentMethod, num(o.totalAmount), num(o.walletUsed || 0), num(o.amountDue ?? o.totalAmount), num(o.deliveryFee || 0),
          (o.items || []).map((i) => `${i.quantity}x ${i.name}`).join(', '), o.pointsAwarded > 0 ? o.pointsAwarded : ''])
    },
    rezerwacje: {
      title: 'rezerwacje',
      head: ['Termin', 'Złożona', 'Lokal', 'Status', 'Imię', 'Telefon', 'Goście', 'Strefa', 'Uwagi', 'Źródło'],
      rows: async (q) => (await M.Reservation.find(dateFilter('createdAt', q.from, q.to)).sort({ createdAt: 1 }).limit(50000).lean())
        .map((r) => [String(r.datetime || '').replace('T', ' '), fmtDate(r.createdAt), r.location, r.status, r.name, r.phone, r.guests, r.zone, r.notes, r.source])
    },
    prepaid: {
      title: 'prepaid',
      head: ['Data', 'Klient', 'Operacja', 'Kwota', 'Powód', 'Kto', 'Prawdziwa wpłata'],
      rows: async (q) => (await M.WalletTransaction.find(dateFilter('date', q.from, q.to)).sort({ date: 1 }).limit(50000).lean())
        .map((w) => [fmtDate(w.date), w.userDisplay, w.action === 'add' ? 'wpłata' : 'pobranie', num(w.amount), w.reason, w.actor,
          w.action === 'add' && !['system', 'klient'].includes(w.actor) ? 'tak' : 'nie'])
    },
    milkosy: {
      title: 'milkosy',
      head: ['Data', 'Klient', 'Kwota zakupu', 'Milkosy', 'W tym premia', 'Źródło', 'Lokal', 'Kto', 'Notatka', 'Cofnięte'],
      rows: async (q) => (await M.PointTransaction.find(dateFilter('date', q.from, q.to)).sort({ date: 1 }).limit(50000).lean())
        .map((t) => [fmtDate(t.date), t.userDisplay, num(t.amountSpent), t.pointsAwarded, t.bonusPoints || 0, t.source, t.location, t.actor, t.note, t.reverted ? 'tak' : ''])
    },
    karty: {
      title: 'karty-podarunkowe',
      head: ['Kod', 'Kwota', 'Saldo', 'Status', 'Źródło', 'Opłacona', 'Ważna do', 'Kupujący', 'E-mail', 'Telefon', 'Dla kogo'],
      rows: async (q) => (await M.GiftCard.find({ status: { $ne: 'awaiting_payment' }, ...dateFilter('createdAt', q.from, q.to) }).sort({ createdAt: 1 }).limit(50000).lean())
        .map((g) => [g.code, num(g.amount), num(g.balance), g.status, g.source, fmtDate(g.paidAt), fmtDate(g.expiresAt), g.buyerName, g.buyerEmail, g.buyerPhone, g.recipientName])
    }
  };
  app.get('/api/admin/export/:type', requireAdmin('manager'), asyncRoute(async (req, res) => {
    const def = EXPORTS[req.params.type];
    if (!def) return res.status(404).json({ success: false, message: 'Nieznany eksport.' });
    const q = { from: req.query.from, to: req.query.to, location: ['slupsk', 'rowy'].includes(req.query.location) ? req.query.location : '' };
    const rows = await def.rows(q);
    // Średnik i BOM: polski Excel otwiera plik poprawnie (z polskimi znakami)
    const csv = '﻿' + [def.head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
    await audit(req, 'eksport CSV', def.title, `${rows.length} wierszy${q.from || q.to ? `, ${q.from || '…'} – ${q.to || '…'}` : ''}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.title}${q.from ? `_${q.from}` : ''}${q.to ? `_${q.to}` : ''}.csv"`);
    res.send(csv);
  }));

  return { churnedCustomers, expiringPointsUserIds, dateFilter, searchRegex };
};
