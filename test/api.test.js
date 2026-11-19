'use strict';
// Testy całego serwera na tymczasowej bazie MongoDB (zestaw replik, więc działają też transakcje).
// Uruchom: npm test. Pierwsze uruchomienie pobiera MongoDB do testów (ok. 100 MB, potem z pamięci podręcznej).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const request = require('supertest');

const ADMIN_PIN = '87654321';
const PAYU_KEY = 'test-second-key';
let replSet;
let app;
let models;
let mongoose;
let adminToken;

const { warsawMinutes, minToHm } = require('../lib/time');
const admin = (r) => r.set('Authorization', `Bearer ${adminToken}`);

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URL = replSet.getUri('milkmi_test');
  process.env.ADMIN_PIN = ADMIN_PIN;
  process.env.PAYU_SECOND_KEY = PAYU_KEY;
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://www.milkshakebar.pl';
  const server = require('../server');
  app = server.app;
  await server.ready;
  mongoose = require('mongoose');
  models = require('../models');
  const login = await request(app).post('/api/admin/login').send({ pin: ADMIN_PIN });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.token;
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

async function setBreakfastUntil(hm) {
  const r = await admin(request(app).post('/api/admin/settings')).send({ location: 'slupsk', breakfastUntil: hm, pickupPrepMinutes: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const product = (name) => models.Product.findOne({ name, archived: { $ne: true } });
const order = (extra) => ({
  location: 'slupsk', customerName: 'Ania', customerPhone: '500600700', deliveryMethod: 'pickup', paymentMethod: 'cash', pickupTime: 'jak najszybciej', ...extra
});

test('karta menu wgrywa się sama, razem ze śniadaniami', async () => {
  const breakfast = await models.Product.countDocuments({ categoryId: /^sniadania/, archived: { $ne: true } });
  assert.equal(breakfast, 30);
  const toast = await product('Tost francuski');
  assert.equal(toast.price, 41);
  const granola = await product('Granola');
  assert.deepEqual(granola.variants.map((v) => [v.name, v.price]), [['Szklanka', 29], ['Miska', 45], ['Szklanka, jogurt wegański', 34], ['Miska, jogurt wegański', 54]]);
  const egg = await product('Egg-truck');
  assert.equal(egg.allowSet, true);
});

test('zamówienie z zestawem i dodatkiem: pełne szczegóły dla kuchni i klienta', async () => {
  const burger = await product('Prostak');
  const addon = burger.addons.find((a) => a.name === '2 sztuki bekonu');
  const body = order({ items: [{ productId: String(burger._id), quantity: 1, variant: 'Duży 160 g', set: { side: 'Frytki z batatów', drink: 'Lemoniada cytrusowa' }, addonIds: [addon.id] }] });
  const res = await request(app).post('/api/orders').send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);

  // Bez klucza zamówienia nie widać
  const hidden = await request(app).get(`/api/orders/${res.body.orderId}`);
  assert.equal(hidden.status, 404);

  const st = await request(app).get(`/api/orders/${res.body.orderId}?t=${res.body.token}`);
  assert.equal(st.status, 200);
  const r = st.body.data.receipt;
  assert.equal(r.items[0].basePrice, 39);
  assert.deepEqual(r.items[0].set, { side: 'Frytki z batatów', drink: 'Lemoniada cytrusowa', price: 25, setPrice: 12, sideExtra: 3, drinkPrice: 10 });
  assert.deepEqual(r.items[0].addons, [{ name: '2 sztuki bekonu', price: 5 }]);
  assert.equal(r.items[0].lineTotal, 69);
  assert.equal(r.packagingFee, 0);
  assert.equal(r.totalAmount, 69);
  assert.equal(r.payment.toPayOnPickup, 69);
  assert.equal(st.body.data.customerName, 'Ania');

  const adminView = await admin(request(app).get(`/api/admin/orders/${res.body.orderId}`));
  assert.equal(adminView.body.data.items[0].set.side, 'Frytki z batatów');
  assert.equal(adminView.body.data.statusHistory[0].status, 'pending');
});

test('zła kwota od klienta (stare ceny) jest odrzucana', async () => {
  const toast = await product('Tost francuski');
  await setBreakfastUntil('23:59');
  const res = await request(app).post('/api/orders').send(order({ items: [{ productId: String(toast._id), quantity: 1 }], totalAmount: 39 }));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'price_changed');
});

test('śniadania: odbiór po godzinie śniadań i zamówienie po tej godzinie są odrzucane', async () => {
  const now = warsawMinutes();
  if (now < 30 || now > 23 * 60) return; // test godzinowy pomijamy tuż przy północy
  const toast = await product('Tost francuski');
  const items = [{ productId: String(toast._id), quantity: 1 }];

  // Śniadania jeszcze trwają (do za 60 min): odbiór za 2 godziny jest za późno
  await setBreakfastUntil(minToHm(Math.min(now + 60, 23 * 60 + 59)));
  const late = await request(app).post('/api/orders').send(order({ items, pickupTime: minToHm(Math.min(now + 120, 23 * 60 + 59)) }));
  assert.equal(late.status, 400);
  assert.equal(late.body.code, 'breakfast');
  const ok = await request(app).post('/api/orders').send(order({ items, pickupTime: minToHm(now + 30) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  // Godzina śniadań minęła: nic ze śniadaniem
  await setBreakfastUntil(minToHm(now - 10));
  const closed = await request(app).post('/api/orders').send(order({ items }));
  assert.equal(closed.status, 400);
  assert.match(closed.body.message, /zamawiamy do/);

  // Reszta menu nadal działa
  const burger = await product('Sergio');
  const other = await request(app).post('/api/orders').send(order({ items: [{ productId: String(burger._id), quantity: 1, variant: 'Mały 85 g' }] }));
  assert.equal(other.status, 200);
  await setBreakfastUntil('13:00');
});

test('saldo MilkMi: płatność częściowa, anulowanie oddaje saldo (transakcja)', async () => {
  const reg = await request(app).post('/api/register').send({ name: 'Kasia', phone: '511222333', password: 'tajne123' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const user = reg.body.user;
  const top = await admin(request(app).post('/api/admin/wallet/modify')).send({ userId: user.id, action: 'add', amount: 50, reason: 'wpłata' });
  assert.equal(top.status, 200, JSON.stringify(top.body));
  assert.equal(top.body.walletBalance, 50);

  const burger = await product('Prostak');
  const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${reg.body.token}`)
    .send(order({ customerName: 'Kasia', customerPhone: '511222333', walletAmount: 20, items: [{ productId: String(burger._id), quantity: 1, variant: 'Mały 85 g' }], totalAmount: 33 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.walletUsed, 20);
  assert.equal(res.body.amountDue, 13);
  assert.equal((await models.User.findById(user.id)).walletBalance, 30);

  // Paragony w aplikacji
  const mine = await request(app).get('/api/me/orders').set('Authorization', `Bearer ${reg.body.token}`);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].receipt.walletUsed, 20);
  assert.equal(mine.body.data[0].receipt.payment.toPayOnPickup, 13);
  // Właściciel widzi status bez klucza z linku
  const own = await request(app).get(`/api/orders/${res.body.orderId}`).set('Authorization', `Bearer ${reg.body.token}`);
  assert.equal(own.status, 200);

  const cancel = await admin(request(app).post(`/api/admin/orders/${res.body.orderId}/status`)).send({ status: 'cancelled', reason: 'brak składnika' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal((await models.User.findById(user.id)).walletBalance, 50);
  const again = await admin(request(app).post(`/api/admin/orders/${res.body.orderId}/status`)).send({ status: 'pending' });
  assert.equal(again.status, 409); // saldo już wróciło, nie przywracamy
  const st = await request(app).get(`/api/orders/${res.body.orderId}?t=${res.body.token}`);
  assert.equal(st.body.data.cancelReason, 'brak składnika');
  const txs = await models.WalletTransaction.find({ userId: user.id }).sort({ date: 1 });
  assert.deepEqual(txs.map((t) => [t.action, t.amount]), [['add', 50], ['remove', 20], ['add', 20]]);
});

test('przyjęcie z czasem, przesunięcie i wydanie z Milkosami', async () => {
  const reg = await request(app).post('/api/register').send({ name: 'Ola', phone: '522333444', password: 'tajne123' });
  const burger = await product('Sergio');
  const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${reg.body.token}`)
    .send(order({ customerName: 'Ola', customerPhone: '522333444', items: [{ productId: String(burger._id), quantity: 2, variant: 'Duży 160 g' }] }));
  const id = res.body.orderId;
  const acc = await admin(request(app).post(`/api/admin/orders/${id}/status`)).send({ status: 'preparing', prepMinutes: 20 });
  assert.equal(acc.status, 200);
  const eta = new Date(acc.body.data.estimatedReadyAt).getTime();
  assert.ok(Math.abs(eta - (Date.now() + 20 * 60e3)) < 60e3);
  const delay = await admin(request(app).patch(`/api/admin/orders/${id}`)).send({ delayMinutes: 10, internalNote: 'dzwonić przed' });
  assert.equal(delay.status, 200);
  assert.ok(new Date(delay.body.data.estimatedReadyAt).getTime() - eta >= 9.9 * 60e3);
  assert.equal(delay.body.data.internalNote, 'dzwonić przed');
  const board = await admin(request(app).get('/api/admin/orders/board?location=slupsk'));
  assert.ok(board.body.data.active.some((o) => o._id === id));
  await admin(request(app).post(`/api/admin/orders/${id}/status`)).send({ status: 'ready' });
  const done = await admin(request(app).post(`/api/admin/orders/${id}/status`)).send({ status: 'completed' });
  assert.equal(done.body.pointsAwarded, 8); // 82 zł → 8 Milkosów
  const hist = await admin(request(app).get('/api/admin/orders?location=slupsk&status=completed&method=pickup'));
  assert.ok(hist.body.data.some((o) => o._id === id));
});

test('kasjer nie zmieni wydanego zamówienia', async () => {
  const add = await admin(request(app).post('/api/admin/staff')).send({ name: 'Bartek', pin: '482915', role: 'cashier' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const cashier = await request(app).post('/api/admin/login').send({ pin: '482915' });
  const done = await models.Order.findOne({ status: 'completed' });
  const r = await request(app).post(`/api/admin/orders/${done._id}/status`).set('Authorization', `Bearer ${cashier.body.token}`).send({ status: 'pending' });
  assert.equal(r.status, 403);
});

test('wstrzymanie zamówień z panelu blokuje zamawiarkę', async () => {
  const pause = await admin(request(app).post('/api/admin/store/quick')).send({ location: 'slupsk', pauseMinutes: 30 });
  assert.equal(pause.status, 200);
  const settings = await request(app).get('/api/settings?location=slupsk');
  assert.equal(settings.body.data.ordersEnabled, false);
  assert.equal(settings.body.data.paused, true);
  const burger = await product('Sergio');
  const res = await request(app).post('/api/orders').send(order({ items: [{ productId: String(burger._id), quantity: 1 }] }));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'closed');
  await admin(request(app).post('/api/admin/store/quick')).send({ location: 'slupsk', pauseMinutes: 0 });
  const busy = await admin(request(app).post('/api/admin/store/quick')).send({ location: 'slupsk', busyExtraMinutes: 30 });
  assert.equal(busy.body.data.pickupPrepMinutes, 30);
  await admin(request(app).post('/api/admin/store/quick')).send({ location: 'slupsk', busyExtraMinutes: 0 });
});

test('wymiana Milkosów na saldo: punkty, partie i historia razem', async () => {
  const reg = await request(app).post('/api/register').send({ name: 'Ewa', phone: '533444555', password: 'tajne123' });
  await models.User.updateOne({ _id: reg.body.user.id }, { points: 25 });
  await models.PointLot.create({ userId: reg.body.user.id, amount: 25, remaining: 25, expiresAt: new Date(Date.now() + 864e5 * 300) });
  const r = await request(app).post('/api/rewards/exchange').set('Authorization', `Bearer ${reg.body.token}`).send({ pointsCost: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.points, 5);
  assert.equal(r.body.walletBalance, 20);
  const lot = await models.PointLot.findOne({ userId: reg.body.user.id });
  assert.equal(lot.remaining, 5);
  const no = await request(app).post('/api/rewards/exchange').set('Authorization', `Bearer ${reg.body.token}`).send({ pointsCost: 10 });
  assert.equal(no.status, 400);
});

test('PayU: powiadomienie bez podpisu odrzucone, z podpisem opłaca zamówienie', async () => {
  const o = await models.Order.create({ orderNumber: 'MI-9999', status: 'awaiting_payment', totalAmount: 25, amountDue: 25, items: [], location: 'slupsk', paymentMethod: 'online' });
  const payload = JSON.stringify({ order: { extOrderId: String(o._id), status: 'COMPLETED', totalAmount: '2500', orderId: 'PAYU1' } });
  const bad = await request(app).post('/api/payu/notify').set('Content-Type', 'application/json').send(payload);
  assert.equal(bad.status, 401);
  const sig = crypto.createHash('md5').update(payload + PAYU_KEY).digest('hex');
  const good = await request(app).post('/api/payu/notify').set('Content-Type', 'application/json')
    .set('OpenPayu-Signature', `sender=checkout;signature=${sig};algorithm=MD5;content=DOCUMENT`).send(payload);
  assert.equal(good.status, 200);
  const after = await models.Order.findById(o._id);
  assert.equal(after.status, 'pending');
  assert.equal(after.statusHistory.at(-1).actor, 'PayU');
});

test('limit prób logowania do panelu jest zapisany w bazie', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await request(app).post('/api/admin/login').set('X-Forwarded-For', '203.0.113.7').send({ pin: '00000000' });
    assert.equal(r.status, 401);
  }
  const blocked = await request(app).post('/api/admin/login').set('X-Forwarded-For', '203.0.113.7').send({ pin: ADMIN_PIN });
  assert.equal(blocked.status, 429);
  const doc = await models.RateLimit.findOne({ key: 'admin:203.0.113.7' });
  assert.equal(doc.count, 5);
  // inny adres dalej może się zalogować
  const other = await request(app).post('/api/admin/login').set('X-Forwarded-For', '203.0.113.8').send({ pin: ADMIN_PIN });
  assert.equal(other.status, 200);
});

test('PIN-y pracowników: za krótki, zbyt prosty i zajęty są odrzucane', async () => {
  const short = await admin(request(app).post('/api/admin/staff')).send({ name: 'A', pin: '4821', role: 'cashier' });
  assert.equal(short.status, 400);
  const simple = await admin(request(app).post('/api/admin/staff')).send({ name: 'A', pin: '123456', role: 'cashier' });
  assert.equal(simple.status, 400);
  const same = await admin(request(app).post('/api/admin/staff')).send({ name: 'A', pin: '111111', role: 'cashier' });
  assert.equal(same.status, 400);
  const taken = await admin(request(app).post('/api/admin/staff')).send({ name: 'A', pin: '482915', role: 'cashier' });
  assert.equal(taken.status, 400);
  assert.match(taken.body.message, /zajęty/);
  // zmiana PIN-u na zajęty też odrzucona
  const add = await admin(request(app).post('/api/admin/staff')).send({ name: 'Celina', pin: '739104', role: 'cashier' });
  const change = await admin(request(app).patch(`/api/admin/staff/${add.body.data._id}/details`)).send({ pin: '482915' });
  assert.equal(change.status, 400);
});

test('upload: tylko prawdziwe zdjęcia', async () => {
  const fake = await admin(request(app).post('/api/admin/upload')).attach('image', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
  assert.equal(fake.status, 400);
  const png = Buffer.concat([Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'), Buffer.alloc(40)]);
  const ok = await admin(request(app).post('/api/admin/upload')).attach('image', png, { filename: 'a.png', contentType: 'image/png' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.imageUrl, /^\/uploads\/menu-.*\.png$/);
  fs.rmSync(path.join(__dirname, '..', ok.body.imageUrl), { force: true });
});

test('nagłówki bezpieczeństwa i CORS tylko dla naszej domeny', async () => {
  const r = await request(app).get('/api/health');
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
  const own = await request(app).get('/api/health').set('Origin', 'https://www.milkshakebar.pl');
  assert.equal(own.headers['access-control-allow-origin'], 'https://www.milkshakebar.pl');
  const bare = await request(app).get('/api/health').set('Origin', 'https://milkshakebar.pl');
  assert.equal(bare.headers['access-control-allow-origin'], 'https://milkshakebar.pl');
  const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('analityka: struktura sprzedaży i poprzedni okres', async () => {
  const r = await admin(request(app).get('/api/admin/analytics?location=slupsk'));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const mix = r.body.data.mix;
  assert.ok(mix.categories.some((c) => c.name === 'Burgery'));
  assert.ok(mix.sets.eligible >= 1);
  assert.ok(mix.sets.withSet >= 1);
  assert.ok('prevRevenue' in r.body.data.daily[0]);
});

test('transakcje są włączone na zestawie replik', async () => {
  const { transactionsSupported } = require('../lib/tx');
  assert.equal(await transactionsSupported(), true);
});
