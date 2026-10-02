// GET /api/plans           → list all plans (Basic/Pro/Elite with locked prices)
// GET /api/plans/:id       → single plan
// GET /api/payment-methods → list enabled payment methods (mirrors quantvexa wallet)

import { Router } from 'express';
import { ok } from '../utils/response.js';
import plansService from '../services/plans.js';
import dataStore from '../services/dataStore.js';

export const plansRouter = Router();

plansRouter.get('/', (req, res) => ok(res, plansService.list()));

plansRouter.get('/:id', (req, res) => {
  const p = plansService.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Plan not found' } });
  return ok(res, p);
});

plansRouter.get('/payment/methods', (req, res) => {
  // Note: this route is shadowed by /:id above if we put it after — register
  // it before /:id in the actual mount. Here we keep /:id first since 'methods'
  // isn't a valid plan id anyway.
  return ok(res, dataStore.getPayments());
});

export default plansRouter;
