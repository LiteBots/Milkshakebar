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
app.get('/', (req, res) => {
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
  serverSelectionTimeoutMS: 5000
})
  .then(() => console.log('✅ Pomyślnie połączono z bazą MongoDB'))
  .catch((err) => console.error('❌ Błąd połączenia z bazą danych:', err.message));

// --- SCHEMAT UŻYTKOWNIKA ---
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  phone: { type: String, required: true, trim: true },
  password: { type: String, required: true },
  points: { type: Number, default: 0 },
  history: [{
      text: String,
      date: { type: String, default: () => new Date().toLocaleString('pl-PL') }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Zmienne środowiskowe
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

// 2. Pobierz wszystkich użytkowników
app.get('/api/admin/users', async (req, res) => {
    try {
        // Zwracamy wszystkie dane z wyjątkiem hasła
        const users = await User.find({}, '-password').sort({ createdAt: -1 });
        res.json({ success: true, data: users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd pobierania bazy użytkowników.' });
    }
});

// 3. Modyfikuj punkty użytkownika (dodaj/usuń)
app.post('/api/admin/users/:id/points', async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, action, reason } = req.body; // action: 'add' lub 'remove'
        
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'Użytkownik nie istnieje.' });

        const numAmount = Number(amount);
        if (action === 'add') {
            user.points += numAmount;
            user.history.unshift({ text: `+ ${numAmount} pkt • ${reason || 'Przyznane przez admina'}` });
        } else if (action === 'remove') {
            if (user.points < numAmount) return res.status(400).json({ success: false, message: 'Użytkownik ma za mało punktów.' });
            user.points -= numAmount;
            user.history.unshift({ text: `- ${numAmount} pkt • ${reason || 'Odjęte przez admina'}` });
        }

        // Ograniczamy historię do 20 ostatnich wpisów
        if(user.history.length > 20) user.history.pop();

        await user.save();
        res.json({ success: true, points: user.points, history: user.history });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd podczas edycji punktów.' });
    }
});

// 4. Usuń użytkownika
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Użytkownik usunięty.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Błąd podczas usuwania konta.' });
    }
});

// ==========================================
// --- API APLIKACJI (KLIENCI) ---
// ==========================================

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
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        points: user.points
      }
    });

  } catch (error) {
    console.error('❌ Błąd podczas logowania:', error);
    res.status(500).json({ message: 'Wystąpił błąd serwera podczas logowania.' });
  }
});

// --- POBIERANIE DANYCH UŻYTKOWNIKA (odświeżanie w app.html) ---
app.get('/api/milkpoints/my', async (req, res) => {
  try {
      const email = req.query.email;
      if(!email) return res.status(400).json({ ok: false, message: 'Brak emaila' });

      const user = await User.findOne({ email: email.toLowerCase() });
      if(!user) return res.status(404).json({ ok: false, message: 'Użytkownik nie istnieje' });

      res.json({
          ok: true,
          points: user.points,
          history: user.history
      });
  } catch (err) {
      res.status(500).json({ ok: false, message: 'Błąd serwera' });
  }
});

// ==========================================
// --- ATTRAPY DLA WORKMI (ZESPÓŁ) ---
// (Żeby skrypty w admin.html nie wyrzucały błędów w konsoli)
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
app.listen(PORT, () => {
  console.log(`🚀 Serwer MilkMi śmiga na porcie ${PORT}`);
});
