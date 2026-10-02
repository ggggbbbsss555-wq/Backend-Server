/**
 * QuantVexa Backend Server — Single-file Node.js bridge
 * ============================================================
 *
 * Connects:
 *   - Telegram Web App (4 quantvexa pages on GitHub Pages)
 *   - Python codebase (1 file main.py — candle + telegram + signals services)
 *   - Firebase admin dashboard (later)
 *
 * All config, middleware, routes, services, webhooks, and WebSocket logic
 * live in THIS file so a single edit covers everything.
 *
 * Compatibility: mirrors the admin dashboard's data shape (Basic/Pro/Elite
 * plans, Binance/TRC20/BEP20 payments, Strong/Medium/Pro strategies,
 * QUOTEX/BINOLLA platforms) so the dashboard can read/write the same data.
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

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  internalSecret:   process.env.INTERNAL_SECRET || 'dev-internal-secret',

  python: {
    candleUrl:   process.env.PYTHON_CANDLE_URL   || 'http://localhost:9001',
    telegramUrl: process.env.PYTHON_TELEGRAM_URL || 'http://localhost:9002',
    signalsUrl:  process.env.PYTHON_SIGNALS_URL  || 'http://localhost:9003',
  },

  // Plan prices locked to 50/75/100 — match the admin dashboard + quantvexa/plans
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
const failBadRequest  = (res, msg = 'Bad request',  d) => fail(res, { code: 'BAD_REQUEST',  message: msg, status: 400, details: d });
const failUnauthorized= (res, msg = 'Unauthorized') => fail(res, { code: 'UNAUTHORIZED', message: msg, status: 401 });
const failNotFound    = (res, msg = 'Not found')    => fail(res, { code: 'NOT_FOUND',    message: msg, status: 404 });

// ============================================================================
// TELEGRAM INIT-DATA VERIFICATION
// ============================================================================
function parseInitData(raw) {
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function verifyInitData(raw, botToken = config.telegramBotToken) {
  if (!raw || !botToken) return null;
  const parsed = parseInitData(raw);
  const hash = parsed.hash;
  if (!hash) return null;

  const dataCheckString = Object.keys(parsed)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${parsed[k]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calcHash.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calcHash), Buffer.from(hash))) return null;

  let user = null;
  try { if (parsed.user) user = JSON.parse(parsed.user); } catch { /* ignore */ }

  const authDate = parseInt(parsed.auth_date ?? '0', 10);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return null;

  return { parsed, user };
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
  const result = verifyInitData(raw);
  if (!result || !result.user) return failUnauthorized(res, 'Invalid Telegram initData');
  req.tgUser = {
    id:        String(result.user.id),
    firstName: result.user.first_name || '',
    lastName:  result.user.last_name || '',
    username:  result.user.username || '',
    photoUrl:  result.user.photo_url || '',
    language:  result.user.language_code || 'en',
    platform:  req.headers['x-tg-platform'] || 'QUOTEX',
  };
  next();
}

function internalAuth(req, res, next) {
  const secret = req.get('X-Internal-Secret');
  if (!secret || secret !== config.internalSecret) {
    return failUnauthorized(res, 'Invalid internal secret');
  }
  next();
}

function notFound(req, res) {
  return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` } });
}

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';
  logger.error('request failed', {
    method: req.method, path: req.path, status, code,
    message: err.message,
    stack: err.stack?.split('\n').slice(0, 3).join(' | '),
  });
  return res.status(status).json({ ok: false, error: { code, message: err.message || 'Internal server error' } });
}

// ============================================================================
// PYTHON BRIDGE — HTTP client to the 3 Python services
// ============================================================================
async function pythonCall(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? 8000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.internalSecret,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      logger.warn('python call non-2xx', { url, status: res.status, body: text?.slice(0, 200) });
      const e = new Error(`Python ${url} returned ${res.status}`);
      e.status = res.status; e.body = data; throw e;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

const pythonBridge = {
  // Candle server
  getCandles(symbol, timeframe = '1m', limit = 200) {
    return pythonCall(`${config.python.candleUrl}/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=${limit}`);
  },
  getSymbols() { return pythonCall(`${config.python.candleUrl}/symbols`); },

  // Telegram bot
  sendTelegramMessage(tgUserId, text) {
    return pythonCall(`${config.python.telegramUrl}/send`, { method: 'POST', body: { tg_user_id: tgUserId, text } });
  },
  notifySubscriptionUpdate(tgUserId, status, planName) {
    return pythonCall(`${config.python.telegramUrl}/notify-subscription`, { method: 'POST', body: { tg_user_id: tgUserId, status, plan_name: planName } });
  },

  // Signals bots
  controlBot(strategy, action) {
    return pythonCall(`${config.python.signalsUrl}/bot/control`, { method: 'POST', body: { strategy, action } });
  },
  getBotStatus() { return pythonCall(`${config.python.signalsUrl}/bot/status`); },
  getRecentSignals(limit = 50) { return pythonCall(`${config.python.signalsUrl}/signals?limit=${limit}`); },
};

// ============================================================================
// DATA STORE — in-memory (swap for Firestore/Postgres later)
// Shape mirrors the admin dashboard's localStorage records so the dashboard
// can read/write the same data once Firebase is wired up.
// ============================================================================
const collections = {
  users:         new Map(),
  subscriptions: new Map(),
  convos:        new Map(),
  signals:       [],
  payments:      new Map(),
};

const dataStore = {
  // Users
  getUser(tgId) { return collections.users.get(String(tgId)); },
  upsertUser(user) {
    const u = { ...user, id: String(user.id), updatedAt: Date.now() };
    collections.users.set(u.id, u);
    return u;
  },
  listUsers() { return Array.from(collections.users.values()); },

  // Subscription payment requests
  listSubRequests({ status, tgId } = {}) {
    return [...collections.subscriptions.values()].filter(r => {
      if (status && r.status !== status) return false;
      if (tgId && r.tgId !== String(tgId)) return false;
      return true;
    }).sort((a, b) => b.createdAt - a.createdAt);
  },
  getSubRequest(id) { return collections.subscriptions.get(id); },
  addSubRequest(req) {
    const r = { id: 'sr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                status: 'pending', createdAt: Date.now(), ...req };
    collections.subscriptions.set(r.id, r);
    logger.info('sub request added', { id: r.id, tgId: r.tgId, plan: r.planName });
    return r;
  },
  updateSubRequest(id, patch) {
    const r = collections.subscriptions.get(id);
    if (!r) return null;
    Object.assign(r, patch, { resolvedAt: Date.now() });
    collections.subscriptions.set(id, r);
    return r;
  },

  // Support conversations
  listConvos(tgId) {
    return [...collections.convos.values()]
      .filter(c => !tgId || c.tgId === String(tgId))
      .sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  },
  getConvo(id) { return collections.convos.get(id); },
  getOrCreateConvo(tgId, userInfo = {}) {
    const key = String(tgId);
    if (collections.convos.has(key)) return collections.convos.get(key);
    const c = { id: 'c_' + key, tgId: key,
                userName: userInfo.name || '', userEmail: userInfo.email || '',
                status: 'open', unread: 0, messages: [], createdAt: Date.now() };
    collections.convos.set(c.id, c);
    collections.convos.set(key, c);
    return c;
  },
  addMessage(convoId, msg) {
    const c = collections.convos.get(convoId) || collections.convos.get(String(convoId));
    if (!c) return null;
    const m = { id: 'm_' + Date.now().toString(36), at: Date.now(), ...msg };
    c.messages.push(m);
    if (m.from === 'user') c.unread = (c.unread || 0) + 1;
    return m;
  },
  markRead(convoId) {
    const c = collections.convos.get(convoId);
    if (c) { c.unread = 0; return c; }
    return null;
  },

  // Signals
  listSignals(limit = 50) { return collections.signals.slice(0, limit); },
  addSignal(sig) {
    const s = { id: 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                createdAt: Date.now(), result: null, profit: null, ...sig };
    collections.signals.unshift(s);
    if (collections.signals.length > 500) collections.signals.length = 500;
    return s;
  },
  resolveSignal(id, result, profit) {
    const s = collections.signals.find(x => x.id === id);
    if (!s) return null;
    s.result = result; s.profit = profit; s.resolvedAt = Date.now();
    return s;
  },

  // Payment-method config (admin-editable; mirrors quantvexa wallet)
  getPayments() {
    return collections.payments.size
      ? Object.fromEntries(collections.payments)
      : {
          binance: { enabled: true, payUser: 'YOUR_BINANCE_PAY_ID' },
          trc20:   { enabled: true, wallet: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
          bep20:   { enabled: true, wallet: '0xXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
        };
  },
  setPayment(methodId, cfg) {
    collections.payments.set(methodId, cfg);
    return collections.payments.get(methodId);
  },
};

// ============================================================================
// PLANS — mirrors quantvexa/plans page + admin dashboard
// ============================================================================
const PLANS = [
  {
    id: 'basic', name: 'Basic', price: config.plans.basic, currency: 'USD',
    duration: 'month', featured: false, tagline: 'For new traders getting started',
    features: ['Up to 100 signals per month','Strong strategy access','Telegram bot integration','Basic trade history (30 days)'],
  },
  {
    id: 'pro', name: 'Pro', price: config.plans.pro, currency: 'USD',
    duration: 'month', featured: true, tagline: 'For serious active traders',
    features: ['Up to 500 signals per month','All strategies (Strong, Medium, Pro)','Advanced analytics dashboard','Full trade history (unlimited)','Priority 24/7 support','Multi-exchange support'],
  },
  {
    id: 'elite', name: 'Elite', price: config.plans.elite, currency: 'USD',
    duration: 'month', featured: false, tagline: 'For professional institutions',
    features: ['Unlimited signals','All strategies + early access','White-label dashboard','Dedicated account manager','24/7 phone support','Custom integrations','SLA guarantee'],
  },
];
const plansService = {
  list() { return PLANS; },
  get(id) { return PLANS.find(p => p.id === id) || null; },
  priceFor(id) { const p = this.get(id); return p ? p.price : null; },
};

// ============================================================================
// STRATEGIES + PLATFORMS — mirrors quantvexa dashboard + admin panel
// ============================================================================
const STRATEGIES = [
  { id: 'strong', name: 'Strong', tag: 'High frequency, moderate accuracy', color: '#00ff88',
    winRate: 0.55, profitRange: [0.3, 1.8], lossRange: [0.4, 1.6],
    costPerSignal: 1, signalsPerDay: '15-25', accuracy: '70%', duration: '1-3m', enabled: true },
  { id: 'medium', name: 'Medium', tag: 'Balanced signals, steady results', color: '#00d2ff',
    winRate: 0.65, profitRange: [0.3, 2.0], lossRange: [0.3, 1.5],
    costPerSignal: 3, signalsPerDay: '8-12', accuracy: '80%', duration: '2-5m', enabled: true },
  { id: 'pro', name: 'Pro', tag: 'Premium accuracy, low frequency', color: '#ab82ff',
    winRate: 0.78, profitRange: [0.5, 2.5], lossRange: [0.3, 1.2],
    costPerSignal: 6, signalsPerDay: '3-5', accuracy: '92%', duration: '5-15m', enabled: true },
];

const PLATFORMS = [
  { id: 'QUOTEX',  name: 'QUOTEX',  description: 'Binary options trading', running: true, color: '#00d2ff' },
  { id: 'BINOLLA', name: 'BINOLLA', description: 'Smart advanced trading',  running: true, color: '#00ff88' },
];

const serversService = {
  async listPlatforms() {
    try {
      const status = await pythonBridge.getBotStatus();
      if (status?.data?.platforms) return status.data.platforms;
    } catch (_) { /* fall through to local */ }
    return PLATFORMS;
  },
  async togglePlatform(id, running) {
    const p = PLATFORMS.find(x => x.id === id);
    if (p) p.running = running;
    try { await pythonBridge.controlBot(id.toLowerCase(), running ? 'start' : 'stop'); }
    catch (err) { logger.warn('python controlBot failed', { id, err: err.message }); }
    return p;
  },
  listStrategies() { return STRATEGIES; },
  async toggleStrategy(id, enabled) {
    const s = STRATEGIES.find(x => x.id === id);
    if (s) s.enabled = enabled;
    try { await pythonBridge.controlBot(id, enabled ? 'start' : 'stop'); }
    catch (err) { logger.warn('python controlBot failed', { id, err: err.message }); }
    return s;
  },
};

// ============================================================================
// SUBSCRIPTIONS SERVICE
// ============================================================================
const subscriptionsService = {
  async createRequest({ tgUser, planId, paymentMethod, transactionId, receiptImage, note }) {
    const plan = plansService.get(planId);
    if (!plan) { const e = new Error('Invalid plan id'); e.code = 'INVALID_PLAN'; e.status = 400; throw e; }
    if (!['binance', 'trc20', 'bep20'].includes(paymentMethod)) {
      const e = new Error('Invalid payment method'); e.code = 'INVALID_METHOD'; e.status = 400; throw e;
    }
    const req = dataStore.addSubRequest({
      tgId: tgUser.id,
      userName: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' '),
      username: tgUser.username,
      planId: plan.id, planName: plan.name,
      amount: plan.price, currency: plan.currency,
      paymentMethod, transactionId,
      receiptImage: receiptImage || null, note: note || '',
    });
    logger.info('subscription request created', { id: req.id, plan: plan.name, method: paymentMethod });
    return req;
  },
  listMine(tgUser) { return dataStore.listSubRequests({ tgId: tgUser.id }); },
  async approve(id, adminNote = '') {
    const req = dataStore.getSubRequest(id);
    if (!req) { const e = new Error('Request not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'pending') { const e = new Error(`Request already ${req.status}`); e.status = 400; e.code = 'ALREADY_RESOLVED'; throw e; }
    dataStore.updateSubRequest(id, { status: 'approved', adminNote });
    const u = dataStore.getUser(req.tgId);
    if (u) {
      dataStore.upsertUser({
        ...u,
        subscriptionStatus: 'ACTIVE', subscriptionPlan: req.planName, subscriptionPlanId: req.planId,
        subscriptionAmount: req.amount,
        subscriptionStartedAt: new Date().toISOString(),
        subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        autoRenewal: true,
      });
    }
    try { await pythonBridge.notifySubscriptionUpdate(req.tgId, 'approved', req.planName); }
    catch (err) { logger.warn('failed to notify telegram bot of approval', { id, err: err.message }); }
    logger.info('subscription approved', { id, plan: req.planName });
    return dataStore.getSubRequest(id);
  },
  async reject(id, adminNote = '') {
    const req = dataStore.getSubRequest(id);
    if (!req) { const e = new Error('Request not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'pending') { const e = new Error(`Request already ${req.status}`); e.status = 400; e.code = 'ALREADY_RESOLVED'; throw e; }
    dataStore.updateSubRequest(id, { status: 'rejected', adminNote });
    try { await pythonBridge.notifySubscriptionUpdate(req.tgId, 'rejected', req.planName); }
    catch (err) { logger.warn('failed to notify telegram bot of rejection', { id, err: err.message }); }
    logger.info('subscription rejected', { id });
    return dataStore.getSubRequest(id);
  },
};

// ============================================================================
// SIGNALS SERVICE (with WebSocket broadcast hook)
// ============================================================================
let broadcastSignalFn = null;
let broadcastSupportFn = null;

const signalsService = {
  receiveNew(signal) {
    const saved = dataStore.addSignal(signal);
    logger.info('signal received', { id: saved.id, symbol: saved.symbol, type: saved.type });
    if (broadcastSignalFn) broadcastSignalFn(saved);
    return saved;
  },
  resolve(id, result, profit) {
    const s = dataStore.resolveSignal(id, result, profit);
    if (s && broadcastSignalFn) broadcastSignalFn({ ...s, event: 'resolved' });
    return s;
  },
  async list(limit = 50) {
    const local = dataStore.listSignals(limit);
    if (local.length > 0) return local;
    try {
      const remote = await pythonBridge.getRecentSignals(limit);
      return Array.isArray(remote) ? remote : (remote?.data || []);
    } catch (err) { logger.warn('failed to fetch signals from python', { err: err.message }); return []; }
  },
  async botStatus() {
    try { return await pythonBridge.getBotStatus(); }
    catch (err) { logger.warn('bot status fetch failed', { err: err.message }); return null; }
  },
  async controlBot(strategy, action) { return await pythonBridge.controlBot(strategy, action); },
};

// ============================================================================
// SUPPORT SERVICE (with WebSocket broadcast hook)
// ============================================================================
const supportService = {
  async userMessage(tgUser, { text, image }) {
    const convo = dataStore.getOrCreateConvo(tgUser.id, {
      name: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' '),
      email: '',
    });
    const msg = dataStore.addMessage(convo.id, { from: 'user', text: text || '', image: image || null });
    try {
      await pythonBridge.sendTelegramMessage(0, `💬 New support message from ${convo.userName || tgUser.id}:\n\n${text || '(image)'}`);
    } catch (err) { logger.warn('failed to forward user message to telegram bot', { err: err.message }); }
    if (broadcastSupportFn) broadcastSupportFn({ convoId: convo.id, msg, event: 'user_message' });
    return { convo, msg };
  },
  async adminMessage({ tgId, text }) {
    const convo = dataStore.getOrCreateConvo(tgId);
    const msg = dataStore.addMessage(convo.id, { from: 'admin', text });
    if (broadcastSupportFn) broadcastSupportFn({ convoId: convo.id, msg, event: 'admin_message' });
    return { convo, msg };
  },
  listMine(tgUser) { return dataStore.listConvos(tgUser.id); },
  listAll() { return dataStore.listConvos(); },
  markRead(convoId) { return dataStore.markRead(convoId); },
};

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

// --- Health check ---
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ============================================================================
// ROUTES — Web App (require Telegram initData auth)
// ============================================================================

// --- Auth ---
app.post('/api/auth/telegram', (req, res) => {
  const { init_data } = req.body || {};
  if (!init_data) return failBadRequest(res, 'Missing init_data');
  const result = verifyInitData(init_data);
  if (!result || !result.user) return failUnauthorized(res, 'Invalid Telegram initData');
  const u = dataStore.upsertUser({
    id: String(result.user.id),
    firstName: result.user.first_name || '', lastName: result.user.last_name || '',
    username: result.user.username || '', photoUrl: result.user.photo_url || '',
    language: result.user.language_code || 'en', platform: 'QUOTEX', lastSeen: Date.now(),
  });
  return ok(res, {
    user: { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '),
            username: u.username, photoUrl: u.photoUrl, language: u.language },
    session_token: init_data,
  });
});

// --- Plans (public — no auth needed to browse plans) ---
app.get('/api/plans', (req, res) => ok(res, plansService.list()));
app.get('/api/plans/:id', (req, res) => {
  const p = plansService.get(req.params.id);
  if (!p) return failNotFound(res, 'Plan not found');
  return ok(res, p);
});
app.get('/api/payment-methods', (req, res) => ok(res, dataStore.getPayments()));

// --- Subscriptions (user) ---
app.post('/api/subscriptions/request', authMiddleware, async (req, res, next) => {
  try {
    const r = await subscriptionsService.createRequest({
      tgUser: req.tgUser, planId: req.body.planId, paymentMethod: req.body.paymentMethod,
      transactionId: req.body.transactionId, receiptImage: req.body.receiptImage, note: req.body.note,
    });
    return created(res, r);
  } catch (err) { next(err); }
});
app.get('/api/subscriptions/mine', authMiddleware, (req, res) => ok(res, subscriptionsService.listMine(req.tgUser)));
app.get('/api/subscriptions/status', authMiddleware, (req, res) => {
  const u = dataStore.getUser(req.tgUser.id);
  return ok(res, {
    subscriptionStatus:    u?.subscriptionStatus    || 'INACTIVE',
    subscriptionPlan:      u?.subscriptionPlan      || null,
    subscriptionPlanId:    u?.subscriptionPlanId    || null,
    subscriptionAmount:    u?.subscriptionAmount    || 0,
    subscriptionStartedAt: u?.subscriptionStartedAt || null,
    subscriptionExpiresAt: u?.subscriptionExpiresAt || null,
    autoRenewal:           u?.autoRenewal           || false,
    signalsRemaining:      u?.signalsRemaining      ?? 0,
    signalsSent:           u?.signalsSent           ?? 0,
    signalsTotal:          u?.signalsTotal          ?? 0,
  });
});

// --- Signals ---
app.get('/api/signals', authMiddleware, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    return ok(res, await signalsService.list(limit));
  } catch (err) { next(err); }
});
app.get('/api/signals/:id', authMiddleware, (req, res) => {
  const sig = signalsService.list(500).find(s => s.id === req.params.id);
  if (!sig) return failNotFound(res, 'Signal not found');
  return ok(res, sig);
});

// --- Candles (proxied to Python candle service) ---
app.get('/api/symbols', authMiddleware, async (req, res, next) => {
  try { return ok(res, await pythonBridge.getSymbols()); }
  catch (err) { logger.warn('candle /symbols proxy failed', { err: err.message }); return ok(res, []); }
});
app.get('/api/candles/:symbol', authMiddleware, async (req, res, next) => {
  try {
    const timeframe = (req.query.timeframe || '1m');
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    return ok(res, await pythonBridge.getCandles(req.params.symbol, timeframe, limit));
  } catch (err) { logger.warn('candle proxy failed', { symbol: req.params.symbol, err: err.message }); return ok(res, []); }
});

// --- Support chat (user) ---
app.get('/api/support/convos', authMiddleware, (req, res) => ok(res, supportService.listMine(req.tgUser)));
app.post('/api/support/messages', authMiddleware, async (req, res, next) => {
  try {
    const { text, image } = req.body || {};
    if (!text && !image) return failBadRequest(res, 'Message text or image required');
    return created(res, await supportService.userMessage(req.tgUser, { text, image }));
  } catch (err) { next(err); }
});
app.post('/api/support/mark-read/:convoId', authMiddleware, (req, res) => ok(res, supportService.markRead(req.params.convoId)));

// --- Bots (read-only for the Web App) ---
app.get('/api/bots/strategies', authMiddleware, (req, res) => ok(res, serversService.listStrategies()));
app.get('/api/bots/platforms', authMiddleware, async (req, res, next) => {
  try { return ok(res, await serversService.listPlatforms()); } catch (err) { next(err); }
});
app.get('/api/bots/status', authMiddleware, async (req, res, next) => {
  try { return ok(res, await signalsService.botStatus() || { running: false, strategies: [] }); }
  catch (err) { next(err); }
});

// ============================================================================
// ROUTES — Admin dashboard (Firebase later; for now use internal-secret)
// ============================================================================
app.get('/api/admin/subscriptions', (req, res) => ok(res, dataStore.listSubRequests(req.query.status ? { status: req.query.status } : {})));
app.post('/api/admin/subscriptions/:id/approve', async (req, res, next) => {
  try { return ok(res, await subscriptionsService.approve(req.params.id, req.body?.note || '')); }
  catch (err) { next(err); }
});
app.post('/api/admin/subscriptions/:id/reject', async (req, res, next) => {
  try { return ok(res, await subscriptionsService.reject(req.params.id, req.body?.note || '')); }
  catch (err) { next(err); }
});
app.get('/api/admin/support/convos', (req, res) => ok(res, supportService.listAll()));
app.post('/api/admin/support/:convoId/mark-read', (req, res) => ok(res, supportService.markRead(req.params.convoId)));
app.post('/api/admin/servers/:id/toggle', async (req, res, next) => {
  try {
    if (typeof req.body?.running !== 'boolean') return failBadRequest(res, 'Missing "running" boolean');
    return ok(res, await serversService.togglePlatform(req.params.id, req.body.running));
  } catch (err) { next(err); }
});
app.post('/api/admin/strategies/:id/toggle', async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return failBadRequest(res, 'Missing "enabled" boolean');
    return ok(res, await serversService.toggleStrategy(req.params.id, req.body.enabled));
  } catch (err) { next(err); }
});
app.get('/api/admin/payments', (req, res) => ok(res, dataStore.getPayments()));
app.put('/api/admin/payments/:methodId', (req, res) => ok(res, dataStore.setPayment(req.params.methodId, req.body || {})));
app.get('/api/admin/users', (req, res) => ok(res, dataStore.listUsers()));
app.get('/api/admin/strategies', (req, res) => ok(res, STRATEGIES));
app.get('/api/admin/platforms', (req, res) => ok(res, PLATFORMS));

// ============================================================================
// INTERNAL WEBHOOKS — Python → Node.js (require X-Internal-Secret)
// ============================================================================
app.post('/internal/signals/new', internalAuth, (req, res) => {
  const s = req.body || {};
  if (!s.symbol || !s.type) return failBadRequest(res, 'Missing symbol/type');
  return created(res, signalsService.receiveNew(s));
});
app.post('/internal/signals/:id/resolve', internalAuth, (req, res) => {
  const { result, profit } = req.body || {};
  if (!['win', 'lose'].includes(result)) return failBadRequest(res, 'Invalid result');
  const updated = signalsService.resolve(req.params.id, result, profit);
  if (!updated) return failNotFound(res, 'Signal not found');
  return ok(res, updated);
});
app.post('/internal/support/message', internalAuth, async (req, res, next) => {
  try {
    const { tg_id, text } = req.body || {};
    if (!tg_id || !text) return failBadRequest(res, 'Missing tg_id or text');
    return created(res, await supportService.adminMessage({ tgId: String(tg_id), text }));
  } catch (err) { next(err); }
});
app.post('/internal/bot/status', internalAuth, (req, res) => {
  logger.info('bot status update', { body: req.body });
  return ok(res, { received: true });
});

// --- 404 + error handlers (last) ---
app.use(notFound);
app.use(errorHandler);

// ============================================================================
// WEBSOCKET SERVER — real-time signals + support chat
// ============================================================================
let wss = null;
const userConnections = new Map();  // tgId → Set<ws>

function attachUser(tgId, ws) {
  if (!userConnections.has(tgId)) userConnections.set(tgId, new Set());
  userConnections.get(tgId).add(ws);
}
function detachUser(tgId, ws) {
  const set = userConnections.get(tgId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userConnections.delete(tgId);
}

function broadcastSignal(signal) {
  if (!wss) return;
  const payload = JSON.stringify({ channel: 'signals', data: signal });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client._authed) client.send(payload);
  }
}
function broadcastSupport(evt) {
  if (!wss) return;
  const payload = JSON.stringify({ channel: 'support', data: evt });
  const target = evt.convoId?.replace(/^c_/, '');
  if (target) {
    const set = userConnections.get(target);
    if (set) for (const ws of set) if (ws.readyState === 1) ws.send(payload);
  }
  for (const client of wss.clients) {
    if (client.readyState === 1 && client._authed && client._tgId !== target) client.send(payload);
  }
}

function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    logger.info('ws client connected', { ip: req.socket.remoteAddress });
    ws._authed = false;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth') {
        const result = verifyInitData(msg.init_data);
        if (!result || !result.user) { ws.close(4001, 'invalid auth'); return; }
        ws._authed = true;
        ws._tgId = String(result.user.id);
        attachUser(ws._tgId, ws);
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

server.listen(config.port, () => {
  logger.info('🚀 Backend server ready', {
    port: config.port, env: config.nodeEnv, wsPath: '/ws', python: config.python,
  });
});

process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down...'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down...');  server.close(() => process.exit(0)); });

export default app;
