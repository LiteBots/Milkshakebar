// server.js — MilkShake Bar
// ✅ bcryptjs (hasła)
// ✅ milkid (6 cyfr per user) + codeid (kody nagród do realizacji)
// ✅ admin: naliczanie punktów po milkId + realizacja kodów
// ❌ NO orders (na razie nie używamy "zamów i odbierz")

const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");

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
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const CLIENTS_PIN = process.env.CLIENTS_PIN || "";

if (!MONGO_URL) console.error("❌ Brak MONGO_URL w zmiennych środowiskowych!");
if (!ADMIN_PIN) console.error("❌ Brak ADMIN_PIN w zmiennych środowiskowych! (Panel admin nie zaloguje się)");

// ==========================
// MongoDB connect + ensure collections
// ==========================
mongoose
  .connect(MONGO_URL, { dbName: "milkshakebar", autoIndex: true })
  .then(async () => {
    console.log("✅ MongoDB connected");
    try {
      const db = mongoose.connection.db;
      const existing = await db.listCollections().toArray();
      const names = new Set(existing.map((c) => c.name));

      const mustHave = ["milkpoint", "milkid", "codeid", "rewards"];
      for (const name of mustHave) {
        if (!names.has(name)) {
          await db.createCollection(name);
          console.log("✅ Created collection:", name);
        }
      }
    } catch (e) {
      console.warn("⚠️ Collection ensure warning:", e?.message || e);
    }
  })
  .catch((err) => console.error("MongoDB connect error:", err));

// ==========================
// Models
// ==========================

// reservations
const ReservationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  guests: { type: String, required: true },
  room: { type: String, required: true },
  notes: { type: String, default: "" },

  email: { type: String, default: "" },
  milkId: { type: String, default: "" },
  source: { type: String, default: "index" },

  createdAt: { type: Date, default: Date.now },
});

// happybar
const HappySchema = new mongoose.Schema({
  text: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
});

// users (email + passwordHash + milkId)
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true, unique: true },
    passwordHash: { type: String, required: true },
    milkId: { type: String, default: "", index: true },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// milkpoint (punkty)
const MilkPointSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    points: { type: Number, default: 0 },
    history: { type: Array, default: [] }, // [{text,date,meta}, ...]
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// milkid mapping (kolekcja: milkid)
const MilkIdSchema = new mongoose.Schema(
  {
    milkId: { type: String, required: true, unique: true, index: true }, // "123456"
    email: { type: String, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// codeid (kolekcja: codeid) – kody do realizacji nagród
const CodeIdSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true }, // np. "MSB-7F3K2A"
    email: { type: String, required: true, index: true },
    milkId: { type: String, default: "", index: true },

    rewardId: { type: String, required: true },
    title: { type: String, required: true },
    cost: { type: Number, required: true },

    status: { type: String, default: "issued" }, // issued / used
    issuedAt: { type: Date, default: Date.now },
    usedAt: { type: Date, default: null },
    usedBy: { type: String, default: "" }, // np. pracownik / kasa / notatka
  },
  { minimize: false }
);

// rewards (opcjonalnie: historia nagród)
const RewardSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    rewardId: { type: String, default: "" },
    title: { type: String, default: "" },
    cost: { type: Number, default: 0 },
    code: { type: String, default: "" },
    status: { type: String, default: "issued" }, // issued/redeemed
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// Kolekcje NA SZTYWNO:
const Reservation = mongoose.model("Reservation", ReservationSchema, "reservations");
const HappyBar = mongoose.model("HappyBar", HappySchema, "happybars");
const User = mongoose.model("User", UserSchema, "users");
const MilkPoint = mongoose.model("MilkPoint", MilkPointSchema, "milkpoint");
const MilkId = mongoose.model("MilkId", MilkIdSchema, "milkid");
const CodeId = mongoose.model("CodeId", CodeIdSchema, "codeid");
const Reward = mongoose.model("Reward", RewardSchema, "rewards");

// products do statystyk (jeśli masz)
const Product = mongoose.model("Product", new mongoose.Schema({}, { strict: false }), "products");

// ==========================
// Express config
// ==========================
app.use(cors());
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

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
// Utils
// ==========================
function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function makeRewardCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "MSB-";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function generateUniqueMilkId() {
  for (let tries = 0; tries < 80; tries++) {
    const milkId = String(Math.floor(100000 + Math.random() * 900000));
    const exists = await MilkId.findOne({ milkId });
    if (!exists) return milkId;
  }
  throw new Error("Nie udało się wygenerować unikalnego Milk ID (spróbuj ponownie).");
}

function calcPointsFromAmountPLN(amountPln) {
  const a = Number(amountPln);
  if (!Number.isFinite(a) || a <= 0) return 0;
  return Math.floor(a / 10);
}

// Serwerowy katalog nagród (rewardId -> tytuł/koszt)
const REWARDS_CATALOG = [
  { id: "milkshake_30", title: "Milkshake do 30 PLN", cost: 25, desc: "Wartość do 30 PLN" },
  { id: "burger_set_60", title: "Zestaw burger do 60 PLN", cost: 50, desc: "Wartość do 60 PLN" },
  { id: "order_120", title: "Zamówienie do 120 PLN", cost: 100, desc: "Wartość do 120 PLN" },
];

// ==========================
// API — HEALTH
// ==========================
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mongoState: mongoose.connection.readyState,
    db: mongoose.connection.name,
  });
});

// ==========================
// API — ADMIN LOGIN (PIN)
// ==========================
app.post("/api/login", (req, res) => {
  const pin = String(req.body?.pin || "");

  if (!ADMIN_PIN) {
    return res.status(500).json({
      ok: false,
      message: "Brak ADMIN_PIN w zmiennych środowiskowych (Railway Variables).",
    });
  }

  if (pin === ADMIN_PIN) return res.json({ ok: true });
  return res.status(401).json({ ok: false, message: "Błędny PIN" });
});

app.post("/api/clients/unlock", (req, res) => {
  const pin = String(req.body?.pin || "");
  if (!CLIENTS_PIN) {
    return res.status(500).json({
      ok: false,
      message: "Brak CLIENTS_PIN w zmiennych środowiskowych (Railway Variables).",
    });
  }
  if (pin === CLIENTS_PIN) return res.json({ ok: true });
  return res.status(401).json({ ok: false, message: "Błędny PIN" });
});

// ==========================
// API — AUTH (register/login)
// ==========================

// Rejestracja: tworzy usera + nadaje milkId (users + milkid)
app.post("/api/auth/register", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, message: "Podaj poprawny email." });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, message: "Hasło min. 6 znaków." });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ ok: false, message: "Konto z tym emailem już istnieje." });

    const now = new Date();
    const milkId = await generateUniqueMilkId();

    const passwordHash = await bcrypt.hash(password, 10);

    const userDoc = await User.create({
      email,
      passwordHash,
      milkId,
      createdAt: now,
      lastLoginAt: now,
    });

    await MilkId.create({ milkId, email, createdAt: now });

    await MilkPoint.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, points: 0, history: [], updatedAt: now } },
      { upsert: true, new: true }
    );

    return res.json({
      ok: true,
      user: { email: userDoc.email, milkId: userDoc.milkId },
      milkId,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd rejestracji" });
  }
});

// Login: weryfikuje hasło (bcrypt), zwraca milkId + punkty/historię
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, message: "Podaj poprawny email." });
    if (!password) return res.status(400).json({ ok: false, message: "Podaj hasło." });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ ok: false, message: "Błędny email lub hasło." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, message: "Błędny email lub hasło." });

    // upewnij milkId + mapping
    if (!user.milkId) {
      const newMilkId = await generateUniqueMilkId();
      user.milkId = newMilkId;
      await user.save();
      await MilkId.findOneAndUpdate(
        { milkId: newMilkId },
        { $set: { milkId: newMilkId, email } },
        { upsert: true, new: true }
      );
    } else {
      await MilkId.findOneAndUpdate(
        { milkId: user.milkId },
        { $set: { milkId: user.milkId, email } },
        { upsert: true, new: true }
      );
    }

    await User.updateOne({ email }, { $set: { lastLoginAt: new Date() } });

    const mp = await MilkPoint.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, points: 0, history: [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    return res.json({
      ok: true,
      user: { email: user.email, milkId: user.milkId },
      milkId: user.milkId,
      points: mp?.points || 0,
      history: mp?.history || [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd logowania" });
  }
});

// pomocniczo: lookup email po milkId (admin)
app.get("/api/milkid/:milkid", async (req, res) => {
  try {
    const milkId = String(req.params.milkid || "").trim();
    if (!milkId || milkId.length !== 6) return res.status(400).json({ ok: false, message: "Zły Milk ID" });

    const doc = await MilkId.findOne({ milkId });
    if (!doc) return res.status(404).json({ ok: false, message: "Nie znaleziono Milk ID" });

    return res.json({ ok: true, milkId: doc.milkId, email: doc.email });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd lookup" });
  }
});

// ==========================
// API — REZERWACJE
// ==========================
app.get("/api/rezerwacje", async (_req, res) => {
  try {
    const list = await Reservation.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

app.get("/api/rezerwacje/my", async (req, res) => {
  try {
    const email = normEmail(req.query?.email);
    if (!email) return res.json([]);
    const list = await Reservation.find({ email }).sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

app.post("/api/rezerwacje", async (req, res) => {
  try {
    const r = req.body || {};
    const { name, phone, date, time, guests, room } = r;

    if (!name || !phone || !date || !time || !guests || !room) {
      return res.status(400).json({ ok: false, message: "Uzupełnij wszystkie wymagane pola." });
    }

    const email = normEmail(r.email || r.user?.email);
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

app.put("/api/rezerwacje/:id", async (req, res) => {
  try {
    const updated = await Reservation.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ ok: false, message: "Nie znaleziono rezerwacji" });
    io.emit("reservations-updated");
    res.json({ ok: true, reservation: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd edycji rezerwacji" });
  }
});

app.delete("/api/rezerwacje/:id", async (req, res) => {
  try {
    await Reservation.findByIdAndDelete(req.params.id);
    io.emit("reservations-updated");
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Błąd usuwania rezerwacji" });
  }
});

// ==========================
// API — HAPPY BAR
// ==========================
app.get("/api/data", async (_req, res) => {
  try {
    const doc = await HappyBar.findOne().sort({ updatedAt: -1 });
    const text = doc?.text || "";
    res.json({ ok: true, happy: text, happyBarText: text, text, updatedAt: doc?.updatedAt || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, happy: "", happyBarText: "", text: "", updatedAt: null });
  }
});

app.get("/api/happy", async (_req, res) => {
  try {
    const doc = await HappyBar.findOne().sort({ updatedAt: -1 });
    res.json({ ok: true, happy: doc?.text || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, happy: "" });
  }
});

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
// API — MILKPOINT (app / konto)
// ==========================
app.get("/api/milkpoints/my", async (req, res) => {
  try {
    const email = normEmail(req.query?.email);
    if (!email) return res.json({ ok: true, email: "", points: 0, history: [] });

    const doc = await MilkPoint.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, points: 0, history: [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, email, points: doc.points || 0, history: doc.history || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd pobierania punktów" });
  }
});

// ==========================
// ADMIN: nalicz punkty po MILK ID (10zł=1pkt)
// ==========================
app.post("/api/admin/milkpoints/add-by-milkid", async (req, res) => {
  try {
    const milkId = String(req.body?.milkId || "").trim();
    const amountPln = req.body?.amountPln;
    const cashier = String(req.body?.cashier || "").trim();

    if (!milkId || milkId.length !== 6) {
      return res.status(400).json({ ok: false, message: "Podaj poprawny Milk ID (6 cyfr)." });
    }

    const mpMap = await MilkId.findOne({ milkId });
    if (!mpMap) return res.status(404).json({ ok: false, message: "Nie znaleziono użytkownika dla tego Milk ID." });

    const addPts = calcPointsFromAmountPLN(amountPln);
    if (addPts <= 0) return res.status(400).json({ ok: false, message: "Kwota za mała (min 10 zł = 1 pkt)." });

    const text = `Naliczenie: +${addPts} pkt (kwota ${Number(amountPln).toFixed(2)} zł) • Milk ID ${milkId}${
      cashier ? ` • ${cashier}` : ""
    }`;

    const doc = await MilkPoint.findOneAndUpdate(
      { email: mpMap.email },
      {
        $inc: { points: addPts },
        $push: {
          history: {
            $each: [{ text, date: new Date().toLocaleString("pl-PL"), meta: { milkId, amountPln, cashier } }],
            $position: 0,
          },
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );

    return res.json({
      ok: true,
      email: mpMap.email,
      milkId,
      addedPoints: addPts,
      points: doc.points,
      history: doc.history || [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd naliczania punktów" });
  }
});

// ==========================
// REWARDS: wymiana w app -> generuje kod i zapisuje do codeid
// ==========================
app.post("/api/rewards/redeem", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const milkId = String(req.body?.milkId || "").trim();
    const rewardId = String(req.body?.rewardId || "").trim();

    if (!email) return res.status(400).json({ ok: false, message: "Brak email." });
    if (!rewardId) return res.status(400).json({ ok: false, message: "Brak rewardId." });

    const reward = REWARDS_CATALOG.find((r) => r.id === rewardId);
    if (!reward) return res.status(400).json({ ok: false, message: "Nieznana nagroda." });

    const mp = await MilkPoint.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, points: 0, history: [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    const current = mp?.points || 0;
    if (current < reward.cost) return res.status(400).json({ ok: false, message: "Za mało punktów." });

    // unikalny kod
    let code = "";
    for (let i = 0; i < 40; i++) {
      const candidate = makeRewardCode();
      const exists = await CodeId.findOne({ code: candidate });
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) return res.status(500).json({ ok: false, message: "Nie udało się wygenerować kodu." });

    const createdCode = await CodeId.create({
      code,
      email,
      milkId,
      rewardId,
      title: reward.title,
      cost: reward.cost,
      status: "issued",
      issuedAt: new Date(),
    });

    await Reward.create({
      email,
      rewardId,
      title: reward.title,
      cost: reward.cost,
      code,
      status: "issued",
      createdAt: new Date(),
    });

    const updated = await MilkPoint.findOneAndUpdate(
      { email },
      {
        $inc: { points: -reward.cost },
        $push: {
          history: {
            $each: [{ text: `Wymieniono: -${reward.cost} pkt (${reward.title}) • Kod: ${code}`, date: new Date().toLocaleString("pl-PL") }],
            $position: 0,
          },
        },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );

    return res.json({
      ok: true,
      code,
      codeDoc: createdCode,
      reward: { id: reward.id, title: reward.title, cost: reward.cost },
      points: updated?.points ?? current - reward.cost,
      history: updated?.history || [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd realizacji nagrody" });
  }
});

// ==========================
// ADMIN: sprawdź / wykorzystaj kod (codeid)
// ==========================

// wspólna logika wykorzystania kodu (żeby nie dublować)
async function useRewardCodeCommon({ codeRaw, usedByRaw }) {
  const code = String(codeRaw || "").trim().toUpperCase();
  const usedBy = String(usedByRaw || "").trim();

  if (!code) {
    const err = new Error("Podaj kod.");
    err.status = 400;
    throw err;
  }

  const doc = await CodeId.findOne({ code });
  if (!doc) {
    const err = new Error("Nie znaleziono kodu.");
    err.status = 404;
    throw err;
  }

  if (doc.status === "used") {
    const err = new Error("Kod został już wykorzystany.");
    err.status = 409;
    err.payload = {
      ok: false,
      message: "Kod został już wykorzystany.",
      code: doc.code,
      name: doc.title,
      used: true,
      usedAt: doc.usedAt,
      note: doc.usedBy,
    };
    throw err;
  }

  doc.status = "used";
  doc.usedAt = new Date();
  doc.usedBy = usedBy || "";
  await doc.save();

  // oznacz historię nagród (opcjonalnie)
  await Reward.updateMany({ code }, { $set: { status: "redeemed" } }).catch(() => {});

  return {
    ok: true,
    code: doc.code,
    name: doc.title,
    used: true,
    usedAt: doc.usedAt,
    note: doc.usedBy,
    email: doc.email,
    milkId: doc.milkId,
  };
}

// sprawdź kod i pokaż co daje
app.post("/api/codeid/check", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, message: "Podaj kod." });

    const doc = await CodeId.findOne({ code });
    if (!doc) return res.status(404).json({ ok: false, message: "Nie znaleziono kodu." });

    return res.json({
      ok: true,
      code: doc.code,
      status: doc.status,
      title: doc.title,
      rewardId: doc.rewardId,
      cost: doc.cost,
      email: doc.email,
      milkId: doc.milkId,
      issuedAt: doc.issuedAt,
      usedAt: doc.usedAt,
      usedBy: doc.usedBy,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Błąd sprawdzania kodu" });
  }
});

// wykorzystaj (zablokuj) kod na zawsze (stary endpoint)
app.post("/api/codeid/use", async (req, res) => {
  try {
    const out = await useRewardCodeCommon({
      codeRaw: req.body?.code,
      usedByRaw: req.body?.usedBy,
    });

    // zachowaj kompatybilność: zwróć też pola jak dawniej
    return res.json({
      ...out,
      message: "Kod wykorzystany i zablokowany ✅",
      title: out.name,
      usedBy: out.note,
    });
  } catch (e) {
    const status = e.status || 500;
    if (e.payload) return res.status(status).json(e.payload);
    console.error(e);
    return res.status(status).json({ ok: false, message: e.message || "Błąd wykorzystania kodu" });
  }
});

// ✅ NOWY ENDPOINT DLA PANELU ADMINA (pasuje do Twojego frontu)
// POST /api/admin/rewards/use { code, note }
app.post("/api/admin/rewards/use", async (req, res) => {
  try {
    const out = await useRewardCodeCommon({
      codeRaw: req.body?.code,
      usedByRaw: req.body?.note, // w panelu "Notatka" zapisujemy jako usedBy/note
    });

    // Forma idealnie pod Twój admin.html:
    // { ok:true, code, name, used:true, usedAt, note }
    return res.json({
      ok: true,
      code: out.code,
      name: out.name,
      used: true,
      usedAt: out.usedAt,
      note: out.note,
    });
  } catch (e) {
    const status = e.status || 500;
    if (e.payload) return res.status(status).json(e.payload);
    console.error(e);
    return res.status(status).json({ ok: false, message: e.message || "Błąd wykorzystania kodu" });
  }
});

// ==========================
// Admin stats (bez orders)
// ==========================
app.get("/api/admin/stats", async (_req, res) => {
  try {
    const [users, products, reservations] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Reservation.countDocuments(),
    ]);

    const milkpointsDocs = await MilkPoint.find({}, { points: 1 }).lean();
    const milkosTotal = milkpointsDocs.reduce((sum, d) => sum + (Number(d.points) || 0), 0);
    const usersWithPoints = milkpointsDocs.filter((d) => (Number(d.points) || 0) > 0).length;

    res.json({
      ok: true,
      users,
      products,
      reservations,
      milkosTotal,
      usersWithPoints,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, users: 0, products: 0, reservations: 0, milkosTotal: 0, usersWithPoints: 0 });
  }
});

// ==========================
// Routes
// ==========================
app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));
app.get("/index.html", (_req, res) => res.redirect(301, "/"));
app.get("/app", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "app.html")));

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, message: "Not found" });
  if (req.path.startsWith("/socket.io/")) return res.sendStatus(404);
  return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

server.listen(PORT, () => {
  console.log("✅ MilkShake Bar server running on port:", PORT);
});
