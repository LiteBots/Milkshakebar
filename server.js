require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const webpush = require('web-push');
// Drukowana karta menu: pozycje, ceny, zestawy (import w panelu: Menu → „Wczytaj kartę”)
const KARTA = require('./data/menu-karta.json');

const STARTED_AT = new Date();
const VERSION = '3.1.0';

const app = express();
app.set('trust proxy', 1); // Railway stoi za proxy: req.ip ma być adresem klienta

// --- MIDDLEWARE ---
// rawBody jest potrzebny do sprawdzenia podpisu powiadomień PayU
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Strony i pliki publiczne leżą w /public, więc kod serwera i konfiguracja nie są dostępne z przeglądarki.
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// HTML zawsze sprawdzany z serwerem, żeby klienci od razu dostawali nową wersję aplikacji
const staticOptions = {
  // Bez przekierowania folderu na adres ze „/”: /zamow to strona, a /zamow/ to jej pliki
  redirect: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
};
// Jeden adres zamawiarki bez polskich znaków (lepszy do linków i Google). Stare adresy przekierowują.
// Także nazwy z „ó” zapisanym jako „o” + akcent (tak zapisuje je macOS) — dawniej plik nazywał się zamów.html
app.get(['/zamów', '/zam%C3%B3w', '/zamów.html', '/zam%C3%B3w.html', '/zamow.html', '/zamo%CC%81w', '/zamo%CC%81w.html'], (req, res) => {
  const q = req.originalUrl.indexOf('?');
  res.redirect(301, `/zamow${q >= 0 ? req.originalUrl.slice(q) : ''}`);
});
// Podstrony SEO, strona główna z danymi strukturalnymi, sitemap.xml i robots.txt
require('./seo')(app, {
  APP_URL: process.env.APP_URL || 'https://www.milkshakebar.pl', PUBLIC_DIR,
  asyncRoute: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  models: () => ({ Product, LocationHours, Mission, StoreSettings }),
  program: () => program, loyalty: () => loyalty, orderConfig: () => ORDER_CONFIG
});
app.use(express.static(PUBLIC_DIR, staticOptions));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `menu-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${IMAGE_TYPES[file.mimetype]}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype]))
});

// --- TRASY FRONTENDU ---
const sendPage = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, file));
};
app.get('/app', sendPage('app.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/zamow', sendPage('zamow.html')); // nazwa pliku bez polskich znaków: działa tak samo na Macu i na serwerze
app.get('/menu', sendPage('menu.html'));

// --- BAZA DANYCH ---
const MONGO_URI = process.env.MONGO_URL || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/milkmi_db';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000, maxPoolSize: 50 })
  .then(() => console.log('✅ Połączono z bazą MongoDB'))
  .catch((err) => console.error('❌ Błąd połączenia z bazą danych:', err.message));

// Numer telefonu w jednym formacie: 9 cyfr bez +48, spacji i myślników.
// Po nim kasa szuka klienta przy nabijaniu Milkosów.
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0048')) digits = digits.slice(4);
  if (digits.length === 11 && digits.startsWith('48')) digits = digits.slice(2);
  return digits;
}

const historySlice = { $each: [], $position: 0, $slice: 20 };
const historyEntry = (text) => ({ text, date: new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }) });
const pushHistory = (...texts) => ({ history: { ...historySlice, $each: texts.map(historyEntry) } });

// --- MODELE ---
// E-mail jest opcjonalny (unikalny tylko, gdy podany; indeks tworzony przy starcie).
// username to unikalny login; dla nowych kont generowany z imienia, a imię trzymamy w polu name.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, required: true, trim: true },
  phoneNormalized: { type: String, index: true },
  password: { type: String, required: true },
  points: { type: Number, default: 0 },
  walletBalance: { type: Number, default: 0 },
  redeemedPoints: { type: Number, default: 0 },
  activeRewards: [{ rewardId: String, name: String, cost: Number, dateClaimed: { type: Date, default: Date.now } }],
  history: [{ text: String, date: { type: String, default: () => new Date().toLocaleString('pl-PL') } }],
  blocked: { type: Boolean, default: false },
  lastSeenAt: Date,
  // Urodziny: prezent raz w roku (data ustawiana raz, potem zmienia ją tylko obsługa)
  birthday: { month: Number, day: Number },
  birthdaySetAt: Date,
  lastBirthdayYear: Number,
  // Polecenia: własny kod i kto nas polecił
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: mongoose.Schema.Types.ObjectId,
  referralRewarded: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
userSchema.pre('save', function (next) {
  if (this.isModified('phone')) this.phoneNormalized = normalizePhone(this.phone);
  next();
});
const User = mongoose.model('User', userSchema);

const pointTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  userDisplay: String,
  amountSpent: Number,
  pointsAwarded: Number,
  bonusPoints: { type: Number, default: 0 }, // ile z tego to premia (poziom, happy hour)
  note: String,
  source: { type: String, default: 'kasa' }, // kasa, zamowienie, korekta, polecenie, misja, urodziny, wygasniecie
  orderId: String,
  location: String,
  actor: String,
  reverted: { type: Boolean, default: false },
  date: { type: Date, default: Date.now }
});
const PointTransaction = mongoose.model('PointTransaction', pointTransactionSchema);

const walletTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  userDisplay: String,
  amount: Number,
  action: String, // 'add' (wpłata) lub 'remove' (pobranie)
  reason: String,
  actor: String,
  date: { type: Date, default: Date.now }
});
const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

const reservationSchema = new mongoose.Schema({
  name: String,
  phone: String,
  phoneNormalized: { type: String, index: true },
  userId: mongoose.Schema.Types.ObjectId,
  datetime: String,
  guests: Number,
  zone: String,
  notes: String,
  location: { type: String, default: 'slupsk' },
  source: { type: String, default: 'web' }, // web (strona) lub app (MilkMi)
  status: { type: String, default: 'pending' }, // pending, accepted, rejected, cancelled
  createdAt: { type: Date, default: Date.now }
});
const Reservation = mongoose.model('Reservation', reservationSchema);

const Counter = mongoose.model('Counter', new mongoose.Schema({
  id: { type: String, required: true },
  seq: { type: Number, default: 0 }
}));

const orderSchema = new mongoose.Schema({
  orderNumber: String,
  clientOrderId: { type: String, index: true },
  customerName: String,
  customerPhone: String,
  phoneNormalized: { type: String, index: true },
  customerEmail: String,
  pickupTime: String,
  pickupDay: { type: String, default: 'today' }, // today albo tomorrow (zamówienie na jutro)
  scheduledFor: Date,
  userId: { type: mongoose.Schema.Types.ObjectId, index: true }, // klient zalogowany kontem MilkMi
  walletUsed: { type: Number, default: 0 }, // ile zapłacono saldem vPLN
  walletRefunded: { type: Boolean, default: false },
  amountDue: Number, // do zapłaty po odjęciu salda
  notes: String,
  items: Array,
  subtotal: Number,
  packagingFee: Number,
  deliveryFee: Number,
  totalAmount: Number,
  paymentMethod: String,
  deliveryMethod: { type: String, default: 'pickup' },
  deliveryAddress: { type: String, default: '' },
  location: { type: String, default: 'slupsk' },
  source: String,
  status: { type: String, default: 'pending' },
  payuOrderId: String,
  pointsAwarded: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

const Banner = mongoose.model('Banner', new mongoose.Schema({
  target: { type: String, required: true, unique: true }, // 'app' lub 'web'
  isActive: { type: Boolean, default: false },
  text: { type: String, default: '' },
  backgroundColor: { type: String, default: '#FF6600' },
  updatedAt: { type: Date, default: Date.now }
}));

const CategoryBanner = mongoose.model('CategoryBanner', new mongoose.Schema({
  categoryId: { type: String, required: true, unique: true },
  imageUrl: { type: String, required: true },
  location: { type: String, default: 'slupsk' },
  updatedAt: { type: Date, default: Date.now }
}));

const UpsellConfig = mongoose.model('UpsellConfig', new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  items: [{ id: String, name: String, price: Number, img: String }],
  updatedAt: { type: Date, default: Date.now }
}));

// Ustawienia zamawiarki dla lokalu: wszystko, co widać na karcie lokalu, zmienia się w panelu
const StoreSettings = mongoose.model('StoreSettings', new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  ordersEnabled: { type: Boolean, default: true },
  pickupEnabled: { type: Boolean, default: true },
  deliveryEnabled: { type: Boolean, default: false },
  deliveryFee: Number, // zł
  freeDeliveryThreshold: Number, // zł, 0 = bez darmowej dostawy
  minOrderDelivery: Number, // zł, minimum przy dostawie
  packagingFee: Number, // zł, raz na zamówienie
  mealSetPrice: Number, // zł, dopłata do zestawu
  pickupPrepMinutes: Number,
  deliveryPrepMinutes: Number,
  payOnline: Boolean, payCash: Boolean, payCard: Boolean, payWallet: Boolean,
  closedMessage: String,
  coverUrl: String,
  updatedAt: { type: Date, default: Date.now }
}));

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number },
  imageUrl: { type: String, required: true },
  categoryId: { type: String, required: true },
  location: { type: String, default: 'slupsk' },
  hasVariants: { type: Boolean, default: false },
  variants: [{ name: { type: String }, price: { type: Number } }],
  allowSet: { type: Boolean, default: false },
  addons: [{ id: { type: String }, name: { type: String }, price: { type: Number } }],
  isBestseller: { type: Boolean, default: false },
  isAvailable: { type: Boolean, default: true },
  pickupOnly: { type: Boolean, default: false }, // np. shake, lody: nie jadą w dostawie
  isNewItem: { type: Boolean, default: false }, // „nowość” na karcie (isNew jest zarezerwowane w Mongoose)
  isVege: { type: Boolean, default: false },
  spicy: { type: Number, default: 0 }, // 0 łagodne, 1 ostre, 2 bardzo ostre
  archived: { type: Boolean, default: false }, // zniknęło z karty: ukryte w menu, widoczne w panelu
  sortOrder: { type: Number }, // kolejność z drukowanej karty
  createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', productSchema);

const LocationHours = mongoose.model('LocationHours', new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  schedule: {
    mon: { isOpen: Boolean, from: String, to: String },
    tue: { isOpen: Boolean, from: String, to: String },
    wed: { isOpen: Boolean, from: String, to: String },
    thu: { isOpen: Boolean, from: String, to: String },
    fri: { isOpen: Boolean, from: String, to: String },
    sat: { isOpen: Boolean, from: String, to: String },
    sun: { isOpen: Boolean, from: String, to: String }
  },
  updatedAt: { type: Date, default: Date.now }
}));

// Konta pracowników panelu (właściciel loguje się PIN-em z ADMIN_PIN)
const StaffMember = mongoose.model('StaffMember', new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  pinHash: { type: String, required: true },
  role: { type: String, enum: ['cashier', 'manager', 'owner'], default: 'cashier' }, // uprawnienia w panelu
  position: { type: String, default: 'Bar' }, // stanowisko: Bar, Kuchnia, Szef Kuchni, Manager, Właściciel
  hourlyRate: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}));

// Czas pracy: zmiana rozpoczęta i zakończona w panelu
const Shift = mongoose.model('Shift', new mongoose.Schema({
  staffId: { type: String, index: true },
  staffName: String,
  start: { type: Date, required: true, index: true },
  end: Date,
  bonus: { type: Number, default: 0 },
  note: String
}));

// Magazyn: stany artykułów z minimalnym poziomem
const StockItem = mongoose.model('StockItem', new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, default: 'Inne' },
  unit: { type: String, default: 'szt.' },
  qty: { type: Number, default: 0 },
  minQty: { type: Number, default: 0 },
  location: { type: String, default: 'slupsk' },
  updatedAt: { type: Date, default: Date.now }
}));

// Powiadomienia push (aplikacja MilkMi na telefonie)
const PushSubscription = mongoose.model('PushSubscription', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  userAgent: String,
  createdAt: { type: Date, default: Date.now }
}));
const PushCampaign = mongoose.model('PushCampaign', new mongoose.Schema({
  title: String, body: String, url: String, audience: String,
  sent: Number, failed: Number, actor: String,
  at: { type: Date, default: Date.now }
}));

// Newsletter: zapis ze zgodą ze strony
const Subscriber = mongoose.model('Subscriber', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  consentAt: { type: Date, default: Date.now },
  source: { type: String, default: 'web' },
  active: { type: Boolean, default: true }
}));

// Odsłony stron liczone bez ciasteczek: dzień + strona
const PageView = mongoose.model('PageView', new mongoose.Schema({
  day: { type: String, index: true },
  page: String,
  count: { type: Number, default: 0 }
}));

const AuditLog = mongoose.model('AuditLog', new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  actor: String,
  role: String,
  action: String,
  target: String,
  details: String
}));

// Ustawienia aplikacji trzymane w bazie (klucz podpisu tokenów, zasady programu lojalnościowego)
const AppConfig = mongoose.model('AppConfig', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed
}));

// Partie Milkosów: każde nabicie ma datę ważności. Wydawanie zdejmuje najpierw najstarsze.
const PointLot = mongoose.model('PointLot', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  amount: Number,
  remaining: Number,
  earnedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, index: true },
  source: String,
  warned: { type: Boolean, default: false },
  expired: { type: Boolean, default: false }
}));

// Misje i odznaki ustawiane w panelu
const Mission = mongoose.model('Mission', new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🏅' },
  type: { type: String, enum: ['visits', 'spend', 'orders', 'product'], default: 'visits' },
  target: { type: Number, default: 1 },
  productQuery: { type: String, default: '' }, // dla typu "product": fragment nazwy, np. "shake"
  periodDays: { type: Number, default: 0 }, // 0 = bez limitu czasu (liczone od startu misji)
  rewardPoints: { type: Number, default: 0 },
  rewardVpln: { type: Number, default: 0 },
  badge: { type: String, default: '' }, // nazwa odznaki
  active: { type: Boolean, default: true },
  startsAt: { type: Date, default: Date.now },
  endsAt: Date,
  createdAt: { type: Date, default: Date.now }
}));
const missionCompletionSchema = new mongoose.Schema({
  missionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  title: String, icon: String, badge: String,
  rewardPoints: Number, rewardVpln: Number,
  at: { type: Date, default: Date.now }
});
missionCompletionSchema.index({ missionId: 1, userId: 1 }, { unique: true });
const MissionCompletion = mongoose.model('MissionCompletion', missionCompletionSchema);

// Karty podarunkowe: kupione online (PayU) albo sprzedane w kasie
const GiftCard = mongoose.model('GiftCard', new mongoose.Schema({
  code: { type: String, unique: true, sparse: true },
  amount: Number,
  balance: Number,
  status: { type: String, enum: ['awaiting_payment', 'active', 'used', 'cancelled'], default: 'awaiting_payment' },
  source: { type: String, default: 'online' }, // online albo lokal
  buyerName: String, buyerEmail: String, buyerPhone: String,
  recipientName: String, message: String,
  viewToken: String,
  payuOrderId: String,
  paidAt: Date,
  expiresAt: Date,
  redeemedBy: mongoose.Schema.Types.ObjectId,
  redeemedAt: Date,
  history: [{ at: { type: Date, default: Date.now }, action: String, amount: Number, actor: String }],
  createdAt: { type: Date, default: Date.now }
}));

// --- KONFIGURACJA ---
const ADMIN_PIN = process.env.ADMIN_PIN;
// Klucz, którym stara wersja podpisywała tokeny (był wpisany w kod). Służy tylko do jednorazowej wymiany starego logowania na nowe.
const LEGACY_JWT_SECRET = 'super_tajny_klucz_zmien_go_w_produkcji';
const LEGACY_SESSIONS_UNTIL = new Date(process.env.LEGACY_SESSIONS_UNTIL || '2027-02-01T00:00:00Z');
const USER_TOKEN_TTL = '180d';
const ADMIN_TOKEN_TTL = '14h';

const DEFAULT_LOYALTY = { zlotyPerPoint: 10, vplnPerPoint: 1, exchangeOptions: [10, 20, 50, 100, 200, 500] };

const ORDER_CONFIG = {
  packagingFee: 0, // karta: „opłata za opakowanie jest wliczona w cenę produktu”
  mealSetPrice: KARTA.zestaw.cenaPodstawowa,
  deliveryFee: 8,
  freeDeliveryThreshold: 80,
  // Karta: zestaw do kanapki, burgera, hot-doga i burrito
  setCategories: ['burgery', 'kanapki', 'hotdogi', 'mexico_burrito', 'lunch_kanapki'],
  setSides: KARTA.zestaw.dodatki, // [{ name, extra }]: dopłata ponad cenę zestawu
  setDrinks: KARTA.zestaw.napoje // [{ name, price }]
};
const DEFAULT_UPSELL = [
  { id: 'u1', name: 'Coca-Cola 0.5l', price: 7.00, img: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=200&q=80' },
  { id: 'u2', name: 'Frytki Duże', price: 10.00, img: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?auto=format&fit=crop&w=200&q=80' },
  { id: 'u3', name: 'Sos Czosnkowy', price: 3.00, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=200&q=80' }
];

const PAYU_POS_ID = process.env.PAYU_POS_ID;
const PAYU_CLIENT_ID = process.env.PAYU_CLIENT_ID;
const PAYU_CLIENT_SECRET = process.env.PAYU_CLIENT_SECRET;
const PAYU_SECOND_KEY = process.env.PAYU_SECOND_KEY;
const PAYU_BASE_URL = process.env.PAYU_ENV === 'secure' ? 'https://secure.payu.com' : 'https://secure.snd.payu.com';
const APP_URL = process.env.APP_URL || 'https://www.milkshakebar.pl';

// Program MilkMi: poziomy, polecenia, urodziny, ważność, happy hours, dane firmy do regulaminu
const DEFAULT_PROGRAM = {
  tiers: {
    enabled: true,
    windowMonths: 12, // poziom liczony z wydatków z ostatnich 12 miesięcy
    levels: [
      { key: 'bronze', name: 'Bronze', minSpent: 0, multiplier: 1 },
      { key: 'silver', name: 'Silver', minSpent: 600, multiplier: 1.25 },
      { key: 'gold', name: 'Gold', minSpent: 1500, multiplier: 1.5 }
    ]
  },
  referral: { enabled: true, referrerPoints: 20, refereePoints: 20, minSpent: 20 },
  birthday: { enabled: true, vpln: 10, points: 0 },
  expiry: { enabled: true, months: 12, warnDays: 30 },
  happyHours: [], // { id, name, days: [1..7], from, to, multiplier, location: all|slupsk|rowy, active }
  company: { name: '', address: '', nip: '', email: '' }
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function mergeProgram(saved = {}) {
  const d = clone(DEFAULT_PROGRAM);
  return {
    tiers: { ...d.tiers, ...(saved.tiers || {}), levels: Array.isArray(saved.tiers && saved.tiers.levels) && saved.tiers.levels.length ? saved.tiers.levels : d.tiers.levels },
    referral: { ...d.referral, ...(saved.referral || {}) },
    birthday: { ...d.birthday, ...(saved.birthday || {}) },
    expiry: { ...d.expiry, ...(saved.expiry || {}) },
    happyHours: Array.isArray(saved.happyHours) ? saved.happyHours : [],
    company: { ...d.company, ...(saved.company || {}) }
  };
}
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(months || 0));
  return d;
}

let jwtSecret = process.env.JWT_SECRET || null;
let loyalty = { ...DEFAULT_LOYALTY };
let program = clone(DEFAULT_PROGRAM);
let vapid = null;

// Przy starcie: klucz podpisu tokenów (tworzony raz i zapisywany w bazie, jeśli nie ma JWT_SECRET),
// zasady programu lojalnościowego i uzupełnienie znormalizowanych telefonów.
const ready = (async () => {
  await mongoose.connection.asPromise();
  if (!jwtSecret) {
    const generated = crypto.randomBytes(48).toString('hex');
    const doc = await AppConfig.findOneAndUpdate(
      { key: 'jwtSecret' }, { $setOnInsert: { value: generated } }, { upsert: true, new: true }
    );
    jwtSecret = doc.value;
  }
  const saved = await AppConfig.findOne({ key: 'loyalty' });
  if (saved && saved.value) loyalty = { ...DEFAULT_LOYALTY, ...saved.value };
  const savedProgram = await AppConfig.findOne({ key: 'program' });
  if (savedProgram && savedProgram.value) program = mergeProgram(savedProgram.value);

  // Ważność Milkosów: punkty zebrane przed wprowadzeniem zasady dostają pełny okres od dziś
  const lotsDone = await AppConfig.findOne({ key: 'pointLotsMigrated' });
  if (!lotsDone) {
    const withPoints = await User.find({ points: { $gt: 0 } }, 'points').lean();
    const now = new Date();
    if (withPoints.length) {
      await PointLot.insertMany(withPoints.map((u) => ({
        userId: u._id, amount: u.points, remaining: u.points, earnedAt: now, expiresAt: addMonths(now, program.expiry.months || 12), source: 'start'
      })));
    }
    await AppConfig.create({ key: 'pointLotsMigrated', value: now });
    if (withPoints.length) console.log(`⏳ Ważność Milkosów: ${withPoints.length} kont dostało datę ważności`);
  }

  // Klucze powiadomień push: tworzone raz i trzymane w bazie
  const vapidDoc = await AppConfig.findOneAndUpdate(
    { key: 'vapid' }, { $setOnInsert: { value: webpush.generateVAPIDKeys() } }, { upsert: true, new: true }
  );
  vapid = vapidDoc.value;
  webpush.setVapidDetails(APP_URL, vapid.publicKey, vapid.privateKey);

  // E-mail przestaje być wymagany: unikalny indeks tylko dla kont, które go mają
  const indexes = await User.collection.indexes().catch(() => []);
  const oldEmail = indexes.find((i) => i.key && i.key.email === 1 && !i.partialFilterExpression);
  if (oldEmail) await User.collection.dropIndex(oldEmail.name);
  await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_unique_if_set', partialFilterExpression: { email: { $type: 'string' } } });

  const missing = await User.find({ $or: [{ phoneNormalized: { $exists: false } }, { phoneNormalized: null }] }, 'phone').lean();
  if (missing.length) {
    await User.bulkWrite(missing.map((u) => ({
      updateOne: { filter: { _id: u._id }, update: { $set: { phoneNormalized: normalizePhone(u.phone) } } }
    })));
    console.log(`📱 Ujednolicono numery telefonów: ${missing.length} kont`);
  }

  // Drukowana karta menu: wgrywana sama po wdrożeniu nowej wersji pliku data/menu-karta.json
  await autoImportKarta().catch((err) => console.error('❌ Import karty menu:', err.message));
})().catch((err) => console.error('❌ Błąd przygotowania serwera:', err.message));

// Zapytania czekają, aż klucz podpisu będzie gotowy
app.use('/api', async (req, res, next) => {
  if (jwtSecret) return next();
  try { await ready; } catch (e) { /* obsłużone wyżej */ }
  if (!jwtSecret) return res.status(503).json({ success: false, message: 'Serwer się uruchamia. Spróbuj za chwilę.' });
  next();
});

// --- POMOCNICZE ---
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isPositiveNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const userDisplay = (user) => `${user.name || user.username} (${user.phone})`;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Wysyłka powiadomień. Wygasłe subskrypcje (telefon odinstalował aplikację) są usuwane.
async function sendPush(subscriptions, payload) {
  if (!vapid || !subscriptions.length) return { sent: 0, failed: 0 };
  const body = JSON.stringify({ icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', url: '/app', ...payload });
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < subscriptions.length; i += 50) {
    const batch = subscriptions.slice(i, i + 50);
    const results = await Promise.allSettled(batch.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 60 * 60 * 24 })));
    const dead = [];
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') sent += 1;
      else {
        failed += 1;
        if ([404, 410].includes(r.reason && r.reason.statusCode)) dead.push(batch[idx].endpoint);
      }
    });
    if (dead.length) await PushSubscription.deleteMany({ endpoint: { $in: dead } });
  }
  return { sent, failed };
}
async function notifyUser(userId, payload) {
  if (!userId) return;
  await sendPush(await PushSubscription.find({ userId }), payload);
}
async function notifyPhone(phoneNormalized, payload) {
  if (!phoneNormalized) return;
  const users = await User.find({ phoneNormalized }, '_id');
  if (users.length === 1) await notifyUser(users[0]._id, payload);
}
const quietly = (promise) => promise.catch((e) => console.error('Powiadomienie push nie wysłane:', e.message));

function publicUser(user) {
  return {
    id: user._id,
    name: user.name || user.username,
    username: user.username,
    email: user.email,
    phone: user.phone,
    points: user.points,
    walletBalance: user.walletBalance || 0,
    redeemedPoints: user.redeemedPoints || 0,
    activeRewards: user.activeRewards || [],
    referralCode: user.referralCode || null,
    birthday: user.birthday && user.birthday.month ? { month: user.birthday.month, day: user.birthday.day } : null,
    createdAt: user.createdAt
  };
}

// ==========================================
// --- SILNIK PROGRAMU MILKMI ---
// ==========================================
// Data i godzina w Polsce (serwer na Railway działa w UTC)
function warsawParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday],
    hm: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour)
  };
}

// Happy hour aktywna w danej chwili i lokalu (najwyższy mnożnik wygrywa)
function activeHappyHour(location, at = new Date()) {
  const p = warsawParts(at);
  const matching = (program.happyHours || []).filter((h) => h.active !== false
    && Array.isArray(h.days) && h.days.map(Number).includes(p.wd)
    && h.from <= p.hm && p.hm < h.to
    && (!h.location || h.location === 'all' || h.location === location));
  return matching.sort((a, b) => Number(b.multiplier) - Number(a.multiplier))[0] || null;
}

// Wydatki klienta z okresu liczenia poziomu (kasa i zamówienia online, bez cofniętych)
async function spentInWindow(userId) {
  const since = addMonths(new Date(), -(program.tiers.windowMonths || 12));
  const agg = await PointTransaction.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)), source: { $in: ['kasa', 'zamowienie'] }, reverted: { $ne: true }, date: { $gte: since } } },
    { $group: { _id: null, s: { $sum: '$amountSpent' } } }
  ]);
  return round2((agg[0] && agg[0].s) || 0);
}
function tierFor(spent) {
  const levels = [...(program.tiers.levels || [])].sort((a, b) => a.minSpent - b.minSpent);
  let current = levels[0] || null;
  for (const l of levels) if (spent >= l.minSpent) current = l;
  const next = levels.find((l) => l.minSpent > spent) || null;
  return { current, next, spent, toNext: next ? round2(next.minSpent - spent) : 0 };
}
async function tierOf(userId) {
  if (!program.tiers.enabled) return null;
  return tierFor(await spentInWindow(userId));
}

async function addLot(userId, amount, source) {
  if (!(amount > 0)) return;
  const now = new Date();
  await PointLot.create({ userId, amount, remaining: amount, earnedAt: now, expiresAt: addMonths(now, program.expiry.months || 12), source });
}
// Zdejmuje punkty z najstarszych partii (te wygasają najwcześniej)
async function consumeLots(userId, amount) {
  let left = Math.floor(amount);
  if (left <= 0) return;
  const lots = await PointLot.find({ userId, remaining: { $gt: 0 } }).sort({ expiresAt: 1 });
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    const r = await PointLot.updateOne({ _id: lot._id, remaining: { $gte: take } }, { $inc: { remaining: -take } });
    if (r.modifiedCount) left -= take;
  }
}

// Punkty bez zakupu: polecenia, misje, urodziny, prezent od lokalu
async function grantBonusPoints(userId, points, label, source, actor = 'system') {
  if (!(points > 0)) return null;
  const user = await User.findByIdAndUpdate(userId, { $inc: { points }, $push: pushHistory(`+ ${points} pkt • ${label}`) }, { new: true });
  if (!user) return null;
  await addLot(user._id, points, source);
  await PointTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amountSpent: 0, pointsAwarded: points, source, note: label, actor });
  return user;
}
async function grantWallet(userId, amount, reason, actor = 'system') {
  amount = round2(amount);
  if (!(amount > 0)) return null;
  const user = await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount }, $push: pushHistory(`+ ${amount.toFixed(2)} PLN • ${reason}`) }, { new: true });
  if (!user) return null;
  await WalletTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amount, action: 'add', reason, actor });
  return user;
}

// Zakupy (kasa albo zamówienie online): Milkosy z mnożnikiem poziomu i happy hour,
// potem polecenie, misje i ewentualny awans.
async function grantPurchasePoints(user, amountSpent, { source, label, orderId, location = 'slupsk', actor = 'system', at = new Date() }) {
  const base = Math.floor(amountSpent / loyalty.zlotyPerPoint);
  if (base <= 0) return { points: 0, base: 0 };
  const tierBefore = await tierOf(user._id);
  const tierMult = tierBefore && tierBefore.current ? Number(tierBefore.current.multiplier) || 1 : 1;
  const hh = activeHappyHour(location, at);
  const hhMult = hh ? Number(hh.multiplier) || 1 : 1;
  const multiplier = round2(tierMult * hhMult);
  const points = Math.floor(base * multiplier);
  const notes = [
    tierMult > 1 ? `poziom ${tierBefore.current.name} ×${tierMult}` : '',
    hh ? `${hh.name || 'Happy hour'} ×${hhMult}` : ''
  ].filter(Boolean).join(', ');

  const updated = await User.findByIdAndUpdate(user._id, {
    $inc: { points }, $push: pushHistory(`+ ${points} pkt • ${label}${notes ? ` (${notes})` : ''}`)
  }, { new: true });
  await addLot(user._id, points, source);
  const tx = await PointTransaction.create({
    userId: user._id, userDisplay: userDisplay(user), amountSpent, pointsAwarded: points, bonusPoints: points - base,
    note: notes, source, orderId, location, actor
  });

  const extras = { missions: [], referral: false, tierUp: null };
  // Awans na wyższy poziom
  if (tierBefore) {
    const after = tierFor(round2(tierBefore.spent + amountSpent));
    if (after.current && tierBefore.current && after.current.key !== tierBefore.current.key && after.current.minSpent > tierBefore.current.minSpent) {
      extras.tierUp = after.current;
      quietly(notifyUser(user._id, { title: `Awans: poziom ${after.current.name}! 🎉`, body: `Od teraz dostajesz ${after.current.multiplier}× więcej Milkosów.`, url: '/app' }));
    }
  }
  // Polecenie: pierwsze zakupy poleconej osoby
  if (program.referral.enabled && updated.referredBy && !updated.referralRewarded && amountSpent >= (program.referral.minSpent || 0)) {
    const claimed = await User.findOneAndUpdate({ _id: user._id, referralRewarded: { $ne: true } }, { referralRewarded: true });
    if (claimed) {
      extras.referral = true;
      await grantBonusPoints(user._id, program.referral.refereePoints, 'Bonus na start z polecenia', 'polecenie');
      const referrer = await grantBonusPoints(updated.referredBy, program.referral.referrerPoints, `Polecenie: ${updated.name || updated.username} zrobił(a) pierwsze zakupy`, 'polecenie');
      if (referrer) quietly(notifyUser(referrer._id, { title: `+${program.referral.referrerPoints} Milkosów za polecenie`, body: `${updated.name || 'Twój znajomy'} zrobił(a) pierwsze zakupy. Dzięki!`, url: '/app' }));
    }
  }
  extras.missions = await evaluateMissions(user._id);
  const fresh = await User.findById(user._id);
  return { points, base, bonus: points - base, multiplier, notes, tx, user: fresh || updated, extras };
}

// --- Misje ---
function missionWindowStart(m) {
  const start = m.startsAt ? new Date(m.startsAt) : new Date(0);
  if (m.periodDays > 0) {
    const rolling = new Date(Date.now() - m.periodDays * 864e5);
    return rolling > start ? rolling : start;
  }
  return start;
}
const normText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
async function missionProgress(user, m) {
  const since = missionWindowStart(m);
  if (m.type === 'product') {
    const q = normText(m.productQuery);
    if (!q) return 0;
    const orders = await Order.find({ $or: [{ userId: user._id }, { phoneNormalized: user.phoneNormalized }], status: 'completed', createdAt: { $gte: since } }, 'items');
    return orders.reduce((s, o) => s + (o.items || []).filter((i) => normText(i.name).includes(q)).reduce((n, i) => n + (Number(i.quantity) || 1), 0), 0);
  }
  const sources = m.type === 'orders' ? ['zamowienie'] : ['kasa', 'zamowienie'];
  const agg = await PointTransaction.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(user._id)), source: { $in: sources }, reverted: { $ne: true }, date: { $gte: since } } },
    { $group: { _id: null, count: { $sum: 1 }, spent: { $sum: '$amountSpent' } } }
  ]);
  const a = agg[0] || { count: 0, spent: 0 };
  return m.type === 'spend' ? round2(a.spent) : a.count;
}
const liveMissionsFilter = () => ({ active: true, startsAt: { $lte: new Date() }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: new Date() } }] });
async function evaluateMissions(userId) {
  const user = await User.findById(userId);
  if (!user) return [];
  const [missions, done] = await Promise.all([Mission.find(liveMissionsFilter()), MissionCompletion.find({ userId }, 'missionId')]);
  const doneIds = new Set(done.map((d) => String(d.missionId)));
  const completed = [];
  for (const m of missions) {
    if (doneIds.has(String(m._id))) continue;
    if ((await missionProgress(user, m)) < m.target) continue;
    try {
      await MissionCompletion.create({ missionId: m._id, userId, title: m.title, icon: m.icon, badge: m.badge, rewardPoints: m.rewardPoints, rewardVpln: m.rewardVpln });
    } catch (e) { continue; } // już zaliczona równolegle
    if (m.rewardPoints > 0) await grantBonusPoints(userId, m.rewardPoints, `Misja: ${m.title}`, 'misja');
    if (m.rewardVpln > 0) await grantWallet(userId, m.rewardVpln, `Misja: ${m.title}`);
    const reward = [m.rewardPoints > 0 ? `+${m.rewardPoints} Milkosów` : '', m.rewardVpln > 0 ? `+${round2(m.rewardVpln).toFixed(2)} zł vPLN` : ''].filter(Boolean).join(' i ');
    quietly(notifyUser(userId, { title: `${m.icon || '🏅'} Misja zaliczona: ${m.title}`, body: [m.badge ? `Odznaka „${m.badge}”` : '', reward].filter(Boolean).join('. ') || 'Gratulacje!', url: '/app' }));
    completed.push({ id: m._id, title: m.title, icon: m.icon, badge: m.badge, rewardPoints: m.rewardPoints, rewardVpln: m.rewardVpln });
  }
  return completed;
}

// --- Kod polecenia ---
async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  const base = normText(user.name || user.username).replace(/[^a-z]/g, '').toUpperCase().slice(0, 5) || 'MILK';
  for (let i = 0; i < 20; i += 1) {
    const code = `${base}${crypto.randomInt(100, 1000)}`;
    const r = await User.updateOne({ _id: user._id, referralCode: { $exists: false } }, { referralCode: code }).catch(() => ({ modifiedCount: 0 }));
    if (r.modifiedCount) { user.referralCode = code; return code; }
    const again = await User.findById(user._id, 'referralCode');
    if (again && again.referralCode) { user.referralCode = again.referralCode; return again.referralCode; }
  }
  return null;
}

// --- Zadania cykliczne: wygasanie Milkosów, przypomnienia, urodziny, nieopłacone zamówienia ---
async function runExpiry(now = new Date()) {
  if (!program.expiry.enabled) return { expired: 0, warned: 0 };
  let expired = 0;
  let warned = 0;
  const due = await PointLot.aggregate([
    { $match: { remaining: { $gt: 0 }, expiresAt: { $lte: now } } },
    { $group: { _id: '$userId', amount: { $sum: '$remaining' }, ids: { $push: '$_id' } } }
  ]);
  for (const g of due) {
    await PointLot.updateMany({ _id: { $in: g.ids } }, { remaining: 0, expired: true });
    const u = await User.findById(g._id, 'points name username phone');
    const take = u ? Math.min(g.amount, u.points) : 0;
    if (take <= 0) continue;
    const upd = await User.findOneAndUpdate({ _id: u._id, points: { $gte: take } }, { $inc: { points: -take }, $push: pushHistory(`- ${take} pkt • Milkosy wygasły po ${program.expiry.months} mies.`) }, { new: true });
    if (!upd) continue;
    expired += take;
    await PointTransaction.create({ userId: u._id, userDisplay: userDisplay(u), amountSpent: 0, pointsAwarded: -take, source: 'wygasniecie', actor: 'system' });
    quietly(notifyUser(u._id, { title: `${take} Milkosów wygasło`, body: 'Zbieraj dalej i wymieniaj na vPLN na bieżąco.', url: '/app' }));
  }
  const warnUntil = new Date(now.getTime() + (program.expiry.warnDays || 30) * 864e5);
  const soon = await PointLot.aggregate([
    { $match: { remaining: { $gt: 0 }, warned: { $ne: true }, expiresAt: { $gt: now, $lte: warnUntil } } },
    { $group: { _id: '$userId', amount: { $sum: '$remaining' }, first: { $min: '$expiresAt' }, ids: { $push: '$_id' } } }
  ]);
  for (const g of soon) {
    await PointLot.updateMany({ _id: { $in: g.ids } }, { warned: true });
    warned += 1;
    const date = new Date(g.first).toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' });
    quietly(notifyUser(g._id, { title: `${g.amount} Milkosów wygaśnie ${date}`, body: 'Wymień je w aplikacji na saldo vPLN, zanim przepadną.', url: '/app' }));
  }
  return { expired, warned };
}

async function runBirthdays(now = new Date()) {
  if (!program.birthday.enabled) return 0;
  const p = warsawParts(now);
  if (p.hour < 8) return 0; // życzenia rano, nie w nocy
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [{ 'birthday.month': p.m, 'birthday.day': p.d }];
  if (p.m === 2 && p.d === 28 && !isLeap(p.y)) days.push({ 'birthday.month': 2, 'birthday.day': 29 });
  const users = await User.find({ $or: days, lastBirthdayYear: { $ne: p.y }, birthdaySetAt: { $lte: new Date(now.getTime() - 30 * 864e5) }, blocked: { $ne: true } }, '_id name username');
  let count = 0;
  for (const u of users) {
    const claimed = await User.findOneAndUpdate({ _id: u._id, lastBirthdayYear: { $ne: p.y } }, { lastBirthdayYear: p.y });
    if (!claimed) continue;
    count += 1;
    if (program.birthday.vpln > 0) await grantWallet(u._id, program.birthday.vpln, 'Prezent urodzinowy 🎂');
    if (program.birthday.points > 0) await grantBonusPoints(u._id, program.birthday.points, 'Prezent urodzinowy 🎂', 'urodziny');
    const gift = [program.birthday.vpln > 0 ? `${round2(program.birthday.vpln).toFixed(2)} zł vPLN` : '', program.birthday.points > 0 ? `${program.birthday.points} Milkosów` : ''].filter(Boolean).join(' i ');
    quietly(notifyUser(u._id, { title: `Wszystkiego najlepszego, ${u.name || u.username}! 🎂`, body: gift ? `Mamy dla Ciebie prezent: ${gift}. Wpadnij do nas!` : 'Wpadnij do nas świętować!', url: '/app' }));
  }
  return count;
}

// Zamówienie nieopłacone przez PayU w ciągu 2 godzin: anuluj i oddaj saldo vPLN
async function runStaleOrders(now = new Date()) {
  const stale = await Order.find({ status: 'awaiting_payment', createdAt: { $lte: new Date(now.getTime() - 2 * 3600e3) } });
  for (const o of stale) {
    const claimed = await Order.findOneAndUpdate({ _id: o._id, status: 'awaiting_payment' }, { status: 'cancelled' }, { new: true });
    if (claimed) await refundOrderWallet(claimed, 'Zwrot: zamówienie nieopłacone');
  }
  return stale.length;
}

async function refundOrderWallet(order, reason) {
  if (!(order.walletUsed > 0) || !order.userId) return 0;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, walletRefunded: { $ne: true } }, { walletRefunded: true });
  if (!claimed) return 0;
  await grantWallet(order.userId, order.walletUsed, `${reason} ${order.orderNumber}`);
  return order.walletUsed;
}

async function runScheduledJobs() {
  try {
    await runExpiry();
    await runBirthdays();
    await runStaleOrders();
  } catch (e) { console.error('Zadania cykliczne:', e.message); }
}

const signUserToken = (user) => jwt.sign({ userId: String(user._id), username: user.username, typ: 'user' }, jwtSecret, { expiresIn: USER_TOKEN_TTL });

// Proste ograniczenie prób logowania (na adres IP i klucz)
const attempts = new Map();
function tooManyAttempts(key, limit, windowMs) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > windowMs) return false;
  return entry.count >= limit;
}
function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > 15 * 60 * 1000) attempts.set(key, { first: now, count: 1 });
  else entry.count += 1;
}
const clearFailures = (key) => attempts.delete(key);

async function audit(req, action, target, details) {
  try {
    await AuditLog.create({
      actor: req.admin ? req.admin.name : 'system', role: req.admin ? req.admin.role : '',
      action, target: target || '', details: details || ''
    });
  } catch (e) { console.error('Błąd zapisu dziennika:', e.message); }
}

// --- AUTORYZACJA KLIENTA ---
const requireUser = asyncRoute(async (req, res, next) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ success: false, ok: false, message: 'Zaloguj się ponownie.' });
  let payload;
  try { payload = jwt.verify(token, jwtSecret); } catch (e) {
    return res.status(401).json({ success: false, ok: false, message: 'Sesja wygasła. Zaloguj się ponownie.' });
  }
  if (payload.typ !== 'user') return res.status(401).json({ success: false, ok: false, message: 'Zaloguj się ponownie.' });
  const user = await User.findById(payload.userId);
  if (!user) return res.status(404).json({ success: false, ok: false, message: 'Konto nie istnieje.' });
  if (user.blocked) return res.status(403).json({ success: false, ok: false, message: 'Konto jest zablokowane. Skontaktuj się z lokalem.' });
  req.user = user;
  next();
});

// Jeśli klient jest zalogowany, przypisz go (np. do rezerwacji); jeśli nie, przejdź dalej
const optionalUser = asyncRoute(async (req, res, next) => {
  const token = bearer(req);
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.typ === 'user') req.user = await User.findById(payload.userId);
    } catch (e) { /* bez logowania */ }
  }
  next();
});

// --- AUTORYZACJA PANELU ---
const ROLE_LEVEL = { cashier: 1, manager: 2, owner: 3 };
const requireAdmin = (minRole = 'cashier') => (req, res, next) => {
  const token = bearer(req);
  let payload = null;
  try { payload = token ? jwt.verify(token, jwtSecret) : null; } catch (e) { payload = null; }
  if (!payload || payload.typ !== 'admin') {
    return res.status(401).json({ success: false, message: 'Zaloguj się do panelu.' });
  }
  if ((ROLE_LEVEL[payload.role] || 0) < ROLE_LEVEL[minRole]) {
    return res.status(403).json({ success: false, message: 'Brak uprawnień do tej operacji.' });
  }
  req.admin = { id: payload.staffId, name: payload.name, role: payload.role };
  next();
};

// ==========================================
// --- API ADMINA: LOGOWANIE I PRACOWNICY ---
// ==========================================
app.post('/api/admin/login', asyncRoute(async (req, res) => {
  const pin = String((req.body && req.body.pin) || '');
  const key = `admin:${req.ip}`;
  if (tooManyAttempts(key, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ success: false, message: 'Za dużo prób. Spróbuj ponownie za 10 minut.' });
  }

  let staff = null;
  if (ADMIN_PIN && pin.length && pin.length === ADMIN_PIN.length &&
      crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN))) {
    staff = { id: 'owner', name: 'Właściciel', role: 'owner' };
  } else if (pin) {
    const members = await StaffMember.find({ active: true });
    for (const m of members) {
      if (await bcrypt.compare(pin, m.pinHash)) { staff = { id: String(m._id), name: m.name, role: m.role }; break; }
    }
  }

  if (!staff) {
    recordFailure(key);
    console.warn('🔒 Nieudana próba logowania do panelu z adresu', req.ip);
    return res.status(401).json({ success: false, message: 'Nieprawidłowy PIN' });
  }
  clearFailures(key);
  const token = jwt.sign({ typ: 'admin', staffId: staff.id, name: staff.name, role: staff.role }, jwtSecret, { expiresIn: ADMIN_TOKEN_TTL });
  req.admin = staff;
  await audit(req, 'logowanie', staff.name, '');
  res.json({ success: true, name: staff.name, role: staff.role, token });
}));

app.get('/api/admin/me', requireAdmin(), (req, res) => res.json({ success: true, ...req.admin }));

app.get('/api/admin/staff', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const staff = await StaffMember.find({}, '-pinHash').sort({ createdAt: 1 });
  res.json({ success: true, data: staff });
}));

app.post('/api/admin/staff', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const { name, pin, role } = req.body || {};
  if (!name || !/^\d{4,8}$/.test(String(pin || ''))) {
    return res.status(400).json({ success: false, message: 'Podaj imię i PIN z 4–8 cyfr.' });
  }
  if (!ROLE_LEVEL[role]) return res.status(400).json({ success: false, message: 'Nieznana rola.' });
  if (ADMIN_PIN && String(pin) === ADMIN_PIN) return res.status(400).json({ success: false, message: 'Ten PIN jest zajęty.' });
  for (const m of await StaffMember.find({ active: true })) {
    if (await bcrypt.compare(String(pin), m.pinHash)) return res.status(400).json({ success: false, message: 'Ten PIN jest zajęty.' });
  }
  const member = await StaffMember.create({
    name: String(name).trim(), pinHash: await bcrypt.hash(String(pin), 10), role,
    position: String(req.body.position || 'Bar').slice(0, 40), hourlyRate: Math.max(0, round2(req.body.hourlyRate) || 0)
  });
  await audit(req, 'dodanie pracownika', member.name, role);
  res.json({ success: true, data: { _id: member._id, name: member.name, role: member.role, position: member.position, hourlyRate: member.hourlyRate, active: member.active } });
}));

app.patch('/api/admin/staff/:id', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const update = {};
  if (typeof req.body.active === 'boolean') update.active = req.body.active;
  if (req.body.role && ROLE_LEVEL[req.body.role]) update.role = req.body.role;
  const member = await StaffMember.findByIdAndUpdate(req.params.id, update, { new: true, projection: '-pinHash' });
  if (!member) return res.status(404).json({ success: false, message: 'Nie znaleziono pracownika.' });
  await audit(req, 'zmiana pracownika', member.name, JSON.stringify(update));
  res.json({ success: true, data: member });
}));

app.get('/api/admin/audit', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const logs = await AuditLog.find().sort({ at: -1 }).limit(300);
  res.json({ success: true, data: logs });
}));

// ==========================================
// --- API ADMINA: STATYSTYKI I KLIENCI ---
// ==========================================
app.get('/api/admin/stats', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [totalUsers, totalReservations, totalOrders, usersWithPoints, activePrepaidCards, pendingOrders, pendingReservations, agg, today] = await Promise.all([
    User.countDocuments(),
    Reservation.countDocuments(),
    Order.countDocuments({ location }),
    User.countDocuments({ points: { $gte: 1 } }),
    User.countDocuments({ walletBalance: { $gte: 1 } }),
    Order.countDocuments({ location, status: 'pending' }),
    Reservation.countDocuments({ status: 'pending' }),
    User.aggregate([{ $group: { _id: null, totalPrepaidBalance: { $sum: '$walletBalance' }, spentMilkosy: { $sum: '$redeemedPoints' }, totalPointsCirculating: { $sum: '$points' } } }]),
    PointTransaction.aggregate([
      { $match: { date: { $gte: startOfDay }, reverted: { $ne: true } } },
      { $group: { _id: null, amount: { $sum: '$amountSpent' }, points: { $sum: '$pointsAwarded' }, count: { $sum: 1 } } }
    ])
  ]);
  const a = agg[0] || {};
  const t = today[0] || {};
  res.json({
    success: true,
    data: {
      totalUsers, totalReservations, totalOrders, usersWithPoints, activePrepaidCards, pendingOrders, pendingReservations,
      totalPrepaidBalance: round2(a.totalPrepaidBalance || 0),
      spentMilkosy: a.spentMilkosy || 0,
      totalPointsCirculating: a.totalPointsCirculating || 0,
      todayAmount: round2(t.amount || 0), todayPoints: t.points || 0, todayTransactions: t.count || 0
    }
  });
}));

app.get('/api/admin/users', requireAdmin(), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  let filter = {};
  if (q) {
    const phone = normalizePhone(q);
    const rx = new RegExp(escapeRegex(q), 'i');
    filter = { $or: [{ username: rx }, { name: rx }, { email: rx }, ...(phone.length >= 3 ? [{ phoneNormalized: new RegExp(escapeRegex(phone)) }] : [])] };
  }
  const users = await User.find(filter, '-password').sort({ createdAt: -1 }).limit(q ? 50 : 1000);
  res.json({ success: true, data: users });
}));

// Kasa: wyszukanie klienta po numerze telefonu (lub e-mailu)
app.get('/api/admin/customers/lookup', requireAdmin(), asyncRoute(async (req, res) => {
  const raw = String(req.query.identifier || '').trim();
  if (!raw) return res.status(400).json({ success: false, message: 'Podaj numer telefonu.' });
  const phone = normalizePhone(raw);
  const users = await User.find(raw.includes('@') ? { email: raw.toLowerCase() } : { phoneNormalized: phone }, '-password -history').limit(10);
  res.json({ success: true, data: users.map(publicUser) });
}));

app.get('/api/admin/users/:id', requireAdmin(), asyncRoute(async (req, res) => {
  const user = await User.findById(req.params.id, '-password');
  if (!user) return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });
  const [points, wallet, orders, reservations, badges, referrals, tier, referrer, nextLot] = await Promise.all([
    PointTransaction.find({ userId: user._id }).sort({ date: -1 }).limit(30),
    WalletTransaction.find({ userId: user._id }).sort({ date: -1 }).limit(30),
    Order.find({ $or: [{ userId: user._id }, { phoneNormalized: user.phoneNormalized }] }).sort({ createdAt: -1 }).limit(20),
    Reservation.find({ $or: [{ userId: user._id }, { phoneNormalized: user.phoneNormalized }] }).sort({ createdAt: -1 }).limit(20),
    MissionCompletion.find({ userId: user._id }).sort({ at: -1 }),
    User.countDocuments({ referredBy: user._id, referralRewarded: true }),
    tierOf(user._id),
    user.referredBy ? User.findById(user.referredBy, 'name username phone') : null,
    PointLot.findOne({ userId: user._id, remaining: { $gt: 0 } }).sort({ expiresAt: 1 })
  ]);
  const program_ = {
    tier: tier ? { name: tier.current && tier.current.name, spent: tier.spent, next: tier.next && tier.next.name, toNext: tier.toNext } : null,
    badges, referrals, referralCode: user.referralCode || null,
    referredBy: referrer ? userDisplay(referrer) : null,
    birthday: user.birthday && user.birthday.month ? user.birthday : null,
    nextExpiry: nextLot ? { amount: nextLot.remaining, at: nextLot.expiresAt } : null
  };
  res.json({ success: true, data: { user, points, wallet, orders, reservations, program: program_ } });
}));

app.post('/api/admin/users/:id/points', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { action, reason } = req.body || {};
  const amount = Math.floor(Number(req.body && req.body.amount));
  if (!isPositiveNumber(amount)) return res.status(400).json({ success: false, message: 'Podaj liczbę punktów większą od zera.' });
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ success: false, message: 'Nieznana operacja.' });

  const delta = action === 'add' ? amount : -amount;
  const text = action === 'add' ? `+ ${amount} pkt • ${reason || 'Przyznane przez lokal'}` : `- ${amount} pkt • ${reason || 'Korekta lokalu'}`;
  const filter = action === 'remove' ? { _id: req.params.id, points: { $gte: amount } } : { _id: req.params.id };
  const user = await User.findOneAndUpdate(filter, { $inc: { points: delta }, $push: pushHistory(text) }, { new: true });
  if (!user) {
    const exists = await User.exists({ _id: req.params.id });
    return res.status(exists ? 400 : 404).json({ success: false, message: exists ? 'Użytkownik ma za mało punktów.' : 'Użytkownik nie istnieje.' });
  }
  if (action === 'add') await addLot(user._id, amount, 'korekta'); else await consumeLots(user._id, amount);
  await PointTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amountSpent: 0, pointsAwarded: delta, source: 'korekta', actor: req.admin.name });
  await audit(req, action === 'add' ? 'dodanie punktów' : 'odjęcie punktów', userDisplay(user), `${amount} pkt: ${reason || ''}`);
  if (action === 'add') quietly(notifyUser(user._id, { title: `+${amount} Milkosów`, body: reason || 'Prezent od Milkshakebar.', url: '/app' }));
  res.json({ success: true, points: user.points, history: user.history });
}));

app.patch('/api/admin/users/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });
  const changes = [];
  if (typeof req.body.blocked === 'boolean') { user.blocked = req.body.blocked; changes.push(req.body.blocked ? 'zablokowano' : 'odblokowano'); }
  if (req.body.phone) {
    const phone = normalizePhone(req.body.phone);
    if (phone.length !== 9) return res.status(400).json({ success: false, message: 'Numer telefonu musi mieć 9 cyfr.' });
    if (await User.exists({ phoneNormalized: phone, _id: { $ne: user._id } })) {
      return res.status(409).json({ success: false, message: 'Ten numer ma już inne konto.' });
    }
    user.phone = phone; changes.push(`telefon ${phone}`);
  }
  if (req.body.birthday !== undefined) {
    const b = req.body.birthday;
    if (b === null) { user.birthday = undefined; changes.push('usunięto urodziny'); } else {
      const bd = validBirthday(b.month, b.day);
      if (!bd) return res.status(400).json({ success: false, message: 'Nieprawidłowa data urodzin.' });
      user.birthday = bd; user.birthdaySetAt = user.birthdaySetAt || new Date(0); changes.push(`urodziny ${bd.day}.${bd.month}`);
    }
  }
  await user.save();
  await audit(req, 'zmiana klienta', userDisplay(user), changes.join(', '));
  res.json({ success: true, data: publicUser(user) });
}));

app.delete('/api/admin/users/:id', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (user) await audit(req, 'usunięcie konta', userDisplay(user), `punkty ${user.points}, saldo ${user.walletBalance}`);
  res.json({ success: true, message: 'Użytkownik usunięty.' });
}));

// Kasa: nabijanie Milkosów po numerze telefonu. 10 zł = 1 Milkos (z ustawień programu).
app.post('/api/admin/award-points', requireAdmin(), asyncRoute(async (req, res) => {
  const { identifier, userId, location } = req.body || {};
  const amountSpent = round2(req.body && req.body.amountSpent);
  if (!isPositiveNumber(amountSpent) || amountSpent > 100000) {
    return res.status(400).json({ success: false, message: 'Wprowadź prawidłową kwotę.' });
  }
  const points = Math.floor(amountSpent / loyalty.zlotyPerPoint);
  if (points <= 0) {
    return res.status(400).json({ success: false, message: `Kwota jest za mała (min. ${loyalty.zlotyPerPoint} zł).` });
  }

  let user;
  if (userId) {
    user = await User.findById(userId);
  } else {
    if (!identifier) return res.status(400).json({ success: false, message: 'Podaj numer telefonu klienta.' });
    const raw = String(identifier).trim();
    const matches = await User.find(raw.includes('@') ? { email: raw.toLowerCase() } : { phoneNormalized: normalizePhone(raw) });
    if (matches.length > 1) {
      return res.status(409).json({ success: false, message: 'Ten numer ma kilka kont. Wybierz właściwe.', candidates: matches.map(publicUser) });
    }
    user = matches[0];
  }
  if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono klienta w bazie.' });
  if (user.blocked) return res.status(403).json({ success: false, message: 'Konto klienta jest zablokowane.' });

  const r = await grantPurchasePoints(user, amountSpent, {
    source: 'kasa', label: `Zakupy w lokalu (${amountSpent.toFixed(2)} zł)`, location: location === 'rowy' ? 'rowy' : 'slupsk', actor: req.admin.name
  });
  await audit(req, 'nabicie punktów', userDisplay(user), `${amountSpent} zł → ${r.points} pkt${r.notes ? ` (${r.notes})` : ''}`);
  quietly(notifyUser(user._id, { title: `+${r.points} Milkosów`, body: `Za zakupy ${amountSpent.toFixed(2)} zł${r.notes ? ` (${r.notes})` : ''}. Masz teraz ${r.user.points} Milkosów.`, url: '/app' }));
  res.json({
    success: true, message: `Dodano ${r.points} pkt do konta klienta ${user.name || user.username}!`,
    points: r.points, basePoints: r.base, bonusPoints: r.bonus, bonusNote: r.notes, totalPoints: r.user.points, transactionId: r.tx._id,
    missions: r.extras.missions, referral: r.extras.referral, tierUp: r.extras.tierUp ? r.extras.tierUp.name : null
  });
}));

// Cofnięcie błędnie nabitych punktów
app.post('/api/admin/point-transactions/:id/revert', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const tx = await PointTransaction.findOneAndUpdate({ _id: req.params.id, reverted: { $ne: true }, pointsAwarded: { $gt: 0 } }, { reverted: true }, { new: true });
  if (!tx) return res.status(400).json({ success: false, message: 'Tej operacji nie można cofnąć.' });
  const user = await User.findOneAndUpdate(
    { _id: tx.userId, points: { $gte: tx.pointsAwarded } },
    { $inc: { points: -tx.pointsAwarded }, $push: pushHistory(`- ${tx.pointsAwarded} pkt • Korekta: cofnięcie nabicia`) },
    { new: true }
  );
  if (!user) {
    await PointTransaction.updateOne({ _id: tx._id }, { reverted: false });
    return res.status(400).json({ success: false, message: 'Klient wydał już te punkty. Popraw saldo ręcznie.' });
  }
  await consumeLots(user._id, tx.pointsAwarded);
  await audit(req, 'cofnięcie nabicia', tx.userDisplay, `${tx.pointsAwarded} pkt`);
  res.json({ success: true, points: user.points });
}));

app.get('/api/admin/point-transactions', requireAdmin(), asyncRoute(async (req, res) => {
  const txs = await PointTransaction.find().sort({ date: -1 }).limit(Math.min(Number(req.query.limit) || 50, 500));
  res.json({ success: true, data: txs });
}));

// ==========================================
// --- API ADMINA: PORTFEL vPLN ---
// ==========================================
app.post('/api/admin/wallet/search', requireAdmin(), asyncRoute(async (req, res) => {
  const raw = String((req.body && req.body.identifier) || '').trim();
  if (!raw) return res.status(400).json({ success: false, message: 'Podaj numer telefonu.' });
  const matches = await User.find(raw.includes('@') ? { email: raw.toLowerCase() } : { phoneNormalized: normalizePhone(raw) });
  if (!matches.length) return res.status(404).json({ success: false, message: 'Nie znaleziono klienta.' });
  const toItem = (u) => ({ id: u._id, username: u.username, email: u.email, phone: u.phone, walletBalance: u.walletBalance || 0, points: u.points });
  res.json({ success: true, user: toItem(matches[0]), candidates: matches.map(toItem) });
}));

app.post('/api/admin/wallet/modify', requireAdmin(), asyncRoute(async (req, res) => {
  const { userId, action, reason } = req.body || {};
  const amount = round2(req.body && req.body.amount);
  if (!isPositiveNumber(amount) || amount > 10000) return res.status(400).json({ success: false, message: 'Nieprawidłowa kwota.' });
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ success: false, message: 'Nieznana operacja.' });

  const text = action === 'add'
    ? `+ ${amount.toFixed(2)} PLN • ${reason || 'Wpłata środków na konto'}`
    : `- ${amount.toFixed(2)} PLN • ${reason || 'Zapłata z portfela w lokalu'}`;
  const filter = action === 'remove' ? { _id: userId, walletBalance: { $gte: amount } } : { _id: userId };
  const user = await User.findOneAndUpdate(filter, { $inc: { walletBalance: action === 'add' ? amount : -amount }, $push: pushHistory(text) }, { new: true });
  if (!user) {
    const exists = userId && mongoose.isValidObjectId(userId) && await User.exists({ _id: userId });
    return res.status(exists ? 400 : 404).json({ success: false, message: exists ? 'Brak wystarczających środków na koncie klienta.' : 'Użytkownik nie istnieje.' });
  }
  user.walletBalance = round2(user.walletBalance);
  await User.updateOne({ _id: user._id }, { walletBalance: user.walletBalance });
  await WalletTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amount, action, reason: reason || '', actor: req.admin.name });
  await audit(req, action === 'add' ? 'wpłata vPLN' : 'płatność vPLN', userDisplay(user), `${amount.toFixed(2)} zł`);
  quietly(notifyUser(user._id, {
    title: action === 'add' ? `Portfel: +${amount.toFixed(2)} zł` : `Zapłacono ${amount.toFixed(2)} zł saldem`,
    body: `Saldo do wydania: ${user.walletBalance.toFixed(2)} vPLN.`, url: '/app'
  }));
  res.json({ success: true, walletBalance: user.walletBalance, message: 'Saldo zostało pomyślnie zaktualizowane.' });
}));

app.get('/api/admin/wallet-transactions', requireAdmin(), asyncRoute(async (req, res) => {
  const txs = await WalletTransaction.find().sort({ date: -1 }).limit(Math.min(Number(req.query.limit) || 50, 500));
  res.json({ success: true, data: txs });
}));

// ==========================================
// --- PROGRAM LOJALNOŚCIOWY ---
// ==========================================
app.get('/api/loyalty', (req, res) => res.json({ success: true, data: loyalty }));

app.put('/api/admin/loyalty', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const zlotyPerPoint = Number(req.body.zlotyPerPoint);
  const vplnPerPoint = Number(req.body.vplnPerPoint);
  const exchangeOptions = (req.body.exchangeOptions || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (!isPositiveNumber(zlotyPerPoint) || !isPositiveNumber(vplnPerPoint) || !exchangeOptions.length) {
    return res.status(400).json({ success: false, message: 'Uzupełnij poprawnie wszystkie pola.' });
  }
  loyalty = { zlotyPerPoint, vplnPerPoint, exchangeOptions: [...new Set(exchangeOptions)] };
  await AppConfig.findOneAndUpdate({ key: 'loyalty' }, { value: loyalty }, { upsert: true });
  await audit(req, 'zmiana zasad programu', '', JSON.stringify(loyalty));
  res.json({ success: true, data: loyalty });
}));

// ==========================================
// --- USTAWIENIA LOKALU ---
// ==========================================
const SETTINGS_DEFAULTS = {
  ordersEnabled: true, pickupEnabled: true, deliveryEnabled: false,
  deliveryFee: ORDER_CONFIG.deliveryFee, freeDeliveryThreshold: ORDER_CONFIG.freeDeliveryThreshold, minOrderDelivery: 0,
  packagingFee: ORDER_CONFIG.packagingFee, mealSetPrice: ORDER_CONFIG.mealSetPrice,
  pickupPrepMinutes: 20, deliveryPrepMinutes: 50,
  payOnline: true, payCash: true, payCard: true, payWallet: true,
  closedMessage: '', coverUrl: ''
};
// Ustawienia z bazy uzupełnione domyślnymi (pola dodane później nie mają jeszcze wartości w bazie)
async function storeSettingsFor(location) {
  const doc = await StoreSettings.findOne({ location }).lean();
  const out = { location, ...SETTINGS_DEFAULTS };
  if (doc) for (const k of Object.keys(SETTINGS_DEFAULTS)) if (doc[k] !== undefined && doc[k] !== null) out[k] = doc[k];
  return out;
}
const defaultSettings = (location) => ({ location, ...SETTINGS_DEFAULTS });

app.get('/api/settings', asyncRoute(async (req, res) => {
  const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
  res.json({ success: true, data: await storeSettingsFor(location) });
}));

app.get('/api/admin/settings', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
  res.json({ success: true, settings: await storeSettingsFor(location) });
}));

// Zapis tylko tych pól, które przyszły (przełącznik zmienia jedno pole, formularz kilka)
app.post('/api/admin/settings', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const location = b.location === 'rowy' ? 'rowy' : 'slupsk';
  const update = { updatedAt: Date.now() };
  for (const k of ['ordersEnabled', 'pickupEnabled', 'deliveryEnabled', 'payOnline', 'payCash', 'payCard', 'payWallet']) {
    if (b[k] !== undefined) update[k] = Boolean(b[k]);
  }
  const money = { deliveryFee: [0, 200], freeDeliveryThreshold: [0, 2000], minOrderDelivery: [0, 2000], packagingFee: [0, 50], mealSetPrice: [0, 100] };
  for (const [k, [min, max]] of Object.entries(money)) {
    if (b[k] === undefined || b[k] === '') continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ success: false, message: `Nieprawidłowa wartość: ${k}.` });
    update[k] = round2(n);
  }
  for (const k of ['pickupPrepMinutes', 'deliveryPrepMinutes']) {
    if (b[k] === undefined || b[k] === '') continue;
    const n = Math.floor(Number(b[k]));
    if (!(n >= 0 && n <= 240)) return res.status(400).json({ success: false, message: 'Czas przygotowania: od 0 do 240 minut.' });
    update[k] = n;
  }
  if (b.closedMessage !== undefined) update.closedMessage = String(b.closedMessage).trim().slice(0, 160);
  if (b.coverUrl !== undefined) {
    const url = String(b.coverUrl).trim().slice(0, 300);
    if (url && !/^(https:\/\/|\/uploads\/|\/img\/)/.test(url)) return res.status(400).json({ success: false, message: 'Okładka: link https albo zdjęcie wgrane w panelu.' });
    update.coverUrl = url;
  }
  await StoreSettings.findOneAndUpdate({ location }, update, { new: true, upsert: true });
  const data = await storeSettingsFor(location);
  await audit(req, 'ustawienia zamawiarki', location, Object.keys(update).filter((k) => k !== 'updatedAt').map((k) => `${k}=${update[k]}`).join(', '));
  res.json({ success: true, message: 'Ustawienia lokalu zaktualizowane', data, settings: data });
}));

// ==========================================
// --- GRAFIKI KATEGORII I UPSELL ---
// ==========================================
app.get('/api/category-banners', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await CategoryBanner.find({}) });
}));

app.post('/api/admin/category-banners', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { categoryId, imageUrl, location = 'slupsk' } = req.body || {};
  if (!categoryId || !imageUrl) return res.status(400).json({ success: false, message: 'Brakujące parametry (categoryId lub imageUrl).' });
  const updated = await CategoryBanner.findOneAndUpdate({ categoryId }, { imageUrl, location, updatedAt: Date.now() }, { new: true, upsert: true });
  await audit(req, 'grafika kategorii', categoryId, imageUrl);
  res.json({ success: true, data: updated, message: 'Grafika kafelka zapisana.' });
}));

async function upsellFor(location) {
  const config = await UpsellConfig.findOne({ location });
  return config && config.items && config.items.length ? config.items : DEFAULT_UPSELL;
}
app.get('/api/upsell', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await upsellFor(req.query.location || 'slupsk') });
}));
app.get('/api/admin/upsell', requireAdmin(), asyncRoute(async (req, res) => {
  res.json({ success: true, items: await upsellFor(req.query.location || 'slupsk') });
}));

app.post('/api/admin/upsell', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { location = 'slupsk', items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ success: false, message: 'Nieprawidłowe dane pozycji.' });
  const mappedItems = items.map((it, idx) => ({
    id: it.id || `u${idx + 1}`,
    name: it.name || 'Dodatek',
    price: Number(it.price) || 0,
    img: it.img || (DEFAULT_UPSELL[idx] || DEFAULT_UPSELL[0]).img
  }));
  const updated = await UpsellConfig.findOneAndUpdate({ location }, { items: mappedItems, updatedAt: Date.now() }, { new: true, upsert: true });
  await audit(req, 'szybkie dodatki', location, mappedItems.map((i) => `${i.name} ${i.price}`).join(', '));
  res.json({ success: true, data: updated, message: 'Lista szybkiego dobierania zapisana.' });
}));

// ==========================================
// --- ZAMÓWIENIA ---
// ==========================================

// Ceny liczone po stronie serwera, tak samo jak w zamawiarce: wariant albo cena bazowa,
// do tego zestaw i dodatki; opakowanie raz na zamówienie, dostawa poniżej progu.
async function priceOrder(body, location, cfg = SETTINGS_DEFAULTS) {
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length || raw.length > 100) throw Object.assign(new Error('Koszyk jest pusty.'), { status: 400 });
  const isDelivery = body.deliveryMethod === 'delivery';

  const productIds = raw.filter((i) => i.type !== 'upsell' && mongoose.isValidObjectId(i.productId)).map((i) => i.productId);
  const products = new Map((await Product.find({ _id: { $in: productIds } })).map((p) => [String(p._id), p]));
  const upsell = await upsellFor(location);

  const items = [];
  const pickupOnly = [];
  for (const item of raw) {
    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw Object.assign(new Error('Nieprawidłowa ilość w koszyku.'), { status: 400 });

    let unit;
    let name;
    if (item.type === 'upsell') {
      const u = upsell.find((x) => String(x.id) === String(item.productId));
      if (!u) throw Object.assign(new Error('Jeden z dodatków nie jest już dostępny. Odśwież koszyk.'), { status: 409 });
      unit = Number(u.price) || 0;
      name = u.name;
    } else {
      const p = products.get(String(item.productId));
      if (!p || p.isAvailable === false) throw Object.assign(new Error(`Produkt „${item.name || ''}” jest niedostępny. Odśwież menu.`), { status: 409 });
      if (isDelivery && p.pickupOnly) pickupOnly.push(p.name);
      if (p.variants && p.variants.length) {
        const variant = item.variant ? p.variants.find((v) => v.name === item.variant) : p.variants[0];
        if (!variant) throw Object.assign(new Error(`Wariant produktu „${p.name}” się zmienił. Odśwież menu.`), { status: 409 });
        unit = Number(variant.price) || 0;
        name = variant.name ? `${p.name} (${variant.name})` : p.name;
      } else {
        unit = Number(p.price) || 0;
        name = p.name;
      }
      // Zestaw: gdy w panelu zaznaczono „zestaw”, albo domyślnie dla burgerów, starterów i kanapek
      const setAllowed = p.allowSet === true || (ORDER_CONFIG.setCategories.includes(p.categoryId) && p.allowSet !== false);
      if (item.set) {
        if (!setAllowed) throw Object.assign(new Error(`Do „${p.name}” nie można dobrać zestawu.`), { status: 409 });
        const side = ORDER_CONFIG.setSides.find((s) => s.name === String(item.set.side || ''));
        const noDrink = !item.set.drink || item.set.drink === 'Bez napoju';
        const drink = noDrink ? { price: 0 } : ORDER_CONFIG.setDrinks.find((d) => d.name === String(item.set.drink));
        if (!side || !drink) throw Object.assign(new Error(`Zestaw do „${p.name}” się zmienił. Odśwież menu.`), { status: 409 });
        unit += (Number(cfg.mealSetPrice) || 0) + side.extra + drink.price;
      }
      const addons = (p.addons || []).map((a, i) => ({ id: String(a.id || a._id || `a${i}`), name: a.name, price: Number(a.price) || 0 }));
      for (const id of (Array.isArray(item.addonIds) ? item.addonIds : [])) {
        const addon = addons.find((a) => a.id === String(id));
        if (!addon) throw Object.assign(new Error(`Dodatek do „${p.name}” jest niedostępny. Odśwież menu.`), { status: 409 });
        unit += addon.price;
      }
    }
    unit = round2(unit);
    items.push({
      id: item.id, productId: item.productId, type: item.type || 'product', name, variant: item.variant || null,
      price: unit, quantity, desc: String(item.desc || '').slice(0, 300), addonIds: item.addonIds || [], set: item.set || null
    });
  }
  if (pickupOnly.length) {
    throw Object.assign(new Error(`Tylko z odbiorem osobistym: ${[...new Set(pickupOnly)].join(', ')}.`), { status: 409, code: 'pickup_only' });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
  if (isDelivery && Number(cfg.minOrderDelivery) > 0 && subtotal < Number(cfg.minOrderDelivery)) {
    throw Object.assign(new Error(`Minimalne zamówienie z dostawą to ${Number(cfg.minOrderDelivery).toFixed(2).replace('.', ',')} zł.`), { status: 400, code: 'min_order' });
  }
  const packagingFee = round2(Number(cfg.packagingFee) || 0);
  const threshold = Number(cfg.freeDeliveryThreshold) || 0;
  const deliveryFee = isDelivery && !(threshold > 0 && subtotal >= threshold) ? round2(Number(cfg.deliveryFee) || 0) : 0;
  return { items, subtotal, packagingFee, deliveryFee, totalAmount: round2(subtotal + packagingFee + deliveryFee) };
}

async function getPayUToken() {
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: PAYU_CLIENT_ID || '', client_secret: PAYU_CLIENT_SECRET || '' });
  const response = await fetch(`${PAYU_BASE_URL}/pl/standard/user/oauth/authorize`, {
    method: 'POST', body: params, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    if (!response.ok) throw new Error(`PayU Auth Error: ${data.error_description || response.statusText}`);
    return data.access_token;
  } catch (err) {
    console.error('❌ Błąd pobierania tokena PayU. Odpowiedź:', text.substring(0, 800));
    throw new Error('Nieudana autoryzacja z PayU.');
  }
}

// Zamówienie w PayU. Gdy część zapłacono saldem vPLN, PayU dostaje jedną pozycję na kwotę do dopłaty.
async function createPayuOrder({ description, amount, extOrderId, buyer, products, continueUrl, customerIp }) {
  const token = await getPayUToken();
  const payuRes = await fetch(`${PAYU_BASE_URL}/api/v2_1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      notifyUrl: `${APP_URL}/api/payu/notify`, continueUrl, customerIp: customerIp || '127.0.0.1',
      merchantPosId: PAYU_POS_ID, description, currencyCode: 'PLN',
      totalAmount: String(Math.round(amount * 100)), extOrderId, buyer, products
    }),
    redirect: 'manual'
  });
  const locationHeader = payuRes.headers.get('location');
  const textResponse = await payuRes.text();
  let payuData = {};
  try { payuData = JSON.parse(textResponse); } catch (e) { payuData = {}; }
  const redirectUrl = payuData.redirectUri || (payuRes.status === 302 ? locationHeader : null);
  if (!redirectUrl) {
    console.error(`❌ PayU odrzuciło zamówienie (${payuRes.status}):`, textResponse.substring(0, 500));
    throw new Error(`Błąd bramki PayU: ${payuRes.status}`);
  }
  return { redirectUrl, payuOrderId: payuData.orderId };
}

// Godzina odbioru "na jutro" zapisana jako konkretna data (czas polski)
function scheduledDate(day, time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) return null;
  const base = warsawParts(new Date(Date.now() + (day === 'tomorrow' ? 864e5 : 0)));
  const [h, m] = time.split(':').map(Number);
  const guess = Date.UTC(base.y, base.m - 1, base.d, h, m);
  const p = warsawParts(new Date(guess));
  const asWarsaw = Date.UTC(p.y, p.m - 1, p.d, p.hour, Number(p.hm.slice(3)));
  return new Date(guess - (asWarsaw - guess)); // odejmij przesunięcie strefy (zima +1 h, lato +2 h)
}


app.post('/api/orders', optionalUser, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const location = body.location === 'rowy' ? 'rowy' : 'slupsk';
  const settings = await storeSettingsFor(location);
  if (!settings.ordersEnabled) {
    return res.status(403).json({ success: false, code: 'closed', message: settings.closedMessage || 'Lokal jest w tej chwili zamknięty na zamówienia online.' });
  }
  const isDelivery = body.deliveryMethod === 'delivery';
  if (isDelivery && !settings.deliveryEnabled) {
    return res.status(403).json({ success: false, code: 'closed', message: 'Dostawa jest chwilowo niedostępna.' });
  }
  if (!isDelivery && !settings.pickupEnabled) {
    return res.status(403).json({ success: false, code: 'closed', message: 'Odbiór osobisty jest chwilowo niedostępny.' });
  }
  const methodFlag = { online: 'payOnline', cash: 'payCash', card: 'payCard' }[body.paymentMethod];
  // Gdy saldo MilkMi pokrywa całość, metoda płatności nie ma znaczenia
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
  const user = req.user && !req.user.blocked ? req.user : null;

  // Ponowne wysłanie tego samego zamówienia (np. przy słabym zasięgu) nie tworzy duplikatu
  if (body.clientOrderId) {
    const existing = await Order.findOne({ clientOrderId: String(body.clientOrderId) }).sort({ createdAt: -1 });
    if (existing && existing.status !== 'awaiting_payment' && existing.status !== 'cancelled') {
      return res.json({ success: true, orderId: existing._id, orderNumber: existing.orderNumber, walletUsed: existing.walletUsed || 0, message: 'Zamówienie zostało przyjęte!' });
    }
    // Poprzednia, nieopłacona próba: anuluj ją i oddaj saldo, zanim powstanie nowa
    if (existing && existing.status === 'awaiting_payment') {
      const old = await Order.findOneAndUpdate({ _id: existing._id, status: 'awaiting_payment' }, { status: 'cancelled' }, { new: true });
      if (old) await refundOrderWallet(old, 'Zwrot: ponowiona płatność');
    }
  }

  let priced;
  try {
    priced = await priceOrder(body, location, settings);
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message, code: err.code });
  }
  if (body.totalAmount !== undefined && Math.abs(Number(body.totalAmount) - priced.totalAmount) > 0.01) {
    console.warn(`⚠️ Różnica ceny zamówienia: klient ${body.totalAmount}, serwer ${priced.totalAmount}`);
    return res.status(409).json({ success: false, code: 'price_changed', message: `Ceny w menu się zmieniły. Aktualna kwota to ${priced.totalAmount.toFixed(2)} zł. Odśwież stronę i złóż zamówienie ponownie.` });
  }

  // Płatność saldem vPLN (tylko zalogowany klient)
  const walletWanted = round2(Number(body.walletAmount) || 0);
  if (walletWanted < 0) return res.status(400).json({ success: false, message: 'Nieprawidłowa kwota z portfela.' });
  if (walletWanted > 0 && !user) return res.status(401).json({ success: false, message: 'Zaloguj się kontem MilkMi, żeby zapłacić saldem.' });
  const walletUsed = Math.min(walletWanted, priced.totalAmount);
  const amountDue = round2(priced.totalAmount - walletUsed);

  const pickupDay = body.pickupDay === 'tomorrow' ? 'tomorrow' : 'today';
  const counter = await Counter.findOneAndUpdate({ id: 'orderNum' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const orderNumber = `MI-${String(((counter.seq - 1) % 9999) + 1).padStart(4, '0')}`;
  let paymentMethod = ['cash', 'card', 'online', 'prepaid'].includes(body.paymentMethod) ? body.paymentMethod : 'cash';
  if (amountDue === 0 && walletUsed > 0) paymentMethod = 'wallet';
  const isOnlinePayment = paymentMethod === 'online' && amountDue > 0;

  if (walletUsed > 0) {
    const paid = await User.findOneAndUpdate(
      { _id: user._id, walletBalance: { $gte: walletUsed } },
      { $inc: { walletBalance: -walletUsed }, $push: pushHistory(`- ${walletUsed.toFixed(2)} PLN • Zamówienie online ${orderNumber}`) },
      { new: true }
    );
    if (!paid) return res.status(409).json({ success: false, code: 'wallet_low', message: 'Saldo vPLN jest niższe niż wybrana kwota. Odśwież stronę.' });
    await WalletTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amount: walletUsed, action: 'remove', reason: `Zamówienie online ${orderNumber}`, actor: 'klient' });
  }

  const newOrder = await Order.create({
    orderNumber,
    clientOrderId: body.clientOrderId ? String(body.clientOrderId) : undefined,
    customerName: String(body.customerName).trim().slice(0, 80),
    customerPhone: String(body.customerPhone || '').trim().slice(0, 20),
    phoneNormalized: normalizePhone(body.customerPhone),
    customerEmail: body.customerEmail ? String(body.customerEmail).slice(0, 120) : undefined,
    pickupTime: String(body.pickupTime || '').slice(0, 40),
    pickupDay,
    scheduledFor: scheduledDate(pickupDay, body.pickupTime) || undefined,
    userId: user ? user._id : undefined,
    walletUsed,
    amountDue,
    notes: String(body.notes || '').slice(0, 500),
    deliveryMethod: isDelivery ? 'delivery' : 'pickup',
    deliveryAddress: isDelivery ? String(body.deliveryAddress || '').slice(0, 200) : '',
    paymentMethod,
    source: body.source || 'web',
    location,
    ...priced,
    status: isOnlinePayment ? 'awaiting_payment' : 'pending'
  });

  const result = { success: true, orderId: newOrder._id, orderNumber, walletUsed, amountDue };
  if (!isOnlinePayment) return res.json({ ...result, message: 'Zamówienie zostało przyjęte!' });

  try {
    const products = walletUsed > 0
      ? [{ name: `Zamówienie ${orderNumber} (po odjęciu ${walletUsed.toFixed(2)} zł z portfela MilkMi)`, unitPrice: String(Math.round(amountDue * 100)), quantity: '1' }]
      : [
        ...newOrder.items.map((i) => ({ name: i.name, unitPrice: String(Math.round(i.price * 100)), quantity: String(i.quantity) })),
        { name: 'Opakowania', unitPrice: String(Math.round(newOrder.packagingFee * 100)), quantity: '1' },
        ...(newOrder.deliveryFee ? [{ name: 'Dostawa', unitPrice: String(Math.round(newOrder.deliveryFee * 100)), quantity: '1' }] : [])
      ];
    const payu = await createPayuOrder({
      description: `Zamówienie ${orderNumber}`, amount: amountDue, extOrderId: String(newOrder._id),
      buyer: { email: body.customerEmail || 'brak@email.pl', phone: newOrder.customerPhone, firstName: newOrder.customerName },
      products, continueUrl: `${APP_URL}/zamow?zamowienie=${newOrder._id}`, customerIp: req.ip
    });
    if (payu.payuOrderId) await Order.updateOne({ _id: newOrder._id }, { payuOrderId: payu.payuOrderId });
    res.json({ ...result, redirectUrl: payu.redirectUrl, message: 'Przekierowanie do płatności...' });
  } catch (err) {
    // Bramka nie działa: anuluj zamówienie i oddaj saldo
    const cancelled = await Order.findOneAndUpdate({ _id: newOrder._id, status: 'awaiting_payment' }, { status: 'cancelled' }, { new: true });
    if (cancelled) await refundOrderWallet(cancelled, 'Zwrot: płatność online niedostępna');
    throw err;
  }
}));


// Powiadomienie PayU: przyjmowane tylko z poprawnym podpisem (klucz MD5 z PAYU_SECOND_KEY)
function payuSignatureValid(req) {
  if (!PAYU_SECOND_KEY || !req.rawBody) return false;
  const header = String(req.headers['openpayu-signature'] || '');
  const parts = Object.fromEntries(header.split(';').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2));
  if (!parts.signature) return false;
  const algorithm = String(parts.algorithm || 'MD5').toUpperCase().replace('-', '');
  const hashName = { MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256' }[algorithm];
  if (!hashName) return false;
  const expected = crypto.createHash(hashName).update(Buffer.concat([req.rawBody, Buffer.from(PAYU_SECOND_KEY)])).digest('hex');
  return expected.length === parts.signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.signature));
}

app.post('/api/payu/notify', asyncRoute(async (req, res) => {
  if (!payuSignatureValid(req)) {
    console.warn('⚠️ Odrzucono powiadomienie PayU bez poprawnego podpisu.');
    return res.status(401).send('Invalid signature');
  }
  const order = req.body && req.body.order;
  const ext = String((order && order.extOrderId) || '');
  // Karta podarunkowa kupiona online
  if (order && ext.startsWith('gc_') && mongoose.isValidObjectId(ext.slice(3))) {
    const card = await GiftCard.findById(ext.slice(3));
    if (card && card.status === 'awaiting_payment') {
      if (order.status === 'COMPLETED' && Number(order.totalAmount) === Math.round(card.amount * 100)) {
        const now = new Date();
        await activateGiftCard(card, { paidAt: now, payuOrderId: order.orderId, actor: 'PayU' });
        console.log(`🎁 Karta podarunkowa ${card.amount} zł opłacona.`);
      } else if (order.status === 'CANCELED') {
        await GiftCard.updateOne({ _id: card._id, status: 'awaiting_payment' }, { status: 'cancelled' });
      }
    }
    return res.status(200).send('OK');
  }
  if (order && mongoose.isValidObjectId(ext)) {
    const dbOrder = await Order.findById(ext);
    const due = dbOrder ? (dbOrder.amountDue !== undefined && dbOrder.amountDue !== null ? dbOrder.amountDue : dbOrder.totalAmount) : 0;
    if (dbOrder && dbOrder.status === 'awaiting_payment' && order.status === 'COMPLETED' && Number(order.totalAmount) === Math.round(due * 100)) {
      dbOrder.status = 'pending';
      dbOrder.payuOrderId = order.orderId || dbOrder.payuOrderId;
      await dbOrder.save();
      console.log(`💰 Zamówienie ${dbOrder.orderNumber} opłacone przez PayU.`);
    } else if (dbOrder && dbOrder.status === 'awaiting_payment' && order.status === 'CANCELED') {
      const cancelled = await Order.findOneAndUpdate({ _id: dbOrder._id, status: 'awaiting_payment' }, { status: 'cancelled' }, { new: true });
      if (cancelled) await refundOrderWallet(cancelled, 'Zwrot: płatność anulowana');
    }
  }
  res.status(200).send('OK');
}));


// Status zamówienia dla klienta: bez danych osobowych
app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
  const order = await Order.findById(req.params.id, 'orderNumber status items totalAmount subtotal packagingFee deliveryFee deliveryMethod paymentMethod pickupTime pickupDay walletUsed amountDue pointsAwarded createdAt');
  if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
  res.json({ success: true, data: order });
}));

app.get('/api/admin/orders/pending', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  res.json({ success: true, data: await Order.find({ status: 'pending', location }).sort({ createdAt: 1 }) });
}));

app.get('/api/admin/orders', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  res.json({ success: true, data: await Order.find({ location }).sort({ createdAt: -1 }).limit(limit) });
}));

const ORDER_STATUSES = ['awaiting_payment', 'pending', 'preparing', 'ready', 'completed', 'cancelled'];

// Zamówienie zrealizowane → Milkosy dla klienta z kontem na ten numer telefonu (raz na zamówienie)
// Milkosy liczone od kwoty zapłaconej pieniędzmi (część opłacona saldem vPLN nie daje punktów).
// Happy hour liczy się według godziny złożenia zamówienia.
async function awardOrderPoints(order, req) {
  if (order.pointsAwarded) return 0;
  const paid = round2(Number(order.totalAmount) - Number(order.walletUsed || 0));
  if (Math.floor(paid / loyalty.zlotyPerPoint) <= 0) return 0;
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

app.post('/api/admin/orders/:id/status', requireAdmin(), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Nieznany status.' });
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
  let points = 0;
  if (status === 'completed') points = await awardOrderPoints(order, req);
  if (status === 'cancelled') await refundOrderWallet(order, 'Zwrot za anulowane zamówienie');
  await audit(req, 'status zamówienia', order.orderNumber, status + (points ? `, +${points} pkt` : ''));
  const messages = {
    preparing: { title: `Zamówienie ${order.orderNumber} przyjęte`, body: 'Właśnie je przygotowujemy.' },
    ready: order.deliveryMethod === 'delivery'
      ? { title: `Zamówienie ${order.orderNumber} jedzie do Ciebie`, body: 'Kierowca jest w drodze.' }
      : { title: `Zamówienie ${order.orderNumber} gotowe`, body: 'Możesz je odebrać w lokalu.' },
    cancelled: { title: `Zamówienie ${order.orderNumber} anulowane`, body: 'W razie pytań zadzwoń do lokalu.' },
    completed: points ? { title: `+${points} Milkosów`, body: `Za zamówienie ${order.orderNumber}. Smacznego!` } : null
  };
  if (messages[status]) quietly(order.userId ? notifyUser(order.userId, { ...messages[status], url: '/app' }) : notifyPhone(order.phoneNormalized, { ...messages[status], url: '/app' }));
  res.json({ success: true, message: 'Status zaktualizowany', pointsAwarded: points });
}));

// ==========================================
// --- REZERWACJE ---
// ==========================================
app.post('/api/reservations', optionalUser, asyncRoute(async (req, res) => {
  const { name, phone, datetime, guests, zone, notes, location } = req.body || {};
  const guestCount = Math.floor(Number(guests));
  if (!name || !phone || !datetime || !guestCount) return res.status(400).json({ success: false, message: 'Brakujące pola' });
  if (guestCount < 1 || guestCount > 60) return res.status(400).json({ success: false, message: 'Nieprawidłowa liczba gości.' });
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60 * 60 * 1000) {
    return res.status(400).json({ success: false, message: 'Wybierz datę z przyszłości.' });
  }
  await Reservation.create({
    name: String(name).slice(0, 80), phone: String(phone).slice(0, 20), phoneNormalized: normalizePhone(phone),
    userId: req.user ? req.user._id : undefined,
    datetime: String(datetime).slice(0, 30), guests: guestCount, zone: String(zone || '').slice(0, 60),
    notes: String(notes || '').slice(0, 500), location: location === 'rowy' ? 'rowy' : 'slupsk', status: 'pending',
    source: req.body.source === 'app' || req.user ? 'app' : 'web'
  });
  console.log(`🛎️ Nowa rezerwacja: ${name}`);
  res.json({ success: true, message: 'Rezerwacja została przyjęta do systemu' });
}));

app.get('/api/admin/reservations/pending', requireAdmin(), asyncRoute(async (req, res) => {
  res.json({ success: true, data: await Reservation.find({ status: 'pending' }).sort({ createdAt: 1 }) });
}));

app.get('/api/admin/reservations', requireAdmin(), asyncRoute(async (req, res) => {
  res.json({ success: true, data: await Reservation.find({}).sort({ datetime: -1 }).limit(1000) });
}));

app.post('/api/admin/reservations/:id/status', requireAdmin(), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'accepted', 'rejected', 'cancelled'].includes(status)) return res.status(400).json({ success: false, message: 'Nieznany status.' });
  const r = await Reservation.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (r) {
    await audit(req, 'status rezerwacji', `${r.name} ${r.datetime}`, status);
    const when = String(r.datetime || '').replace('T', ' ');
    const msg = { accepted: { title: 'Rezerwacja potwierdzona', body: `Czekamy na Ciebie ${when}, ${r.guests} os.` }, rejected: { title: 'Rezerwacja odrzucona', body: `Niestety nie mamy miejsca ${when}. Zadzwoń, znajdziemy inny termin.` } }[status];
    if (msg) quietly(r.userId ? notifyUser(r.userId, { ...msg, url: '/app' }) : notifyPhone(r.phoneNormalized, { ...msg, url: '/app' }));
  }
  res.json({ success: true });
}));

app.delete('/api/admin/reservations/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const r = await Reservation.findByIdAndDelete(req.params.id);
  if (r) await audit(req, 'usunięcie rezerwacji', `${r.name} ${r.datetime}`, '');
  res.json({ success: true, message: 'Rezerwacja usunięta' });
}));

// ==========================================
// --- BANERY ---
// ==========================================
app.post('/api/admin/banners', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { target, isActive, text, backgroundColor } = req.body || {};
  if (!['app', 'web'].includes(target)) return res.status(400).json({ success: false, message: 'Nieznany baner.' });
  const banner = await Banner.findOneAndUpdate(
    { target },
    { isActive: Boolean(isActive), text: String(text || '').slice(0, 200), backgroundColor: /^#[0-9a-f]{3,8}$/i.test(backgroundColor || '') ? backgroundColor : '#FF6600', updatedAt: Date.now() },
    { new: true, upsert: true }
  );
  await audit(req, 'baner', target, `${isActive ? 'włączony' : 'wyłączony'}: ${text || ''}`);
  res.json({ success: true, banner });
}));

app.get('/api/banners', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await Banner.find({}) });
}));

// ==========================================
// --- MENU ---
// ==========================================
app.get('/api/menu', asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const query = { $or: [{ location }, { location: { $exists: false } }, { location: null }, { location: '' }] };
  if (req.query.all !== '1') query.archived = { $ne: true }; // panel widzi też pozycje spoza karty
  const products = await Product.find(query).sort({ categoryId: 1, name: 1 });
  res.json({ success: true, data: products, meta: { set: { sides: ORDER_CONFIG.setSides, drinks: ORDER_CONFIG.setDrinks }, notes: KARTA.notatki } });
}));

// Porównanie nazw bez wielkości liter, polskich znaków, spacji i interpunkcji („Espresso 35ml” = „Espresso 35 ml”)
const nameKey = (s) => String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const KARTA_VERSION = crypto.createHash('sha1').update(JSON.stringify(KARTA.produkty)).digest('hex').slice(0, 12);

// Import drukowanej karty: aktualizuje pozycje o tej samej nazwie (zdjęcie, bestseller i „tylko odbiór” zostają),
// dodaje brakujące, a pozycje spoza karty chowa (archived), niczego nie usuwa. dryRun: tylko podgląd.
async function importKarta(location, { dryRun = false, actor = null } = {}) {
  const existing = await Product.find({ $or: [{ location }, { location: { $exists: false } }, { location: null }, { location: '' }] });
  // Gdy menu jest wspólne dla lokali (produkty bez zapisanego lokalu), nowe pozycje też są wspólne
  const raw = await Product.collection.find({ _id: { $in: existing.map((p) => p._id) } }, { projection: { location: 1 } }).toArray();
  const shared = raw.length > 0 && raw.every((p) => !p.location);
  const used = new Set();
  const plan = { updated: [], created: [], archived: [] };
  const ops = [];
  for (const [index, k] of KARTA.produkty.entries()) {
    const key = nameKey(k.name);
    // Ta sama nazwa: najpierw w tej samej kategorii (np. „Lotus” jest i gofrem, i shake'iem)
    const match = existing.find((p) => !used.has(String(p._id)) && nameKey(p.name) === key && p.categoryId === k.categoryId)
      || existing.find((p) => !used.has(String(p._id)) && nameKey(p.name) === key);
    const fields = {
      name: k.name, description: k.description || '', categoryId: k.categoryId,
      hasVariants: Boolean(k.variants), variants: k.variants || [], price: k.variants ? undefined : k.price,
      allowSet: Boolean(k.allowSet), addons: k.addons || [], isNewItem: Boolean(k.isNew), isVege: Boolean(k.isVege), spicy: k.spicy || 0,
      isAvailable: true, archived: false, sortOrder: index
    };
    if (match) {
      used.add(String(match._id));
      plan.updated.push(k.name);
      ops.push(() => Product.updateOne({ _id: match._id }, { $set: fields, ...(k.variants ? { $unset: { price: 1 } } : {}) }));
    } else {
      plan.created.push(k.name);
      ops.push(() => Product.create({ ...fields, location: shared ? '' : location, imageUrl: `/img/zamow/${k.art || 'logo'}.png`, pickupOnly: Boolean(k.pickupOnly) }));
    }
  }
  const leftovers = existing.filter((p) => !used.has(String(p._id)) && !p.archived);
  plan.archived = leftovers.map((p) => p.name.trim());
  if (!dryRun) {
    for (const op of ops) await op();
    if (leftovers.length) await Product.updateMany({ _id: { $in: leftovers.map((p) => p._id) } }, { $set: { archived: true, isAvailable: false } });
    await AppConfig.findOneAndUpdate({ key: `menuKarta:${location}` }, { value: { version: KARTA_VERSION, at: new Date() } }, { upsert: true });
    await audit(actor || {}, 'import karty menu', location, `zmienione ${plan.updated.length}, nowe ${plan.created.length}, schowane ${plan.archived.length}`);
  }
  return { location, shared, counts: { updated: plan.updated.length, created: plan.created.length, archived: plan.archived.length }, ...plan };
}

// Po wdrożeniu nowej karty (zmieniony data/menu-karta.json) serwer wgrywa ją sam, raz. KARTA_AUTO=off wyłącza.
async function autoImportKarta() {
  if (process.env.KARTA_AUTO === 'off') return;
  for (const location of ['slupsk', 'rowy']) {
    const mark = await AppConfig.findOne({ key: `menuKarta:${location}` });
    if (mark && mark.value && mark.value.version === KARTA_VERSION) continue;
    // Rowy tylko, gdy mają własne menu; wspólne menu wgrywa się razem ze Słupskiem
    if (location === 'rowy' && !(await Product.exists({ location: 'rowy' }))) continue;
    const r = await importKarta(location);
    console.log(`📋 Karta menu wgrana (${location}): ${r.counts.updated} zmienionych, ${r.counts.created} nowych, ${r.counts.archived} schowanych`);
  }
}

app.post('/api/admin/menu/import-karta', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const location = req.body && req.body.location === 'rowy' ? 'rowy' : 'slupsk';
  const result = await importKarta(location, { dryRun: Boolean(req.body && req.body.dryRun), actor: req });
  res.json({ success: true, dryRun: Boolean(req.body && req.body.dryRun), ...result });
}));

function productFields(body) {
  const { name, description, price, imageUrl, categoryId, location = 'slupsk', hasVariants, variants, allowSet, addons, isBestseller, isAvailable, pickupOnly } = body || {};
  if (!name || !imageUrl || !categoryId) return { error: 'Wypełnij wymagane pola.' };
  const cleanVariants = Array.isArray(variants) ? variants.filter((v) => v && v.name).map((v) => ({ name: String(v.name), price: round2(v.price) || 0 })) : [];
  if (hasVariants && !cleanVariants.length) return { error: 'Dodaj co najmniej jeden wariant.' };
  if (!hasVariants && (price === undefined || price === null || price === '' || !Number.isFinite(Number(price)))) {
    return { error: 'Wypełnij cenę dla produktu bez wariantów.' };
  }
  return {
    fields: {
      name: String(name).trim(), description: String(description || ''), price: hasVariants ? undefined : round2(price),
      imageUrl, categoryId, location, hasVariants: Boolean(hasVariants), variants: hasVariants ? cleanVariants : [],
      allowSet: Boolean(allowSet),
      addons: Array.isArray(addons) ? addons.filter((a) => a && a.name).map((a, i) => ({ id: String(a.id || `a${Date.now()}${i}`), name: String(a.name), price: round2(a.price) || 0 })) : [],
      isBestseller: Boolean(isBestseller), isAvailable: isAvailable !== false, pickupOnly: Boolean(pickupOnly)
    }
  };
}

app.post('/api/admin/menu', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { fields, error } = productFields(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  const newProduct = await Product.create(fields);
  await audit(req, 'dodanie produktu', newProduct.name, '');
  res.json({ success: true, product: newProduct, message: 'Produkt dodany do menu!' });
}));

app.put('/api/admin/menu/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { fields, error } = productFields(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  // Edycja nie przenosi produktu do innego lokalu (wspólne menu Słupska i Rowów zostaje wspólne)
  delete fields.location;
  const updatedProduct = await Product.findByIdAndUpdate(req.params.id, fields, { new: true });
  if (!updatedProduct) return res.status(404).json({ success: false, message: 'Nie znaleziono produktu.' });
  await audit(req, 'edycja produktu', updatedProduct.name, '');
  res.json({ success: true, product: updatedProduct, message: 'Produkt zaktualizowany pomyślnie!' });
}));

// Szybkie przełączniki z listy menu: dostępność, „tylko z odbiorem”, bestseller
app.patch('/api/admin/menu/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const update = {};
  for (const key of ['isAvailable', 'pickupOnly', 'isBestseller']) {
    if (typeof req.body[key] === 'boolean') update[key] = req.body[key];
  }
  if (update.isAvailable === true) update.archived = false; // przywrócenie pozycji schowanej przy imporcie karty
  const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!product) return res.status(404).json({ success: false, message: 'Nie znaleziono produktu.' });
  await audit(req, 'zmiana produktu', product.name, JSON.stringify(update));
  res.json({ success: true, product });
}));

// Cała kategoria naraz: np. wszystkie shake'i tylko z odbiorem
app.post('/api/admin/menu/category-flags', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { categoryId, pickupOnly, location = 'slupsk' } = req.body || {};
  if (!categoryId || typeof pickupOnly !== 'boolean') return res.status(400).json({ success: false, message: 'Brakujące dane.' });
  const result = await Product.updateMany(
    { categoryId, $or: [{ location }, { location: { $exists: false } }, { location: null }, { location: '' }] },
    { pickupOnly }
  );
  await audit(req, 'kategoria: tylko odbiór', categoryId, String(pickupOnly));
  res.json({ success: true, updated: result.modifiedCount });
}));

app.delete('/api/admin/menu/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const p = await Product.findByIdAndDelete(req.params.id);
  if (p) await audit(req, 'usunięcie produktu', p.name, '');
  res.json({ success: true, message: 'Produkt usunięty.' });
}));

app.post('/api/admin/upload', requireAdmin('manager'), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Wybierz zdjęcie JPG, PNG, WebP lub GIF (do 8 MB).' });
  res.json({ success: true, imageUrl: `/uploads/${req.file.filename}` });
});

// ==========================================
// --- GODZINY OTWARCIA ---
// ==========================================
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
app.post('/api/admin/hours', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const schedule = {};
  for (const d of DAYS) {
    const day = (req.body || {})[d] || {};
    const valid = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
    schedule[d] = { isOpen: Boolean(day.isOpen), from: valid(day.from) ? day.from : '10:00', to: valid(day.to) ? day.to : '20:00' };
  }
  const updatedHours = await LocationHours.findOneAndUpdate({ location }, { schedule, updatedAt: Date.now() }, { new: true, upsert: true });
  await audit(req, 'godziny otwarcia', location, '');
  res.json({ success: true, message: `Godziny otwarcia dla ${location} zaktualizowane!`, data: updatedHours });
}));

app.get('/api/hours', asyncRoute(async (req, res) => {
  const hoursDoc = await LocationHours.findOne({ location: req.query.location || 'slupsk' });
  if (hoursDoc && hoursDoc.schedule) res.json({ success: true, data: hoursDoc.schedule });
  else res.json({ success: false, message: 'Brak ustawionych godzin dla tej lokalizacji.' });
}));

// ==========================================
// --- APLIKACJA KLIENTA: KONTO ---
// ==========================================
// Pierwszy krok logowania w aplikacji: czy ten numer ma już konto (bez zdradzania danych)
app.post('/api/auth/check-phone', asyncRoute(async (req, res) => {
  const key = `check:${req.ip}`;
  if (tooManyAttempts(key, 40, 15 * 60 * 1000)) return res.status(429).json({ message: 'Za dużo prób. Spróbuj za kilka minut.' });
  recordFailure(key);
  const phone = normalizePhone(req.body && req.body.phone);
  if (phone.length !== 9) return res.status(400).json({ message: 'Podaj numer telefonu z 9 cyframi.' });
  const user = await User.findOne({ phoneNormalized: phone }, 'name username');
  const first = user ? String(user.name || user.username).trim().charAt(0).toUpperCase() : '';
  res.json({ success: true, exists: Boolean(user), hint: user ? `${first}***` : null });
}));

function loginFromName(name) {
  const base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'klient';
  return `${base}${crypto.randomInt(1000, 9999)}`;
}

// Rejestracja: imię, telefon i hasło. E-mail opcjonalny (stara aplikacja wysyłała username i email).
app.post('/api/register', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || body.username || '').trim().slice(0, 40);
  const cleanEmail = body.email ? String(body.email).trim().toLowerCase() : '';
  const cleanPhone = normalizePhone(body.phone);
  const password = String(body.password || '');
  if (name.length < 2) return res.status(400).json({ message: 'Podaj swoje imię.' });
  if (cleanPhone.length !== 9) return res.status(400).json({ message: 'Podaj numer telefonu z 9 cyframi.' });
  if (password.length < 6) return res.status(400).json({ message: 'Hasło musi mieć co najmniej 6 znaków.' });
  if (cleanEmail && !/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ message: 'Podaj poprawny adres e-mail albo zostaw pole puste.' });

  if (await User.exists({ phoneNormalized: cleanPhone })) {
    return res.status(409).json({ message: 'Ten numer ma już konto. Zaloguj się hasłem.', code: 'phone_taken' });
  }
  if (cleanEmail && await User.exists({ email: cleanEmail })) {
    return res.status(409).json({ message: 'Ten e-mail jest przypisany do innego konta.' });
  }
  // Kod polecenia znajomego (opcjonalny)
  let referrer = null;
  const refCode = String(body.referralCode || '').trim().toUpperCase();
  if (refCode) {
    referrer = await User.findOne({ referralCode: refCode }, '_id phoneNormalized');
    if (!referrer || referrer.phoneNormalized === cleanPhone) return res.status(400).json({ message: 'Nie znamy takiego kodu polecenia. Sprawdź go albo zostaw pole puste.', code: 'bad_referral' });
  }

  // Stara aplikacja podawała własny login; nowa generuje go z imienia
  let username = body.username && !body.name ? name : loginFromName(name);
  if (await User.exists({ username })) username = loginFromName(name);
  while (await User.exists({ username })) username = loginFromName(name);

  const user = await User.create({
    username, name, phone: cleanPhone, password: await bcrypt.hash(password, 10),
    ...(cleanEmail ? { email: cleanEmail } : {}),
    ...(referrer ? { referredBy: referrer._id } : {})
  });
  await ensureReferralCode(user);
  console.log(`🆕 Zarejestrowano: ${name}`);
  res.status(201).json({ message: 'Konto zostało pomyślnie utworzone.', token: signUserToken(user), user: publicUser(user) });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { loginOrEmail, password } = req.body || {};
  if (!loginOrEmail || !password) return res.status(400).json({ message: 'Podaj login/email oraz hasło.' });
  const key = `login:${req.ip}`;
  if (tooManyAttempts(key, 10, 15 * 60 * 1000)) return res.status(429).json({ message: 'Za dużo prób logowania. Spróbuj za 15 minut.' });

  const cleanLogin = String(loginOrEmail).trim();
  const phone = normalizePhone(cleanLogin);
  const or = [{ email: cleanLogin.toLowerCase() }, { username: cleanLogin }];
  if (phone.length === 9 && !cleanLogin.includes('@')) or.push({ phoneNormalized: phone });
  const candidates = await User.find({ $or: or }).limit(5);

  let user = null;
  for (const c of candidates) {
    if (await bcrypt.compare(String(password), c.password)) { user = c; break; }
  }
  if (!user) {
    recordFailure(key);
    return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
  }
  if (user.blocked) return res.status(403).json({ message: 'Konto jest zablokowane. Skontaktuj się z lokalem.' });
  clearFailures(key);
  await User.updateOne({ _id: user._id }, { lastSeenAt: new Date() });
  res.status(200).json({ message: 'Zalogowano pomyślnie.', token: signUserToken(user), user: publicUser(user) });
}));

// Odnowienie sesji przy każdym otwarciu aplikacji. Przyjmuje też tokeny ze starej wersji
// (podpisane starym kluczem), ale tylko jeśli e-mail z telefonu klienta zgadza się z kontem.
app.post('/api/session/refresh', asyncRoute(async (req, res) => {
  const { token, email } = req.body || {};
  if (!token) return res.status(401).json({ success: false, message: 'Zaloguj się ponownie.' });

  let userId = null;
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.typ === 'user') userId = payload.userId;
  } catch (e) {
    if (Date.now() < LEGACY_SESSIONS_UNTIL.getTime()) {
      try {
        const legacy = jwt.verify(token, LEGACY_JWT_SECRET, { ignoreExpiration: true });
        if (legacy.userId && !legacy.typ) {
          const candidate = await User.findById(legacy.userId);
          if (candidate && email && candidate.email === String(email).trim().toLowerCase()) userId = legacy.userId;
        }
      } catch (e2) { userId = null; }
    }
  }
  const user = userId && mongoose.isValidObjectId(userId) ? await User.findById(userId) : null;
  if (!user) return res.status(401).json({ success: false, message: 'Zaloguj się ponownie.' });
  if (user.blocked) return res.status(403).json({ success: false, message: 'Konto jest zablokowane.' });
  await User.updateOne({ _id: user._id }, { lastSeenAt: new Date() });
  res.json({ success: true, token: signUserToken(user), user: publicUser(user) });
}));

app.get('/api/me', requireUser, (req, res) => {
  res.json({ success: true, user: publicUser(req.user), history: req.user.history, loyalty });
});

app.patch('/api/me', requireUser, asyncRoute(async (req, res) => {
  const user = req.user;
  const { phone, email } = req.body || {};
  const name = req.body && (req.body.name ?? req.body.username);
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 40);
    if (clean.length < 2) return res.status(400).json({ success: false, message: 'Imię jest za krótkie.' });
    user.name = clean;
  }
  if (email !== undefined) {
    const clean = String(email).trim().toLowerCase();
    if (clean && !/^\S+@\S+\.\S+$/.test(clean)) return res.status(400).json({ success: false, message: 'Podaj poprawny adres e-mail.' });
    if (clean && clean !== user.email && await User.exists({ email: clean })) {
      return res.status(409).json({ success: false, message: 'Ten e-mail jest przypisany do innego konta.' });
    }
    user.email = clean || undefined;
  }
  if (phone !== undefined) {
    const clean = normalizePhone(phone);
    if (clean.length !== 9) return res.status(400).json({ success: false, message: 'Podaj numer telefonu z 9 cyframi.' });
    if (clean !== user.phoneNormalized && await User.exists({ phoneNormalized: clean, _id: { $ne: user._id } })) {
      return res.status(409).json({ success: false, message: 'Ten numer ma już inne konto.' });
    }
    user.phone = clean;
  }
  await user.save();
  res.json({ success: true, user: publicUser(user) });
}));

app.post('/api/me/password', requireUser, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !(await bcrypt.compare(String(currentPassword), req.user.password))) {
    return res.status(400).json({ success: false, message: 'Obecne hasło jest nieprawidłowe.' });
  }
  if (String(newPassword || '').length < 6) return res.status(400).json({ success: false, message: 'Nowe hasło musi mieć co najmniej 6 znaków.' });
  req.user.password = await bcrypt.hash(String(newPassword), 10);
  await req.user.save();
  res.json({ success: true, message: 'Hasło zmienione.' });
}));

app.get('/api/me/reservations', requireUser, asyncRoute(async (req, res) => {
  const data = await Reservation.find({ $or: [{ userId: req.user._id }, { phoneNormalized: req.user.phoneNormalized }] }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data });
}));

app.get('/api/me/orders', requireUser, asyncRoute(async (req, res) => {
  const data = await Order.find({ phoneNormalized: req.user.phoneNormalized, status: { $ne: 'awaiting_payment' } }, 'orderNumber status totalAmount items createdAt deliveryMethod pointsAwarded walletUsed location').sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data });
}));

// Stary adres używany przez poprzednią wersję aplikacji. Teraz wymaga zalogowania,
// a e-mail w adresie jest ignorowany: dane dotyczą zawsze zalogowanego klienta.
app.get('/api/milkpoints/my', requireUser, (req, res) => {
  const user = req.user;
  res.json({ ok: true, points: user.points, walletBalance: user.walletBalance || 0, history: user.history, activeRewards: user.activeRewards || [] });
});

// Wymiana Milkosów na saldo vPLN: kwotę liczy serwer (1 Milkos = 1 vPLN), operacja jest atomowa.
app.post('/api/rewards/exchange', requireUser, asyncRoute(async (req, res) => {
  const pointsCost = Math.floor(Number(req.body && req.body.pointsCost));
  if (!loyalty.exchangeOptions.includes(pointsCost)) {
    return res.status(400).json({ success: false, message: 'Nieprawidłowa wartość bonu.' });
  }
  const vplnAmount = round2(pointsCost * loyalty.vplnPerPoint);
  const user = await User.findOneAndUpdate(
    { _id: req.user._id, points: { $gte: pointsCost } },
    {
      $inc: { points: -pointsCost, redeemedPoints: pointsCost, walletBalance: vplnAmount },
      $push: pushHistory(`+ ${vplnAmount.toFixed(2)} PLN • Zasilenie z punktów lojalnościowych`, `- ${pointsCost} pkt • Kupiono bon do portfela`)
    },
    { new: true }
  );
  if (!user) return res.status(400).json({ success: false, message: 'Niewystarczająca liczba punktów.' });
  await consumeLots(user._id, pointsCost);
  await WalletTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amount: vplnAmount, action: 'add', reason: `Wymiana ${pointsCost} Milkosów`, actor: 'klient' });
  res.json({
    success: true, points: user.points, walletBalance: user.walletBalance, history: user.history,
    message: `Pomyślnie zamieniono ${pointsCost} pkt na ${vplnAmount.toFixed(2)} PLN!`
  });
}));

app.get('/api/health', (req, res) => res.json({ ok: mongoose.connection.readyState === 1 }));

// ==========================================
// --- POWIADOMIENIA PUSH ---
// ==========================================
app.get('/api/push/key', (req, res) => res.json({ success: true, publicKey: vapid ? vapid.publicKey : null }));

app.post('/api/push/subscribe', requireUser, asyncRoute(async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ success: false, message: 'Nieprawidłowa subskrypcja.' });
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { userId: req.user._id, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
    { upsert: true }
  );
  res.json({ success: true });
}));

app.post('/api/push/unsubscribe', requireUser, asyncRoute(async (req, res) => {
  await PushSubscription.deleteOne({ endpoint: String((req.body && req.body.endpoint) || ''), userId: req.user._id });
  res.json({ success: true });
}));

app.post('/api/push/test', requireUser, asyncRoute(async (req, res) => {
  const result = await sendPush(await PushSubscription.find({ userId: req.user._id }), { title: 'Powiadomienia działają', body: 'Tu dostaniesz info o Milkosach, zamówieniach i rezerwacjach.', url: '/app' });
  res.json({ success: true, ...result });
}));

app.get('/api/admin/push', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const [devices, users, campaigns] = await Promise.all([
    PushSubscription.countDocuments(), PushSubscription.distinct('userId'), PushCampaign.find().sort({ at: -1 }).limit(30)
  ]);
  res.json({ success: true, data: { devices, users: users.length, campaigns } });
}));

app.post('/api/admin/push', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 60);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 180);
  const url = String((req.body && req.body.url) || '/app').trim().slice(0, 200);
  const audience = ['all', 'points', 'inactive'].includes(req.body && req.body.audience) ? req.body.audience : 'all';
  if (!title || !body) return res.status(400).json({ success: false, message: 'Podaj tytuł i treść.' });
  if (!url.startsWith('/') && !url.startsWith(APP_URL)) return res.status(400).json({ success: false, message: 'Link musi prowadzić do Waszej strony, np. /zamów.' });

  let filter = {};
  if (audience !== 'all') {
    const userFilter = audience === 'points' ? { points: { $gte: 1 } } : { $or: [{ lastSeenAt: { $lt: new Date(Date.now() - 30 * 864e5) } }, { lastSeenAt: { $exists: false } }] };
    filter = { userId: { $in: await User.distinct('_id', userFilter) } };
  }
  const result = await sendPush(await PushSubscription.find(filter), { title, body, url });
  await PushCampaign.create({ title, body, url, audience, ...result, actor: req.admin.name });
  await audit(req, 'powiadomienie push', title, `${result.sent} wysłanych, ${result.failed} błędów`);
  res.json({ success: true, ...result });
}));

// ==========================================
// --- NEWSLETTER ---
// ==========================================
app.post('/api/newsletter', asyncRoute(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'Podaj poprawny adres e-mail.' });
  if (!(req.body && req.body.consent === true)) return res.status(400).json({ success: false, message: 'Zaznacz zgodę na otrzymywanie wiadomości.' });
  await Subscriber.findOneAndUpdate({ email }, { active: true, consentAt: new Date(), source: req.body.source === 'app' ? 'app' : 'web' }, { upsert: true });
  res.json({ success: true, message: 'Dziękujemy! Jesteś na liście.' });
}));

app.get('/api/admin/newsletter', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const list = await Subscriber.find({ active: true }).sort({ consentAt: -1 });
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="newsletter.csv"');
    return res.send('﻿email;zgoda;zrodlo\n' + list.map((s) => `${s.email};${s.consentAt.toISOString()};${s.source}`).join('\n'));
  }
  res.json({ success: true, data: list });
}));

app.delete('/api/admin/newsletter/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const s = await Subscriber.findByIdAndUpdate(req.params.id, { active: false });
  if (s) await audit(req, 'wypisanie z newslettera', s.email, '');
  res.json({ success: true });
}));

// ==========================================
// --- KLIENCI: RESET HASŁA ---
// ==========================================
// Klient zapomniał hasła: obsługa nadaje hasło tymczasowe i podaje je klientowi przy kasie
app.post('/api/admin/users/:id/reset-password', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const temp = String(crypto.randomInt(100000, 999999));
  const user = await User.findByIdAndUpdate(req.params.id, { password: await bcrypt.hash(temp, 10) }, { new: true });
  if (!user) return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });
  await audit(req, 'reset hasła klienta', userDisplay(user), '');
  res.json({ success: true, tempPassword: temp });
}));

// ==========================================
// --- ZESPÓŁ: CZAS PRACY I KOSZTY ---
// ==========================================
app.patch('/api/admin/staff/:id/details', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const update = {};
  if (req.body.name) update.name = String(req.body.name).trim().slice(0, 60);
  if (req.body.position) update.position = String(req.body.position).slice(0, 40);
  if (req.body.hourlyRate !== undefined && Number.isFinite(Number(req.body.hourlyRate)) && Number(req.body.hourlyRate) >= 0) update.hourlyRate = round2(req.body.hourlyRate);
  if (req.body.pin) {
    if (!/^\d{4,8}$/.test(String(req.body.pin))) return res.status(400).json({ success: false, message: 'PIN musi mieć 4–8 cyfr.' });
    update.pinHash = await bcrypt.hash(String(req.body.pin), 10);
  }
  const member = await StaffMember.findByIdAndUpdate(req.params.id, update, { new: true, projection: '-pinHash' });
  if (!member) return res.status(404).json({ success: false, message: 'Nie znaleziono pracownika.' });
  await audit(req, 'dane pracownika', member.name, Object.keys(update).join(', '));
  res.json({ success: true, data: member });
}));

// Rozpoczęcie i zakończenie zmiany przez zalogowanego pracownika
app.get('/api/admin/shifts/current', requireAdmin(), asyncRoute(async (req, res) => {
  res.json({ success: true, data: await Shift.findOne({ staffId: req.admin.id, end: null }) });
}));
app.post('/api/admin/shifts/clock', requireAdmin(), asyncRoute(async (req, res) => {
  const open = await Shift.findOne({ staffId: req.admin.id, end: null });
  if (req.body.action === 'in') {
    if (open) return res.status(400).json({ success: false, message: 'Zmiana już trwa.' });
    const shift = await Shift.create({ staffId: req.admin.id, staffName: req.admin.name, start: new Date() });
    return res.json({ success: true, data: shift });
  }
  if (!open) return res.status(400).json({ success: false, message: 'Nie masz rozpoczętej zmiany.' });
  open.end = new Date();
  await open.save();
  res.json({ success: true, data: open });
}));

const monthRange = (month) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  const now = new Date();
  const y = m ? Number(m[1]) : now.getFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getMonth();
  return [new Date(y, mo, 1), new Date(y, mo + 1, 1)];
};
app.get('/api/admin/shifts', requireAdmin(), asyncRoute(async (req, res) => {
  const [from, to] = monthRange(req.query.month);
  const filter = { start: { $gte: from, $lt: to } };
  if (ROLE_LEVEL[req.admin.role] < ROLE_LEVEL.manager) filter.staffId = req.admin.id;
  res.json({ success: true, data: await Shift.find(filter).sort({ start: -1 }) });
}));
app.post('/api/admin/shifts', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { staffId, start, end, bonus, note } = req.body || {};
  const member = staffId === 'owner' ? { name: 'Właściciel' } : await StaffMember.findById(staffId);
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  if (!member || Number.isNaN(s.getTime()) || (e && (Number.isNaN(e.getTime()) || e <= s))) {
    return res.status(400).json({ success: false, message: 'Sprawdź pracownika oraz godziny rozpoczęcia i zakończenia.' });
  }
  const shift = await Shift.create({ staffId, staffName: member.name, start: s, end: e, bonus: Number(bonus) || 0, note: String(note || '').slice(0, 200) });
  await audit(req, 'dodanie zmiany', member.name, `${s.toLocaleString('pl-PL')}`);
  res.json({ success: true, data: shift });
}));
app.patch('/api/admin/shifts/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const update = {};
  if (req.body.start) update.start = new Date(req.body.start);
  if (req.body.end !== undefined) update.end = req.body.end ? new Date(req.body.end) : null;
  if (req.body.bonus !== undefined) update.bonus = Number(req.body.bonus) || 0;
  const shift = await Shift.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!shift) return res.status(404).json({ success: false, message: 'Nie znaleziono zmiany.' });
  await audit(req, 'korekta zmiany', shift.staffName, JSON.stringify(update));
  res.json({ success: true, data: shift });
}));
app.delete('/api/admin/shifts/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const shift = await Shift.findByIdAndDelete(req.params.id);
  if (shift) await audit(req, 'usunięcie zmiany', shift.staffName, shift.start.toLocaleString('pl-PL'));
  res.json({ success: true });
}));

// Koszty: godziny × stawka + premie, w wybranym miesiącu
app.get('/api/admin/costs', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const [from, to] = monthRange(req.query.month);
  const [shifts, staff] = await Promise.all([Shift.find({ start: { $gte: from, $lt: to } }), StaffMember.find({}, '-pinHash')]);
  const rows = new Map();
  for (const m of staff) rows.set(String(m._id), { staffId: String(m._id), name: m.name, position: m.position, hourlyRate: m.hourlyRate || 0, hours: 0, bonus: 0 });
  for (const s of shifts) {
    const row = rows.get(s.staffId) || { staffId: s.staffId, name: s.staffName, position: s.staffId === 'owner' ? 'Właściciel' : '', hourlyRate: 0, hours: 0, bonus: 0 };
    const end = s.end || new Date();
    row.hours += Math.max(0, (end - s.start) / 3600000);
    row.bonus += s.bonus || 0;
    rows.set(s.staffId, row);
  }
  const data = [...rows.values()].map((r) => ({ ...r, hours: round2(r.hours), total: round2(r.hours * r.hourlyRate + r.bonus) })).filter((r) => r.hours > 0 || r.hourlyRate > 0);
  const revenueAgg = await Order.aggregate([{ $match: { createdAt: { $gte: from, $lt: to }, status: 'completed' } }, { $group: { _id: null, sum: { $sum: '$totalAmount' } } }]);
  res.json({ success: true, data, totals: { cost: round2(data.reduce((s, r) => s + r.total, 0)), onlineRevenue: round2((revenueAgg[0] || {}).sum || 0) } });
}));

// ==========================================
// --- MAGAZYN ---
// ==========================================
app.get('/api/admin/stock', requireAdmin(), asyncRoute(async (req, res) => {
  res.json({ success: true, data: await StockItem.find({ location: req.query.location || 'slupsk' }).sort({ category: 1, name: 1 }) });
}));
app.post('/api/admin/stock', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { name, category, unit, qty, minQty, location = 'slupsk' } = req.body || {};
  if (!name) return res.status(400).json({ success: false, message: 'Podaj nazwę artykułu.' });
  const item = await StockItem.create({ name, category: category || 'Inne', unit: unit || 'szt.', qty: Number(qty) || 0, minQty: Number(minQty) || 0, location });
  await audit(req, 'magazyn: nowy artykuł', item.name, `${item.qty} ${item.unit}`);
  res.json({ success: true, data: item });
}));
app.patch('/api/admin/stock/:id', requireAdmin(), asyncRoute(async (req, res) => {
  const item = await StockItem.findById(req.params.id);
  if (!item) return res.status(404).json({ success: false, message: 'Nie znaleziono artykułu.' });
  const before = item.qty;
  if (req.body.delta !== undefined) item.qty = round2(item.qty + Number(req.body.delta || 0));
  if (ROLE_LEVEL[req.admin.role] >= ROLE_LEVEL.manager) {
    for (const k of ['name', 'category', 'unit']) if (req.body[k]) item[k] = String(req.body[k]).slice(0, 60);
    for (const k of ['qty', 'minQty']) if (req.body[k] !== undefined && Number.isFinite(Number(req.body[k]))) item[k] = Number(req.body[k]);
  }
  item.updatedAt = new Date();
  await item.save();
  await audit(req, 'magazyn: zmiana stanu', item.name, `${before} → ${item.qty} ${item.unit}`);
  res.json({ success: true, data: item });
}));
app.delete('/api/admin/stock/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const item = await StockItem.findByIdAndDelete(req.params.id);
  if (item) await audit(req, 'magazyn: usunięcie', item.name, '');
  res.json({ success: true });
}));

// ==========================================
// --- STATYSTYKI STRONY I SYSTEM ---
// ==========================================
const TRACKED_PAGES = ['home', 'menu', 'zamow', 'app'];
const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
app.post('/api/track', asyncRoute(async (req, res) => {
  const page = String((req.body && req.body.page) || '');
  if (TRACKED_PAGES.includes(page)) await PageView.updateOne({ day: dayKey(), page }, { $inc: { count: 1 } }, { upsert: true });
  res.status(204).end();
}));

app.get('/api/admin/web-stats', requireAdmin(), asyncRoute(async (req, res) => {
  const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - i * 864e5)));
  const views = await PageView.find({ day: { $in: days } });
  const today = Object.fromEntries(TRACKED_PAGES.map((p) => [p, 0]));
  const week = Object.fromEntries(TRACKED_PAGES.map((p) => [p, 0]));
  views.forEach((v) => { week[v.page] += v.count; if (v.day === days[0]) today[v.page] += v.count; });
  const weekStart = new Date(Date.now() - 7 * 864e5);
  const [webReservations, appReservations, subscribers, lowStock, stockItems] = await Promise.all([
    Reservation.countDocuments({ source: 'web', createdAt: { $gte: weekStart } }),
    Reservation.countDocuments({ source: 'app', createdAt: { $gte: weekStart } }),
    Subscriber.countDocuments({ active: true }),
    StockItem.countDocuments({ $expr: { $lte: ['$qty', '$minQty'] } }),
    StockItem.countDocuments()
  ]);
  res.json({ success: true, data: { today, week, webReservations, appReservations, subscribers, lowStock, stockItems } });
}));

app.get('/api/admin/system', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const [users, orders, products, devices, lastOrder, staff] = await Promise.all([
    User.estimatedDocumentCount(), Order.estimatedDocumentCount(), Product.estimatedDocumentCount(),
    PushSubscription.estimatedDocumentCount(), Order.findOne({}, 'createdAt orderNumber').sort({ createdAt: -1 }), StaffMember.countDocuments({ active: true })
  ]);
  let uploads = 0;
  try { uploads = fs.readdirSync(UPLOADS_DIR).length; } catch (e) { uploads = 0; }
  res.json({
    success: true,
    data: {
      version: VERSION, node: process.version, startedAt: STARTED_AT, uptimeSec: Math.round(process.uptime()),
      database: mongoose.connection.readyState === 1 ? 'online' : 'offline',
      payu: Boolean(PAYU_POS_ID && PAYU_CLIENT_ID && PAYU_CLIENT_SECRET), payuSignature: Boolean(PAYU_SECOND_KEY), payuEnv: process.env.PAYU_ENV === 'secure' ? 'produkcja' : 'testowe',
      push: Boolean(vapid), devices, users, orders, products, staff, uploads,
      lastOrder: lastOrder ? { at: lastOrder.createdAt, number: lastOrder.orderNumber } : null
    }
  });
}));

// ==========================================
// --- PROGRAM MILKMI: KLIENT ---
// ==========================================
const happyHourPublic = (h) => (h ? { name: h.name || 'Happy hour', multiplier: Number(h.multiplier), from: h.from, to: h.to } : null);
function validBirthday(month, day) {
  const m = Math.floor(Number(month));
  const d = Math.floor(Number(day));
  if (!(m >= 1 && m <= 12) || !(d >= 1)) return null;
  return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ? { month: m, day: d } : null;
}
const PURCHASE_SOURCES = ['kasa', 'zamowienie'];
async function canEnterReferral(user) {
  if (!program.referral.enabled || user.referredBy) return false;
  if (Date.now() - new Date(user.createdAt).getTime() > 14 * 864e5) return false;
  return !(await PointTransaction.exists({ userId: user._id, source: { $in: PURCHASE_SOURCES } }));
}

// Zasady programu dla strony i aplikacji (bez logowania)
app.get('/api/program', (req, res) => {
  const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
  res.json({
    success: true,
    data: {
      loyalty,
      tiers: program.tiers,
      referral: program.referral,
      birthday: program.birthday,
      expiry: program.expiry,
      happyHours: program.happyHours.filter((h) => h.active !== false).map((h) => ({ name: h.name, days: h.days, from: h.from, to: h.to, multiplier: h.multiplier, location: h.location || 'all' })),
      activeHappyHour: happyHourPublic(activeHappyHour(location))
    }
  });
});

// Wszystko o kliencie w programie: poziom, misje, odznaki, polecenia, urodziny, ważność
app.get('/api/me/program', requireUser, asyncRoute(async (req, res) => {
  const user = req.user;
  const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
  await ensureReferralCode(user);
  const [tier, missions, done, invited, rewarded, lots, canRef] = await Promise.all([
    tierOf(user._id),
    Mission.find(liveMissionsFilter()).sort({ createdAt: 1 }),
    MissionCompletion.find({ userId: user._id }).sort({ at: -1 }),
    User.countDocuments({ referredBy: user._id }),
    User.countDocuments({ referredBy: user._id, referralRewarded: true }),
    PointLot.find({ userId: user._id, remaining: { $gt: 0 } }).sort({ expiresAt: 1 }).limit(100),
    canEnterReferral(user)
  ]);
  const doneMap = new Map(done.map((d) => [String(d.missionId), d]));
  const missionList = [];
  for (const m of missions) {
    const completed = doneMap.get(String(m._id));
    const progress = completed ? m.target : Math.min(m.target, await missionProgress(user, m));
    missionList.push({
      id: m._id, title: m.title, description: m.description, icon: m.icon, type: m.type, target: m.target, progress,
      completed: Boolean(completed), completedAt: completed ? completed.at : null,
      rewardPoints: m.rewardPoints, rewardVpln: m.rewardVpln, badge: m.badge, endsAt: m.endsAt || null, periodDays: m.periodDays
    });
  }
  let nextExpiry = null;
  if (program.expiry.enabled && lots.length && user.points > 0) {
    const first = new Date(lots[0].expiresAt);
    const amount = lots.filter((l) => new Date(l.expiresAt) - first <= 31 * 864e5).reduce((s, l) => s + l.remaining, 0);
    nextExpiry = { at: first, amount: Math.min(amount, user.points) };
  }
  res.json({
    success: true,
    data: {
      tier: tier ? { current: tier.current, next: tier.next, spent: tier.spent, toNext: tier.toNext, windowMonths: program.tiers.windowMonths } : null,
      levels: program.tiers.enabled ? program.tiers.levels : [],
      happyHour: happyHourPublic(activeHappyHour(location)),
      missions: missionList,
      badges: done.filter((d) => d.badge).map((d) => ({ name: d.badge, icon: d.icon, title: d.title, at: d.at })),
      referral: program.referral.enabled ? {
        code: user.referralCode, link: `${APP_URL}/app?ref=${encodeURIComponent(user.referralCode || '')}`, invited, rewarded,
        referrerPoints: program.referral.referrerPoints, refereePoints: program.referral.refereePoints, minSpent: program.referral.minSpent, canEnterCode: canRef
      } : null,
      birthday: program.birthday.enabled ? { date: user.birthday && user.birthday.month ? user.birthday : null, vpln: program.birthday.vpln, points: program.birthday.points } : null,
      expiry: program.expiry.enabled ? { months: program.expiry.months, next: nextExpiry } : null
    }
  });
}));

// Kod polecenia wpisany po rejestracji (do 14 dni, przed pierwszymi zakupami)
app.post('/api/me/referral', requireUser, asyncRoute(async (req, res) => {
  if (!(await canEnterReferral(req.user))) return res.status(400).json({ success: false, message: 'Kod polecenia można wpisać tylko na nowym koncie, przed pierwszymi zakupami.' });
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  const referrer = code ? await User.findOne({ referralCode: code }, '_id phoneNormalized') : null;
  if (!referrer || String(referrer._id) === String(req.user._id) || referrer.phoneNormalized === req.user.phoneNormalized) {
    return res.status(400).json({ success: false, message: 'Nie znamy takiego kodu polecenia.' });
  }
  await User.updateOne({ _id: req.user._id, referredBy: { $exists: false } }, { referredBy: referrer._id });
  res.json({ success: true, message: `Kod przyjęty. Po pierwszych zakupach od ${program.referral.minSpent} zł dostaniesz ${program.referral.refereePoints} Milkosów.` });
}));

// Data urodzin: klient ustawia ją raz (zmianę robi obsługa w panelu)
app.post('/api/me/birthday', requireUser, asyncRoute(async (req, res) => {
  if (req.user.birthday && req.user.birthday.month) return res.status(400).json({ success: false, message: 'Data urodzin jest już zapisana. Zmianę zrobi obsługa w lokalu.' });
  const bd = validBirthday(req.body && req.body.month, req.body && req.body.day);
  if (!bd) return res.status(400).json({ success: false, message: 'Wybierz poprawną datę.' });
  req.user.birthday = bd;
  req.user.birthdaySetAt = new Date();
  await req.user.save();
  res.json({ success: true, user: publicUser(req.user), message: 'Zapisane. Prezent czeka w dniu urodzin.' });
}));

// ==========================================
// --- KARTY PODARUNKOWE ---
// ==========================================
const GIFT_AMOUNTS = [50, 100, 150, 200];
const GIFT_MIN = 20;
const GIFT_MAX = 1000;
const GIFT_VALID_MONTHS = 12;
const GIFT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O i 1/I
const payuConfigured = () => Boolean(PAYU_POS_ID && PAYU_CLIENT_ID && PAYU_CLIENT_SECRET);
function giftCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += GIFT_ALPHABET[crypto.randomInt(GIFT_ALPHABET.length)];
  return `MILK-${s.slice(0, 4)}-${s.slice(4)}`;
}
function cleanGiftCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('MILK') ? s.slice(4) : s;
  return body.length === 8 ? `MILK-${body.slice(0, 4)}-${body.slice(4)}` : null;
}
async function activateGiftCard(card, { paidAt = new Date(), payuOrderId, actor }) {
  for (let i = 0; i < 10; i += 1) {
    try {
      return await GiftCard.findOneAndUpdate(
        { _id: card._id, status: 'awaiting_payment' },
        { status: 'active', code: giftCode(), balance: card.amount, paidAt, expiresAt: addMonths(paidAt, GIFT_VALID_MONTHS), payuOrderId, $push: { history: { action: 'aktywacja', amount: card.amount, actor } } },
        { new: true }
      );
    } catch (e) { if (e.code !== 11000) throw e; } // kod się powtórzył: losuj jeszcze raz
  }
  throw new Error('Nie udało się nadać kodu karty.');
}
const giftPublic = (c, withCode) => ({
  id: c._id, amount: c.amount, balance: c.balance, status: c.status, source: c.source, recipientName: c.recipientName, message: c.message,
  expiresAt: c.expiresAt, createdAt: c.createdAt, code: withCode ? c.code : undefined
});

app.get('/api/gift-cards/options', (req, res) => res.json({
  success: true, data: { amounts: GIFT_AMOUNTS, min: GIFT_MIN, max: GIFT_MAX, validMonths: GIFT_VALID_MONTHS, online: payuConfigured() }
}));

app.post('/api/gift-cards', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const key = `gift:${req.ip}`;
  if (tooManyAttempts(key, 10, 15 * 60 * 1000)) return res.status(429).json({ success: false, message: 'Za dużo prób. Spróbuj za kilka minut.' });
  recordFailure(key);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount < GIFT_MIN || amount > GIFT_MAX) return res.status(400).json({ success: false, message: `Wybierz kwotę od ${GIFT_MIN} do ${GIFT_MAX} zł.` });
  const buyerName = String(b.buyerName || '').trim().slice(0, 80);
  const buyerEmail = String(b.buyerEmail || '').trim().toLowerCase().slice(0, 120);
  if (buyerName.length < 2 || !/^\S+@\S+\.\S+$/.test(buyerEmail)) return res.status(400).json({ success: false, message: 'Podaj imię i e-mail kupującego.' });
  if (b.consent !== true) return res.status(400).json({ success: false, message: 'Zaakceptuj regulamin kart podarunkowych.' });
  if (!payuConfigured()) return res.status(503).json({ success: false, message: 'Płatność online jest chwilowo niedostępna. Kartę kupisz w lokalu.' });
  const card = await GiftCard.create({
    amount, balance: 0, status: 'awaiting_payment', source: 'online', buyerName, buyerEmail,
    buyerPhone: String(b.buyerPhone || '').slice(0, 20), recipientName: String(b.recipientName || '').trim().slice(0, 40),
    message: String(b.message || '').trim().slice(0, 200), viewToken: crypto.randomBytes(16).toString('hex')
  });
  try {
    const payu = await createPayuOrder({
      description: `Karta podarunkowa Milkshakebar ${amount} zł`, amount, extOrderId: `gc_${card._id}`,
      buyer: { email: buyerEmail, firstName: buyerName, ...(card.buyerPhone ? { phone: card.buyerPhone } : {}) },
      products: [{ name: `Karta podarunkowa ${amount} zł`, unitPrice: String(amount * 100), quantity: '1' }],
      continueUrl: `${APP_URL}/karty-podarunkowe?karta=${card._id}&t=${card.viewToken}`, customerIp: req.ip
    });
    if (payu.payuOrderId) await GiftCard.updateOne({ _id: card._id }, { payuOrderId: payu.payuOrderId });
    res.json({ success: true, redirectUrl: payu.redirectUrl, id: card._id, token: card.viewToken });
  } catch (e) {
    await GiftCard.updateOne({ _id: card._id }, { status: 'cancelled' });
    res.status(502).json({ success: false, message: 'Płatność online jest chwilowo niedostępna. Spróbuj za chwilę albo kup kartę w lokalu.' });
  }
}));

// Podgląd karty po powrocie z płatności (link z tokenem, bez logowania)
app.get('/api/gift-cards/:id', asyncRoute(async (req, res) => {
  const card = mongoose.isValidObjectId(req.params.id) ? await GiftCard.findById(req.params.id) : null;
  if (!card || !card.viewToken || String(req.query.t || '') !== card.viewToken) return res.status(404).json({ success: false, message: 'Nie znaleziono karty.' });
  res.json({ success: true, data: giftPublic(card, ['active', 'used'].includes(card.status)) });
}));

// Klient dodaje kartę do swojego portfela vPLN
app.post('/api/me/gift-cards/redeem', requireUser, asyncRoute(async (req, res) => {
  const key = `giftredeem:${req.user._id}`;
  if (tooManyAttempts(key, 10, 15 * 60 * 1000)) return res.status(429).json({ success: false, message: 'Za dużo prób. Spróbuj za kilka minut.' });
  const code = cleanGiftCode(req.body && req.body.code);
  const now = new Date();
  const card = code ? await GiftCard.findOneAndUpdate(
    { code, status: 'active', expiresAt: { $gt: now }, balance: { $gt: 0 } },
    { status: 'used', balance: 0, redeemedBy: req.user._id, redeemedAt: now, $push: { history: { action: 'do portfela MilkMi', actor: userDisplay(req.user) } } },
    { new: false }
  ) : null;
  if (!card) {
    recordFailure(key);
    const any = code ? await GiftCard.findOne({ code }) : null;
    const msg = !any ? 'Nie znamy takiego kodu. Sprawdź, czy jest wpisany dokładnie.'
      : any.status === 'used' ? 'Ta karta została już wykorzystana.'
        : any.status === 'cancelled' ? 'Ta karta jest anulowana.'
          : any.expiresAt && any.expiresAt <= now ? 'Ta karta straciła ważność.' : 'Tej karty nie można teraz użyć.';
    return res.status(400).json({ success: false, message: msg });
  }
  await GiftCard.updateOne({ _id: card._id, 'history.action': 'do portfela MilkMi' }, { $set: { 'history.$.amount': card.balance } });
  const user = await grantWallet(req.user._id, card.balance, `Karta podarunkowa ${card.code}`);
  res.json({ success: true, amount: card.balance, walletBalance: user.walletBalance, message: `Dodano ${card.balance.toFixed(2).replace(".", ",")} zł do portfela.` });
}));

// ==========================================
// --- KARTY PODARUNKOWE: PANEL ---
// ==========================================
app.get('/api/admin/gift-cards', requireAdmin(), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const code = cleanGiftCode(q);
  let filter = { status: { $ne: 'awaiting_payment' } };
  if (code) filter = { code };
  else if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter = { $or: [{ code: rx }, { recipientName: rx }, { buyerName: rx }, { buyerEmail: rx }] };
  }
  const [cards, agg] = await Promise.all([
    GiftCard.find(filter).sort({ createdAt: -1 }).limit(100),
    GiftCard.aggregate([{ $match: { status: 'active', expiresAt: { $gt: new Date() } } }, { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balance' } } }])
  ]);
  res.json({ success: true, data: cards, totals: { active: (agg[0] && agg[0].count) || 0, balance: round2((agg[0] && agg[0].balance) || 0) } });
}));

// Sprzedaż karty w kasie (klient płaci przy ladzie, karta od razu aktywna)
app.post('/api/admin/gift-cards', requireAdmin(), asyncRoute(async (req, res) => {
  const amount = round2(req.body && req.body.amount);
  if (!(amount >= 10 && amount <= 2000)) return res.status(400).json({ success: false, message: 'Kwota karty: od 10 do 2000 zł.' });
  const card = await GiftCard.create({
    amount, balance: 0, status: 'awaiting_payment', source: 'lokal',
    recipientName: String((req.body && req.body.recipientName) || '').trim().slice(0, 40),
    message: String((req.body && req.body.message) || '').trim().slice(0, 200)
  });
  const active = await activateGiftCard(card, { actor: req.admin.name });
  await audit(req, 'sprzedaż karty podarunkowej', active.code, `${amount.toFixed(2)} zł`);
  res.json({ success: true, data: giftPublic(active, true) });
}));

// Płatność kartą w kasie: zdejmuje część albo całość salda karty
app.post('/api/admin/gift-cards/:id/charge', requireAdmin(), asyncRoute(async (req, res) => {
  const amount = round2(req.body && req.body.amount);
  if (!isPositiveNumber(amount)) return res.status(400).json({ success: false, message: 'Podaj kwotę.' });
  const card = await GiftCard.findOneAndUpdate(
    { _id: req.params.id, status: 'active', expiresAt: { $gt: new Date() }, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $push: { history: { action: 'płatność w kasie', amount, actor: req.admin.name } } },
    { new: true }
  );
  if (!card) {
    const any = mongoose.isValidObjectId(req.params.id) ? await GiftCard.findById(req.params.id) : null;
    const msg = !any ? 'Nie znaleziono karty.' : any.status !== 'active' ? 'Karta nie jest aktywna.' : any.expiresAt <= new Date() ? 'Karta straciła ważność.' : `Na karcie jest tylko ${any.balance.toFixed(2)} zł.`;
    return res.status(400).json({ success: false, message: msg });
  }
  card.balance = round2(card.balance);
  if (card.balance <= 0) card.status = 'used';
  await GiftCard.updateOne({ _id: card._id }, { balance: card.balance, status: card.status });
  await audit(req, 'płatność kartą podarunkową', card.code, `${amount.toFixed(2)} zł, zostało ${card.balance.toFixed(2)} zł`);
  res.json({ success: true, data: giftPublic(card, true) });
}));

app.post('/api/admin/gift-cards/:id/cancel', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const card = await GiftCard.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['active', 'awaiting_payment'] } },
    { status: 'cancelled', $push: { history: { action: 'anulowanie', actor: req.admin.name } } },
    { new: true }
  );
  if (!card) return res.status(400).json({ success: false, message: 'Tej karty nie można anulować.' });
  await audit(req, 'anulowanie karty podarunkowej', card.code || String(card._id), '');
  res.json({ success: true });
}));

// ==========================================
// --- PROGRAM MILKMI: PANEL ---
// ==========================================
const intIn = (v, min, max, fallback) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const numIn = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, round2(n))) : fallback; };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/admin/program', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location === 'rowy' ? 'rowy' : 'slupsk';
  const [referrals, completions, giftAgg] = await Promise.all([
    User.countDocuments({ referralRewarded: true }),
    MissionCompletion.estimatedDocumentCount(),
    GiftCard.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, balance: { $sum: '$balance' } } }])
  ]);
  res.json({ success: true, data: program, stats: { referrals, completions, giftBalance: round2((giftAgg[0] && giftAgg[0].balance) || 0), activeHappyHour: happyHourPublic(activeHappyHour(location)) } });
}));

app.put('/api/admin/program', requireAdmin('owner'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const next = clone(program);
  if (b.tiers) {
    const levels = (Array.isArray(b.tiers.levels) ? b.tiers.levels : []).slice(0, 6)
      .filter((l) => l && String(l.name || '').trim())
      .map((l, i) => ({
        key: String(l.key || normText(l.name).replace(/[^a-z0-9]/g, '') || `poziom${i}`).slice(0, 20),
        name: String(l.name).trim().slice(0, 20), minSpent: numIn(l.minSpent, 0, 1000000, 0), multiplier: numIn(l.multiplier, 1, 5, 1)
      }))
      .sort((a, c) => a.minSpent - c.minSpent);
    if (!levels.length) return res.status(400).json({ success: false, message: 'Dodaj co najmniej jeden poziom.' });
    levels[0].minSpent = 0;
    next.tiers = { enabled: Boolean(b.tiers.enabled), windowMonths: intIn(b.tiers.windowMonths, 1, 36, 12), levels };
  }
  if (b.referral) next.referral = { enabled: Boolean(b.referral.enabled), referrerPoints: intIn(b.referral.referrerPoints, 0, 1000, 20), refereePoints: intIn(b.referral.refereePoints, 0, 1000, 20), minSpent: numIn(b.referral.minSpent, 0, 10000, 20) };
  if (b.birthday) next.birthday = { enabled: Boolean(b.birthday.enabled), vpln: numIn(b.birthday.vpln, 0, 500, 10), points: intIn(b.birthday.points, 0, 1000, 0) };
  if (b.expiry) next.expiry = { enabled: Boolean(b.expiry.enabled), months: intIn(b.expiry.months, 1, 60, 12), warnDays: intIn(b.expiry.warnDays, 1, 90, 30) };
  if (b.company) next.company = Object.fromEntries(['name', 'address', 'nip', 'email'].map((k) => [k, String(b.company[k] || '').trim().slice(0, 160)]));
  program = next;
  await AppConfig.findOneAndUpdate({ key: 'program' }, { value: program }, { upsert: true });
  await audit(req, 'zmiana programu MilkMi', '', ['tiers', 'referral', 'birthday', 'expiry', 'company'].filter((k) => b[k]).join(', '));
  res.json({ success: true, data: program });
}));

app.put('/api/admin/happy-hours', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const list = Array.isArray(req.body && req.body.happyHours) ? req.body.happyHours.slice(0, 20) : null;
  if (!list) return res.status(400).json({ success: false, message: 'Brak listy.' });
  const clean = [];
  for (const h of list) {
    const days = [...new Set((Array.isArray(h.days) ? h.days : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (!days.length || !HM.test(String(h.from)) || !HM.test(String(h.to)) || h.from >= h.to) {
      return res.status(400).json({ success: false, message: `Sprawdź dni i godziny w „${h.name || 'Happy hour'}” (koniec musi być po początku).` });
    }
    clean.push({
      id: String(h.id || crypto.randomBytes(4).toString('hex')).slice(0, 20), name: String(h.name || 'Happy hour').trim().slice(0, 40),
      days, from: h.from, to: h.to, multiplier: numIn(h.multiplier, 1.1, 5, 2),
      location: ['slupsk', 'rowy'].includes(h.location) ? h.location : 'all', active: h.active !== false
    });
  }
  program = { ...program, happyHours: clean };
  await AppConfig.findOneAndUpdate({ key: 'program' }, { value: program }, { upsert: true });
  await audit(req, 'happy hours', '', clean.map((h) => `${h.name} ${h.from}-${h.to} ×${h.multiplier}${h.active ? '' : ' (wył.)'}`).join('; '));
  res.json({ success: true, data: clean, active: happyHourPublic(activeHappyHour(req.query.location === 'rowy' ? 'rowy' : 'slupsk')) });
}));

function missionFields(b = {}) {
  const title = String(b.title || '').trim().slice(0, 60);
  if (title.length < 2) return { error: 'Podaj nazwę misji.' };
  const type = ['visits', 'spend', 'orders', 'product'].includes(b.type) ? b.type : 'visits';
  const target = type === 'spend' ? numIn(b.target, 1, 100000, 0) : intIn(b.target, 1, 1000, 0);
  if (!(target > 0)) return { error: 'Podaj cel misji (liczbę większą od zera).' };
  const productQuery = String(b.productQuery || '').trim().slice(0, 40);
  if (type === 'product' && productQuery.length < 2) return { error: 'Wpisz, jaki produkt liczymy (np. shake).' };
  const rewardPoints = intIn(b.rewardPoints, 0, 10000, 0);
  const rewardVpln = numIn(b.rewardVpln, 0, 1000, 0);
  const badge = String(b.badge || '').trim().slice(0, 30);
  if (!rewardPoints && !rewardVpln && !badge) return { error: 'Dodaj nagrodę: Milkosy, vPLN albo odznakę.' };
  const startsAt = b.startsAt ? new Date(b.startsAt) : new Date();
  const endsAt = b.endsAt ? new Date(b.endsAt) : null;
  if (Number.isNaN(startsAt.getTime()) || (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt))) return { error: 'Sprawdź daty misji.' };
  return {
    fields: {
      title, description: String(b.description || '').trim().slice(0, 200), icon: String(b.icon || '🏅').trim().slice(0, 8) || '🏅',
      type, target, productQuery, periodDays: intIn(b.periodDays, 0, 365, 0), rewardPoints, rewardVpln, badge,
      active: b.active !== false, startsAt, endsAt
    }
  };
}
app.get('/api/admin/missions', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const [missions, counts] = await Promise.all([
    Mission.find().sort({ createdAt: -1 }),
    MissionCompletion.aggregate([{ $group: { _id: '$missionId', n: { $sum: 1 } } }])
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({ success: true, data: missions.map((m) => ({ ...m.toObject(), completions: byId.get(String(m._id)) || 0 })) });
}));
app.post('/api/admin/missions', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { fields, error } = missionFields(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  const m = await Mission.create(fields);
  await audit(req, 'nowa misja', m.title, `${m.type} ${m.target}`);
  res.json({ success: true, data: m });
}));
app.put('/api/admin/missions/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { fields, error } = missionFields(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  const m = await Mission.findByIdAndUpdate(req.params.id, fields, { new: true });
  if (!m) return res.status(404).json({ success: false, message: 'Nie znaleziono misji.' });
  await audit(req, 'edycja misji', m.title, '');
  res.json({ success: true, data: m });
}));
app.patch('/api/admin/missions/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const m = await Mission.findByIdAndUpdate(req.params.id, { active: Boolean(req.body && req.body.active) }, { new: true });
  if (!m) return res.status(404).json({ success: false, message: 'Nie znaleziono misji.' });
  await audit(req, m.active ? 'włączenie misji' : 'wyłączenie misji', m.title, '');
  res.json({ success: true, data: m });
}));
app.delete('/api/admin/missions/:id', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const m = await Mission.findByIdAndDelete(req.params.id);
  if (m) await audit(req, 'usunięcie misji', m.title, 'zdobyte odznaki zostają u klientów');
  res.json({ success: true });
}));
app.get('/api/admin/missions/:id/completions', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const list = await MissionCompletion.find({ missionId: req.params.id }).sort({ at: -1 }).limit(200);
  const users = new Map((await User.find({ _id: { $in: list.map((c) => c.userId) } }, 'name username phone')).map((u) => [String(u._id), u]));
  res.json({ success: true, data: list.map((c) => ({ at: c.at, user: users.has(String(c.userId)) ? userDisplay(users.get(String(c.userId))) : 'konto usunięte' })) });
}));

// --- 404 I BŁĘDY ---
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Nie znaleziono.' }));
app.use((req, res) => res.redirect('/'));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ success: false, message: 'Zdjęcie jest za duże (max 8 MB).' });
  console.error('❌ Błąd serwera:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: 'Błąd serwera. Spróbuj ponownie.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serwer MilkMi działa na porcie ${PORT}`));
  // Co godzinę: wygasanie Milkosów i przypomnienia, prezenty urodzinowe, porzucone płatności
  ready.then(() => {
    setTimeout(runScheduledJobs, 60 * 1000);
    setInterval(runScheduledJobs, 60 * 60 * 1000);
  });
}
module.exports = { app, ready, normalizePhone, jobs: { runExpiry, runBirthdays, runStaleOrders, autoImportKarta } };
