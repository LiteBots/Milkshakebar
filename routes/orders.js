'use strict';
// Zamówienia online: składanie (cena liczona od nowa na serwerze), status dla klienta z pełnym rozliczeniem,
// paragony w aplikacji MilkMi i obsługa w panelu (szczegóły, statusy, czas, wstrzymanie, tryb „dużo zamówień”).
const crypto = require('crypto');
const mongoose = require('mongoose');
const { priceCart } = require('../lib/pricing');
const { toGr, fromGr, round2 } = require('../lib/money');
const { isHm, hmToMin, minToHm, warsawMinutes, scheduledDate } = require('../lib/time');
const { breakfastUntil, breakfastProblem } = require('../lib/breakfast');
const { timeProblem } = require('../lib/orderWindow');
const { withTransaction, opts: txOpts } = require('../lib/tx');

const ORDER_STATUSES = ['awaiting_payment', 'pending', 'preparing', 'ready', 'completed', 'cancelled'];
const STATUS_NAMES = {
  awaiting_payment: 'czeka na płatność', pending: 'nowe', preparing: 'w przygotowaniu', ready: 'gotowe',
  completed: 'wydane', cancelled: 'anulowane'
};
const PAYMENT_NAMES = { online: 'Online (BLIK, przelew, karta)', cash: 'Gotówka', card: 'Karta', prepaid: 'Saldo w lokalu', wallet: 'Saldo MilkMi' };
const LOCATIONS = {
  slupsk: { name: 'Milkshakebar Słupsk', address: 'ul. Szczecińska 17, Słupsk' },
  rowy: { name: 'Milkshakebar Rowy', address: 'ul. Wydmowa 2, Rowy' }
};

// Pełne rozliczenie zamówienia: to samo widzi klient (status, paragon w MilkMi) i obsługa.
// Zamówienia sprzed tej wersji nie mają rozbicia na zestaw i dodatki: wtedy pokazujemy opis pozycji.
function receipt(o) {
  const items = (o.items || []).map((i) => {
    const quantity = Number(i.quantity) || 1;
    const price = round2(i.price);
    return {
      name: i.name, productName: i.productName || i.name, variant: i.variant || null, quantity,
      basePrice: i.basePrice !== undefined ? round2(i.basePrice) : null,
      set: i.set && i.set.side ? {
        side: i.set.side, drink: i.set.drink || '',
        price: i.set.price !== undefined ? round2(i.set.price) : null,
        setPrice: i.set.setPrice !== undefined ? round2(i.set.setPrice) : null,
        sideExtra: i.set.sideExtra !== undefined ? round2(i.set.sideExtra) : null,
        drinkPrice: i.set.drinkPrice !== undefined ? round2(i.set.drinkPrice) : null
      } : null,
      addons: Array.isArray(i.addons) ? i.addons.map((a) => ({ name: a.name, price: round2(a.price) })) : [],
      desc: i.desc || '', category: i.category || null, breakfast: Boolean(i.breakfast),
      price, lineTotal: i.lineTotal !== undefined ? round2(i.lineTotal) : fromGr(toGr(price) * quantity)
    };
  });
  const walletUsed = round2(o.walletUsed || 0);
  const total = round2(o.totalAmount);
  const amountDue = o.amountDue !== undefined && o.amountDue !== null ? round2(o.amountDue) : fromGr(toGr(total) - toGr(walletUsed));
  const method = o.paymentMethod || 'cash';
  // Czy klient ma jeszcze coś do zapłaty przy odbiorze
  const paidOnline = method === 'online' && !['awaiting_payment', 'cancelled'].includes(o.status);
  const settled = amountDue === 0 || paidOnline || o.status === 'completed';
  return {
    items,
    subtotal: round2(o.subtotal),
    packagingFee: round2(o.packagingFee || 0),
    deliveryFee: round2(o.deliveryFee || 0),
    totalAmount: total,
    walletUsed,
    amountDue,
    paymentMethod: method,
    paymentLabel: PAYMENT_NAMES[method] || method,
    payment: {
      paidOnline,
      toPayOnPickup: settled ? 0 : amountDue,
      status: o.status === 'cancelled' ? 'anulowane'
        : o.status === 'awaiting_payment' ? 'czeka na płatność online'
          : amountDue === 0 ? 'opłacone saldem MilkMi'
            : paidOnline ? 'opłacone online'
              : o.status === 'completed' ? 'opłacone przy odbiorze'
                : `do zapłaty przy ${o.deliveryMethod === 'delivery' ? 'dostawie' : 'odbiorze'}`
    }
  };
}

function publicOrder(o, { withPersonal = false } = {}) {
  const loc = LOCATIONS[o.location] || LOCATIONS.slupsk;
  return {
    _id: o._id, orderNumber: o.orderNumber, status: o.status, statusName: STATUS_NAMES[o.status] || o.status,
    createdAt: o.createdAt, statusAt: o.statusAt || {}, estimatedReadyAt: o.estimatedReadyAt || null,
    deliveryMethod: o.deliveryMethod, pickupTime: o.pickupTime, pickupDay: o.pickupDay, scheduledFor: o.scheduledFor || null,
    location: o.location, venue: loc, cancelReason: o.status === 'cancelled' ? (o.cancelReason || '') : '',
    pointsAwarded: o.pointsAwarded > 0 ? o.pointsAwarded : 0, hasBreakfast: Boolean(o.hasBreakfast),
    // Zgodność ze starszą zamawiarką
    items: o.items, totalAmount: o.totalAmount, subtotal: o.subtotal, packagingFee: o.packagingFee, deliveryFee: o.deliveryFee,
    paymentMethod: o.paymentMethod, walletUsed: o.walletUsed || 0, amountDue: o.amountDue,
    receipt: receipt(o),
    ...(withPersonal ? {
      customerName: o.customerName, customerPhone: o.customerPhone,
      deliveryAddress: o.deliveryMethod === 'delivery' ? o.deliveryAddress : '', notes: o.notes || ''
    } : {})
  };
}

module.exports = function registerOrderRoutes(app, { models, helpers, config }) {
  const { Order, User, Product, Counter, WalletTransaction, StoreSettings } = models;
  const {
    asyncRoute, requireAdmin, requireUser, optionalUser, audit, normalizePhone, pushHistory, userDisplay,
    storeSettingsFor, effectiveSettings, orderWindowFor, upsellFor, createPayuOrder, refundOrderWallet, grantPurchasePoints,
    notifyUser, notifyPhone, quietly, analytics, verifyUserToken
  } = helpers;
  const { ORDER_CONFIG, APP_URL } = config;
  const loyalty = () => config.loyalty();
  const locationOf = (v) => (v === 'rowy' ? 'rowy' : 'slupsk');
  const setConfig = { categories: ORDER_CONFIG.setCategories, sides: ORDER_CONFIG.setSides, drinks: ORDER_CONFIG.setDrinks };

  async function priceOrder(body, location, settings) {
    const raw = Array.isArray(body.items) ? body.items : [];
    const ids = raw.filter((i) => i && i.type !== 'upsell' && mongoose.isValidObjectId(i.productId)).map((i) => i.productId);
    const products = new Map((await Product.find({ _id: { $in: ids } })).map((p) => [String(p._id), p]));
    return priceCart({ rawItems: raw, deliveryMethod: body.deliveryMethod, products, upsell: await upsellFor(location), settings, setConfig });
  }

  const notifyCustomer = (order, payload) => quietly(order.userId
    ? notifyUser(order.userId, { url: '/app', ...payload })
    : notifyPhone(order.phoneNormalized, { url: '/app', ...payload }));

  // ===================== Klient: złożenie zamówienia =====================
  app.post('/api/orders', optionalUser, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const location = locationOf(body.location);
    const settings = effectiveSettings(await storeSettingsFor(location));
    if (!settings.ordersEnabled) {
      return res.status(403).json({ success: false, code: 'closed', message: settings.closedMessage || 'Lokal jest w tej chwili zamknięty na zamówienia online.' });
    }
    const isDelivery = body.deliveryMethod === 'delivery';
    if (isDelivery && !settings.deliveryEnabled) return res.status(403).json({ success: false, code: 'closed', message: 'Dostawa jest chwilowo niedostępna.' });
    if (!isDelivery && !settings.pickupEnabled) return res.status(403).json({ success: false, code: 'closed', message: 'Odbiór osobisty jest chwilowo niedostępny.' });
    const methodFlag = { online: 'payOnline', cash: 'payCash', card: 'payCard' }[body.paymentMethod];
    const walletCoversAll = Number(body.walletAmount) > 0 && Number(body.walletAmount) >= Number(body.totalAmount);
    if (methodFlag && !settings[methodFlag] && !walletCoversAll) {
      return res.status(400).json({ success: false, code: 'payment', message: 'Ta metoda płatności jest chwilowo wyłączona. Wybierz inną.' });
    }
    if (Number(body.walletAmount) > 0 && !settings.payWallet) {
      return res.status(400).json({ success: false, code: 'payment', message: 'Płatność saldem MilkMi jest chwilowo wyłączona.' });
    }
    if (!String(body.customerName || '').trim() || normalizePhone(body.customerPhone).length < 9) {
      return res.status(400).json({ success: false, message: 'Podaj imię i poprawny numer telefonu.' });
    }
    if (isDelivery && String(body.deliveryAddress || '').trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Podaj adres dostawy.' });
    }
    const user = req.user && !req.user.blocked ? req.user : null;

    // Ponowne wysłanie tego samego zamówienia (np. przy słabym zasięgu) nie tworzy duplikatu
    if (body.clientOrderId) {
      const existing = await Order.findOne({ clientOrderId: String(body.clientOrderId) }).sort({ createdAt: -1 });
      if (existing && existing.status !== 'awaiting_payment' && existing.status !== 'cancelled') {
        return res.json({ success: true, orderId: existing._id, orderNumber: existing.orderNumber, token: existing.viewToken, walletUsed: existing.walletUsed || 0, message: 'Zamówienie zostało przyjęte!' });
      }
      if (existing && existing.status === 'awaiting_payment') {
        const old = await Order.findOneAndUpdate({ _id: existing._id, status: 'awaiting_payment' }, { status: 'cancelled', 'statusAt.cancelled': new Date(), cancelReason: 'Ponowiona płatność' }, { new: true });
        if (old) await refundOrderWallet(old, 'Zwrot: ponowiona płatność');
      }
    }

    let priced;
    try {
      priced = await priceOrder(body, location, settings);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message, code: err.code });
    }

    // Termin: „jak najszybciej” albo godzina dziś. Śniadania tylko do ustawionej godziny (domyślnie 13:00).
    const pickupDay = body.pickupDay === 'tomorrow' ? 'tomorrow' : 'today';
    const rawTime = String(body.pickupTime || 'jak najszybciej').trim();
    const asap = !isHm(rawTime);
    const nowMin = warsawMinutes();
    const prep = isDelivery ? Number(settings.deliveryPrepMinutes) || 0 : Number(settings.pickupPrepMinutes) || 0;
    const readyMin = asap ? nowMin + prep : hmToMin(rawTime);
    if (!asap && pickupDay === 'today' && readyMin < nowMin - 5) {
      return res.status(400).json({ success: false, code: 'time', message: 'Ta godzina już minęła. Wybierz późniejszą.' });
    }
    // Godziny zamówień online z panelu: do której można zamawiać i na którą najpóźniej
    if (pickupDay === 'today') {
      const win = await orderWindowFor(location, settings);
      const problem = timeProblem(win, { mode: isDelivery ? 'delivery' : 'pickup', asap, readyMin });
      if (problem) return res.status(400).json({ success: false, code: win.accepting ? 'time' : 'closed', message: problem });
    }
    if (priced.hasBreakfast) {
      const until = breakfastUntil(settings);
      const problem = pickupDay === 'tomorrow'
        ? (readyMin > hmToMin(until) ? `Śniadania wydajemy do ${until}. Wybierz wcześniejszą godzinę.` : null)
        : breakfastProblem({ until, nowMin, readyMin });
      if (problem) return res.status(400).json({ success: false, code: 'breakfast', message: problem });
    }

    if (body.totalAmount !== undefined && toGr(body.totalAmount) !== toGr(priced.totalAmount)) {
      console.warn(`⚠️ Różnica ceny zamówienia: klient ${body.totalAmount}, serwer ${priced.totalAmount}`);
      return res.status(409).json({ success: false, code: 'price_changed', message: `Ceny w menu się zmieniły. Aktualna kwota to ${priced.totalAmount.toFixed(2)} zł. Odśwież stronę i złóż zamówienie ponownie.` });
    }

    // Płatność saldem vPLN (tylko zalogowany klient)
    const walletWanted = round2(Number(body.walletAmount) || 0);
    if (walletWanted < 0) return res.status(400).json({ success: false, message: 'Nieprawidłowa kwota z portfela.' });
    if (walletWanted > 0 && !user) return res.status(401).json({ success: false, message: 'Zaloguj się kontem MilkMi, żeby zapłacić saldem.' });
    const walletUsed = fromGr(Math.min(toGr(walletWanted), toGr(priced.totalAmount)));
    const amountDue = fromGr(toGr(priced.totalAmount) - toGr(walletUsed));

    const counter = await Counter.findOneAndUpdate({ id: 'orderNum' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    const orderNumber = `MI-${String(((counter.seq - 1) % 9999) + 1).padStart(4, '0')}`;
    let paymentMethod = ['cash', 'card', 'online', 'prepaid'].includes(body.paymentMethod) ? body.paymentMethod : 'cash';
    if (amountDue === 0 && walletUsed > 0) paymentMethod = 'wallet';
    const isOnlinePayment = paymentMethod === 'online' && amountDue > 0;
    const status = isOnlinePayment ? 'awaiting_payment' : 'pending';
    const now = new Date();

    // Saldo, historia portfela i zamówienie zapisują się razem albo wcale (transakcja)
    let newOrder;
    try {
      newOrder = await withTransaction(async (session) => {
        if (walletUsed > 0) {
          const paid = await User.findOneAndUpdate(
            { _id: user._id, walletBalance: { $gte: walletUsed } },
            { $inc: { walletBalance: -walletUsed }, $push: pushHistory(`- ${walletUsed.toFixed(2)} PLN • Zamówienie online ${orderNumber}`) },
            txOpts(session, { new: true })
          );
          if (!paid) throw Object.assign(new Error('Saldo vPLN jest niższe niż wybrana kwota. Odśwież stronę.'), { status: 409, code: 'wallet_low' });
          await WalletTransaction.create([{ userId: user._id, userDisplay: userDisplay(user), amount: walletUsed, action: 'remove', reason: `Zamówienie online ${orderNumber}`, actor: 'klient' }], txOpts(session));
        }
        const [created] = await Order.create([{
          orderNumber,
          clientOrderId: body.clientOrderId ? String(body.clientOrderId) : undefined,
          customerName: String(body.customerName).trim().slice(0, 80),
          customerPhone: String(body.customerPhone || '').trim().slice(0, 20),
          phoneNormalized: normalizePhone(body.customerPhone),
          customerEmail: body.customerEmail ? String(body.customerEmail).slice(0, 120) : undefined,
          pickupTime: asap ? 'jak najszybciej' : rawTime,
          pickupDay,
          scheduledFor: asap ? undefined : (scheduledDate(pickupDay, rawTime) || undefined),
          estimatedReadyAt: new Date(now.getTime() + Math.max(0, readyMin - nowMin) * 60e3),
          userId: user ? user._id : undefined,
          walletUsed,
          amountDue,
          notes: String(body.notes || '').slice(0, 500),
          deliveryMethod: isDelivery ? 'delivery' : 'pickup',
          deliveryAddress: isDelivery ? String(body.deliveryAddress || '').slice(0, 200) : '',
          paymentMethod,
          source: ['web', 'app'].includes(body.source) ? body.source : 'web',
          location,
          items: priced.items, subtotal: priced.subtotal, packagingFee: priced.packagingFee, deliveryFee: priced.deliveryFee, totalAmount: priced.totalAmount,
          hasBreakfast: priced.hasBreakfast,
          viewToken: crypto.randomBytes(12).toString('hex'),
          status,
          statusAt: status === 'pending' ? { pending: now } : {},
          statusHistory: [{ status, at: now, actor: 'klient' }]
        }], txOpts(session));
        return created;
      });
    } catch (err) {
      if (err.code === 'wallet_low') return res.status(409).json({ success: false, code: 'wallet_low', message: err.message });
      throw err;
    }

    const result = { success: true, orderId: newOrder._id, orderNumber, token: newOrder.viewToken, walletUsed, amountDue };
    if (!isOnlinePayment) return res.json({ ...result, message: 'Zamówienie zostało przyjęte!' });

    try {
      const products = walletUsed > 0
        ? [{ name: `Zamówienie ${orderNumber} (po odjęciu ${walletUsed.toFixed(2)} zł z portfela MilkMi)`, unitPrice: String(toGr(amountDue)), quantity: '1' }]
        : [
          ...newOrder.items.map((i) => ({ name: i.name, unitPrice: String(toGr(i.price)), quantity: String(i.quantity) })),
          ...(newOrder.packagingFee ? [{ name: 'Opakowania', unitPrice: String(toGr(newOrder.packagingFee)), quantity: '1' }] : []),
          ...(newOrder.deliveryFee ? [{ name: 'Dostawa', unitPrice: String(toGr(newOrder.deliveryFee)), quantity: '1' }] : [])
        ];
      const payu = await createPayuOrder({
        description: `Zamówienie ${orderNumber}`, amount: amountDue, extOrderId: String(newOrder._id),
        buyer: { email: body.customerEmail || 'brak@email.pl', phone: newOrder.customerPhone, firstName: newOrder.customerName },
        products, continueUrl: `${APP_URL}/zamow?zamowienie=${newOrder._id}&t=${newOrder.viewToken}`, customerIp: req.ip
      });
      if (payu.payuOrderId) await Order.updateOne({ _id: newOrder._id }, { payuOrderId: payu.payuOrderId });
      res.json({ ...result, redirectUrl: payu.redirectUrl, message: 'Przekierowanie do płatności...' });
    } catch (err) {
      // Bramka nie działa: anuluj zamówienie i oddaj saldo
      const cancelled = await Order.findOneAndUpdate({ _id: newOrder._id, status: 'awaiting_payment' }, { status: 'cancelled', 'statusAt.cancelled': new Date(), cancelReason: 'Płatność online niedostępna' }, { new: true });
      if (cancelled) await refundOrderWallet(cancelled, 'Zwrot: płatność online niedostępna');
      throw err;
    }
  }));

  // ===================== Klient: status zamówienia =====================
  // Link z zamawiarki zawiera token (?t=...). Zalogowany właściciel zamówienia widzi je też bez tokenu.
  // Zamówienia sprzed tej wersji (bez tokenu) działają po samym numerze, ale bez danych osobowych.
  app.get('/api/orders/:id', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
    const auth = String(req.headers.authorization || '');
    const payload = auth.startsWith('Bearer ') ? verifyUserToken(auth.slice(7)) : null;
    const owner = Boolean(payload && order.userId && String(order.userId) === String(payload.userId));
    const tokenOk = Boolean(order.viewToken) && String(req.query.t || '') === order.viewToken;
    if (order.viewToken && !tokenOk && !owner) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
    res.json({ success: true, data: publicOrder(order, { withPersonal: tokenOk || owner }) });
  }));

  // ===================== Klient: paragony w MilkMi =====================
  const myOrdersFilter = (user) => ({
    $or: [{ userId: user._id }, ...(user.phoneNormalized ? [{ phoneNormalized: user.phoneNormalized }] : [])],
    status: { $ne: 'awaiting_payment' }
  });
  app.get('/api/me/orders', requireUser, asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const orders = await Order.find(myOrdersFilter(req.user)).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, data: orders.map((o) => publicOrder(o, { withPersonal: true })) });
  }));
  app.get('/api/me/orders/:id', requireUser, asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
    const order = await Order.findOne({ _id: req.params.id, ...myOrdersFilter(req.user) });
    if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
    res.json({ success: true, data: publicOrder(order, { withPersonal: true }) });
  }));

  // ===================== Panel: lista i szczegóły =====================
  const adminOrder = (o) => ({ ...o.toObject(), receipt: receipt(o), statusName: STATUS_NAMES[o.status] || o.status });

  app.get('/api/admin/orders/pending', requireAdmin(), asyncRoute(async (req, res) => {
    const location = locationOf(req.query.location);
    const orders = await Order.find({ status: 'pending', location }).sort({ createdAt: 1 });
    res.json({ success: true, data: orders.map(adminOrder) });
  }));

  app.get('/api/admin/orders', requireAdmin(), asyncRoute(async (req, res) => {
    const location = locationOf(req.query.location);
    const limit = Math.min(Number(req.query.limit) || 300, 2000);
    const filter = { location, ...analytics.dateFilter('createdAt', req.query.from, req.query.to) };
    const q = analytics.searchRegex(req.query.q);
    if (q) filter.$or = [{ customerName: q }, { customerPhone: q }, { orderNumber: q }, { deliveryAddress: q }];
    const statuses = String(req.query.status || '').split(',').filter((s) => ORDER_STATUSES.includes(s));
    if (statuses.length) filter.status = { $in: statuses };
    if (['pickup', 'delivery'].includes(req.query.method)) filter.deliveryMethod = req.query.method;
    if (['online', 'cash', 'card', 'wallet', 'prepaid'].includes(req.query.payment)) filter.paymentMethod = req.query.payment;
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, data: orders.map(adminOrder) });
  }));

  // Tablica na żywo: zamówienia w toku + podsumowanie dnia
  app.get('/api/admin/orders/board', requireAdmin(), asyncRoute(async (req, res) => {
    const location = locationOf(req.query.location);
    const nowD = new Date();
    nowD.setSeconds(0, 0);
    const dayStart = new Date(nowD.getTime() - warsawMinutes(nowD) * 60e3); // północ w Polsce
    const [active, today, settings] = await Promise.all([
      Order.find({ location, status: { $in: ['pending', 'preparing', 'ready'] } }).sort({ createdAt: 1 }),
      Order.aggregate([
        { $match: { location, createdAt: { $gte: dayStart } } },
        { $group: { _id: '$status', n: { $sum: 1 }, s: { $sum: '$totalAmount' } } }
      ]),
      storeSettingsFor(location)
    ]);
    const by = Object.fromEntries(today.map((t) => [t._id, t]));
    const sum = (keys, f) => keys.reduce((s, k) => s + ((by[k] && by[k][f]) || 0), 0);
    const live = effectiveSettings(settings);
    res.json({
      success: true,
      data: {
        active: active.map(adminOrder),
        today: {
          orders: sum(['pending', 'preparing', 'ready', 'completed'], 'n'),
          revenue: round2(sum(['pending', 'preparing', 'ready', 'completed'], 's')),
          completed: sum(['completed'], 'n'), cancelled: sum(['cancelled'], 'n'), awaitingPayment: sum(['awaiting_payment'], 'n')
        },
        store: {
          ordersEnabled: settings.ordersEnabled, paused: live.paused, pausedUntil: live.paused ? settings.pausedUntil : null,
          busyExtraMinutes: live.busyExtraMinutes, busyUntil: live.busyExtraMinutes ? settings.busyUntil : null,
          pickupPrepMinutes: live.pickupPrepMinutes, deliveryPrepMinutes: live.deliveryPrepMinutes,
          breakfastUntil: breakfastUntil(settings),
          window: await orderWindowFor(location, live)
        }
      }
    });
  }));

  app.get('/api/admin/orders/:id', requireAdmin(), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    const previous = order.phoneNormalized ? await Order.countDocuments({ phoneNormalized: order.phoneNormalized, status: 'completed', _id: { $ne: order._id } }) : 0;
    res.json({ success: true, data: { ...adminOrder(order), customerOrdersBefore: previous } });
  }));

  // Zamówienie zrealizowane → Milkosy dla klienta z kontem (raz na zamówienie), od kwoty zapłaconej pieniędzmi.
  async function awardOrderPoints(order, req) {
    if (order.pointsAwarded) return 0;
    const paid = round2(Number(order.totalAmount) - Number(order.walletUsed || 0));
    if (Math.floor(paid / loyalty().zlotyPerPoint) <= 0) return 0;
    let user = null;
    if (order.userId) user = await User.findOne({ _id: order.userId, blocked: { $ne: true } });
    else if (order.phoneNormalized) {
      const users = await User.find({ phoneNormalized: order.phoneNormalized, blocked: { $ne: true } });
      if (users.length === 1) user = users[0];
    }
    if (!user) return 0;
    const claimed = await Order.findOneAndUpdate({ _id: order._id, pointsAwarded: { $in: [0, null] } }, { pointsAwarded: -1 });
    if (!claimed) return 0;
    const r = await grantPurchasePoints(user, paid, {
      source: 'zamowienie', label: `Zamówienie ${order.orderNumber}`, orderId: String(order._id), location: order.location,
      actor: req.admin ? req.admin.name : 'system', at: order.createdAt
    });
    await Order.updateOne({ _id: order._id }, { pointsAwarded: r.points });
    return r.points;
  }

  // Zmiana statusu. Przy przyjęciu można podać czas przygotowania (min), przy anulowaniu powód (widzi go klient).
  // Zamówienia wydanego albo anulowanego kasjer już nie zmienia; manager może (np. pomyłka), co trafia do dziennika.
  app.post('/api/admin/orders/:id/status', requireAdmin(), asyncRoute(async (req, res) => {
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status) || status === 'awaiting_payment') return res.status(400).json({ success: false, message: 'Nieznany status.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    const before = await Order.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    if (before.status === status) return res.json({ success: true, message: 'Bez zmian', data: adminOrder(before) });
    const finished = ['completed', 'cancelled'].includes(before.status);
    if (finished && req.admin.role === 'cashier') {
      return res.status(403).json({ success: false, message: `Zamówienie jest już ${STATUS_NAMES[before.status]}. Zmienić je może manager.` });
    }
    if (before.status === 'cancelled' && before.walletRefunded) {
      return res.status(409).json({ success: false, message: 'Saldo za to zamówienie już wróciło do klienta. Przyjmij nowe zamówienie zamiast przywracać anulowane.' });
    }
    if (before.status === 'awaiting_payment' && status !== 'cancelled') {
      return res.status(409).json({ success: false, message: 'To zamówienie czeka na płatność online. Można je tylko anulować.' });
    }
    const now = new Date();
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    const prepMinutes = Math.floor(Number(req.body && req.body.prepMinutes));
    const update = {
      status, [`statusAt.${status}`]: now,
      $push: { statusHistory: { status, at: now, actor: req.admin.name, note: reason || (prepMinutes > 0 ? `${prepMinutes} min` : '') } }
    };
    if (status === 'preparing' && prepMinutes > 0 && prepMinutes <= 240) update.estimatedReadyAt = new Date(now.getTime() + prepMinutes * 60e3);
    if (status === 'cancelled') update.cancelReason = reason;
    const order = await Order.findOneAndUpdate({ _id: before._id, status: before.status }, update, { new: true });
    if (!order) return res.status(409).json({ success: false, message: 'Ktoś właśnie zmienił to zamówienie. Odśwież listę.' });

    let points = 0;
    if (status === 'completed') points = await awardOrderPoints(order, req);
    if (status === 'cancelled') await refundOrderWallet(order, 'Zwrot za anulowane zamówienie');
    await audit(req, 'status zamówienia', order.orderNumber, `${before.status} → ${status}${reason ? ` (${reason})` : ''}${points ? `, +${points} pkt` : ''}`);

    const readyAt = order.estimatedReadyAt ? minToHm(warsawMinutes(order.estimatedReadyAt)) : null;
    const messages = {
      preparing: { title: `Zamówienie ${order.orderNumber} przyjęte`, body: readyAt ? `Przygotowujemy. ${order.deliveryMethod === 'delivery' ? 'Wyjazd' : 'Gotowe'} około ${readyAt}.` : 'Właśnie je przygotowujemy.' },
      ready: order.deliveryMethod === 'delivery'
        ? { title: `Zamówienie ${order.orderNumber} jedzie do Ciebie`, body: 'Kierowca jest w drodze.' }
        : { title: `Zamówienie ${order.orderNumber} gotowe`, body: 'Możesz je odebrać w lokalu.' },
      cancelled: { title: `Zamówienie ${order.orderNumber} anulowane`, body: reason ? `Powód: ${reason}. ${order.walletUsed ? 'Saldo MilkMi wróciło na konto.' : ''}`.trim() : 'W razie pytań zadzwoń do lokalu.' },
      completed: points ? { title: `+${points} Milkosów`, body: `Za zamówienie ${order.orderNumber}. Smacznego!` } : null
    };
    if (messages[status]) notifyCustomer(order, messages[status]);
    res.json({ success: true, message: 'Status zaktualizowany', pointsAwarded: points, data: adminOrder(await Order.findById(order._id)) });
  }));

  // Notatka obsługi i przesunięcie czasu (klient dostaje powiadomienie o nowej godzinie)
  app.patch('/api/admin/orders/:id', requireAdmin(), asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
    const b = req.body || {};
    const update = {};
    const notes = [];
    if (b.internalNote !== undefined) { update.internalNote = String(b.internalNote).slice(0, 500); notes.push('notatka'); }
    const delay = Math.floor(Number(b.delayMinutes));
    if (delay && Math.abs(delay) <= 180 && !['completed', 'cancelled'].includes(order.status)) {
      const base = order.estimatedReadyAt && order.estimatedReadyAt > new Date() ? order.estimatedReadyAt : new Date();
      update.estimatedReadyAt = new Date(base.getTime() + delay * 60e3);
      update.$push = { statusHistory: { status: order.status, at: new Date(), actor: req.admin.name, note: `czas ${delay > 0 ? '+' : ''}${delay} min` } };
      notes.push(`czas ${delay > 0 ? '+' : ''}${delay} min`);
    }
    if (!notes.length) return res.status(400).json({ success: false, message: 'Brak zmian.' });
    const updated = await Order.findByIdAndUpdate(order._id, update, { new: true });
    await audit(req, 'zmiana zamówienia', order.orderNumber, notes.join(', '));
    if (update.estimatedReadyAt && delay > 0) {
      notifyCustomer(updated, { title: `Zamówienie ${updated.orderNumber}: nowa godzina`, body: `Mamy więcej zamówień. Będzie gotowe około ${minToHm(warsawMinutes(updated.estimatedReadyAt))}. Przepraszamy!` });
    }
    res.json({ success: true, data: adminOrder(updated) });
  }));

  // Szybkie przełączniki z tablicy zamówień: wstrzymanie na X minut i tryb „dużo zamówień” (+X min do czasu)
  app.post('/api/admin/store/quick', requireAdmin(), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const location = locationOf(b.location);
    const now = Date.now();
    const update = { updatedAt: new Date() };
    const log = [];
    if (b.pauseMinutes !== undefined) {
      const m = Math.floor(Number(b.pauseMinutes));
      if (!(m >= 0 && m <= 480)) return res.status(400).json({ success: false, message: 'Wstrzymanie: od 0 do 480 minut.' });
      update.pausedUntil = m > 0 ? new Date(now + m * 60e3) : null;
      log.push(m > 0 ? `wstrzymanie na ${m} min` : 'wznowienie zamówień');
    }
    if (b.busyExtraMinutes !== undefined) {
      const extra = Math.floor(Number(b.busyExtraMinutes));
      const forMin = Math.floor(Number(b.busyForMinutes) || 120);
      if (!(extra >= 0 && extra <= 120) || !(forMin > 0 && forMin <= 600)) return res.status(400).json({ success: false, message: 'Dodatkowy czas: od 0 do 120 minut.' });
      update.busyExtraMinutes = extra;
      update.busyUntil = extra > 0 ? new Date(now + forMin * 60e3) : null;
      log.push(extra > 0 ? `+${extra} min do czasu przez ${forMin} min` : 'koniec trybu „dużo zamówień”');
    }
    if (!log.length) return res.status(400).json({ success: false, message: 'Brak zmian.' });
    await StoreSettings.findOneAndUpdate({ location }, update, { upsert: true });
    await audit(req, 'zamawiarka: szybka zmiana', location, log.join(', '));
    const live = effectiveSettings(await storeSettingsFor(location));
    res.json({ success: true, message: log.join(', '), data: { paused: live.paused, busyExtraMinutes: live.busyExtraMinutes, pickupPrepMinutes: live.pickupPrepMinutes, deliveryPrepMinutes: live.deliveryPrepMinutes } });
  }));
};

module.exports.receipt = receipt;
module.exports.publicOrder = publicOrder;
