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
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
};
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
app.get(['/zamów', '/zamow', '/zam%C3%B3w'], sendPage('zamów.html'));
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
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
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
  source: { type: String, default: 'kasa' }, // kasa, zamowienie, korekta
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

const StoreSettings = mongoose.model('StoreSettings', new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  ordersEnabled: { type: Boolean, default: true },
  pickupEnabled: { type: Boolean, default: true },
  deliveryEnabled: { type: Boolean, default: false },
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
  role: { type: String, enum: ['cashier', 'manager', 'owner'], default: 'cashier' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
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

// --- KONFIGURACJA ---
const ADMIN_PIN = process.env.ADMIN_PIN;
// Klucz, którym stara wersja podpisywała tokeny (był wpisany w kod). Służy tylko do jednorazowej wymiany starego logowania na nowe.
const LEGACY_JWT_SECRET = 'super_tajny_klucz_zmien_go_w_produkcji';
const LEGACY_SESSIONS_UNTIL = new Date(process.env.LEGACY_SESSIONS_UNTIL || '2027-02-01T00:00:00Z');
const USER_TOKEN_TTL = '180d';
const ADMIN_TOKEN_TTL = '14h';

const DEFAULT_LOYALTY = { zlotyPerPoint: 10, vplnPerPoint: 1, exchangeOptions: [10, 20, 50, 100, 200, 500] };

const ORDER_CONFIG = {
  packagingFee: 2,
  mealSetPrice: 10,
  deliveryFee: 8,
  freeDeliveryThreshold: 80,
  setCategories: ['burgery', 'startery', 'kanapki', 'dania_glowne']
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

let jwtSecret = process.env.JWT_SECRET || null;
let loyalty = { ...DEFAULT_LOYALTY };

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

  const missing = await User.find({ $or: [{ phoneNormalized: { $exists: false } }, { phoneNormalized: null }] }, 'phone').lean();
  if (missing.length) {
    await User.bulkWrite(missing.map((u) => ({
      updateOne: { filter: { _id: u._id }, update: { $set: { phoneNormalized: normalizePhone(u.phone) } } }
    })));
    console.log(`📱 Ujednolicono numery telefonów: ${missing.length} kont`);
  }
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
const userDisplay = (user) => `${user.username} (${user.phone})`;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    points: user.points,
    walletBalance: user.walletBalance || 0,
    redeemedPoints: user.redeemedPoints || 0,
    activeRewards: user.activeRewards || [],
    createdAt: user.createdAt
  };
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
  const member = await StaffMember.create({ name: String(name).trim(), pinHash: await bcrypt.hash(String(pin), 10), role });
  await audit(req, 'dodanie pracownika', member.name, role);
  res.json({ success: true, data: { _id: member._id, name: member.name, role: member.role, active: member.active } });
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
    filter = { $or: [{ username: rx }, { email: rx }, ...(phone.length >= 3 ? [{ phoneNormalized: new RegExp(escapeRegex(phone)) }] : [])] };
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
  const [points, wallet, orders, reservations] = await Promise.all([
    PointTransaction.find({ userId: user._id }).sort({ date: -1 }).limit(30),
    WalletTransaction.find({ userId: user._id }).sort({ date: -1 }).limit(30),
    Order.find({ phoneNormalized: user.phoneNormalized }).sort({ createdAt: -1 }).limit(20),
    Reservation.find({ $or: [{ userId: user._id }, { phoneNormalized: user.phoneNormalized }] }).sort({ createdAt: -1 }).limit(20)
  ]);
  res.json({ success: true, data: { user, points, wallet, orders, reservations } });
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
  await PointTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amountSpent: 0, pointsAwarded: delta, source: 'korekta', actor: req.admin.name });
  await audit(req, action === 'add' ? 'dodanie punktów' : 'odjęcie punktów', userDisplay(user), `${amount} pkt: ${reason || ''}`);
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

  const updated = await User.findByIdAndUpdate(user._id, {
    $inc: { points }, $push: pushHistory(`+ ${points} pkt • Zakupy w lokalu (${amountSpent.toFixed(2)} zł)`)
  }, { new: true });
  const tx = await PointTransaction.create({
    userId: user._id, userDisplay: userDisplay(user), amountSpent, pointsAwarded: points,
    source: 'kasa', location: location || 'slupsk', actor: req.admin.name
  });
  await audit(req, 'nabicie punktów', userDisplay(user), `${amountSpent} zł → ${points} pkt`);
  res.json({ success: true, message: `Dodano ${points} pkt do konta klienta ${user.username}!`, points, totalPoints: updated.points, transactionId: tx._id });
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
const defaultSettings = (location) => ({ location, ordersEnabled: true, pickupEnabled: true, deliveryEnabled: false });

app.get('/api/settings', asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const settings = await StoreSettings.findOne({ location });
  res.json({ success: true, data: settings || defaultSettings(location) });
}));

app.get('/api/admin/settings', requireAdmin(), asyncRoute(async (req, res) => {
  const location = req.query.location || 'slupsk';
  const settings = await StoreSettings.findOne({ location });
  res.json({ success: true, settings: settings || defaultSettings(location) });
}));

app.post('/api/admin/settings', requireAdmin('manager'), asyncRoute(async (req, res) => {
  const { location = 'slupsk', ordersEnabled, pickupEnabled, deliveryEnabled } = req.body || {};
  const updated = await StoreSettings.findOneAndUpdate(
    { location },
    { ordersEnabled: Boolean(ordersEnabled), pickupEnabled: Boolean(pickupEnabled), deliveryEnabled: Boolean(deliveryEnabled), updatedAt: Date.now() },
    { new: true, upsert: true }
  );
  await audit(req, 'ustawienia lokalu', location, `zamówienia ${ordersEnabled}, odbiór ${pickupEnabled}, dostawa ${deliveryEnabled}`);
  res.json({ success: true, message: 'Ustawienia lokalu zaktualizowane', data: updated });
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
async function priceOrder(body, location) {
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
      const setAllowed = ORDER_CONFIG.setCategories.includes(p.categoryId) && p.allowSet !== false;
      if (item.set) {
        if (!setAllowed) throw Object.assign(new Error(`Do „${p.name}” nie można dobrać zestawu.`), { status: 409 });
        unit += ORDER_CONFIG.mealSetPrice;
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
  const packagingFee = ORDER_CONFIG.packagingFee;
  const deliveryFee = isDelivery && subtotal < ORDER_CONFIG.freeDeliveryThreshold ? ORDER_CONFIG.deliveryFee : 0;
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

app.post('/api/orders', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const location = body.location || 'slupsk';
  const settings = await StoreSettings.findOne({ location });
  if (settings && !settings.ordersEnabled) {
    return res.status(403).json({ success: false, message: 'Lokal jest w tej chwili zamknięty na zamówienia online.' });
  }
  const isDelivery = body.deliveryMethod === 'delivery';
  if (isDelivery && !(settings && settings.deliveryEnabled)) {
    return res.status(403).json({ success: false, message: 'Dostawa jest chwilowo niedostępna.' });
  }
  if (!String(body.customerName || '').trim() || normalizePhone(body.customerPhone).length < 9) {
    return res.status(400).json({ success: false, message: 'Podaj imię i poprawny numer telefonu.' });
  }

  // Ponowne wysłanie tego samego zamówienia (np. przy słabym zasięgu) nie tworzy duplikatu
  if (body.clientOrderId) {
    const existing = await Order.findOne({ clientOrderId: String(body.clientOrderId) });
    if (existing && existing.status !== 'awaiting_payment') {
      return res.json({ success: true, orderId: existing._id, orderNumber: existing.orderNumber, message: 'Zamówienie zostało przyjęte!' });
    }
  }

  let priced;
  try {
    priced = await priceOrder(body, location);
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message, code: err.code });
  }
  if (body.totalAmount !== undefined && Math.abs(Number(body.totalAmount) - priced.totalAmount) > 0.01) {
    console.warn(`⚠️ Różnica ceny zamówienia: klient ${body.totalAmount}, serwer ${priced.totalAmount}`);
    return res.status(409).json({ success: false, code: 'price_changed', message: `Ceny w menu się zmieniły. Aktualna kwota to ${priced.totalAmount.toFixed(2)} zł. Odśwież stronę i złóż zamówienie ponownie.` });
  }

  const counter = await Counter.findOneAndUpdate({ id: 'orderNum' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const orderNumber = `MI-${String(((counter.seq - 1) % 9999) + 1).padStart(4, '0')}`;
  const isOnlinePayment = body.paymentMethod === 'online';

  const newOrder = await Order.create({
    orderNumber,
    clientOrderId: body.clientOrderId ? String(body.clientOrderId) : undefined,
    customerName: String(body.customerName).trim().slice(0, 80),
    customerPhone: String(body.customerPhone || '').trim().slice(0, 20),
    phoneNormalized: normalizePhone(body.customerPhone),
    customerEmail: body.customerEmail ? String(body.customerEmail).slice(0, 120) : undefined,
    pickupTime: String(body.pickupTime || '').slice(0, 40),
    notes: String(body.notes || '').slice(0, 500),
    deliveryMethod: isDelivery ? 'delivery' : 'pickup',
    deliveryAddress: isDelivery ? String(body.deliveryAddress || '').slice(0, 200) : '',
    paymentMethod: ['cash', 'card', 'online', 'prepaid'].includes(body.paymentMethod) ? body.paymentMethod : 'cash',
    source: body.source || 'web',
    location,
    ...priced,
    status: isOnlinePayment ? 'awaiting_payment' : 'pending'
  });

  if (!isOnlinePayment) {
    return res.json({ success: true, orderId: newOrder._id, orderNumber, message: 'Zamówienie zostało przyjęte!' });
  }

  const token = await getPayUToken();
  const payuRes = await fetch(`${PAYU_BASE_URL}/api/v2_1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      notifyUrl: `${APP_URL}/api/payu/notify`,
      continueUrl: `${APP_URL}/zamów`,
      customerIp: req.ip || '127.0.0.1',
      merchantPosId: PAYU_POS_ID,
      description: `Zamówienie ${orderNumber}`,
      currencyCode: 'PLN',
      totalAmount: String(Math.round(newOrder.totalAmount * 100)),
      extOrderId: String(newOrder._id),
      buyer: { email: body.customerEmail || 'brak@email.pl', phone: newOrder.customerPhone, firstName: newOrder.customerName },
      products: [
        ...newOrder.items.map((i) => ({ name: i.name, unitPrice: String(Math.round(i.price * 100)), quantity: String(i.quantity) })),
        { name: 'Opakowania', unitPrice: String(Math.round(newOrder.packagingFee * 100)), quantity: '1' },
        ...(newOrder.deliveryFee ? [{ name: 'Dostawa', unitPrice: String(Math.round(newOrder.deliveryFee * 100)), quantity: '1' }] : [])
      ]
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
  if (payuData.orderId) await Order.updateOne({ _id: newOrder._id }, { payuOrderId: payuData.orderId });
  res.json({ success: true, redirectUrl, orderId: newOrder._id, orderNumber, message: 'Przekierowanie do płatności...' });
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
  if (order && order.status === 'COMPLETED' && mongoose.isValidObjectId(order.extOrderId)) {
    const dbOrder = await Order.findById(order.extOrderId);
    if (dbOrder && dbOrder.status === 'awaiting_payment' && Number(order.totalAmount) === Math.round(dbOrder.totalAmount * 100)) {
      dbOrder.status = 'pending';
      dbOrder.payuOrderId = order.orderId || dbOrder.payuOrderId;
      await dbOrder.save();
      console.log(`💰 Zamówienie ${dbOrder.orderNumber} opłacone przez PayU.`);
    }
  }
  res.status(200).send('OK');
}));

// Status zamówienia dla klienta: bez danych osobowych
app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
  const order = await Order.findById(req.params.id, 'orderNumber status items totalAmount subtotal packagingFee deliveryFee deliveryMethod paymentMethod pickupTime createdAt');
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
async function awardOrderPoints(order, req) {
  if (order.pointsAwarded || !order.phoneNormalized) return 0;
  const points = Math.floor(Number(order.totalAmount) / loyalty.zlotyPerPoint);
  if (points <= 0) return 0;
  const users = await User.find({ phoneNormalized: order.phoneNormalized, blocked: { $ne: true } });
  if (users.length !== 1) return 0;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, pointsAwarded: { $in: [0, null] } }, { pointsAwarded: points });
  if (!claimed) return 0;
  const user = users[0];
  await User.updateOne({ _id: user._id }, { $inc: { points }, $push: pushHistory(`+ ${points} pkt • Zamówienie ${order.orderNumber}`) });
  await PointTransaction.create({
    userId: user._id, userDisplay: userDisplay(user), amountSpent: order.totalAmount, pointsAwarded: points,
    source: 'zamowienie', orderId: String(order._id), location: order.location, actor: req.admin ? req.admin.name : 'system'
  });
  return points;
}

app.post('/api/admin/orders/:id/status', requireAdmin(), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Nieznany status.' });
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
  let points = 0;
  if (status === 'completed') points = await awardOrderPoints(order, req);
  await audit(req, 'status zamówienia', order.orderNumber, status + (points ? `, +${points} pkt` : ''));
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
    notes: String(notes || '').slice(0, 500), location: location === 'rowy' ? 'rowy' : 'slupsk', status: 'pending'
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
  if (r) await audit(req, 'status rezerwacji', `${r.name} ${r.datetime}`, status);
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
  const products = await Product.find({
    $or: [{ location }, { location: { $exists: false } }, { location: null }, { location: '' }]
  }).sort({ categoryId: 1, name: 1 });
  res.json({ success: true, data: products });
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
app.post('/api/register', asyncRoute(async (req, res) => {
  const { username, email, phone, password } = req.body || {};
  if (!username || !email || !phone || !password) return res.status(400).json({ message: 'Wszystkie pola są wymagane.' });

  const cleanUsername = String(username).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPhone = normalizePhone(phone);
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ message: 'Podaj poprawny adres e-mail.' });
  if (cleanPhone.length !== 9) return res.status(400).json({ message: 'Podaj numer telefonu z 9 cyframi.' });
  if (String(password).length < 6) return res.status(400).json({ message: 'Hasło musi mieć co najmniej 6 znaków.' });

  if (await User.exists({ $or: [{ email: cleanEmail }, { username: cleanUsername }] })) {
    return res.status(409).json({ message: 'Użytkownik o takim emailu lub loginie już istnieje.' });
  }
  if (await User.exists({ phoneNormalized: cleanPhone })) {
    return res.status(409).json({ message: 'Ten numer telefonu ma już konto. Zaloguj się albo skontaktuj się z lokalem.' });
  }

  await User.create({ username: cleanUsername, email: cleanEmail, phone: cleanPhone, password: await bcrypt.hash(String(password), 10) });
  console.log(`🆕 Zarejestrowano: ${cleanUsername}`);
  res.status(201).json({ message: 'Konto zostało pomyślnie utworzone.' });
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
  const { username, phone } = req.body || {};
  if (username !== undefined) {
    const clean = String(username).trim();
    if (clean.length < 2) return res.status(400).json({ success: false, message: 'Imię jest za krótkie.' });
    if (clean !== user.username && await User.exists({ username: clean })) {
      return res.status(409).json({ success: false, message: 'Ta nazwa jest zajęta.' });
    }
    user.username = clean;
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
  const data = await Order.find({ phoneNormalized: req.user.phoneNormalized, status: { $ne: 'awaiting_payment' } }, 'orderNumber status totalAmount items createdAt deliveryMethod pointsAwarded').sort({ createdAt: -1 }).limit(20);
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
  await WalletTransaction.create({ userId: user._id, userDisplay: userDisplay(user), amount: vplnAmount, action: 'add', reason: `Wymiana ${pointsCost} Milkosów`, actor: 'klient' });
  res.json({
    success: true, points: user.points, walletBalance: user.walletBalance, history: user.history,
    message: `Pomyślnie zamieniono ${pointsCost} pkt na ${vplnAmount.toFixed(2)} PLN!`
  });
}));

app.get('/api/health', (req, res) => res.json({ ok: mongoose.connection.readyState === 1 }));

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
}
module.exports = { app, ready, normalizePhone };
