'use strict';
// Modele bazy danych (Mongoose) i pomocnicze funkcje używane przez modele.
const mongoose = require('mongoose');

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
  // Kiedy zamówienie dostało dany status (do liczenia czasu realizacji)
  statusAt: { pending: Date, preparing: Date, ready: Date, completed: Date, cancelled: Date },
  // Pełna historia zmian statusu: kto i kiedy (panel pokazuje ją przy zamówieniu)
  statusHistory: [{ status: String, at: { type: Date, default: Date.now }, actor: String, note: String, _id: false }],
  estimatedReadyAt: Date, // kiedy będzie gotowe (ustawia obsługa przy przyjęciu)
  cancelReason: String, // powód anulowania widoczny dla klienta
  internalNote: String, // notatka obsługi, klient jej nie widzi
  hasBreakfast: { type: Boolean, default: false }, // w koszyku są śniadania (podawane do określonej godziny)
  viewToken: String, // link do statusu zamówienia bez logowania
  createdAt: { type: Date, default: Date.now, index: true }
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
  breakfastUntil: String, // HH:MM, do kiedy można zamawiać i odbierać śniadania
  // Godziny zamówień online (osobno od godzin otwarcia): lib/orderWindow.js
  orderHoursMode: String, // opening | custom | always
  orderSchedule: mongoose.Schema.Types.Mixed, // własne godziny zamówień na każdy dzień
  lastOrderBeforeClose: Number, // min przed końcem: ostatnie zamówienie
  lastReadyBeforeClose: Number, // min przed końcem: najpóźniejszy odbiór / dostawa
  maxAheadMinutes: Number, // na ile do przodu (0 = do końca dnia)
  ordersBeforeOpen: Boolean, // zamówienia na później przed otwarciem
  pausedUntil: Date, // wstrzymanie przyjmowania zamówień z panelu (np. na 30 min)
  busyExtraMinutes: Number, // tryb „dużo zamówień”: dodatkowe minuty przygotowania
  busyUntil: Date,
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
  userIds: [mongoose.Schema.Types.ObjectId], // klienci, do których poszło (skuteczność kampanii)
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

// Limity prób (logowanie, PIN-y, kody kart) trzymane w bazie: działają po restarcie i przy kilku instancjach.
// Dokument znika sam po wygaśnięciu okna (indeks TTL).
const RateLimit = mongoose.model('RateLimit', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
}));

module.exports = {
  normalizePhone, pushHistory, User, PointTransaction, WalletTransaction, Reservation, Counter, Order, Banner, CategoryBanner, UpsellConfig, StoreSettings, Product, LocationHours, StaffMember, Shift, StockItem, PushSubscription, PushCampaign, Subscriber, PageView, AuditLog, AppConfig, PointLot, Mission, MissionCompletion, GiftCard, RateLimit
};
