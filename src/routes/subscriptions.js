// User-facing subscription endpoints (Web App):
//   POST   /api/subscriptions/request  → user submits a payment receipt
//   GET    /api/subscriptions/mine     → user's own subscription history
//   GET    /api/subscriptions/status   → user's current subscription status

import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ok, failBadRequest } from '../utils/response.js';
import subscriptionsService from '../services/subscriptions.js';
import dataStore from '../services/dataStore.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.use(authMiddleware);

// POST /api/subscriptions/request
// Body: { planId, paymentMethod, transactionId, receiptImage, note }
subscriptionsRouter.post('/request', async (req, res, next) => {
  try {
    const r = await subscriptionsService.createRequest({
      tgUser: req.tgUser,
      planId: req.body.planId,
      paymentMethod: req.body.paymentMethod,
      transactionId: req.body.transactionId,
      receiptImage: req.body.receiptImage,
      note: req.body.note,
    });
    return ok(res, r, 201);
  } catch (err) { next(err); }
});

// GET /api/subscriptions/mine
subscriptionsRouter.get('/mine', (req, res) => {
  return ok(res, subscriptionsService.listMine(req.tgUser));
});

// GET /api/subscriptions/status — current subscription state for this user
subscriptionsRouter.get('/status', (req, res) => {
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

export default subscriptionsRouter;
