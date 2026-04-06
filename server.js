require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Połączenie z bazą MongoDB
// Domyślnie używa zmiennej środowiskowej MONGO_URI, jeśli nie istnieje - próbuje połączyć się lokalnie
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/milkmi_db';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Pomyślnie połączono z bazą MongoDB'))
  .catch((err) => console.error('❌ Błąd połączenia z bazą danych:', err));

// Definicja schematu użytkownika (Mongoose automatycznie stworzy kolekcję 'users')
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
    default: 0 // Domyślna liczba punktów na start
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

const User = mongoose.model('User', userSchema);

// Sekretny klucz do tokenów JWT
const JWT_SECRET = process.env.JWT_SECRET || 'super_tajny_klucz_zmien_go_w_produkcji';

// --- ROUTE: REJESTRACJA ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;

    // Walidacja czy wszystkie pola zostały podane
    if (!username || !email || !phone || !password) {
      return res.status(400).json({ message: 'Wszystkie pola są wymagane.' });
    }

    // Sprawdzenie czy użytkownik już istnieje (po emailu lub loginie)
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(409).json({ message: 'Użytkownik o takim emailu lub loginie już istnieje.' });
    }

    // Hashowanie hasła (10 to koszt obliczeniowy - salt rounds)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Utworzenie i zapisanie nowego użytkownika w bazie
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

// --- ROUTE: LOGOWANIE ---
app.post('/api/login', async (req, res) => {
  try {
    // Użytkownik może zalogować się za pomocą loginu LUB emaila (loginOrEmail to to, co wysyła frontend)
    const { loginOrEmail, password } = req.body;

    if (!loginOrEmail || !password) {
      return res.status(400).json({ message: 'Podaj login/email oraz hasło.' });
    }

    // Szukamy użytkownika po emailu lub nazwie użytkownika
    const user = await User.findOne({
      $or: [{ email: loginOrEmail.toLowerCase() }, { username: loginOrEmail }]
    });

    if (!user) {
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    // Porównanie podanego hasła z hashem w bazie
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Nieprawidłowy login lub hasło.' });
    }

    // Generowanie tokena JWT (ważny 24 godziny)
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Zwracamy token oraz podstawowe dane bez hasła
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

// Start serwera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serwer uruchomiony na porcie ${PORT}`);
});
