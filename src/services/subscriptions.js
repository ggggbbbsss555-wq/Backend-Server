// Subscription service — handles payment requests from the Web App.
// Flow:
//   1. User picks a plan → POST /api/subscriptions/request with payment method + receipt
//   2. Admin (via Firebase dashboard later) verifies → POST /api/admin/subscriptions/:id/approve
//   3. We update the user's subscription status + notify Python telegram bot

import dataStore from './dataStore.js';
import plansService from './plans.js';
import pythonBridge from './pythonBridge.js';
import logger from '../utils/logger.js';

export const subscriptionsService = {
  // Create a new payment request from a Web App user
  async createRequest({ tgUser, planId, paymentMethod, transactionId, receiptImage, note }) {
    const plan = plansService.get(planId);
    if (!plan) {
      const e = new Error('Invalid plan id'); e.code = 'INVALID_PLAN'; e.status = 400; throw e;
    }
    if (!['binance', 'trc20', 'bep20'].includes(paymentMethod)) {
      const e = new Error('Invalid payment method'); e.code = 'INVALID_METHOD'; e.status = 400; throw e;
    }

    const req = dataStore.addSubRequest({
      tgId: tgUser.id,
      userName: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' '),
      username: tgUser.username,
      planId: plan.id,
      planName: plan.name,
      amount: plan.price,
      currency: plan.currency,
      paymentMethod,
      transactionId,
      receiptImage: receiptImage || null,
      note: note || '',
    });

    logger.info('subscription request created', { id: req.id, plan: plan.name, method: paymentMethod });
    return req;
  },

  // List a user's own requests
  listMine(tgUser) {
    return dataStore.listSubRequests({ tgId: tgUser.id });
  },

  // Admin approves a request — called from /api/admin/subscriptions/:id/approve
  async approve(id, adminNote = '') {
    const req = dataStore.getSubRequest(id);
    if (!req) { const e = new Error('Request not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'pending') {
      const e = new Error(`Request already ${req.status}`); e.status = 400; e.code = 'ALREADY_RESOLVED'; throw e;
    }
    dataStore.updateSubRequest(id, { status: 'approved', adminNote });

    // Update the user record so they have an active subscription
    const u = dataStore.getUser(req.tgId);
    if (u) {
      const plan = plansService.get(req.planId);
      dataStore.upsertUser({
        ...u,
        subscriptionStatus: 'ACTIVE',
        subscriptionPlan: req.planName,
        subscriptionPlanId: req.planId,
        subscriptionAmount: req.amount,
        subscriptionStartedAt: new Date().toISOString(),
        subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        autoRenewal: true,
      });
    }

    // Tell the Python telegram bot to notify the user
    try {
      await pythonBridge.notifySubscriptionUpdate(req.tgId, 'approved', req.planName);
    } catch (err) {
      logger.warn('failed to notify telegram bot of approval', { id, err: err.message });
    }

    logger.info('subscription approved', { id, plan: req.planName });
    return dataStore.getSubRequest(id);
  },

  // Admin rejects a request — same flow but status=rejected
  async reject(id, adminNote = '') {
    const req = dataStore.getSubRequest(id);
    if (!req) { const e = new Error('Request not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'pending') {
      const e = new Error(`Request already ${req.status}`); e.status = 400; e.code = 'ALREADY_RESOLVED'; throw e;
    }
    dataStore.updateSubRequest(id, { status: 'rejected', adminNote });

    try {
      await pythonBridge.notifySubscriptionUpdate(req.tgId, 'rejected', req.planName);
    } catch (err) {
      logger.warn('failed to notify telegram bot of rejection', { id, err: err.message });
    }

    logger.info('subscription rejected', { id });
    return dataStore.getSubRequest(id);
  },
};

export default subscriptionsService;
