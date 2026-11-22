'use strict';
// Serwer do podglądu bez instalowania MongoDB: tymczasowa baza w pamięci + przykładowe zamówienia.
// Uruchom: npm run dev:memory  →  http://localhost:3000/zamow, /admin (PIN 12345678), /app
// Dane znikają po zatrzymaniu. Nie używać na produkcji.
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');

(async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URL = db.getUri('milkmi_dev');
  process.env.ADMIN_PIN = process.env.ADMIN_PIN || '12345678';
  process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const { app, ready } = require('../server');
  await ready;
  const M = require('../models');

  // Tryb testowy: lokal „otwarty” całą dobę, śniadania do 23:59 i dostawa włączona,
  // żeby złożyć zamówienie o każdej porze (np. wieczorem). Wyłączysz to: DEV_REAL_HOURS=1 npm run dev:memory
  if (process.env.DEV_REAL_HOURS !== '1') {
    const day = { isOpen: true, from: '00:00', to: '23:59' };
    for (const location of ['slupsk', 'rowy']) {
      await M.LocationHours.findOneAndUpdate({ location }, { schedule: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day } }, { upsert: true });
      await M.StoreSettings.findOneAndUpdate({ location }, { breakfastUntil: '23:59', orderHoursMode: 'always', deliveryEnabled: true, pickupPrepMinutes: 5, deliveryPrepMinutes: 15 }, { upsert: true });
    }
    console.log('🕐 Tryb testowy: otwarte 00:00–23:59, śniadania do 23:59, dostawa włączona');
  }

  // Przykładowe zamówienia na tablicę w panelu
  const burger = await M.Product.findOne({ name: 'Prostak' });
  const toast = await M.Product.findOne({ name: 'Szakszuka' });
  const shake = await M.Product.findOne({ categoryId: 'shakes_klasyczne' });
  const base = { location: 'slupsk', paymentMethod: 'cash', source: 'web', pickupDay: 'today' };
  const item = (p, extra = {}) => ({ productId: String(p._id), type: 'product', name: p.name, productName: p.name, category: p.categoryId, quantity: 1, ...extra });
  const now = Date.now();
  await M.Order.create([
    { ...base, orderNumber: 'MI-0001', status: 'pending', customerName: 'Ania', customerPhone: '500 600 700', phoneNormalized: '500600700', deliveryMethod: 'pickup', pickupTime: 'jak najszybciej', notes: 'Bez cebuli, alergia na orzechy',
      items: [item(burger, { name: 'Prostak (Duży 160 g)', variant: 'Duży 160 g', basePrice: 39, set: { side: 'Krążki cebulowe', drink: 'Lemoniada cytrusowa', setPrice: 12, sideExtra: 4, drinkPrice: 10, price: 26 }, addons: [{ id: 'burger-3', name: '2 sztuki bekonu', price: 5 }], price: 70, lineTotal: 70 }),
        item(shake, { basePrice: shake.price, price: shake.price, lineTotal: shake.price, addons: [] })],
      subtotal: 70 + shake.price, packagingFee: 0, deliveryFee: 0, totalAmount: 70 + shake.price, amountDue: 70 + shake.price, createdAt: new Date(now - 4 * 60e3), statusHistory: [{ status: 'pending', at: new Date(now - 4 * 60e3), actor: 'klient' }] },
    { ...base, orderNumber: 'MI-0002', status: 'preparing', customerName: 'Tomek', customerPhone: '511 222 333', deliveryMethod: 'delivery', deliveryAddress: 'ul. Wojska Polskiego 12, m. 4, Słupsk', pickupTime: 'jak najszybciej', paymentMethod: 'online',
      items: [item(toast, { basePrice: 41, addons: [{ id: 'sn-chorizo', name: 'Chorizo 80 g', price: 8 }], price: 49, lineTotal: 49, breakfast: true })], hasBreakfast: true,
      subtotal: 49, packagingFee: 0, deliveryFee: 8, totalAmount: 57, amountDue: 57, estimatedReadyAt: new Date(now + 12 * 60e3), createdAt: new Date(now - 18 * 60e3), statusAt: { preparing: new Date(now - 10 * 60e3) } }
  ]);
  await M.Counter.updateOne({ id: 'orderNum' }, { seq: 2 }, { upsert: true });

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`🧪 Podgląd: http://localhost:${port}/zamow · panel /admin (PIN ${process.env.ADMIN_PIN})`));
  const stop = async () => { await db.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
