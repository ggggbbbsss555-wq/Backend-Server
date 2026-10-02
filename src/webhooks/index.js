// Internal webhooks — called by the Python codebase to push events INTO Node.js.
// All endpoints require X-Internal-Secret header (see middleware/internalAuth.js).
//
// Endpoints:
//   POST /internal/signals/new          → new signal generated
//   POST /internal/signals/:id/resolve  → trade closed (win/lose)
//   POST /internal/support/message      → admin replied via Telegram
//   POST /internal/bot/status           → bot status update

import { Router } from 'express';
import internalAuth from '../middleware/internalAuth.js';
import { ok, failBadRequest } from '../utils/response.js';
import signalsService from '../services/signals.js';
import supportService from '../services/support.js';
import logger from '../utils/logger.js';

export const webhooksRouter = Router();

webhooksRouter.use(internalAuth);

// POST /internal/signals/new
// Body: { symbol, type, entry, duration, strategy, platform, ... }
webhooksRouter.post('/signals/new', (req, res) => {
  const s = req.body || {};
  if (!s.symbol || !s.type) return failBadRequest(res, 'Missing symbol/type');
  const saved = signalsService.receiveNew(s);
  return ok(res, saved, 201);
});

// POST /internal/signals/:id/resolve
// Body: { result: 'win'|'lose', profit: 1.23 }
webhooksRouter.post('/signals/:id/resolve', (req, res) => {
  const { result, profit } = req.body || {};
  if (!['win', 'lose'].includes(result)) return failBadRequest(res, 'Invalid result');
  const updated = signalsService.resolve(req.params.id, result, profit);
  if (!updated) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
  return ok(res, updated);
});

// POST /internal/support/message
// Body: { tg_id, text }
webhooksRouter.post('/support/message', async (req, res, next) => {
  try {
    const { tg_id, text } = req.body || {};
    if (!tg_id || !text) return failBadRequest(res, 'Missing tg_id or text');
    const result = await supportService.adminMessage({ tgId: String(tg_id), text });
    return ok(res, result, 201);
  } catch (err) { next(err); }
});

// POST /internal/bot/status
// Body: { platforms: [...], strategies: [...] }
webhooksRouter.post('/bot/status', (req, res) => {
  // For now we just log — Python will push periodic status updates and we
  // could cache them or forward to the admin dashboard via WebSocket.
  logger.info('bot status update', { body: req.body });
  return ok(res, { received: true });
});

export default webhooksRouter;
