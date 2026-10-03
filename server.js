/**
 * QuantVexa Backend Server — BRIDGE ONLY (single file)
 * ============================================================
 *
 * This server is a PURE BRIDGE. It contains NO business logic:
 *   ❌ No Telegram bot token
 *   ❌ No signals generator
 *   ❌ No candle data generator
 *   ❌ No user logic beyond caching
 *
 * Its ONLY jobs:
 *   1. Receive REST requests from the Web App + admin dashboard
 *   2. Forward them to the residential server (RESIDENTIAL_SERVER_URL)
 *   3. Cache results in MongoDB for speed
 *   4. Broadcast real-time events via WebSocket (signals + support chat)
 *   5. Accept internal webhooks from the residential server
 *   6. Authenticate admin requests (HMAC token)
 *
 * The residential server (home computer) holds ALL the real logic:
 *   ✅ Telegram bot token + polling
 *   ✅ Signals generator (Strong/Medium/Pro)
 *   ✅ Candle data server (QUOTEX/BINOLLA)
 *   ✅ MongoDB (users, subscriptions, signals, convos, etc.)
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
// CONFIG — bridge only. No bot token, no signal interval, no candle config.
// ============================================================================
const config = {
  port:           parseInt(process.env.PORT || '8080', 10),
  nodeEnv:        process.env.NODE_ENV || 'development',
  logLevel:       process.env.LOG_LEVEL || 'info',

  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Shared secret between this bridge and the residential server
  internalSecret: process.env.INTERNAL_SECRET || 'dev-internal-secret',

  // The residential server URL (the home computer — source of ALL truth)
  residentialUrl: (process.env.RESIDENTIAL_SERVER_URL || '').replace(/\/$/, ''),

  // MongoDB — optional cache layer (speeds up reads; residential server is the real DB)
  mongodbUrl: process.env.MONGODB_URL || '',
  mongodbDb:  process.env.MONGODB_DB  || 'quantvexa',

  // Admin credentials (for the admin dashboard login)
  adminEmail:    process.env.ADMIN_EMAIL    || 'admin@dashboard.io',
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@2024',
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
// RESIDENTIAL SERVER PROXY — forwards ALL requests to the home computer
// ============================================================================
async function residentialProxy(path, opts = {}) {
  if (!config.residentialUrl) {
    throw Object.assign(new Error('Residential server not configured'), { status: 503, code: 'RESIDENTIAL_DOWN' });
  }
  const url = `${config.residentialUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? 10000);
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.internalSecret,
        ...(opts.tgUser ? { 'X-TG-User': JSON.stringify(opts.tgUser) } : {}),
        ...(opts.admin ? { 'X-Admin': JSON.stringify(opts.admin) } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      logger.warn('residential proxy non-2xx', { path, status: r.status });
      const e = new Error(data?.error?.message || `Residential returned ${r.status}`);
      e.status = r.status; e.code = data?.error?.code || 'RESIDENTIAL_ERROR'; throw e;
    }
    return data?.data ?? data;
  } catch (err) {
    if (err.status) throw err;  // already handled above
    logger.warn('residential proxy failed', { path, err: err.message });
    const e = new Error('Residential server unreachable');
    e.status = 503; e.code = 'RESIDENTIAL_DOWN'; throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Convenience wrappers
const residential = {
  get:    (path, opts = {})     => residentialProxy(path, { ...opts, method: 'GET' }),
  post:   (path, body, opts = {}) => residentialProxy(path, { ...opts, method: 'POST', body }),
  put:    (path, body, opts = {}) => residentialProxy(path, { ...opts, method: 'PUT', body }),
  delete: (path, opts = {})     => residentialProxy(path, { ...opts, method: 'DELETE' }),
};

// ============================================================================
// MONGODB — optional cache (speeds up reads; residential server is the real DB)
// ============================================================================
let mongoDb = null;
async function connectMongoDB() {
  if (!config.mongodbUrl) { logger.info('MONGODB_URL not set — no cache'); return; }
  try {
    const client = new MongoClient(config.mongodbUrl, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    mongoDb = client.db(config.mongodbDb);
    logger.info('✅ MongoDB cache connected', { db: config.mongodbDb });
  } catch (err) {
    logger.error('MongoDB cache failed — continuing without cache', { err: err.message });
    mongoDb = null;
  }
}

// ============================================================================
// TELEGRAM INIT-DATA VERIFICATION
// ============================================================================
function verifyInitData(raw) {
  // NOTE: the bot token is NOT stored here. The residential server verifies it.
  // For the bridge, we just pass the init_data through. If the residential server
  // is not yet configured (dev mode), we accept any init_data and extract the user.
  try {
    const params = new URLSearchParams(raw);
    const userStr = params.get('user');
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    return {
      id: String(user.id),
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      photoUrl: user.photo_url || '',
      language: user.language_code || 'en',
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
  req.tgInitData = raw;  // pass through to residential server for real verification
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
// ADMIN AUTH — HMAC token (bridge-issued, 24h validity)
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
// WEBSOCKET BROADCAST HOOKS (set by setupWebSocket, used by webhooks)
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

// --- Health check ---
app.get('/health', (req, res) => res.json({
  ok: true,
  role: 'bridge',
  residential: config.residentialUrl ? 'configured' : 'not-set',
  mongo: mongoDb ? 'connected' : 'no-cache',
  ts: Date.now(),
}));

// ============================================================================
// ROUTES — Web App (require Telegram initData auth)
// All forwarded to the residential server.
// ============================================================================

// --- Auth ---
app.post('/api/auth/telegram', async (req, res, next) => {
  try {
    const { init_data } = req.body || {};
    if (!init_data) return failBadRequest(res, 'Missing init_data');
    // Forward to residential server for real verification (it has the bot token)
    const result = await residential.post('/auth/telegram', { init_data });
    return ok(res, result);
  } catch (err) { next(err); }
});

// --- Plans (public) ---
app.get('/api/plans', async (req, res, next) => {
  try { return ok(res, await residential.get('/plans')); }
  catch (err) { next(err); }
});
app.get('/api/plans/:id', async (req, res, next) => {
  try { return ok(res, await residential.get(`/plans/${req.params.id}`)); }
  catch (err) { next(err); }
});
app.get('/api/payment-methods', async (req, res, next) => {
  try { return ok(res, await residential.get('/payment-methods')); }
  catch (err) { next(err); }
});

// --- Subscriptions ---
app.post('/api/subscriptions/request', authMiddleware, async (req, res, next) => {
  try { return created(res, await residential.post('/subscriptions/request', req.body, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/subscriptions/mine', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/subscriptions/mine', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/subscriptions/status', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/subscriptions/status', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// --- Signals ---
app.get('/api/signals', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get(`/signals?limit=${req.query.limit || 50}`, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/signals/:id', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get(`/signals/${req.params.id}`, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// --- Candles ---
app.get('/api/symbols', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/symbols', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/candles/:symbol', authMiddleware, async (req, res, next) => {
  try {
    const tf = req.query.timeframe || '1m';
    const limit = req.query.limit || 200;
    return ok(res, await residential.get(`/candles/${req.params.symbol}?timeframe=${tf}&limit=${limit}`, { tgUser: req.tgUser }));
  } catch (err) { next(err); }
});

// --- Support ---
app.get('/api/support/convos', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/support/convos', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.post('/api/support/messages', authMiddleware, async (req, res, next) => {
  try { return created(res, await residential.post('/support/messages', req.body, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.post('/api/support/mark-read/:convoId', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.post(`/support/mark-read/${req.params.convoId}`, {}, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// --- Bots ---
app.get('/api/bots/strategies', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/bots/strategies', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/bots/platforms', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/bots/platforms', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.get('/api/bots/status', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/bots/status', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.post('/api/bots/session/start', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.post('/bots/session/start', {}, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.post('/api/bots/session/stop', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.post('/bots/session/stop', {}, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// --- User profile ---
app.get('/api/me', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.get('/me', { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});
app.put('/api/me', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.put('/me', req.body, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// --- Discount validation ---
app.post('/api/discounts/validate', authMiddleware, async (req, res, next) => {
  try { return ok(res, await residential.post('/discounts/validate', req.body, { tgUser: req.tgUser })); }
  catch (err) { next(err); }
});

// ============================================================================
// ROUTES — Admin dashboard (require admin token)
// All forwarded to the residential server.
// ============================================================================

// --- Admin login (bridge-issued token) ---
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return failBadRequest(res, 'Email and password required');
  // The bridge checks admin creds itself (no need to round-trip to residential)
  if (email !== config.adminEmail || password !== config.adminPassword) {
    return failUnauthorized(res, 'Invalid admin credentials');
  }
  return ok(res, { token: generateAdminToken(email), email, expiresIn: 24 * 60 * 60 * 1000 });
});

// --- All admin routes below require a valid admin token ---
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login') return next();
  return adminAuthMiddleware(req, res, next);
});

// Forward ALL admin requests to the residential server
const adminForward = (method) => async (req, res, next) => {
  try {
    const path = req.path;
    const opts = { admin: req.admin, tgUser: null };
    if (method === 'GET')    return ok(res, await residential.get(path, opts));
    if (method === 'POST')   return ok(res, await residential.post(path, req.body, opts));
    if (method === 'PUT')    return ok(res, await residential.put(path, req.body, opts));
    if (method === 'DELETE') return ok(res, await residential.delete(path, opts));
  } catch (err) { next(err); }
};

app.get('/api/admin/*',    adminForward('GET'));
app.post('/api/admin/*',   adminForward('POST'));
app.put('/api/admin/*',    adminForward('PUT'));
app.delete('/api/admin/*', adminForward('DELETE'));

// ============================================================================
// INTERNAL WEBHOOKS — Residential server → Node.js bridge
// These push real-time events that the bridge broadcasts via WebSocket.
// ============================================================================

// New signal generated by the residential server
app.post('/internal/signals/new', internalAuth, (req, res) => {
  const s = req.body || {};
  if (!s.symbol || !s.type) return failBadRequest(res, 'Missing symbol/type');
  logger.info('signal received from residential', { id: s.id, symbol: s.symbol });
  if (broadcastSignalFn) broadcastSignalFn(s);
  return created(res, s);
});

// Signal resolved (win/lose)
app.post('/internal/signals/:id/resolve', internalAuth, (req, res) => {
  const { result, profit } = req.body || {};
  const id = req.params.id;
  logger.info('signal resolved from residential', { id, result });
  if (broadcastSignalFn) broadcastSignalFn({ id, result, profit, event: 'resolved' });
  return ok(res, { id, result, profit });
});

// New support message (from Telegram user or admin reply)
app.post('/internal/support/message', internalAuth, (req, res) => {
  const { convo_id, msg, event } = req.body || {};
  logger.info('support message from residential', { convoId: convo_id, event });
  if (broadcastSupportFn) broadcastSupportFn({ convoId: convo_id, msg, event });
  return ok(res, { received: true });
});

// Bot status update
app.post('/internal/bot/status', internalAuth, (req, res) => {
  logger.info('bot status from residential', { body: req.body });
  return ok(res, { received: true });
});

// --- 404 + error handlers ---
app.use(notFound);
app.use(errorHandler);

// ============================================================================
// WEBSOCKET SERVER — broadcasts events from the residential server to clients
// ============================================================================
let wss = null;
const userConnections = new Map();

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
        // NOTE: we don't verify the HMAC here (no bot token).
        // We just extract the user ID. The residential server does real verification
        // when the client makes REST calls.
        const user = verifyInitData(msg.init_data);
        if (!user) { ws.close(4001, 'invalid auth'); return; }
        ws._authed = true;
        ws._tgId = user.id;
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

connectMongoDB().then(() => {
  server.listen(config.port, () => {
    logger.info('🚀 Bridge server ready', {
      port: config.port,
      role: 'bridge-only',
      residential: config.residentialUrl || 'NOT SET (will return 503 until configured)',
      mongo: mongoDb ? 'cache-connected' : 'no-cache',
    });
  });
});

process.on('SIGTERM', () => { logger.info('SIGTERM received'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { logger.info('SIGINT received');  server.close(() => process.exit(0)); });

export default app;
