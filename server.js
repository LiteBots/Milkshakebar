// server.js — MilkShake Bar (EXTENDED: index.html + app.html PWA)
// Bazowe: reservations + happybar realtime + ADMIN PIN from env
// Dodatkowo: users/auth + orders + milkpoint + rewards
// Kolekcje: users, orders, products, reservations, happybars, milkpoint, rewards

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
  .then(async () => {
    console.log("✅ MongoDB connected");
    // Utwórz brakujące kolekcje (milkpoint, rewards) – jeśli nie istnieją
    try {
      const db = mongoose.connection.db;
      const existing = await db.listCollections().toArray();
      const names = new Set(existing.map((c) => c.name));

      if (!names.has("milkpoint")) {
        await db.createCollection("milkpoint");
        console.log("✅ Created collection: milkpoint");
      }
      if (!names.has("rewards")) {
        await db.createCollection("rewards");
        console.log("✅ Created collection: rewards");
      }
    } catch (e) {
      console.warn("⚠️ Collection ensure warning:", e?.message || e);
    }
  })
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

// Nowe: milkpoint (punkty + historia)
const MilkPointSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  points: { type: Number, default: 0 },
  history: { type: Array, default: [] }, // [{text,date}, ...]
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

// Nowe: rewards (realizacje nagród / kody odbioru)
const RewardSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  rewardId: { type: String, default: "" },
  title: { type: String, default: "" },
  cost: { type: Number, default: 0 },
  code: { type: String, default: "" },     // kod odbioru
  status: { type: String, default: "issued" }, // issued/redeemed/cancelled
  createdAt: { type: Date, default: Date.now },
}, { minimize: false });

// Kolekcje NA SZTYWNO:
const Reservation = mongoose.model("Reservation", ReservationSchema, "reservations");
const HappyBar = mongoose.model("HappyBar", HappySchema, "happybars");

// Liczniki do kafelków w panelu (opcjonalnie, strict:false)
const User = mongoose.model("User", new mongoose.Schema({}, { strict: false }), "users");
const Order = mongoose.model("Order", new mongoose.Schema({}, { strict: false }), "orders");
const Product = mongoose.model("Product", new mongoose.Schema({}, { strict: false }), "products");

// Nowe kolekcje (też na sztywno)
const MilkPoint = mongoose.model("MilkPoint", MilkPointSchema, "milkpoint");
const Reward = mongoose.model("Reward", RewardSchema, "rewards");

// ==========================
// Express config
// ==========================
app.use(cors());
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// jeśli trzymasz index.html/admin.html/app.html na tym samym serwerze:
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
// API — AUTH (app.html)
// ==========================
// Prosty login "email-only" (tak jak w Twoim app.html)
// Upsertuje usera do kolekcji users i zwraca {ok, user}
app.post("/api/auth/login", async (req, res) => {
  try {
    const emailRaw = String(req.body?.email || "").trim().toLowerCase();
    if (!emailRaw || !emailRaw.includes("@")) {
      return res.status(400).json({ ok: false, message: "Podaj poprawny email." });
    }

    // Upsert do "users" (strict:false)
    const now = new Date();
    const userDoc = await User.findOneAndUpdate(
      { email: emailRaw },
      {
        $set: { email: emailRaw, lastLoginAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, new: true }
    );

    // Upewnij się, że istnieje też dokument punktów
    await MilkPoint.findOneAndUpdate(
      { email: emailRaw },
      { $setOnInsert: { email: emailRaw, points: 0, history: [], updatedAt: now } },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, user: userDoc });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd logowania" });
  }
});

// ==========================
// API — REZERWACJE (index.html + app.html)
// ==========================

// admin.html: pobranie listy (WSZYSTKIE)
app.get("/api/rezerwacje", async (_req, res) => {
  try {
    const list = await Reservation.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// app.html: pobranie MOICH rezerwacji (po email)
app.get("/api/rezerwacje/my", async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.json([]);

    const list = await Reservation.find({ email }).sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// index.html + app.html: zapis rezerwacji do DB + realtime do admin.html
app.post("/api/rezerwacje", async (req, res) => {
  try {
    const r = req.body || {};

    // wspieramy dwa formaty:
    // 1) index.html -> {name,phone,date,time,guests,room,notes}
    // 2) app.html   -> {name,phone,date,time,guests,room,notes, email / user.email, milkId/loyaltyCode, source}
    const name = r.name;
    const phone = r.phone;
    const date = r.date;
    const time = r.time;
    const guests = r.guests;
    const room = r.room;

    if (!name || !phone || !date || !time || !guests || !room) {
      return res.status(400).json({ ok: false, message: "Uzupełnij wszystkie wymagane pola." });
    }

    const email = String(r.email || r.user?.email || "").trim().toLowerCase();
    const milkId = String(r.milkId || r.loyaltyCode || r.milkID || "").trim();
    const source = String(r.source || (milkId ? "app" : "index"));

    const reservation = await Reservation.create({
      name: String(name),
      phone: String(phone),
      date: String(date),
      time: String(time),
      guests: String(guests),
      room: String(room),
      notes: String(r.notes || ""),
      email,
      milkId,
      source,
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
// API — HAPPY BAR (index.html)
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
// API — ORDERS (app.html) -> kolekcja orders
// ==========================

// app.html: dodaj zamówienie (Zamów i odbierz)
app.post("/api/orders", async (req, res) => {
  try {
    const o = req.body || {};

    const email = String(o.user?.email || o.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, message: "Brak email użytkownika." });
    }

    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, message: "Koszyk jest pusty." });
    }

    const now = new Date();

    const orderDoc = {
      source: String(o.source || "app"),
      pickupTime: String(o.pickupTime || ""),
      pickupLocation: String(o.pickupLocation || ""),
      notes: String(o.notes || ""),
      items,
      total: Number(o.total || 0),
      status: String(o.status || "Przyjęte"),
      createdAt: o.createdAt ? new Date(o.createdAt) : now,

      user: {
        email,
        name: String(o.user?.name || ""),
        phone: String(o.user?.phone || ""),
      },

      loyaltyCode: String(o.loyaltyCode || o.milkId || ""),
    };

    const created = await Order.create(orderDoc);

    io.emit("new-order", created);

    return res.json({ ok: true, order: created });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd zapisu zamówienia" });
  }
});

// app.html: moje zamówienia
app.get("/api/orders/my", async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.json([]);

    const list = await Order.find({ "user.email": email }).sort({ createdAt: -1 });
    return res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json([]);
  }
});

// ==========================
// API — MILKPOINT (punkty) -> kolekcja milkpoint
// ==========================

// app.html: pobierz moje punkty
app.get("/api/milkpoints/my", async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.json({ ok: true, email: "", points: 0, history: [] });

    const doc = await MilkPoint.findOne({ email });
    if (!doc) {
      const created = await MilkPoint.create({ email, points: 0, history: [], updatedAt: new Date() });
      return res.json({ ok: true, email, points: created.points, history: created.history || [] });
    }

    return res.json({ ok: true, email, points: doc.points || 0, history: doc.history || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd pobierania punktów" });
  }
});

// app.html: sync (zapisz punkty/historię z klienta)
app.post("/api/milkpoints/sync", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, message: "Brak email." });

    const points = Number(req.body?.points || 0);
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    const updated = await MilkPoint.findOneAndUpdate(
      { email },
      { $set: { points, history, updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, email, points: updated.points, history: updated.history || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd synchronizacji punktów" });
  }
});

// (opcjonalnie) admin/cashier: dodaj punkty
app.post("/api/milkpoints/add", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const add = Number(req.body?.add || 0);
    const text = String(req.body?.text || `Dodano punkty: +${add}`);
    if (!email) return res.status(400).json({ ok: false, message: "Brak email." });
    if (!Number.isFinite(add) || add <= 0) return res.status(400).json({ ok: false, message: "Zła wartość add." });

    const doc = await MilkPoint.findOneAndUpdate(
      { email },
      {
        $inc: { points: add },
        $push: { history: { $each: [{ text, date: new Date().toLocaleString("pl-PL") }], $position: 0 } },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, email, points: doc.points, history: doc.history || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd dodawania punktów" });
  }
});

// ==========================
// API — REWARDS (realizacje) -> kolekcja rewards
// ==========================

function makeRewardCode() {
  // np. "MSB-7F3K2A"
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "MSB-";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// app.html: wymień nagrodę (serwer: sprawdza punkty, odejmuje, zapisuje reward i daje kod)
app.post("/api/rewards/redeem", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const rewardId = String(req.body?.rewardId || "");
    const title = String(req.body?.title || "");
    const cost = Number(req.body?.cost || 0);

    if (!email) return res.status(400).json({ ok: false, message: "Brak email." });
    if (!rewardId || !title || !Number.isFinite(cost) || cost <= 0) {
      return res.status(400).json({ ok: false, message: "Brak danych nagrody." });
    }

    const mp = await MilkPoint.findOne({ email });
    const current = mp?.points || 0;

    if (current < cost) {
      return res.status(400).json({ ok: false, message: "Za mało punktów." });
    }

    const code = makeRewardCode();

    // zapis reward
    const created = await Reward.create({
      email,
      rewardId,
      title,
      cost,
      code,
      status: "issued",
      createdAt: new Date(),
    });

    // odejmij punkty + dopisz historię
    const updated = await MilkPoint.findOneAndUpdate(
      { email },
      {
        $inc: { points: -cost },
        $push: { history: { $each: [{ text: `Wymieniono: -${cost} pkt (${title}) • Kod: ${code}`, date: new Date().toLocaleString("pl-PL") }], $position: 0 } },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );

    return res.json({
      ok: true,
      code,
      reward: created,
      points: updated?.points ?? (current - cost),
      history: updated?.history || [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd realizacji nagrody" });
  }
});

// app.html: moje realizacje nagród
app.get("/api/rewards/my", async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.json([]);

    const list = await Reward.find({ email }).sort({ createdAt: -1 });
    return res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json([]);
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

// (opcjonalnie) ścieżka na PWA plik
app.get("/app", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "app.html")));

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
