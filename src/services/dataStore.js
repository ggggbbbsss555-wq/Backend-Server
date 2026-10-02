// In-memory data store for prototypes.
// Each collection is a Map keyed by id. This is intentionally minimal —
// later, swap these functions for Postgres / Firebase / Redis without
// changing the route handlers.

import logger from '../utils/logger.js';

const collections = {
  users:         new Map(),  // keyed by tgId
  subscriptions: new Map(),  // keyed by request id
  convos:        new Map(),  // keyed by convo id
  signals:       [],         // array (newest first)
  payments:      new Map(),  // payment-method config (binance/trc20/bep20)
};

export const dataStore = {
  // ----- Users -----
  getUser(tgId) {
    return collections.users.get(String(tgId));
  },
  upsertUser(user) {
    const u = { ...user, id: String(user.id), updatedAt: Date.now() };
    collections.users.set(u.id, u);
    return u;
  },

  // ----- Subscription payment requests -----
  // (user submits a payment receipt → admin verifies → approved/rejected)
  listSubRequests({ status, tgId } = {}) {
    const all = [...collections.subscriptions.values()];
    return all.filter(r => {
      if (status && r.status !== status) return false;
      if (tgId && r.tgId !== String(tgId)) return false;
      return true;
    }).sort((a, b) => b.createdAt - a.createdAt);
  },
  getSubRequest(id) {
    return collections.subscriptions.get(id);
  },
  addSubRequest(req) {
    const r = {
      id: 'sr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      status: 'pending',
      createdAt: Date.now(),
      ...req,
    };
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

  // ----- Support conversations -----
  listConvos(tgId) {
    const all = [...collections.convos.values()];
    return all
      .filter(c => !tgId || c.tgId === String(tgId))
      .sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  },
  getConvo(id) { return collections.convos.get(id); },
  getOrCreateConvo(tgId, userInfo = {}) {
    const key = String(tgId);
    if (collections.convos.has(key)) return collections.convos.get(key);
    const c = {
      id: 'c_' + key,
      tgId: key,
      userName: userInfo.name || '',
      userEmail: userInfo.email || '',
      status: 'open',
      unread: 0,
      messages: [],
      createdAt: Date.now(),
    };
    collections.convos.set(c.id, c);
    // Also store under tgId for quick lookup
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

  // ----- Signals -----
  // Newest first; bounded to last 500 to keep memory under control
  listSignals(limit = 50) {
    return collections.signals.slice(0, limit);
  },
  addSignal(sig) {
    const s = {
      id: 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      createdAt: Date.now(),
      result: null,
      profit: null,
      ...sig,
    };
    collections.signals.unshift(s);
    if (collections.signals.length > 500) collections.signals.length = 500;
    return s;
  },
  resolveSignal(id, result, profit) {
    const s = collections.signals.find(x => x.id === id);
    if (!s) return null;
    s.result = result;
    s.profit = profit;
    s.resolvedAt = Date.now();
    return s;
  },

  // ----- Payment-method config (admin-editable; mirrors quantvexa wallet) -----
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

export default dataStore;
