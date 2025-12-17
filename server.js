// server.js — MilkShake Bar (MINIMAL: reservations + happybar realtime + ADMIN PIN from env)
// Kolekcje: users, orders, products, reservations, happybars

const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] },
});

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// ==========================
// ENV (Railway Variables)
// ==========================
const MONGO_URL = process.env.MONGO_URL;
const ADMIN_PIN = process.env.ADMIN_PIN || "";      // ustaw w Railway Variables (np. 0051)
const CLIENTS_PIN = process.env.CLIENTS_PIN || "";  // opcjonalnie (np. 5100)

if (!MONGO_URL) console.error("❌ Brak MONGO_URL w zmiennych środowiskowych!");
if (!ADMIN_PIN) console.error("❌ Brak ADMIN_PIN w zmiennych środowiskowych! (Panel admin nie zaloguje się)");

// ==========================
// MongoDB connect
// ==========================
mongoose
  .connect(MONGO_URL, {
    dbName: "milkshakebar",
    autoIndex: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("MongoDB connect error:", err));

// ==========================
// Models (kolekcje BEZ new_)
// ==========================

// reservations
const ReservationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  date: { type: String, required: true }, // np. "2025-12-15"
  time: { type: String, required: true }, // np. "18:30"
  guests: { type: String, required: true },
  room: { type: String, required: true },
  notes: { type: String, default: "" },

  email: { type: String, default: "" },
  milkId: { type: String, default: "" },
  source: { type: String, default: "index" }, // "index" / "app" itd.

  createdAt: { type: Date, default: Date.now },
});

// happybar (pasek info)
const HappySchema = new mongoose.Schema({
  text: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
});

// Kolekcje NA SZTYWNO:
const Reservation = mongoose.model("Reservation", ReservationSchema, "reservations");
const HappyBar = mongoose.model("HappyBar", HappySchema, "happybars");

// Liczniki do kafelków w panelu (opcjonalnie, strict:false)
const User = mongoose.model("User", new mongoose.Schema({}, { strict: false }), "users");
const Order = mongoose.model("Order", new mongoose.Schema({}, { strict: false }), "orders");
const Product = mongoose.model("Product", new mongoose.Schema({}, { strict: false }), "products");

// ==========================
// Express config
// ==========================
app.use(cors());
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// jeśli trzymasz index.html/admin.html na tym samym serwerze:
app.use(express.static(PUBLIC_DIR));

// (opcjonalnie) log requestów do debug
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
    console.log(`➡️ ${req.method} ${req.path}`);
  }
  next();
});

// ==========================
// Socket.IO
// ==========================
io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// ==========================
// API — HEALTH
// ==========================
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mongoState: mongoose.connection.readyState, // 1 = connected
    db: mongoose.connection.name,
  });
});

// ==========================
// API — ADMIN LOGIN (PIN from Railway Variables)
// ==========================
app.post("/api/login", (req, res) => {
  const pin = String(req.body?.pin || "");

  // jeśli ktoś zapomniał ustawić w Railway:
  if (!ADMIN_PIN) {
    return res.status(500).json({
      ok: false,
      message: "Brak ADMIN_PIN w zmiennych środowiskowych (Railway Variables).",
    });
  }

  if (pin === ADMIN_PIN) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, message: "Błędny PIN" });
});

// opcjonalnie: osobny PIN do odblokowania 'Baza klientów'
app.post("/api/clients/unlock", (req, res) => {
  const pin = String(req.body?.pin || "");

  if (!CLIENTS_PIN) {
    return res.status(500).json({
      ok: false,
      message: "Brak CLIENTS_PIN w zmiennych środowiskowych (Railway Variables).",
    });
  }

  if (pin === CLIENTS_PIN) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, message: "Błędny PIN" });
});

// ==========================
// API — REZERWACJE
// ==========================

// admin.html: pobranie listy
app.get("/api/rezerwacje", async (_req, res) => {
  try {
    const list = await Reservation.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// index.html: zapis rezerwacji do DB + realtime do admin.html
app.post("/api/rezerwacje", async (req, res) => {
  try {
    const r = req.body || {};

    if (!r.name || !r.phone || !r.date || !r.time || !r.guests || !r.room) {
      return res.status(400).json({ ok: false, message: "Uzupełnij wszystkie wymagane pola." });
    }

    const reservation = await Reservation.create({
      name: String(r.name),
      phone: String(r.phone),
      date: String(r.date),
      time: String(r.time),
      guests: String(r.guests),
      room: String(r.room),
      notes: String(r.notes || ""),
      email: String(r.email || ""),
      milkId: String(r.milkId || ""),
      source: String(r.source || (r.milkId ? "app" : "index")),
    });

    io.emit("new-reservation", reservation);

    res.json({ ok: true, reservation });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd zapisu rezerwacji" });
  }
});

// admin.html: edycja
app.put("/api/rezerwacje/:id", async (req, res) => {
  try {
    const updated = await Reservation.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ ok: false, message: "Nie znaleziono rezerwacji" });

    io.emit("reservations-updated"); // opcjonalnie
    res.json({ ok: true, reservation: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd edycji rezerwacji" });
  }
});

// admin.html: usuwanie
app.delete("/api/rezerwacje/:id", async (req, res) => {
  try {
    await Reservation.findByIdAndDelete(req.params.id);

    io.emit("reservations-updated"); // opcjonalnie
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd usuwania rezerwacji" });
  }
});

// ==========================
// API — HAPPY BAR
// ==========================

// kompatybilny endpoint dla index.html (/api/data)
app.get("/api/data", async (_req, res) => {
  try {
    const doc = await HappyBar.findOne().sort({ updatedAt: -1 });
    const text = doc?.text || "";
    res.json({
      ok: true,
      happy: text,
      happyBarText: text,
      text: text,
      updatedAt: doc?.updatedAt || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, happy: "", happyBarText: "", text: "", updatedAt: null });
  }
});

// pobranie tekstu
app.get("/api/happy", async (_req, res) => {
  try {
    const doc = await HappyBar.findOne().sort({ updatedAt: -1 });
    res.json({ ok: true, happy: doc?.text || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, happy: "" });
  }
});

// zapis + realtime update
app.post("/api/happy", async (req, res) => {
  try {
    const text = String(req.body?.happy ?? req.body?.text ?? "");

    await HappyBar.create({ text, updatedAt: new Date() });

    io.emit("happy-updated", text);

    res.json({ ok: true, happy: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd zapisu paska" });
  }
});

// ==========================
// API — kafelki w panelu (liczniki)
// ==========================
app.get("/api/admin/stats", async (_req, res) => {
  try {
    const [users, orders, products, reservations] = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      Product.countDocuments(),
      Reservation.countDocuments(),
    ]);
    res.json({ ok: true, users, orders, products, reservations });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, users: 0, orders: 0, products: 0, reservations: 0 });
  }
});

// ==========================
// Routes
// ==========================
app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));
app.get("/index.html", (_req, res) => res.redirect(301, "/"));

// ==========================
// SPA fallback (nie łamiemy /api i /socket.io)
// ==========================
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, message: "Not found" });
  if (req.path.startsWith("/socket.io/")) return res.sendStatus(404);
  return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ==========================
// Start
// ==========================
server.listen(PORT, () => {
  console.log("✅ MilkShake Bar server running on port:", PORT);
});
