require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const multer = require('multer'); // do obsługi plików (zdjęć)
const fs = require('fs'); // do obsługi systemu plików

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());

// Serwowanie plików statycznych z folderu głównego (CSS, obrazy, JS frontendu)
app.use(express.static(__dirname));

// --- OBSŁUGA ZDJĘĆ (MULTER) ---
// Tworzymy folder 'uploads', jeśli nie istnieje
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Konfiguracja nazw plików i miejsca zapisu
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'menu-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage });

// Udostępniamy folder 'uploads' publicznie, aby aplikacja mogła czytać zdjęcia
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// --- TRASY FRONTENDU (WIDOKI) ---

// Trasa główna - serwuje aplikację kliencką
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// Trasa panelu admina - serwuje admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Trasa pod /zamów (oraz alternatywna /zamow bez polskich znaków)
app.get('/zamów', (req, res) => {
  res.sendFile(path.join(__dirname, 'zamow.html'));
});

app.get('/zamow', (req, res) => {
  res.sendFile(path.join(__dirname, 'zamow.html'));
});

// --- BAZA DANYCH MONGO DB ---

// Szukamy zmiennej pod różnymi nazwami, których używa Railway
const MONGO_URI = process.env.MONGO_URL || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/milkmi_db';

console.log('🛠️ Aplikacja widzi ten adres bazy:', MONGO_URI);

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000, // Zamyka zawieszone połączenia
  maxPoolSize: 50         // Utrzymuje do 50 otwartych połączeń dla lepszej wydajności
})
  .then(() => {
    console.log('✅ Pomyślnie połączono z bazą MongoDB');
  })
  .catch((err) => {
    console.error('❌ Błąd połączenia z bazą danych:', err.message);
  });

// --- SCHEMAT UŻYTKOWNIKA (Klienci aplikacji) ---
const userSchema = new mongoose.Schema({
  username: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true, 
    lowercase: true 
  },
  phone: { 
    type: String, 
    required: true, 
    trim: true 
  },
  password: { 
    type: String, 
    required: true 
  },
  points: { 
    type: Number, 
    default: 0 
  },
  walletBalance: { 
    type: Number, 
    default: 0 
  },
  redeemedPoints: { 
    type: Number, 
    default: 0 
  },
  activeRewards: [{
    rewardId: String,
    name: String,
    cost: Number,
    dateClaimed: { type: Date, default: Date.now }
  }],
  history: [{
      text: String,
      date: { type: String, default: () => new Date().toLocaleString('pl-PL') }
  }],
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

const User = mongoose.model('User', userSchema);

// --- SCHEMAT TRANSAKCJI (Globalna historia z kasy dla admina) ---
const pointTransactionSchema = new mongoose.Schema({
    userDisplay: String, 
    amountSpent: Number,
    pointsAwarded: Number,
    date: { 
      type: Date, 
      default: Date.now 
    }
});

const PointTransaction = mongoose.model('PointTransaction', pointTransactionSchema);

// --- SCHEMAT TRANSAKCJI PORTFELA (PRE-PAID) ---
const walletTransactionSchema = new mongoose.Schema({
    userDisplay: String,
    amount: Number,
    action: String, // 'add' (wpłata) lub 'remove' (pobranie)
    date: { 
        type: Date, 
        default: Date.now 
    }
});

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

// --- SCHEMAT REZERWACJI ---
const reservationSchema = new mongoose.Schema({
  name: String,
  phone: String,
  datetime: String,
  guests: Number,
  zone: String,
  notes: String,
  status: { type: String, default: 'pending' }, // 'pending', 'accepted', 'rejected'
  createdAt: { type: Date, default: Date.now }
});

const Reservation = mongoose.model('Reservation', reservationSchema);

// --- SCHEMAT LICZNIKA (Dla numeracji zamówień MI-XXXX) ---
const counterSchema = new mongoose.Schema({
  id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// --- SCHEMAT ZAMÓWIENIA ---
const orderSchema = new mongoose.Schema({
  orderNumber: String,
  customerName: String,
  customerPhone: String,
  pickupTime: String,
  notes: String,
  items: Array,
  totalAmount: Number,
  paymentMethod: String,
  deliveryMethod: { type: String, default: 'pickup' },
  deliveryAddress: { type: String, default: '' },
  location: { type: String, default: 'slupsk' },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// --- SCHEMAT USTAWIEŃ BANERÓW ---
const bannerSchema = new mongoose.Schema({
  target: { type: String, required: true, unique: true }, // 'app' lub 'web'
  isActive: { type: Boolean, default: false },
  text: { type: String, default: '' },
  backgroundColor: { type: String, default: '#FF6600' },
  updatedAt: { type: Date, default: Date.now }
});

const Banner = mongoose.model('Banner', bannerSchema);

// --- SCHEMAT GRAFIK KATEGORII I PODKATEGORII ---
const categoryBannerSchema = new mongoose.Schema({
  categoryId: { type: String, required: true, unique: true }, // np. 'cat_burgery', 'sub_desery_wloskie'
  imageUrl: { type: String, required: true },
  location: { type: String, default: 'slupsk' },
  updatedAt: { type: Date, default: Date.now }
});
const CategoryBanner = mongoose.model('CategoryBanner', categoryBannerSchema);

// --- SCHEMAT SZYBKICH DODATKÓW W KOSZYKU (UPSELL Z OPCJĄ ZDJĘĆ) ---
const upsellSchema = new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  items: [{
    id: String,
    name: String,
    price: Number,
    img: String
  }],
  updatedAt: { type: Date, default: Date.now }
});
const UpsellConfig = mongoose.model('UpsellConfig', upsellSchema);

// --- SCHEMAT USTAWIEŃ LOKALU ---
const storeSettingsSchema = new mongoose.Schema({
  location: { type: String, required: true, unique: true },
  ordersEnabled: { type: Boolean, default: true },
  pickupEnabled: { type: Boolean, default: true },
  deliveryEnabled: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});

const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);

// --- SCHEMAT PRODUKTU (MENU) ---
const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number }, 
  imageUrl: { type: String, required: true },
  categoryId: { type: String, required: true },
  location: { type: String, default: 'slupsk' },
  
  hasVariants: { type: Boolean, default: false },
  variants: [{
    name: { type: String },
    price: { type: Number }
  }],

  // Domyślnie wyłączona opcja zestawów, włączana celowo tylko dla burgerów/dań
  allowSet: { type: Boolean, default: false },
  addons: [{
    id: { type: String },
    name: { type: String },
    price: { type: Number }
  }],

  isBestseller: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// --- SCHEMAT GODZIN OTWARCIA ---
const hoursSchema = new mongoose.Schema({
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
});

const LocationHours = mongoose.model('LocationHours', hoursSchema);

// --- ZMIENNE ŚRODOWISKOWE ---
const JWT_SECRET = process.env.JWT_SECRET || 'super_tajny_klucz_zmien_go_w_produkcji';
const ADMIN_PIN = process.env.ADMIN_PIN || '12345'; 

// --- KONFIGURACJA PAYU ---
const PAYU_POS_ID = process.env.PAYU_POS_ID;
const PAYU_CLIENT_ID = process.env.PAYU_CLIENT_ID;
const PAYU_CLIENT_SECRET = process.env.PAYU_CLIENT_SECRET;
const PAYU_BASE_URL = process.env.PAYU_ENV === 'secure' 
  ? 'https://secure.payu.com' 
  : 'https://secure.snd.payu.com';
const APP_URL = process.env.APP_URL || 'https://twoja-domena.railway.app';

// Funkcja do pobierania tokena dostępowego PayU
async function getPayUToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', PAYU_CLIENT_ID || '');
  params.append('client_secret', PAYU_CLIENT_SECRET || '');

  const response = await fetch(`${PAYU_BASE_URL}/pl/standard/user/oauth/authorize`, {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  
  const text = await response.text(); 
  
  try {
      const data = JSON.parse(text);
      if (!response.ok) throw new Error(`PayU Auth Error: ${data.error_description || response.statusText}`);
      return data.access_token;
  } catch (err) {
      console.error('❌ Błąd pobierania tokena PayU (HTML zamiast JSON). Odpowiedź serwera:', text.substring(0, 800));
      throw new Error('Nieudana autoryzacja z PayU.');
  }
}

// ==========================================
// --- API ADMINA ---
// ==========================================

// 1. Logowanie do Panelu Admina
app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  
  if (pin === ADMIN_PIN) {
    console.log('🔓 Panel Administratora został odblokowany.');
    return res.json({ success: true, name: 'Szefie' });
  } else {
    console.warn('🔒 Nieudana próba logowania do panelu admina. Błędny PIN:', pin);
    return res.status(401).json({ success: false, message: 'Nieprawidłowy PIN' });
  }
});

// 2. Pobieranie statystyk do Dashboardu
app.get('/api/admin/stats', async (req, res) => {
    try {
        const location = req.query.location || 'slupsk';
        const totalUsers = await User.countDocuments();
        const totalReservations = await Reservation.countDocuments();
        const totalOrders = await Order.countDocuments({ location: location });
        const usersWithPoints = await User.countDocuments({ points: { $gte: 1 } });
        const activePrepaidCards = await User.countDocuments({ walletBalance: { $gte: 1 } });

        const statsAgg = await User.aggregate([
            { 
                $group: { 
                    _id: null, 
                    totalPrepaidBalance: { $sum: "$walletBalance" },
                    spentMilkosy: { $sum: "$redeemedPoints" },
                    totalPointsCirculating: { $sum: "$points" }
                } 
            }
        ]);

        const totalPrepaidBalance = statsAgg.length > 0 ? statsAgg[0].totalPrepaidBalance : 0;
        const spentMilkosy = statsAgg.length > 0 ? statsAgg[0].spentMilkosy : 0;
        const totalPointsCirculating = statsAgg.length > 0 ? statsAgg[0].totalPointsCirculating : 0;

        res.json({
            success: true,
            data: {
                totalUsers,
                totalReservations,
                totalOrders,
                usersWithPoints,
                activePrepaidCards,
                totalPrepaidBalance,
                spentMilkosy,
                totalPointsCirculating
            }
        });
    } catch (err) {
        console.error('Błąd statystyk:', err);
        res.status(500).json({ success: false, message: 'Błąd generowania statystyk' });
    }
});

// 3. Pobierz wszystkich użytkowników
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}, '-password').sort({ createdAt: -1 });
        res.json({ success: true, data: users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd pobierania bazy użytkowników.' });
    }
});

// 4. Modyfikuj punkty użytkownika
app.post('/api/admin/users/:id/points', async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, action, reason } = req.body; 
        
        const user = await User.findById(id);
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });
        }

        const numAmount = Number(amount);
        
        if (action === 'add') {
            user.points += numAmount;
            user.history.unshift({ text: `+ ${numAmount} pkt • ${reason || 'Przyznane przez admina'}` });
        } else if (action === 'remove') {
            if (user.points < numAmount) {
                return res.status(400).json({ success: false, message: 'Użytkownik ma za mało punktów.' });
            }
            user.points -= numAmount;
            user.history.unshift({ text: `- ${numAmount} pkt • ${reason || 'Odjęte przez admina'}` });
        }

        if(user.history.length > 20) {
            user.history.pop();
        }

        await user.save();
        res.json({ success: true, points: user.points, history: user.history });
        
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd podczas edycji punktów.' });
    }
});

// 5. Usuń użytkownika
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Użytkownik usunięty.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd podczas usuwania konta.' });
    }
});

// 6. Nabijanie punktów z kasy
app.post('/api/admin/award-points', async (req, res) => {
    try {
        const { identifier, amountSpent } = req.body;
        
        if (!identifier || !amountSpent || amountSpent <= 0) {
            return res.status(400).json({ success: false, message: 'Wprowadź prawidłowe dane.' });
        }

        const cleanId = identifier.trim().toLowerCase();
        const user = await User.findOne({ $or: [{ email: cleanId }, { phone: cleanId }] });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono klienta w bazie.' });
        }

        const points = Math.floor(Number(amountSpent) / 10);
        
        if (points <= 0) {
            return res.status(400).json({ success: false, message: 'Kwota jest za mała (min. 10 PLN).' });
        }

        user.points += points;
        user.history.unshift({ text: `+ ${points} pkt • Zakupy w lokalu` });
        
        if(user.history.length > 20) {
            user.history.pop();
        }
        
        await user.save();

        const tx = new PointTransaction({
            userDisplay: `${user.username} (${user.phone})`,
            amountSpent: Number(amountSpent),
            pointsAwarded: points
        });
        await tx.save();

        res.json({ success: true, message: `Dodano ${points} pkt do konta klienta ${user.username}!`, points });
        
    } catch(err) {
        res.status(500).json({ success: false, message: 'Błąd serwera.' });
    }
});

// 7. Pobieranie historii punktów
app.get('/api/admin/point-transactions', async (req, res) => {
    try {
        const txs = await PointTransaction.find().sort({ date: -1 }).limit(50);
        res.json({ success: true, data: txs });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// --- API ADMINA (PORTFEL / PRE-PAID) ---
// ==========================================

app.post('/api/admin/wallet/search', async (req, res) => {
    try {
        const { identifier } = req.body;
        const cleanId = identifier.trim().toLowerCase();
        
        const user = await User.findOne({ $or: [{ email: cleanId }, { phone: cleanId }] });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono klienta.' });
        }
        
        res.json({ 
            success: true, 
            user: { 
                id: user._id, 
                username: user.username, 
                email: user.email, 
                phone: user.phone, 
                walletBalance: user.walletBalance || 0 
            } 
        });
    } catch(err) {
        res.status(500).json({ success: false, message: 'Błąd serwera.' });
    }
});

app.post('/api/admin/wallet/modify', async (req, res) => {
    try {
        const { userId, amount, action } = req.body;
        const user = await User.findById(userId);
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });
        }

        const numAmount = Number(amount);
        
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowa kwota.' });
        }

        if (action === 'add') {
            user.walletBalance = (user.walletBalance || 0) + numAmount;
            user.history.unshift({ text: `+ ${numAmount.toFixed(2)} PLN • Wpłata środków na konto` });
        } else if (action === 'remove') {
            if ((user.walletBalance || 0) < numAmount) {
                return res.status(400).json({ success: false, message: 'Brak wystarczających środków na koncie klienta.' });
            }
            user.walletBalance -= numAmount;
            user.history.unshift({ text: `- ${numAmount.toFixed(2)} PLN • Zapłata z portfela w lokalu` });
        }
        
        if(user.history.length > 20) {
            user.history.pop();
        }
        await user.save();

        const tx = new WalletTransaction({
            userDisplay: `${user.username} (${user.phone})`,
            amount: numAmount,
            action: action
        });
        await tx.save();

        res.json({ success: true, walletBalance: user.walletBalance, message: 'Saldo zostało pomyślnie zaktualizowane.' });
    } catch(err) {
        res.status(500).json({ success: false, message: 'Błąd serwera.' });
    }
});

app.get('/api/admin/wallet-transactions', async (req, res) => {
    try {
        const txs = await WalletTransaction.find().sort({ date: -1 }).limit(50);
        res.json({ success: true, data: txs });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// --- API USTAWIEŃ LOKALU (ZAMAWIARKI) ---
// ==========================================

app.get('/api/settings', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const settings = await StoreSettings.findOne({ location: location });

    if (settings) {
      res.json({ success: true, data: settings });
    } else {
      res.json({
        success: true,
        data: {
          location: location,
          ordersEnabled: true,
          pickupEnabled: true,
          deliveryEnabled: false
        }
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania ustawień sklepu.' });
  }
});

app.get('/api/admin/settings', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    let settings = await StoreSettings.findOne({ location: location });
    if (!settings) {
      settings = { location: location, ordersEnabled: true, pickupEnabled: true, deliveryEnabled: false };
    }
    res.json({ success: true, settings: settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania ustawień admina.' });
  }
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    const { location = 'slupsk', ordersEnabled, pickupEnabled, deliveryEnabled } = req.body;
    
    const updated = await StoreSettings.findOneAndUpdate(
      { location: location },
      {
        ordersEnabled: Boolean(ordersEnabled),
        pickupEnabled: Boolean(pickupEnabled),
        deliveryEnabled: Boolean(deliveryEnabled),
        updatedAt: Date.now()
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Ustawienia lokalu zaktualizowane', data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd przy zapisywaniu ustawień.' });
  }
});

// ==========================================
// --- API GRAFIK KATEGORII (/api/category-banners) ---
// ==========================================
app.get('/api/category-banners', async (req, res) => {
  try {
    const banners = await CategoryBanner.find({});
    res.json({ success: true, data: banners });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania grafik kategorii.' });
  }
});

app.post('/api/admin/category-banners', async (req, res) => {
  try {
    const { categoryId, imageUrl, location = 'slupsk' } = req.body;
    if (!categoryId || !imageUrl) {
      return res.status(400).json({ success: false, message: 'Brakujące parametry (categoryId lub imageUrl).' });
    }

    const updated = await CategoryBanner.findOneAndUpdate(
      { categoryId: categoryId },
      { imageUrl: imageUrl, location: location, updatedAt: Date.now() },
      { new: true, upsert: true }
    );

    res.json({ success: true, data: updated, message: 'Grafika kafelka zapisana.' });
  } catch (err) {
    console.error('Błąd zapisu grafiki kategorii:', err);
    res.status(500).json({ success: false, message: 'Błąd po stronie serwera.' });
  }
});

// ==========================================
// --- API SZYBKICH DODATKÓW KOSZYKA (/api/upsell) ---
// ==========================================
app.get('/api/upsell', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const config = await UpsellConfig.findOne({ location: location });
    if (config && config.items) {
      res.json({ success: true, data: config.items });
    } else {
      res.json({
        success: true,
        data: [
          { id: 'u1', name: 'Coca-Cola 0.5l', price: 7.00, img: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=200&q=80' },
          { id: 'u2', name: 'Frytki Duże', price: 10.00, img: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?auto=format&fit=crop&w=200&q=80' },
          { id: 'u3', name: 'Sos Czosnkowy', price: 3.00, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=200&q=80' }
        ]
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania szybkiego dobierania (upsell).' });
  }
});

app.get('/api/admin/upsell', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const config = await UpsellConfig.findOne({ location: location });
    if (config && config.items) {
      res.json({ success: true, items: config.items });
    } else {
      res.json({
        success: true,
        items: [
          { id: 'u1', name: 'Coca-Cola 0.5l', price: 7.00, img: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=200&q=80' },
          { id: 'u2', name: 'Frytki Duże', price: 10.00, img: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?auto=format&fit=crop&w=200&q=80' },
          { id: 'u3', name: 'Sos Czosnkowy', price: 3.00, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=200&q=80' }
        ]
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania dodatków w adminie.' });
  }
});

app.post('/api/admin/upsell', async (req, res) => {
  try {
    const { location = 'slupsk', items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Nieprawidłowe dane pozycji.' });
    }

    // Uzupełnienie lub zachowanie domyślnego zdjęcia dla paska upsell
    const defaultImages = [
      'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=200&q=80',
      'https://images.unsplash.com/photo-1576107232684-1279f390859f?auto=format&fit=crop&w=200&q=80',
      'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=200&q=80'
    ];

    const mappedItems = items.map((it, idx) => ({
      id: it.id || `u${idx + 1}`,
      name: it.name || 'Dodatek',
      price: Number(it.price) || 0,
      img: it.img || defaultImages[idx] || defaultImages[0]
    }));

    const updated = await UpsellConfig.findOneAndUpdate(
      { location: location },
      { items: mappedItems, updatedAt: Date.now() },
      { new: true, upsert: true }
    );

    res.json({ success: true, data: updated, message: 'Lista szybkiego dobierania zapisana.' });
  } catch (err) {
    console.error('Błąd zapisu upsell:', err);
    res.status(500).json({ success: false, message: 'Błąd po stronie serwera.' });
  }
});

// ==========================================
// --- API ZAMÓWIEŃ (ORDERS) ---
// ==========================================

app.post('/api/orders', async (req, res) => {
  try {
    const { location = 'slupsk' } = req.body;

    const storeSettings = await StoreSettings.findOne({ location: location });
    if (storeSettings && !storeSettings.ordersEnabled) {
      return res.status(403).json({ success: false, message: 'Lokal jest w tej chwili zamknięty na zamówienia online.' });
    }

    let counter = await Counter.findOneAndUpdate(
      { id: 'orderNum' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    
    if (counter.seq > 9999) {
        counter.seq = 1;
        await counter.save();
    }
    
    const orderNumber = `MI-${String(counter.seq).padStart(4, '0')}`;
    
    const isOnlinePayment = req.body.paymentMethod === 'online';
    const initialStatus = isOnlinePayment ? 'awaiting_payment' : 'pending';

    const newOrder = new Order({
        ...req.body,
        location: location,
        orderNumber: orderNumber,
        status: initialStatus
    });
    
    await newOrder.save();
    
    if (isOnlinePayment) {
      const token = await getPayUToken();
      
      const payuOrderData = {
        notifyUrl: `${APP_URL}/api/payu/notify`, 
        customerIp: req.ip || "127.0.0.1",
        merchantPosId: PAYU_POS_ID,
        description: `Zamówienie ${orderNumber}`,
        currencyCode: "PLN",
        totalAmount: Math.round(newOrder.totalAmount * 100),
        extOrderId: newOrder._id.toString(),
        buyer: {
          email: req.body.customerEmail || "brak@email.pl",
          phone: req.body.customerPhone,
          firstName: req.body.customerName
        },
        products: newOrder.items.map(item => ({
          name: item.name,
          unitPrice: Math.round(item.price * 100),
          quantity: item.quantity
        }))
      };

      const payuRes = await fetch(`${PAYU_BASE_URL}/api/v2_1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payuOrderData),
        redirect: 'manual'
      });
      
      const locationHeader = payuRes.headers.get('location');
      
      if (payuRes.status === 302 && locationHeader) {
          return res.json({ 
            success: true, 
            redirectUrl: locationHeader, 
            orderId: newOrder._id, 
            orderNumber,
            message: 'Przekierowanie do płatności...'
          });
      }

      const textResponse = await payuRes.text();
      let payuData;
      
      try {
          payuData = JSON.parse(textResponse);
      } catch (err) {
          console.error(`❌ Błąd PayU. Zwrócono HTML mimo blokady redirectu (Status: ${payuRes.status}). HTML:`, textResponse.substring(0, 500));
          throw new Error('PayU zwróciło nieprawidłową odpowiedź.');
      }

      if (!payuRes.ok && payuRes.status !== 200 && payuRes.status !== 201) {
          console.error(`❌ PayU odrzuciło zamówienie. Szczegóły:`, payuData);
          throw new Error(`Błąd bramki PayU: ${payuRes.status}`);
      }

      return res.json({ 
        success: true, 
        redirectUrl: payuData.redirectUri, 
        orderId: newOrder._id, 
        orderNumber,
        message: 'Przekierowanie do płatności...'
      });
    }
    
    res.json({ success: true, orderId: newOrder._id, orderNumber: orderNumber, message: 'Zamówienie zostało przyjęte!' });
  } catch (err) {
    console.error('Błąd zapisu zamówienia:', err);
    res.status(500).json({ success: false, message: 'Błąd serwera przy składaniu zamówienia.' });
  }
});

app.post('/api/payu/notify', async (req, res) => {
  try {
    const order = req.body.order;
    
    if (order && order.status === 'COMPLETED') {
      const dbOrderId = order.extOrderId;
      
      await Order.findByIdAndUpdate(dbOrderId, { 
        status: 'pending'
      });
      
      console.log(`💰 Zamówienie PayU ${dbOrderId} zostało opłacone! Wysłano alarm.`);
    }
    
    res.status(200).send('OK');
  } catch (err) {
    console.error('Błąd webhooka PayU:', err);
    res.status(500).send('Error');
  }
});

app.get('/api/orders/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
        res.json({ success: true, data: order });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/orders/pending', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const pendingOrders = await Order.find({ status: 'pending', location: location }).sort({ createdAt: 1 });
    res.json({ success: true, data: pendingOrders });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const allOrders = await Order.find({ location: location }).sort({ createdAt: -1 });
    res.json({ success: true, data: allOrders });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await Order.findByIdAndUpdate(req.params.id, { status: status });
    res.json({ success: true, message: 'Status zaktualizowany' });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// --- API REZERWACJE ---
// ==========================================

app.post('/api/reservations', async (req, res) => {
  try {
    const { name, phone, datetime, guests, zone, notes } = req.body;
    
    if (!name || !phone || !datetime || !guests) {
      return res.status(400).json({ success: false, message: 'Brakujące pola' });
    }

    const newReservation = new Reservation({
      name,
      phone,
      datetime,
      guests,
      zone,
      notes,
      status: 'pending'
    });

    await newReservation.save();
    console.log(`🛎️ Wpadła nowa rezerwacja od: ${name}`);
    
    res.json({ success: true, message: 'Rezerwacja została przyjęta do systemu' });
  } catch (err) {
    console.error('Błąd zapisu rezerwacji:', err);
    res.status(500).json({ success: false, message: 'Wystąpił błąd serwera' });
  }
});

app.get('/api/admin/reservations/pending', async (req, res) => {
  try {
    const pending = await Reservation.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.json({ success: true, data: pending });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/reservations', async (req, res) => {
  try {
    const allReservations = await Reservation.find({}).sort({ datetime: -1 });
    res.json({ success: true, data: allReservations });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/reservations/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await Reservation.findByIdAndUpdate(req.params.id, { status: status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.delete('/api/admin/reservations/:id', async (req, res) => {
  try {
    await Reservation.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Rezerwacja usunięta' });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// --- API BANERÓW ---
// ==========================================

app.post('/api/admin/banners', async (req, res) => {
  try {
    const { target, isActive, text, backgroundColor } = req.body;
    
    const banner = await Banner.findOneAndUpdate(
      { target: target },
      { isActive, text, backgroundColor, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    
    res.json({ success: true, banner });
  } catch (err) {
    console.error('Błąd zapisu baneru:', err);
    res.status(500).json({ success: false, message: 'Wystąpił błąd podczas zapisywania baneru.' });
  }
});

app.get('/api/banners', async (req, res) => {
  try {
    const banners = await Banner.find({});
    res.json({ success: true, data: banners });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania banerów.' });
  }
});

// ==========================================
// --- API MENU (PRODUKTY - MCDONALD STYLE) ---
// ==========================================

// POBIERANIE CAŁEGO MENU (Dla aplikacji klienckiej i admina)
app.get('/api/menu', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    
    // Szukamy produktów z danej lokalizacji ORAZ starych produktów z MongoDB bez pola location
    const products = await Product.find({
      $or: [
        { location: location },
        { location: { $exists: false } },
        { location: null },
        { location: '' }
      ]
    }).sort({ categoryId: 1, name: 1 });

    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania menu.' });
  }
});

// DODAWANIE NOWEGO PRODUKTU
app.post('/api/admin/menu', async (req, res) => {
  try {
    const { 
      name, description, price, imageUrl, categoryId, 
      location = 'slupsk', hasVariants, variants, allowSet, addons 
    } = req.body;
    
    if (!name || !imageUrl || !categoryId) {
      return res.status(400).json({ success: false, message: 'Wypełnij wymagane pola.' });
    }

    if (!hasVariants && (price === undefined || price === null || price === '')) {
      return res.status(400).json({ success: false, message: 'Wypełnij cenę dla produktu bez wariantów.' });
    }

    const newProduct = new Product({ 
      name, description, price, imageUrl, categoryId, 
      location, hasVariants, variants, allowSet, addons 
    });
    
    await newProduct.save();
    
    res.json({ success: true, product: newProduct, message: 'Produkt dodany do menu!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd dodawania produktu.' });
  }
});

// AKTUALIZACJA PRODUKTU
app.put('/api/admin/menu/:id', async (req, res) => {
  try {
    const { 
      name, description, price, imageUrl, categoryId, 
      location = 'slupsk', hasVariants, variants, allowSet, addons 
    } = req.body;
    
    if (!name || !imageUrl || !categoryId) {
      return res.status(400).json({ success: false, message: 'Wypełnij wymagane pola.' });
    }

    if (!hasVariants && (price === undefined || price === null || price === '')) {
      return res.status(400).json({ success: false, message: 'Wypełnij cenę dla produktu bez wariantów.' });
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      { name, description, price, imageUrl, categoryId, location, hasVariants, variants, allowSet, addons },
      { new: true }
    );
    
    if (!updatedProduct) {
      return res.status(404).json({ success: false, message: 'Nie znaleziono produktu.' });
    }

    res.json({ success: true, product: updatedProduct, message: 'Produkt zaktualizowany pomyślnie!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd aktualizacji produktu.' });
  }
});

// USUWANIE PRODUKTU
app.delete('/api/admin/menu/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Produkt usunięty.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd usuwania produktu.' });
  }
});

// UPLOAD ZDJĘCIA DLA PRODUKTU / KATEGORII / UPSELL
app.post('/api/admin/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Brak pliku' });
  }
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, imageUrl: imageUrl });
});

// ==========================================
// --- API GODZIN OTWARCIA (HOURS) ---
// ==========================================

app.post('/api/admin/hours', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const scheduleData = req.body;

    const updatedHours = await LocationHours.findOneAndUpdate(
      { location: location },
      { schedule: scheduleData, updatedAt: Date.now() },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: `Godziny otwarcia dla ${location} zaktualizowane!`, data: updatedHours });
  } catch (err) {
    console.error('Błąd zapisu godzin:', err);
    res.status(500).json({ success: false, message: 'Wystąpił błąd podczas zapisu godzin.' });
  }
});

app.get('/api/hours', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const hoursDoc = await LocationHours.findOne({ location: location });

    if (hoursDoc && hoursDoc.schedule) {
      res.json({ success: true, data: hoursDoc.schedule });
    } else {
      res.json({ success: false, message: 'Brak ustawionych godzin dla tej lokalizacji.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania godzin.' });
  }
});

// ==========================================
// --- API APLIKACJI (KLIENCI - LOJALNOŚĆ) ---
// ==========================================

app.post('/api/rewards/exchange', async (req, res) => {
    try {
        const { userId, pointsCost, vplnAmount } = req.body;
        const user = await User.findById(userId);
        
        if (!user || user.points < pointsCost) {
            return res.status(400).json({ success: false, message: 'Niewystarczająca liczba punktów.' });
        }

        user.points -= pointsCost;
        user.redeemedPoints = (user.redeemedPoints || 0) + pointsCost; 
        user.walletBalance = (user.walletBalance || 0) + vplnAmount;
        
        user.history.unshift({ text: `- ${pointsCost} pkt • Kupiono bon do portfela` });
        user.history.unshift({ text: `+ ${vplnAmount} PLN • Zasilenie z punktów lojalnościowych` });
        
        if(user.history.length > 20) {
            user.history = user.history.slice(0, 20);
        }

        await user.save();

        const tx = new WalletTransaction({
            userDisplay: `${user.username} (${user.phone})`,
            amount: vplnAmount,
            action: 'add'
        });
        await tx.save();

        res.json({ 
            success: true, 
            points: user.points, 
            walletBalance: user.walletBalance,
            history: user.history,
            message: `Pomyślnie zamieniono ${pointsCost} pkt na ${vplnAmount} PLN!` 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Błąd serwera.' });
    }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;

    if (!username || !email || !phone || !password) {
      return res.status(400).json({ message: 'Wszystkie pola są wymagane.' });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = phone.trim();

    const existingUser = await User.findOne({ $or: [{ email: cleanEmail }, { username: cleanUsername }] });
    
    if (existingUser) {
      return res.status(409).json({ message: 'Użytkownik o takim emailu lub loginie już istnieje.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username: cleanUsername,
      email: cleanEmail,
      phone: cleanPhone,
      password: hashedPassword
    });

    await newUser.save();
    console.log(`🆕 Zarejestrowano nowego użytkownika: ${cleanUsername}`);
    res.status(201).json({ message: 'Konto zostało pomyślnie utworzone.' });

  } catch (error) {
    console.error('❌ Błąd podczas rejestracji:', error);
    res.status(500).json({ message: 'Wystąpił błąd serwera podczas rejestracji.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { loginOrEmail, password } = req.body;

    if (!loginOrEmail || !password) {
      return res.status(400).json({ message: 'Podaj login/email oraz hasło.' });
    }

    const cleanLogin = loginOrEmail.trim();

    const user = await User.findOne({
      $or: [{ email: cleanLogin.toLowerCase() }, { username: cleanLogin }]
    });

    if (!user) {
      console.log(`🚫 Logowanie nieudane: Nie znaleziono użytkownika dla -> "${cleanLogin}"`);
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      console.log(`🚫 Logowanie nieudane: Złe hasło dla -> "${cleanLogin}"`);
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`✅ Zalogowano użytkownika: ${user.username}`);

    res.status(200).json({
      message: 'Zalogowano pomyślnie.',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        points: user.points,
        walletBalance: user.walletBalance || 0,
        activeRewards: user.activeRewards || []
      }
    });

  } catch (error) {
    console.error('❌ Błąd podczas logowania:', error);
    res.status(500).json({ message: 'Wystąpił błąd serwera podczas logowania.' });
  }
});

app.get('/api/milkpoints/my', async (req, res) => {
  try {
      const email = req.query.email;
      
      if(!email) {
          return res.status(400).json({ ok: false, message: 'Brak emaila' });
      }

      const user = await User.findOne({ email: email.toLowerCase() });
      
      if(!user) {
          return res.status(404).json({ ok: false, message: 'Użytkownik nie istnieje' });
      }

      res.json({
          ok: true,
          points: user.points,
          walletBalance: user.walletBalance || 0,
          history: user.history,
          activeRewards: user.activeRewards || []
      });
      
  } catch (err) {
      res.status(500).json({ ok: false, message: 'Błąd serwera' });
  }
});

// ==========================================
// --- ATTRAPY DLA WORKMI (ZESPÓŁ) ---
// ==========================================
app.get('/api/team', (req, res) => {
  res.json({ success: true, data: [] });
});

app.post('/api/team', (req, res) => {
  res.json({ success: true });
});

// --- OBSŁUGA BŁĘDÓW 404 ---
app.use((req, res) => {
  res.status(404).redirect('/');
});

// START SERWERA
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serwer MilkMi śmiga na porcie ${PORT}`);
});
