/**
 * QuantVexa Backend Server — API Hub (single file)
 * ============================================================
 *
 * This server has ALL the APIs for:
 *   - Web App (4 quantvexa pages on GitHub Pages)
 *   - Admin dashboard
 *
 * It does NOT have:
 *   ❌ TELEGRAM_BOT_TOKEN (that's in the residential server)
 *   ❌ Signal generator (that's in the residential server)
 *   ❌ Telegram polling (that's in the residential server)
 *
 * The residential server (home computer) PUSHES data here via webhooks:
 *   POST /internal/signals/new       — new signal generated
 *   POST /internal/signals/:id/resolve — signal resolved (win/lose)
 *   POST /internal/support/message   — user sent a Telegram message
 *   POST /internal/bot/status        — bot status update
 *
 * For outgoing Telegram messages (notify user of approval/rejection),
 * the bridge stores them in a notification queue. The residential server
 * polls GET /internal/notifications/queue, sends them via Telegram,
 * then POST /internal/notifications/:id/sent to mark as delivered.
 *
 * Candle data is generated natively (deterministic — no sensitive data).
 */

import http from 'http';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';

dotenv.config();

// ============================================================================
// CONFIG
// ============================================================================
const config = {
  port:           parseInt(process.env.PORT || '8080', 10),
  nodeEnv:        process.env.NODE_ENV || 'development',
  logLevel:       process.env.LOG_LEVEL || 'info',

  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',').map(s => s.trim()).filter(Boolean),

  internalSecret: process.env.INTERNAL_SECRET || 'dev-internal-secret',

  mongodbUrl: process.env.MONGODB_URL || '',
  mongodbDb:  process.env.MONGODB_DB  || 'quantvexa',

  adminEmail:    process.env.ADMIN_EMAIL    || 'admin@dashboard.io',
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@2024',

  plans: {
    basic: parseInt(process.env.PLAN_BASIC_PRICE || '50', 10),
    pro:   parseInt(process.env.PLAN_PRO_PRICE   || '75', 10),
    elite: parseInt(process.env.PLAN_ELITE_PRICE || '100', 10),
  },
};

// ============================================================================
// LOGGER
// ============================================================================
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = LEVELS[config.logLevel] ?? LEVELS.info;
function log(level, msg, meta) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const line = { t: new Date().toISOString(), level, msg, ...(meta || {}) };
  if (config.nodeEnv === 'production') {
    process.stdout.write(JSON.stringify(line) + '\n');
  } else {
    const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level];
    process.stdout.write(`${color}[${level.toUpperCase()}]\x1b[0m ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`);
  }
}
const logger = {
  debug: (m, x) => log('debug', m, x),
  info:  (m, x) => log('info',  m, x),
  warn:  (m, x) => log('warn',  m, x),
  error: (m, x) => log('error', m, x),
};

// ============================================================================
// RESPONSE HELPERS
// ============================================================================
const ok = (res, data = null, status = 200) => res.status(status).json({ ok: true, data });
const created = (res, data) => ok(res, data, 201);
const fail = (res, { code = 'INTERNAL', message = 'Something went wrong', status = 500, details } = {}) =>
  res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
const failBadRequest   = (res, msg = 'Bad request',  d) => fail(res, { code: 'BAD_REQUEST',   message: msg, status: 400, details: d });
const failUnauthorized = (res, msg = 'Unauthorized') => fail(res, { code: 'UNAUTHORIZED',  message: msg, status: 401 });
const failNotFound     = (res, msg = 'Not found')    => fail(res, { code: 'NOT_FOUND',     message: msg, status: 404 });

// ============================================================================
// MONGODB (optional cache/persistence)
// ============================================================================
let mongoDb = null;
async function connectMongoDB() {
  if (!config.mongodbUrl) { logger.info('MONGODB_URL not set — in-memory only'); return; }
  try {
    const client = new MongoClient(config.mongodbUrl, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    mongoDb = client.db(config.mongodbDb);
    logger.info('✅ MongoDB connected', { db: config.mongodbDb });
    await loadFromDB();
  } catch (err) {
    logger.error('MongoDB connection failed — in-memory only', { err: err.message });
    mongoDb = null;
  }
}
async function loadFromDB() {
  if (!mongoDb) return;
  try {
    const users = await mongoDb.collection('users').find({}).toArray();
    users.forEach(u => collections.users.set(u.id, u));
    const subs = await mongoDb.collection('subscriptions').find({}).toArray();
    subs.forEach(s => collections.subscriptions.set(s.id, s));
    const convos = await mongoDb.collection('convos').find({}).toArray();
    convos.forEach(c => { collections.convos.set(c.id, c); collections.convos.set(c.tgId, c); });
    const signals = await mongoDb.collection('signals').find({}).sort({ createdAt: -1 }).limit(500).toArray();
    collections.signals = signals.reverse();
    const payDoc = await mongoDb.collection('config').findOne({ _id: 'payments' });
    if (payDoc?.methods) Object.entries(payDoc.methods).forEach(([k, v]) => collections.payments.set(k, v));
    const notifs = await mongoDb.collection('notifications').find({}).sort({ sentAt: -1 }).toArray();
    collections.notifications = notifs;
    const promos = await mongoDb.collection('promos').find({}).toArray();
    collections.promos = promos;
    const offers = await mongoDb.collection('offers').find({}).toArray();
    collections.offers = offers;
    logger.info('data loaded from MongoDB', { users: collections.users.size, signals: collections.signals.length });
  } catch (err) { logger.error('loadFromDB failed', { err: err.message }); }
}
function mongoPersist(col, op, filter, doc) {
  if (!mongoDb) return;
  const c = mongoDb.collection(col);
  if (op === 'insert') c.insertOne(doc).catch(e => logger.warn('mongo insert', { col, err: e.message }));
  else if (op === 'replace') c.replaceOne(filter, doc, { upsert: true }).catch(e => logger.warn('mongo replace', { col, err: e.message }));
  else if (op === 'delete') c.deleteOne(filter).catch(e => logger.warn('mongo delete', { col, err: e.message }));
}

// ============================================================================
// TELEGRAM INIT-DATA VERIFICATION (no bot token needed — residential verifies)
// ============================================================================
function verifyInitData(raw) {
  try {
    const params = new URLSearchParams(raw);
    const userStr = params.get('user');
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    return {
      id: String(user.id), firstName: user.first_name || '', lastName: user.last_name || '',
      username: user.username || '', photoUrl: user.photo_url || '', language: user.language_code || 'en',
      platform: 'QUOTEX',
    };
  } catch { return null; }
}
function extractInitData(req) {
  const auth = req.get('Authorization') || '';
  if (auth.startsWith('tma '))      return auth.slice(4);
  if (auth.startsWith('Telegram ')) return auth.slice(9);
  if (req.query['tg-init-data'])    return String(req.query['tg-init-data']);
  return null;
}

// ============================================================================
// MIDDLEWARE
// ============================================================================
function corsMiddleware() {
  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (config.allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret'],
  });
}
function authMiddleware(req, res, next) {
  const raw = extractInitData(req);
  if (!raw) return failUnauthorized(res, 'Missing Telegram initData');
  const user = verifyInitData(raw);
  if (!user) return failUnauthorized(res, 'Invalid Telegram initData');
  req.tgUser = user;
  next();
}
function internalAuth(req, res, next) {
  const secret = req.get('X-Internal-Secret');
  if (!secret || secret !== config.internalSecret) return failUnauthorized(res, 'Invalid internal secret');
  next();
}
function notFound(req, res) {
  return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` } });
}
function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';
  logger.error('request failed', { method: req.method, path: req.path, status, code, message: err.message });
  return res.status(status).json({ ok: false, error: { code, message: err.message || 'Internal server error' } });
}

// ============================================================================
// ADMIN AUTH
// ============================================================================
function generateAdminToken(email) {
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const payload = Buffer.from(`${email}:${expiresAt}`).toString('base64');
  const sig = crypto.createHmac('sha256', config.internalSecret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyAdminToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const calcSig = crypto.createHmac('sha256', config.internalSecret).update(payload).digest('hex');
  if (sig !== calcSig) return null;
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const [email, expiresAt] = decoded.split(':');
    if (Date.now() > parseInt(expiresAt, 10)) return null;
    return { email, expiresAt: parseInt(expiresAt, 10) };
  } catch { return null; }
}
function adminAuthMiddleware(req, res, next) {
  const auth = req.get('Authorization') || '';
  let token = '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  else if (auth.startsWith('Admin ')) token = auth.slice(6);
  const result = verifyAdminToken(token);
  if (!result) return failUnauthorized(res, 'Invalid or expired admin token');
  req.admin = result;
  next();
}

// ============================================================================
// CANDLE DATA — deterministic OHLCV (no sensitive data, generated natively)
// ============================================================================
const CANDLE_SYMBOLS = [
  { symbol: 'BRLUSD-OTC', price: 0.1985, change: 0.42 }, { symbol: 'USDARS-OTC', price: 985.50, change: -0.31 },
  { symbol: 'USDBDT-OTC', price: 117.25, change: 0.18 }, { symbol: 'USDCOP-OTC', price: 4150.75, change: -0.55 },
  { symbol: 'USDEGP-OTC', price: 48.85, change: 0.12 }, { symbol: 'USDIDR-OTC', price: 15820.50, change: -0.28 },
  { symbol: 'USDINR-OTC', price: 83.42, change: 0.22 }, { symbol: 'USDMXN-OTC', price: 17.15, change: -0.41 },
  { symbol: 'USDNGN-OTC', price: 1485.30, change: 0.67 }, { symbol: 'USDPHP-OTC', price: 56.78, change: -0.19 },
  { symbol: 'USDPKR-OTC', price: 278.45, change: 0.34 }, { symbol: 'USDZAR-OTC', price: 18.92, change: -0.48 },
  { symbol: 'EURUSD-OTC', price: 1.0852, change: 0.18 }, { symbol: 'GBPUSD-OTC', price: 1.3025, change: -0.12 },
  { symbol: 'USDJPY-OTC', price: 149.85, change: 0.27 }, { symbol: 'AUDUSD-OTC', price: 0.6582, change: -0.08 },
  { symbol: 'USDCAD-OTC', price: 1.3585, change: 0.15 }, { symbol: 'EURJPY-OTC', price: 163.45, change: 0.31 },
  { symbol: 'EURGBP-OTC', price: 0.8338, change: -0.05 }, { symbol: 'GBPJPY-OTC', price: 195.42, change: 0.22 },
  { symbol: 'BTC/USDT', price: 67234.50, change: 1.42 }, { symbol: 'ETH/USDT', price: 3456.20, change: 0.95 },
  { symbol: 'SOL/USDT', price: 178.50, change: -0.31 }, { symbol: 'XRP/USDT', price: 0.5432, change: 0.18 },
  { symbol: 'AVAX/USDT', price: 38.76, change: -0.55 }, { symbol: 'DOGE/USDT', price: 0.1654, change: 0.34 },
];
const TIMEFRAME_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(rng, mean, std) {
  const u1 = rng() || 0.0001, u2 = rng();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function genCandles(symbol, timeframe, limit) {
  const seed = parseInt(crypto.createHash('sha256').update(symbol).digest('hex').slice(0, 8), 16);
  const rng = mulberry32(seed);
  const symInfo = CANDLE_SYMBOLS.find(s => s.symbol === symbol);
  const basePrice = symInfo ? symInfo.price : 100;
  const volatility = Math.max(0.0005, Math.log10(basePrice + 1) * 0.001);
  const tfSec = TIMEFRAME_SECONDS[timeframe] || 60;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - limit * tfSec;
  const candles = [];
  let price = basePrice;
  for (let i = 0; i < limit; i++) {
    const ts = startTime + i * tfSec;
    const drift = (basePrice - price) * 0.02;
    const change = gauss(rng, drift, volatility * price);
    const open = price;
    const close = Math.max(0.0001, price + change);
    const wickUp = Math.abs(gauss(rng, 0, volatility * price * 0.5));
    const wickDn = Math.abs(gauss(rng, 0, volatility * price * 0.5));
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDn;
    const volume = Math.floor(rng() * 9900) + 100;
    candles.push({ time: ts, open: Math.round(open*1e5)/1e5, high: Math.round(high*1e5)/1e5, low: Math.round(low*1e5)/1e5, close: Math.round(close*1e5)/1e5, volume });
    price = close;
  }
  return candles;
}

// ============================================================================
// DATA STORE — in-memory + MongoDB write-through
// ============================================================================
const collections = {
  users: new Map(), subscriptions: new Map(), convos: new Map(),
  signals: [], payments: new Map(), notifications: [], promos: [], offers: [],
  notifQueue: [],  // outgoing Telegram notifications (residential server polls this)
};

const dataStore = {
  // Users
  getUser(tgId) { return collections.users.get(String(tgId)); },
  upsertUser(user) {
    const u = { ...user, id: String(user.id), updatedAt: Date.now() };
    collections.users.set(u.id, u);
    mongoPersist('users', 'replace', { _id: u.id }, { ...u, _id: u.id });
    return u;
  },
  listUsers() { return Array.from(collections.users.values()); },

  // Subscriptions
  listSubRequests({ status, tgId } = {}) {
    return [...collections.subscriptions.values()].filter(r => {
      if (status && r.status !== status) return false;
      if (tgId && r.tgId !== String(tgId)) return false;
      return true;
    }).sort((a, b) => b.createdAt - a.createdAt);
  },
  getSubRequest(id) { return collections.subscriptions.get(id); },
  addSubRequest(req) {
    const r = { id: 'sr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'pending', createdAt: Date.now(), ...req };
    collections.subscriptions.set(r.id, r);
    mongoPersist('subscriptions', 'insert', { _id: r.id }, { ...r, _id: r.id });
    return r;
  },
  updateSubRequest(id, patch) {
    const r = collections.subscriptions.get(id);
    if (!r) return null;
    Object.assign(r, patch, { resolvedAt: Date.now() });
    collections.subscriptions.set(id, r);
    mongoPersist('subscriptions', 'replace', { _id: id }, { ...r, _id: id });
    return r;
  },

  // Convos
  listConvos(tgId) {
    return [...collections.convos.values()].filter(c => !tgId || c.tgId === String(tgId))
      .sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  },
  getConvo(id) { return collections.convos.get(id); },
  getOrCreateConvo(tgId, userInfo = {}) {
    const key = String(tgId);
    if (collections.convos.has(key)) return collections.convos.get(key);
    const c = { id: 'c_' + key, tgId: key, userName: userInfo.name || '', userEmail: userInfo.email || '', status: 'open', unread: 0, messages: [], createdAt: Date.now() };
    collections.convos.set(c.id, c); collections.convos.set(key, c);
    mongoPersist('convos', 'insert', { _id: c.id }, { ...c, _id: c.id });
    return c;
  },
  addMessage(convoId, msg) {
    const c = collections.convos.get(convoId) || collections.convos.get(String(convoId));
    if (!c) return null;
    const m = { id: 'm_' + Date.now().toString(36), at: Date.now(), ...msg };
    c.messages.push(m);
    if (m.from === 'user') c.unread = (c.unread || 0) + 1;
    mongoPersist('convos', 'replace', { _id: c.id }, { ...c, _id: c.id });
    return m;
  },
  markRead(convoId) {
    const c = collections.convos.get(convoId);
    if (c) { c.unread = 0; mongoPersist('convos', 'replace', { _id: c.id }, { ...c, _id: c.id }); return c; }
    return null;
  },

  // Signals
  listSignals(limit = 50) { return collections.signals.slice(0, limit); },
  addSignal(sig) {
    const s = { id: sig.id || 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), createdAt: Date.now(), result: null, profit: null, ...sig };
    collections.signals.unshift(s);
    if (collections.signals.length > 500) collections.signals.length = 500;
    mongoPersist('signals', 'insert', { _id: s.id }, { ...s, _id: s.id });
    return s;
  },
  resolveSignal(id, result, profit) {
    const s = collections.signals.find(x => x.id === id);
    if (!s) return null;
    s.result = result; s.profit = profit; s.resolvedAt = Date.now();
    mongoPersist('signals', 'replace', { _id: id }, { ...s, _id: id });
    return s;
  },

  // Payments
  getPayments() {
    return collections.payments.size ? Object.fromEntries(collections.payments) : {
      binance: { enabled: true, payUser: 'YOUR_BINANCE_PAY_ID' },
      trc20: { enabled: true, wallet: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
      bep20: { enabled: true, wallet: '0xXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    };
  },
  setPayment(methodId, cfg) {
    collections.payments.set(methodId, cfg);
    mongoPersist('config', 'replace', { _id: 'payments' }, { _id: 'payments', methods: Object.fromEntries(collections.payments) });
    return collections.payments.get(methodId);
  },

  // Notifications
  listNotifications() { return collections.notifications; },
  addNotification(notif) {
    const n = { id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), sentAt: Date.now(), sentCount: 0, ...notif };
    collections.notifications.unshift(n);
    mongoPersist('notifications', 'insert', { _id: n.id }, { ...n, _id: n.id });
    return n;
  },
  deleteNotification(id) {
    const idx = collections.notifications.findIndex(n => n.id === id);
    if (idx === -1) return false;
    collections.notifications.splice(idx, 1);
    mongoPersist('notifications', 'delete', { _id: id }, null);
    return true;
  },

  // Promos
  listPromos() { return collections.promos; },
  addPromo(promo) {
    const p = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), activated: 0, createdAt: Date.now(), ...promo };
    collections.promos.unshift(p);
    mongoPersist('promos', 'insert', { _id: p.id }, { ...p, _id: p.id });
    return p;
  },
  deletePromo(id) { const idx = collections.promos.findIndex(p => p.id === id); if (idx === -1) return false; collections.promos.splice(idx, 1); mongoPersist('promos', 'delete', { _id: id }, null); return true; },
  togglePromo(id) { const p = collections.promos.find(x => x.id === id); if (!p) return null; p.active = !p.active; mongoPersist('promos', 'replace', { _id: id }, { ...p, _id: id }); return p; },

  // Offers
  listOffers() { return collections.offers; },
  addOffer(offer) {
    const o = { id: 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), active: true, createdAt: Date.now(), ...offer };
    collections.offers.unshift(o);
    mongoPersist('offers', 'insert', { _id: o.id }, { ...o, _id: o.id });
    return o;
  },
  deleteOffer(id) { const idx = collections.offers.findIndex(o => o.id === id); if (idx === -1) return false; collections.offers.splice(idx, 1); mongoPersist('offers', 'delete', { _id: id }, null); return true; },
  toggleOffer(id) { const o = collections.offers.find(x => x.id === id); if (!o) return null; o.active = !o.active; mongoPersist('offers', 'replace', { _id: id }, { ...o, _id: id }); return o; },

  // Notification queue — residential server polls this to send Telegram messages
  queueNotification(tgId, text, type = 'info') {
    const n = { id: 'nq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), tgId: String(tgId), text, type, status: 'pending', createdAt: Date.now() };
    collections.notifQueue.push(n);
    return n;
  },
  getPendingNotifications() { return collections.notifQueue.filter(n => n.status === 'pending'); },
  markNotificationSent(id) { const n = collections.notifQueue.find(x => x.id === id); if (n) { n.status = 'sent'; n.sentAt = Date.now(); } return n; },
};

// ============================================================================
// PLANS + STRATEGIES + PLATFORMS (static catalogs)
// ============================================================================
const PLANS = [
  { id: 'basic', name: 'Basic', price: config.plans.basic, currency: 'USD', duration: 'month', featured: false, tagline: 'For new traders getting started', features: ['Up to 100 signals per month','Strong strategy access','Telegram bot integration','Basic trade history (30 days)'] },
  { id: 'pro', name: 'Pro', price: config.plans.pro, currency: 'USD', duration: 'month', featured: true, tagline: 'For serious active traders', features: ['Up to 500 signals per month','All strategies (Strong, Medium, Pro)','Advanced analytics dashboard','Full trade history (unlimited)','Priority 24/7 support','Multi-exchange support'] },
  { id: 'elite', name: 'Elite', price: config.plans.elite, currency: 'USD', duration: 'month', featured: false, tagline: 'For professional institutions', features: ['Unlimited signals','All strategies + early access','White-label dashboard','Dedicated account manager','24/7 phone support','Custom integrations','SLA guarantee'] },
];
const STRATEGIES = [
  { id: 'strong', name: 'Strong', tag: 'High frequency, moderate accuracy', color: '#00ff88', winRate: 0.55, profitRange: [0.3, 1.8], lossRange: [0.4, 1.6], costPerSignal: 1, signalsPerDay: '15-25', accuracy: '70%', duration: '1-3m', enabled: true },
  { id: 'medium', name: 'Medium', tag: 'Balanced signals, steady results', color: '#00d2ff', winRate: 0.65, profitRange: [0.3, 2.0], lossRange: [0.3, 1.5], costPerSignal: 3, signalsPerDay: '8-12', accuracy: '80%', duration: '2-5m', enabled: true },
  { id: 'pro', name: 'Pro', tag: 'Premium accuracy, low frequency', color: '#ab82ff', winRate: 0.78, profitRange: [0.5, 2.5], lossRange: [0.3, 1.2], costPerSignal: 6, signalsPerDay: '3-5', accuracy: '92%', duration: '5-15m', enabled: true },
];
const PLATFORMS = [
  { id: 'QUOTEX', name: 'QUOTEX', description: 'Binary options trading', running: true, color: '#00d2ff' },
  { id: 'BINOLLA', name: 'BINOLLA', description: 'Smart advanced trading', running: true, color: '#00ff88' },
];

// ============================================================================
// WEBSITE BROADCAST HOOKS
// ============================================================================
let broadcastSignalFn = null;
let broadcastSupportFn = null;

// ============================================================================
// EXPRESS APP
// ============================================================================
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/internal', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ ok: true, role: 'api-hub', mongo: mongoDb ? 'connected' : 'in-memory', signals: collections.signals.length, ts: Date.now() }));

// ============================================================================
// ROUTES — Web App
// ============================================================================

// Auth
app.post('/api/auth/telegram', (req, res) => {
  const { init_data } = req.body || {};
  if (!init_data) return failBadRequest(res, 'Missing init_data');
  const user = verifyInitData(init_data);
  if (!user) return failUnauthorized(res, 'Invalid Telegram initData');
  const u = dataStore.upsertUser({ ...user, lastSeen: Date.now() });
  return ok(res, { user: { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), username: u.username, photoUrl: u.photoUrl, language: u.language }, session_token: init_data });
});

// Plans
app.get('/api/plans', (req, res) => ok(res, PLANS));
app.get('/api/plans/:id', (req, res) => { const p = PLANS.find(x => x.id === req.params.id); if (!p) return failNotFound(res, 'Plan not found'); return ok(res, p); });
app.get('/api/payment-methods', (req, res) => ok(res, dataStore.getPayments()));

// Subscriptions
app.post('/api/subscriptions/request', authMiddleware, (req, res, next) => {
  try {
    const plan = PLANS.find(p => p.id === req.body.planId);
    if (!plan) return failBadRequest(res, 'Invalid plan');
    if (!['binance', 'trc20', 'bep20'].includes(req.body.paymentMethod)) return failBadRequest(res, 'Invalid payment method');
    const r = dataStore.addSubRequest({ tgId: req.tgUser.id, userName: [req.tgUser.firstName, req.tgUser.lastName].filter(Boolean).join(' '), username: req.tgUser.username, planId: plan.id, planName: plan.name, amount: plan.price, currency: plan.currency, paymentMethod: req.body.paymentMethod, transactionId: req.body.transactionId, receiptImage: req.body.receiptImage || null, note: req.body.note || '' });
    return created(res, r);
  } catch (err) { next(err); }
});
app.get('/api/subscriptions/mine', authMiddleware, (req, res) => ok(res, dataStore.listSubRequests({ tgId: req.tgUser.id })));
app.get('/api/subscriptions/status', authMiddleware, (req, res) => {
  const u = dataStore.getUser(req.tgUser.id);
  return ok(res, { subscriptionStatus: u?.subscriptionStatus || 'INACTIVE', subscriptionPlan: u?.subscriptionPlan || null, subscriptionPlanId: u?.subscriptionPlanId || null, subscriptionAmount: u?.subscriptionAmount || 0, subscriptionStartedAt: u?.subscriptionStartedAt || null, subscriptionExpiresAt: u?.subscriptionExpiresAt || null, autoRenewal: u?.autoRenewal || false, signalsRemaining: u?.signalsRemaining ?? 0, signalsSent: u?.signalsSent ?? 0, signalsTotal: u?.signalsTotal ?? 0 });
});

// Signals
app.get('/api/signals', authMiddleware, (req, res) => ok(res, dataStore.listSignals(Math.min(parseInt(req.query.limit, 10) || 50, 200))));
app.get('/api/signals/:id', authMiddleware, (req, res) => { const sig = dataStore.listSignals(500).find(s => s.id === req.params.id); if (!sig) return failNotFound(res, 'Signal not found'); return ok(res, sig); });

// Candles (generated natively — no sensitive data)
app.get('/api/symbols', authMiddleware, (req, res) => ok(res, CANDLE_SYMBOLS));
app.get('/api/candles/:symbol', authMiddleware, (req, res) => {
  const tf = req.query.timeframe || '1m';
  if (!TIMEFRAME_SECONDS[tf]) return failBadRequest(res, 'Bad timeframe');
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  return ok(res, { symbol: req.params.symbol, timeframe: tf, candles: genCandles(req.params.symbol, tf, limit) });
});

// Support
app.get('/api/support/convos', authMiddleware, (req, res) => ok(res, dataStore.listConvos(req.tgUser.id)));
app.post('/api/support/messages', authMiddleware, (req, res, next) => {
  try {
    const { text, image } = req.body || {};
    if (!text && !image) return failBadRequest(res, 'Message text or image required');
    const convo = dataStore.getOrCreateConvo(req.tgUser.id, { name: [req.tgUser.firstName, req.tgUser.lastName].filter(Boolean).join(' ') });
    const msg = dataStore.addMessage(convo.id, { from: 'user', text: text || '', image: image || null });
    if (broadcastSupportFn) broadcastSupportFn({ convoId: convo.id, msg, event: 'user_message' });
    return created(res, { convo, msg });
  } catch (err) { next(err); }
});
app.post('/api/support/mark-read/:convoId', authMiddleware, (req, res) => ok(res, dataStore.markRead(req.params.convoId)));

// Bots
app.get('/api/bots/strategies', authMiddleware, (req, res) => ok(res, STRATEGIES));
app.get('/api/bots/platforms', authMiddleware, (req, res) => ok(res, PLATFORMS));
app.get('/api/bots/status', authMiddleware, (req, res) => ok(res, { running: true, strategies: STRATEGIES, platforms: PLATFORMS, signals_total: collections.signals.length, signals_active: collections.signals.filter(s => s.result === null).length }));
app.post('/api/bots/session/start', authMiddleware, (req, res) => { const u = dataStore.getUser(req.tgUser.id); if (u) dataStore.upsertUser({ ...u, botRunning: true }); return ok(res, { running: true }); });
app.post('/api/bots/session/stop', authMiddleware, (req, res) => { const u = dataStore.getUser(req.tgUser.id); if (u) dataStore.upsertUser({ ...u, botRunning: false }); return ok(res, { running: false }); });

// User profile
app.get('/api/me', authMiddleware, (req, res) => {
  const u = dataStore.getUser(req.tgUser.id);
  return ok(res, { id: req.tgUser.id, name: [req.tgUser.firstName, req.tgUser.lastName].filter(Boolean).join(' '), username: req.tgUser.username, photoUrl: req.tgUser.photoUrl, language: req.tgUser.language, platform: u?.platform || 'QUOTEX', subscriptionStatus: u?.subscriptionStatus || 'INACTIVE', subscriptionPlan: u?.subscriptionPlan || null, subscriptionAmount: u?.subscriptionAmount || 0, signalsRemaining: u?.signalsRemaining ?? 0, signalsSent: u?.signalsSent ?? 0, signalsTotal: u?.signalsTotal ?? 0, botRunning: u?.botRunning || false, strategy: u?.strategy || 'strong' });
});
app.put('/api/me', authMiddleware, (req, res) => {
  const u = dataStore.getUser(req.tgUser.id);
  const updated = dataStore.upsertUser({ ...(u || { id: req.tgUser.id, firstName: req.tgUser.firstName, lastName: req.tgUser.lastName, username: req.tgUser.username, photoUrl: req.tgUser.photoUrl, language: req.tgUser.language }), id: req.tgUser.id, platform: req.body.platform || u?.platform || 'QUOTEX', strategy: req.body.strategy || u?.strategy || 'strong' });
  return ok(res, { id: updated.id, platform: updated.platform, strategy: updated.strategy });
});

// Discount validation
app.post('/api/discounts/validate', authMiddleware, (req, res) => {
  const DISCOUNTS = { 'SAVE10': { code: 'SAVE10', percent: 10, label: '10% off' }, 'WELCOME20': { code: 'WELCOME20', percent: 20, label: '20% off' }, 'PRO50': { code: 'PRO50', percent: 50, label: '50% off' }, 'VIP100': { code: 'VIP100', percent: 100, label: '100% off' } };
  const result = DISCOUNTS[(req.body.code || '').toUpperCase()];
  if (!result) return failNotFound(res, 'Invalid discount code');
  return ok(res, result);
});

// ============================================================================
// ROUTES — Admin dashboard
// ============================================================================
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return failBadRequest(res, 'Email and password required');
  if (email !== config.adminEmail || password !== config.adminPassword) return failUnauthorized(res, 'Invalid admin credentials');
  return ok(res, { token: generateAdminToken(email), email, expiresIn: 24 * 60 * 60 * 1000 });
});
app.use('/api/admin', (req, res, next) => { if (req.path === '/login') return next(); return adminAuthMiddleware(req, res, next); });

app.get('/api/admin/dashboard-stats', (req, res) => {
  const users = dataStore.listUsers();
  return ok(res, { users: { total: users.length, active: users.filter(u => u.subscriptionStatus === 'ACTIVE').length, banned: users.filter(u => u.status === 'BANNED').length }, subscriptions: { pending: dataStore.listSubRequests({ status: 'pending' }).length, approved: dataStore.listSubRequests({ status: 'approved' }).length }, revenue: { total: users.reduce((s, u) => s + (u.subscriptionAmount || 0), 0), currency: 'USD' }, signals: { total: collections.signals.length, active: collections.signals.filter(s => s.result === null).length }, support: { openConvos: [...collections.convos.values()].filter(c => c.id?.startsWith('c_') && c.status === 'open').length, unreadConvos: [...collections.convos.values()].filter(c => c.id?.startsWith('c_') && c.unread > 0).length }, notifications: collections.notifications.length, promos: collections.promos.length, offers: collections.offers.length, timestamp: Date.now() });
});
app.get('/api/admin/subscriptions', (req, res) => ok(res, dataStore.listSubRequests(req.query.status ? { status: req.query.status } : {})));
app.post('/api/admin/subscriptions/:id/approve', (req, res) => {
  const r = dataStore.getSubRequest(req.params.id);
  if (!r) return failNotFound(res, 'Request not found');
  if (r.status !== 'pending') return failBadRequest(res, `Already ${r.status}`);
  dataStore.updateSubRequest(req.params.id, { status: 'approved', adminNote: req.body?.note || '' });
  const u = dataStore.getUser(r.tgId);
  if (u) dataStore.upsertUser({ ...u, subscriptionStatus: 'ACTIVE', subscriptionPlan: r.planName, subscriptionPlanId: r.planId, subscriptionAmount: r.amount, subscriptionStartedAt: new Date().toISOString(), subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), autoRenewal: true });
  // Queue Telegram notification — residential server will send it
  dataStore.queueNotification(r.tgId, `✅ Payment Verified\n\nYour payment has been verified and you've been upgraded to the ${r.planName} plan.`, 'subscription_approved');
  return ok(res, dataStore.getSubRequest(req.params.id));
});
app.post('/api/admin/subscriptions/:id/reject', (req, res) => {
  const r = dataStore.getSubRequest(req.params.id);
  if (!r) return failNotFound(res, 'Request not found');
  if (r.status !== 'pending') return failBadRequest(res, `Already ${r.status}`);
  dataStore.updateSubRequest(req.params.id, { status: 'rejected', adminNote: req.body?.note || '' });
  dataStore.queueNotification(r.tgId, `❌ Payment Rejected\n\nYour payment for the ${r.planName} plan was rejected. This is your final warning.`, 'subscription_rejected');
  return ok(res, dataStore.getSubRequest(req.params.id));
});
app.get('/api/admin/support/convos', (req, res) => ok(res, dataStore.listConvos()));
app.post('/api/admin/support/:convoId/mark-read', (req, res) => ok(res, dataStore.markRead(req.params.convoId)));
app.post('/api/admin/support/:convoId/reply', (req, res) => {
  const convo = dataStore.getConvo(req.params.convoId);
  if (!convo) return failNotFound(res, 'Conversation not found');
  const msg = dataStore.addMessage(convo.id, { from: 'admin', text: req.body.text });
  dataStore.queueNotification(convo.tgId, req.body.text, 'support_reply');
  if (broadcastSupportFn) broadcastSupportFn({ convoId: convo.id, msg, event: 'admin_message' });
  return created(res, { convo, msg });
});
app.post('/api/admin/servers/:id/toggle', (req, res) => { const p = PLATFORMS.find(x => x.id === req.params.id); if (p) p.running = req.body.running; return ok(res, p); });
app.post('/api/admin/strategies/:id/toggle', (req, res) => { const s = STRATEGIES.find(x => x.id === req.params.id); if (s) s.enabled = req.body.enabled; return ok(res, s); });
app.get('/api/admin/payments', (req, res) => ok(res, dataStore.getPayments()));
app.put('/api/admin/payments/:methodId', (req, res) => ok(res, dataStore.setPayment(req.params.methodId, req.body || {})));
app.get('/api/admin/users', (req, res) => ok(res, dataStore.listUsers()));
app.get('/api/admin/users/:tgId', (req, res) => { const u = dataStore.getUser(req.params.tgId); if (!u) return failNotFound(res, 'User not found'); return ok(res, u); });
app.put('/api/admin/users/:tgId', (req, res) => { const u = dataStore.getUser(req.params.tgId); if (!u) return failNotFound(res, 'User not found'); return ok(res, dataStore.upsertUser({ ...u, ...req.body, id: req.params.tgId })); });
app.post('/api/admin/users/:tgId/ban', (req, res) => { const u = dataStore.getUser(req.params.tgId); if (!u) return failNotFound(res, 'User not found'); return ok(res, dataStore.upsertUser({ ...u, status: 'BANNED' })); });
app.post('/api/admin/users/:tgId/unban', (req, res) => { const u = dataStore.getUser(req.params.tgId); if (!u) return failNotFound(res, 'User not found'); return ok(res, dataStore.upsertUser({ ...u, status: 'ACTIVE' })); });
app.post('/api/admin/users/:tgId/promote', (req, res) => {
  const u = dataStore.getUser(req.params.tgId); if (!u) return failNotFound(res, 'User not found');
  const { level } = req.body || {}; if (![0, 1, 2, 3].includes(level)) return failBadRequest(res, 'Level 0-3');
  const planMap = { 0: 'Basic', 1: 'Pro', 2: 'Pro', 3: 'Elite' }; const amountMap = { 0: 50, 1: 75, 2: 75, 3: 100 };
  return ok(res, dataStore.upsertUser({ ...u, level, subscriptionStatus: level > 0 ? 'ACTIVE' : 'INACTIVE', subscriptionPlan: level > 0 ? planMap[level] : null, subscriptionAmount: level > 0 ? amountMap[level] : 0, promotedAt: new Date().toISOString() }));
});
app.get('/api/admin/signals', (req, res) => ok(res, dataStore.listSignals(Math.min(parseInt(req.query.limit, 10) || 100, 500))));
app.get('/api/admin/strategies', (req, res) => ok(res, STRATEGIES));
app.get('/api/admin/platforms', (req, res) => ok(res, PLATFORMS));
app.get('/api/admin/notifications', (req, res) => ok(res, dataStore.listNotifications()));
app.post('/api/admin/notifications', (req, res) => { if (!req.body.title || !req.body.body) return failBadRequest(res, 'title and body required'); return created(res, dataStore.addNotification({ title: req.body.title, body: req.body.body, channel: req.body.channel || 'ALL', target: req.body.target || null })); });
app.delete('/api/admin/notifications/:id', (req, res) => { if (!dataStore.deleteNotification(req.params.id)) return failNotFound(res, 'Not found'); return ok(res, { deleted: true }); });
app.get('/api/admin/promos', (req, res) => ok(res, dataStore.listPromos()));
app.post('/api/admin/promos', (req, res) => { if (!req.body.code) return failBadRequest(res, 'code required'); return created(res, dataStore.addPromo({ code: req.body.code, audience: req.body.audience || 'ALL', maxUsers: req.body.maxUsers || 100, discountPct: req.body.discountPct || 10 })); });
app.delete('/api/admin/promos/:id', (req, res) => { if (!dataStore.deletePromo(req.params.id)) return failNotFound(res, 'Not found'); return ok(res, { deleted: true }); });
app.post('/api/admin/promos/:id/toggle', (req, res) => { const p = dataStore.togglePromo(req.params.id); if (!p) return failNotFound(res, 'Not found'); return ok(res, p); });
app.get('/api/admin/offers', (req, res) => ok(res, dataStore.listOffers()));
app.post('/api/admin/offers', (req, res) => { if (!req.body.title || !req.body.body) return failBadRequest(res, 'title and body required'); return created(res, dataStore.addOffer({ title: req.body.title, body: req.body.body })); });
app.delete('/api/admin/offers/:id', (req, res) => { if (!dataStore.deleteOffer(req.params.id)) return failNotFound(res, 'Not found'); return ok(res, { deleted: true }); });
app.post('/api/admin/offers/:id/toggle', (req, res) => { const o = dataStore.toggleOffer(req.params.id); if (!o) return failNotFound(res, 'Not found'); return ok(res, o); });

// ============================================================================
// INTERNAL WEBHOOKS — Residential server → Bridge
// ============================================================================

// New signal — residential server generates it and pushes here
app.post('/internal/signals/new', internalAuth, (req, res) => {
  const s = req.body || {};
  if (!s.symbol || !s.type) return failBadRequest(res, 'Missing symbol/type');
  const saved = dataStore.addSignal(s);
  logger.info('signal received from residential', { id: saved.id, symbol: saved.symbol });
  if (broadcastSignalFn) broadcastSignalFn(saved);
  return created(res, saved);
});

// Signal resolved
app.post('/internal/signals/:id/resolve', internalAuth, (req, res) => {
  const { result, profit } = req.body || {};
  if (!['win', 'lose'].includes(result)) return failBadRequest(res, 'Invalid result');
  const updated = dataStore.resolveSignal(req.params.id, result, profit);
  if (!updated) return failNotFound(res, 'Signal not found');
  if (broadcastSignalFn) broadcastSignalFn({ ...updated, event: 'resolved' });
  return ok(res, updated);
});

// Support message from Telegram user (residential server forwards it)
app.post('/internal/support/message', internalAuth, (req, res) => {
  const { tg_id, text, user_name } = req.body || {};
  if (!tg_id || !text) return failBadRequest(res, 'Missing tg_id or text');
  const convo = dataStore.getOrCreateConvo(tg_id, { name: user_name || '' });
  const msg = dataStore.addMessage(convo.id, { from: 'user', text });
  if (broadcastSupportFn) broadcastSupportFn({ convoId: convo.id, msg, event: 'user_message' });
  return created(res, { convo, msg });
});

// Bot status update
app.post('/internal/bot/status', internalAuth, (req, res) => {
  logger.info('bot status from residential', { body: req.body });
  return ok(res, { received: true });
});

// --- Notification queue: residential server polls this, sends via Telegram, marks as sent ---
app.get('/internal/notifications/queue', internalAuth, (req, res) => {
  return ok(res, dataStore.getPendingNotifications());
});
app.post('/internal/notifications/:id/sent', internalAuth, (req, res) => {
  const n = dataStore.markNotificationSent(req.params.id);
  if (!n) return failNotFound(res, 'Notification not found');
  return ok(res, n);
});

// --- 404 + error handlers ---
app.use(notFound);
app.use(errorHandler);

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================
let wss = null;
const userConnections = new Map();
function attachUser(tgId, ws) { if (!userConnections.has(tgId)) userConnections.set(tgId, new Set()); userConnections.get(tgId).add(ws); }
function detachUser(tgId, ws) { const set = userConnections.get(tgId); if (!set) return; set.delete(ws); if (set.size === 0) userConnections.delete(tgId); }
function broadcastSignal(signal) { if (!wss) return; const payload = JSON.stringify({ channel: 'signals', data: signal }); for (const c of wss.clients) if (c.readyState === 1 && c._authed) c.send(payload); }
function broadcastSupport(evt) { if (!wss) return; const payload = JSON.stringify({ channel: 'support', data: evt }); const target = evt.convoId?.replace(/^c_/, ''); if (target) { const set = userConnections.get(target); if (set) for (const ws of set) if (ws.readyState === 1) ws.send(payload); } for (const c of wss.clients) if (c.readyState === 1 && c._authed && c._tgId !== target) c.send(payload); }

function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    ws._authed = false;
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth') {
        const user = verifyInitData(msg.init_data);
        if (!user) { ws.close(4001, 'invalid auth'); return; }
        ws._authed = true; ws._tgId = user.id; attachUser(ws._tgId, ws);
        ws.send(JSON.stringify({ channel: 'system', data: { ok: true, message: 'authenticated' } }));
        return;
      }
      if (!ws._authed) ws.close(4001, 'not authed');
    });
    ws.on('close', () => { if (ws._tgId) detachUser(ws._tgId, ws); });
    ws.on('error', (err) => logger.warn('ws error', { err: err.message }));
  });
  broadcastSignalFn = broadcastSignal;
  broadcastSupportFn = broadcastSupport;
  logger.info('WebSocket server ready', { path: '/ws' });
}

// ============================================================================
// BOOT
// ============================================================================
const server = http.createServer(app);
setupWebSocket(server);
connectMongoDB().then(() => {
  server.listen(config.port, () => {
    logger.info('🚀 API Hub ready', { port: config.port, mongo: mongoDb ? 'connected' : 'in-memory', signals: collections.signals.length, endpoints: '59+' });
  });
});
process.on('SIGTERM', () => { logger.info('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { logger.info('SIGINT'); server.close(() => process.exit(0)); });

export default app;
