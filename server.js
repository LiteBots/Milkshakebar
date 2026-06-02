require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());

// Serwowanie plików statycznych z folderu głównego (CSS, obrazy, JS frontendu)
app.use(express.static(__dirname));

// --- TRASY FRONTENDU (WIDOKI) ---

// Trasa główna - serwuje aplikację kliencką
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// Trasa panelu admina - serwuje admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
  // Środki wirtualnego portfela klienta
  walletBalance: { 
    type: Number, 
    default: 0 
  },
  // Śledzenie wydanych punktów na nagrody (Bony vPLN)
  redeemedPoints: { 
    type: Number, 
    default: 0 
  },
  // Zostawiamy dla kompatybilności wstecznej bazy
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
  orderNumber: String, // Np. MI-0004
  customerName: String,
  customerPhone: String,
  pickupTime: String,
  notes: String,
  items: Array, // Tablica z produktami (id, nazwa, cena, ilosc)
  totalAmount: Number,
  status: { type: String, default: 'pending' }, // 'pending', 'preparing', 'completed', 'cancelled'
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// --- SCHEMAT USTAWIEŃ BANERÓW (Pasek w aplikacji i na stronie) ---
const bannerSchema = new mongoose.Schema({
  target: { type: String, required: true, unique: true }, // 'app' lub 'web'
  isActive: { type: Boolean, default: false },
  text: { type: String, default: '' },
  backgroundColor: { type: String, default: '#FF6600' },
  updatedAt: { type: Date, default: Date.now }
});

const Banner = mongoose.model('Banner', bannerSchema);

// --- SCHEMAT PRODUKTU (MENU) ---
const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number }, // Usunięto required: true dla kompatybilności z wariantami
  imageUrl: { type: String, required: true },
  categoryId: { type: String, required: true }, // Np. 'shakes_klasyczne', 'burgery'
  
  // NOWE POLA: Warianty wielkości
  hasVariants: { type: Boolean, default: false },
  variants: [{
    name: { type: String },
    price: { type: Number }
  }],

  createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// --- SCHEMAT GODZIN OTWARCIA LOKALI ---
const hoursSchema = new mongoose.Schema({
  location: { type: String, required: true, unique: true }, // 'slupsk' lub 'rowy'
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
        const totalUsers = await User.countDocuments();
        const totalReservations = await Reservation.countDocuments();
        const totalOrders = await Order.countDocuments();
        const usersWithPoints = await User.countDocuments({ points: { $gte: 1 } });
        const activePrepaidCards = await User.countDocuments({ walletBalance: { $gte: 1 } });

        // OPTYMALIZACJA: Jedna agregacja zamiast trzech osobnych
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

// 3. Pobierz wszystkich użytkowników (Baza Klientów)
app.get('/api/admin/users', async (req, res) => {
    try {
        // Zwracamy wszystkie dane z wyjątkiem hasła
        const users = await User.find({}, '-password').sort({ createdAt: -1 });
        res.json({ success: true, data: users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd pobierania bazy użytkowników.' });
    }
});

// 4. Modyfikuj punkty użytkownika ręcznie (Modal Użytkownika)
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

        // Ograniczamy historię na koncie klienta do 20 wpisów
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

// 6. Nabijanie punktów za zakupy z kasy
app.post('/api/admin/award-points', async (req, res) => {
    try {
        const { identifier, amountSpent } = req.body;
        
        if (!identifier || !amountSpent || amountSpent <= 0) {
            return res.status(400).json({ success: false, message: 'Wprowadź prawidłowe dane.' });
        }

        const cleanId = identifier.trim().toLowerCase();
        
        // Szukamy po mailu LUB telefonie
        const user = await User.findOne({ $or: [{ email: cleanId }, { phone: cleanId }] });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono klienta w bazie.' });
        }

        // Algorytm 10 zł = 1 punkt (zaokrąglanie w dół)
        const points = Math.floor(Number(amountSpent) / 10);
        
        if (points <= 0) {
            return res.status(400).json({ success: false, message: 'Kwota jest za mała (min. 10 PLN).' });
        }

        // Aktualizacja użytkownika
        user.points += points;
        user.history.unshift({ text: `+ ${points} pkt • Zakupy w lokalu` });
        
        if(user.history.length > 20) {
            user.history.pop();
        }
        
        await user.save();

        // Zapis transakcji do globalnej historii panelu admina
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

// 7. Pobieranie historii globalnej punktów do panelu
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

// 1. Wyszukiwanie klienta do modyfikacji portfela
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

// 2. Modyfikacja środków w portfelu (Wpłata/Pobranie zapłaty)
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

        // Zapis transakcji do globalnej historii panelu admina
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

// 3. Pobieranie historii globalnej operacji na portfelu (Pre-paid)
app.get('/api/admin/wallet-transactions', async (req, res) => {
    try {
        const txs = await WalletTransaction.find().sort({ date: -1 }).limit(50);
        res.json({ success: true, data: txs });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// --- API ZAMÓWIEŃ (ORDERS) ---
// ==========================================

// KLIENCI - Złożenie nowego zamówienia z poziomu aplikacji
app.post('/api/orders', async (req, res) => {
  try {
    // Generowanie numeru MI-XXXX
    let counter = await Counter.findOneAndUpdate(
      { id: 'orderNum' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    
    // Reset licznika po 9999
    if (counter.seq > 9999) {
        counter.seq = 1;
        await counter.save();
    }
    
    // Formatowanie z zerami z przodu np. MI-0004
    const orderNumber = `MI-${String(counter.seq).padStart(4, '0')}`;

    const newOrder = new Order({
        ...req.body,
        orderNumber: orderNumber
    });
    
    await newOrder.save();
    
    res.json({ success: true, orderId: newOrder._id, orderNumber: orderNumber, message: 'Zamówienie zostało przyjęte!' });
  } catch (err) {
    console.error('Błąd zapisu zamówienia:', err);
    res.status(500).json({ success: false, message: 'Błąd serwera przy składaniu zamówienia.' });
  }
});

// KLIENCI - Sprawdzanie statusu zamówienia (na ekranie paragonu)
app.get('/api/orders/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
        res.json({ success: true, data: order });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// ADMIN - Pobranie nowych zamówień do ALARMU (Tylko oczekujące)
app.get('/api/admin/orders/pending', async (req, res) => {
  try {
    const pendingOrders = await Order.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.json({ success: true, data: pendingOrders });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ADMIN - Pobranie wszystkich zamówień do tabeli
app.get('/api/admin/orders', async (req, res) => {
  try {
    const allOrders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, data: allOrders });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ADMIN - Zmiana statusu zamówienia
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

// --- KLIENCI: Złożenie nowej rezerwacji ze strony WWW ---
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
      status: 'pending' // to wyzwoli alarm w panelu admina
    });

    await newReservation.save();
    console.log(`🛎️ Wpadła nowa rezerwacja od: ${name}`);
    
    res.json({ success: true, message: 'Rezerwacja została przyjęta do systemu' });
  } catch (err) {
    console.error('Błąd zapisu rezerwacji:', err);
    res.status(500).json({ success: false, message: 'Wystąpił błąd serwera' });
  }
});

// 1. PANEL ADMINA - Pobieranie nowych (pending) TYLKO dla mechanizmu alarmu
app.get('/api/admin/reservations/pending', async (req, res) => {
  try {
    const pending = await Reservation.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.json({ success: true, data: pending });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 2. PANEL ADMINA - Pobieranie WSZYSTKICH rezerwacji (do widoku w tabeli)
app.get('/api/admin/reservations', async (req, res) => {
  try {
    const allReservations = await Reservation.find({}).sort({ datetime: -1 });
    res.json({ success: true, data: allReservations });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 3. PANEL ADMINA - Zmiana statusu rezerwacji (np. akceptacja z alarmu lub z tabeli)
app.post('/api/admin/reservations/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await Reservation.findByIdAndUpdate(req.params.id, { status: status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 4. PANEL ADMINA - Trwałe usuwanie rezerwacji (z tabeli)
app.delete('/api/admin/reservations/:id', async (req, res) => {
  try {
    await Reservation.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Rezerwacja usunięta' });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// --- API BANERÓW (PASKÓW INFORMACYJNYCH) ---
// ==========================================

// ZAPISYWANIE/AKTUALIZACJA BANERÓW PRZEZ ADMINA
app.post('/api/admin/banners', async (req, res) => {
  try {
    const { target, isActive, text, backgroundColor } = req.body;
    
    const banner = await Banner.findOneAndUpdate(
      { target: target }, // Szukamy po polu 'target' ('app' lub 'web')
      { isActive, text, backgroundColor, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    
    res.json({ success: true, banner });
  } catch (err) {
    console.error('Błąd zapisu baneru:', err);
    res.status(500).json({ success: false, message: 'Wystąpił błąd podczas zapisywania baneru.' });
  }
});

// POBIERANIE BANERÓW (Dla aplikacji i WWW)
app.get('/api/banners', async (req, res) => {
  try {
    const banners = await Banner.find({});
    res.json({ success: true, data: banners });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania banerów.' });
  }
});

// ==========================================
// --- API MENU (PRODUKTY) ---
// ==========================================

// POBIERANIE CAŁEGO MENU (Dla aplikacji klienckiej i admina)
app.get('/api/menu', async (req, res) => {
  try {
    const products = await Product.find().sort({ categoryId: 1, name: 1 });
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania menu.' });
  }
});

// DODAWANIE NOWEGO PRODUKTU (Tylko Admin)
app.post('/api/admin/menu', async (req, res) => {
  try {
    // Dodano hasVariants oraz variants
    const { name, description, price, imageUrl, categoryId, hasVariants, variants } = req.body;
    
    if (!name || !imageUrl || !categoryId) {
      return res.status(400).json({ success: false, message: 'Wypełnij wymagane pola.' });
    }

    if (!hasVariants && (price === undefined || price === null || price === '')) {
      return res.status(400).json({ success: false, message: 'Wypełnij cenę dla produktu bez wariantów.' });
    }

    const newProduct = new Product({ name, description, price, imageUrl, categoryId, hasVariants, variants });
    await newProduct.save();
    
    res.json({ success: true, product: newProduct, message: 'Produkt dodany do menu!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd dodawania produktu.' });
  }
});

// AKTUALIZACJA PRODUKTU (EDYTKOWANIE - Tylko Admin)
app.put('/api/admin/menu/:id', async (req, res) => {
  try {
    // Dodano hasVariants oraz variants
    const { name, description, price, imageUrl, categoryId, hasVariants, variants } = req.body;
    
    if (!name || !imageUrl || !categoryId) {
      return res.status(400).json({ success: false, message: 'Wypełnij wymagane pola.' });
    }

    if (!hasVariants && (price === undefined || price === null || price === '')) {
      return res.status(400).json({ success: false, message: 'Wypełnij cenę dla produktu bez wariantów.' });
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      { name, description, price, imageUrl, categoryId, hasVariants, variants },
      { new: true } // Zwraca zaktualizowany dokument
    );
    
    if (!updatedProduct) {
      return res.status(404).json({ success: false, message: 'Nie znaleziono produktu.' });
    }

    res.json({ success: true, product: updatedProduct, message: 'Produkt zaktualizowany pomyślnie!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd aktualizacji produktu.' });
  }
});

// USUWANIE PRODUKTU (Tylko Admin)
app.delete('/api/admin/menu/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Produkt usunięty.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd usuwania produktu.' });
  }
});

// ==========================================
// --- API GODZIN OTWARCIA (HOURS) ---
// ==========================================

// 1. ZAPISYWANIE GODZIN (Tylko Admin)
app.post('/api/admin/hours', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const scheduleData = req.body; // Zawiera obiekt z dniami: mon, tue, wed...

    // Zapisujemy lub aktualizujemy (upsert) godziny dla danej lokalizacji
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

// 2. POBIERANIE GODZIN (Strona główna WWW oraz Panel Admina)
app.get('/api/hours', async (req, res) => {
  try {
    const location = req.query.location || 'slupsk';
    const hoursDoc = await LocationHours.findOne({ location: location });

    if (hoursDoc && hoursDoc.schedule) {
      res.json({ success: true, data: hoursDoc.schedule });
    } else {
      // Jeśli jeszcze nie zapisano żadnych godzin dla lokalizacji
      res.json({ success: false, message: 'Brak ustawionych godzin dla tej lokalizacji.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Błąd pobierania godzin.' });
  }
});

// ==========================================
// --- API APLIKACJI (KLIENCI) ---
// ==========================================

// --- API: WYMIANA PUNKTÓW NA DOŁADOWANIE PORTFELA (vPLN) ---
app.post('/api/rewards/exchange', async (req, res) => {
    try {
        const { userId, pointsCost, vplnAmount } = req.body;
        const user = await User.findById(userId);
        
        if (!user || user.points < pointsCost) {
            return res.status(400).json({ success: false, message: 'Niewystarczająca liczba punktów.' });
        }

        // 1. Odjęcie punktów
        user.points -= pointsCost;
        
        // 2. Dodanie punktów do statystyk wydanych
        user.redeemedPoints = (user.redeemedPoints || 0) + pointsCost; 

        // 3. Automatyczne dodanie środków do portfela vPLN
        user.walletBalance = (user.walletBalance || 0) + vplnAmount;
        
        // 4. Wpisy do historii klienta
        user.history.unshift({ text: `- ${pointsCost} pkt • Kupiono bon do portfela` });
        user.history.unshift({ text: `+ ${vplnAmount} PLN • Zasilenie z punktów lojalnościowych` });
        
        if(user.history.length > 20) {
            user.history = user.history.slice(0, 20);
        }

        await user.save();

        // 5. Zapis transakcji do panelu admina (Zaksięgowane w Pre-paid)
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

// --- API: REJESTRACJA ---
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

// --- API: LOGOWANIE ---
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
      // Zwracamy dane do aplikacji frontowej
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

// --- POBIERANIE DANYCH UŻYTKOWNIKA (odświeżanie po stronie klienta) ---
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
