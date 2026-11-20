'use strict';
// Limity prób trzymane w MongoDB (kolekcja ratelimits z indeksem TTL).
// Działają po restarcie serwera i przy kilku instancjach. Gdy baza nie odpowiada, liczymy w pamięci.

module.exports = function createRateLimiter(RateLimit) {
  const memory = new Map();
  const memGet = (key) => {
    const e = memory.get(key);
    if (e && e.expiresAt > Date.now()) return e;
    memory.delete(key);
    return null;
  };

  // Czy limit został przekroczony (bez liczenia tej próby)
  async function tooMany(key, limit) {
    try {
      const doc = await RateLimit.findOne({ key, expiresAt: { $gt: new Date() } }, 'count').lean();
      return Boolean(doc && doc.count >= limit);
    } catch (e) {
      const m = memGet(key);
      return Boolean(m && m.count >= limit);
    }
  }

  // Liczy próbę; okno startuje od pierwszej próby
  async function hit(key, windowMs) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    try {
      const inc = await RateLimit.findOneAndUpdate({ key, expiresAt: { $gt: now } }, { $inc: { count: 1 } }, { new: true });
      if (inc) return inc.count;
      try {
        await RateLimit.findOneAndUpdate({ key }, { $set: { count: 1, expiresAt } }, { upsert: true });
      } catch (dup) {
        // Równoległa pierwsza próba: dokument już jest, wystarczy go zwiększyć
        await RateLimit.updateOne({ key }, { $inc: { count: 1 } });
      }
      return 1;
    } catch (e) {
      const m = memGet(key) || { count: 0, expiresAt: expiresAt.getTime() };
      m.count += 1;
      memory.set(key, m);
      return m.count;
    }
  }

  async function clear(key) {
    memory.delete(key);
    try { await RateLimit.deleteOne({ key }); } catch (e) { /* wygaśnie samo */ }
  }

  return { tooMany, hit, clear };
};
