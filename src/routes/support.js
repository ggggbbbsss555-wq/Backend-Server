// Web App support chat endpoints:
//   GET  /api/support/convos         → user's own conversations
//   POST /api/support/messages       → user sends a message
//   POST /api/support/mark-read/:id  → mark a convo as read

import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ok, failBadRequest } from '../utils/response.js';
import supportService from '../services/support.js';

export const supportRouter = Router();

supportRouter.use(authMiddleware);

// GET /api/support/convos
supportRouter.get('/convos', (req, res) => {
  return ok(res, supportService.listMine(req.tgUser));
});

// POST /api/support/messages
// Body: { text, image }
supportRouter.post('/messages', async (req, res, next) => {
  try {
    const { text, image } = req.body || {};
    if (!text && !image) return failBadRequest(res, 'Message text or image required');
    const result = await supportService.userMessage(req.tgUser, { text, image });
    return ok(res, result, 201);
  } catch (err) { next(err); }
});

// POST /api/support/mark-read/:convoId
supportRouter.post('/mark-read/:convoId', (req, res) => {
  const c = supportService.markRead(req.params.convoId);
  return ok(res, c);
});

export default supportRouter;
