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

// Trasa główna - serwuje Twój plik app.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// --- BAZA DANYCH MONGOOD ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/milkmi_db';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Pomyślnie połączono z bazą MongoDB'))
  .catch((err) => console.error('❌ Błąd połączenia z bazą danych:', err));

// Schemat użytkownika - kolekcja 'users' utworzy się automatycznie przy pierwszym zapisie
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
    required: true 
  },
  password: { 
    type: String, 
    required: true 
  },
  points: {
    type: Number,
    default: 0 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

const User = mongoose.model('User', userSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'super_tajny_klucz_zmien_go_w_produkcji';

// --- API: REJESTRACJA ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;

    if (!username || !email || !phone || !password) {
      return res.status(400).json({ message: 'Wszystkie pola są wymagane.' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(409).json({ message: 'Użytkownik o takim emailu lub loginie już istnieje.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username,
      email,
      phone,
      password: hashedPassword
    });

    await newUser.save();
    res.status(201).json({ message: 'Konto zostało pomyślnie utworzone.' });

  } catch (error) {
    console.error('Błąd podczas rejestracji:', error);
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

    const user = await User.findOne({
      $or: [{ email: loginOrEmail.toLowerCase() }, { username: loginOrEmail }]
    });

    if (!user) {
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Zalogowano pomyślnie.',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        points: user.points
      }
    });

  } catch (error) {
    console.error('Błąd podczas logowania:', error);
    res.status(500).json({ message: 'Wystąpił błąd serwera podczas logowania.' });
  }
});

// --- OBSŁUGA BŁĘDÓW 404 ---
// Jeśli ktoś wpisze adres, który nie istnieje (np. /app), przekieruj go do strony głównej
app.use((req, res) => {
  res.status(404).redirect('/');
});

// START SERWERA
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serwer MilkMi śmiga na http://localhost:${PORT}`);
});
