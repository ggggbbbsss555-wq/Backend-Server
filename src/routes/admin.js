// Admin endpoints — called by the Firebase admin dashboard (later) and
// by Python when it needs to push state to the admin.
//
// All admin endpoints require either:
//   - A valid Firebase admin token (TODO when we wire Firebase), OR
//   - The X-Internal-Secret header (for Python → admin pushes)
//
// For now we use the internal-secret middleware only — Firebase auth will
// be layered in once the dashboard is migrated off localStorage.

import { Router } from 'express';
import internalAuth from '../middleware/internalAuth.js';
import { ok, failBadRequest, failNotFound } from '../utils/response.js';
import dataStore from '../services/dataStore.js';
import subscriptionsService from '../services/subscriptions.js';
import supportService from '../services/support.js';
import serversService from '../services/servers.js';
import plansService from '../services/plans.js';

export const adminRouter = Router();

// === Subscription management ===
adminRouter.get('/subscriptions', (req, res) => {
  const { status } = req.query;
  return ok(res, dataStore.listSubRequests(status ? { status } : {}));
});

adminRouter.post('/subscriptions/:id/approve', async (req, res, next) => {
  try {
    const r = await subscriptionsService.approve(req.params.id, req.body?.note || '');
    return ok(res, r);
  } catch (err) { next(err); }
});

adminRouter.post('/subscriptions/:id/reject', async (req, res, next) => {
  try {
    const r = await subscriptionsService.reject(req.params.id, req.body?.note || '');
    return ok(res, r);
  } catch (err) { next(err); }
});

// === Support chat (admin side) ===
adminRouter.get('/support/convos', (req, res) => {
  return ok(res, supportService.listAll());
});

adminRouter.post('/support/:convoId/mark-read', (req, res) => {
  return ok(res, supportService.markRead(req.params.convoId));
});

// === Server / bot control ===
adminRouter.post('/servers/:id/toggle', async (req, res, next) => {
  try {
    const { running } = req.body || {};
    if (typeof running !== 'boolean') return failBadRequest(res, 'Missing "running" boolean');
    const p = await serversService.togglePlatform(req.params.id, running);
    return ok(res, p);
  } catch (err) { next(err); }
});

adminRouter.post('/strategies/:id/toggle', async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return failBadRequest(res, 'Missing "enabled" boolean');
    const s = await serversService.toggleStrategy(req.params.id, enabled);
    return ok(res, s);
  } catch (err) { next(err); }
});

// === Payment-method config ===
adminRouter.get('/payments', (req, res) => {
  return ok(res, dataStore.getPayments());
});

adminRouter.put('/payments/:methodId', (req, res) => {
  const cfg = req.body || {};
  const updated = dataStore.setPayment(req.params.methodId, cfg);
  return ok(res, updated);
});

// === Users (read-only for the admin) ===
adminRouter.get('/users', (req, res) => {
  const all = [];
  // dataStore exposes no listUsers() yet — iterate the underlying Map directly.
  // (Yes this leaks the abstraction; we'll fix when we move to Postgres/Firestore.)
  for (const u of dataStore.getUser._map?.values?.() || []) all.push(u);
  return ok(res, all);
});

export default adminRouter;
