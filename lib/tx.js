'use strict';
// Transakcje MongoDB: kilka zapisów naraz albo żaden (np. zmiana salda + wpis do historii).
// Transakcje działają tylko na zestawie replik (MongoDB Atlas, replica set). Na pojedynczym serwerze
// (np. domyślny MongoDB na Railway) wykonujemy te same kroki bez transakcji, jak dotąd.
const mongoose = require('mongoose');

let supported = null;
async function transactionsSupported() {
  if (supported !== null) return supported;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch (e) {
    supported = false;
  }
  return supported;
}

// fn(session) dostaje sesję (albo null bez transakcji) i ma ją przekazać do każdego zapisu: { session }
async function withTransaction(fn) {
  if (!(await transactionsSupported())) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

const opts = (session, extra = {}) => (session ? { ...extra, session } : extra);
const resetForTests = () => { supported = null; };

module.exports = { withTransaction, transactionsSupported, opts, resetForTests };
