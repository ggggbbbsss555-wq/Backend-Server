// GET /api/signals                → recent signals (in-memory buffer + Python fallback)
// GET /api/signals/:id            → single signal
// WS  /ws/signals                 → real-time stream of new + resolved signals

import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ok, failNotFound } from '../utils/response.js';
import signalsService from '../services/signals.js';

export const signalsRouter = Router();

signalsRouter.use(authMiddleware);

signalsRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const list = await signalsService.list(limit);
    return ok(res, list);
  } catch (err) { next(err); }
});

signalsRouter.get('/:id', (req, res) => {
  // Search the in-memory buffer
  const list = signalsService.list(500);
  const sig = list.find(s => s.id === req.params.id);
  if (!sig) return failNotFound(res, 'Signal not found');
  return ok(res, sig);
});

export default signalsRouter;
