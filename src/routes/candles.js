// GET /api/candles/:symbol   → OHLCV data (proxied to Python candle server)
// GET /api/symbols           → list of available trading symbols

import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ok } from '../utils/response.js';
import pythonBridge from '../services/pythonBridge.js';
import logger from '../utils/logger.js';

export const candlesRouter = Router();

candlesRouter.use(authMiddleware);

candlesRouter.get('/symbols', async (req, res, next) => {
  try {
    const data = await pythonBridge.getSymbols();
    return ok(res, data);
  } catch (err) {
    logger.warn('candle /symbols proxy failed', { err: err.message });
    return ok(res, []);  // graceful degradation — Web App shows "no symbols"
  }
});

candlesRouter.get('/:symbol', async (req, res, next) => {
  try {
    const timeframe = (req.query.timeframe || '1m');
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const data = await pythonBridge.getCandles(req.params.symbol, timeframe, limit);
    return ok(res, data);
  } catch (err) {
    logger.warn('candle proxy failed', { symbol: req.params.symbol, err: err.message });
    return ok(res, []);  // graceful — chart will show empty
  }
});

export default candlesRouter;
