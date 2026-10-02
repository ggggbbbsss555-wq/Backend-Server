// Bot/strategy/platform catalog endpoints (read-only for the Web App):
//   GET /api/bots/strategies   → Strong/Medium/Pro strategy catalog
//   GET /api/bots/platforms    → QUOTEX/BINOLLA + running status
//   GET /api/bots/status       → live bot status (proxied to Python)

import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ok } from '../utils/response.js';
import serversService from '../services/servers.js';

export const botsRouter = Router();

botsRouter.use(authMiddleware);

botsRouter.get('/strategies', (req, res) => {
  return ok(res, serversService.listStrategies());
});

botsRouter.get('/platforms', async (req, res, next) => {
  try {
    const platforms = await serversService.listPlatforms();
    return ok(res, platforms);
  } catch (err) { next(err); }
});

botsRouter.get('/status', async (req, res, next) => {
  try {
    const status = await serversService.botStatus();
    return ok(res, status || { running: false, strategies: [] });
  } catch (err) { next(err); }
});

export default botsRouter;
