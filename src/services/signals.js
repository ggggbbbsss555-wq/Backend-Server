// Signals service — manages the in-memory signal buffer and proxies
// status/control calls to the Python signals bots.
//
// Two flows:
//   - Python signals bot pushes new signal → POST /internal/signals/new (webhook)
//     → we addSignal() to the in-memory buffer + broadcast via WebSocket
//   - Web App requests history → GET /api/signals → we return from buffer
//     (and optionally backfill from Python if buffer is empty)

import dataStore from './dataStore.js';
import pythonBridge from './pythonBridge.js';
import logger from '../utils/logger.js';

// Will be wired by the WebSocket setup — signalsChannel.broadcast(signal)
let broadcastFn = null;
export function setBroadcaster(fn) { broadcastFn = fn; }

export const signalsService = {
  // Receive a new signal from the Python signals bot
  receiveNew(signal) {
    const saved = dataStore.addSignal(signal);
    logger.info('signal received', { id: saved.id, symbol: saved.symbol, type: saved.type });
    if (broadcastFn) broadcastFn(saved);
    return saved;
  },

  // Resolve a signal (win/lose) — called by Python when the trade closes
  resolve(id, result, profit) {
    const s = dataStore.resolveSignal(id, result, profit);
    if (s && broadcastFn) broadcastFn({ ...s, event: 'resolved' });
    return s;
  },

  // List recent signals — try in-memory first, fall back to Python
  async list(limit = 50) {
    const local = dataStore.listSignals(limit);
    if (local.length > 0) return local;
    try {
      const remote = await pythonBridge.getRecentSignals(limit);
      return Array.isArray(remote) ? remote : (remote?.data || []);
    } catch (err) {
      logger.warn('failed to fetch signals from python', { err: err.message });
      return [];
    }
  },

  // Get bot status (running strategies, server load, etc.) from Python
  async botStatus() {
    try { return await pythonBridge.getBotStatus(); }
    catch (err) { logger.warn('bot status fetch failed', { err: err.message }); return null; }
  },

  // Start/stop a bot (admin action)
  async controlBot(strategy, action) {
    return await pythonBridge.controlBot(strategy, action);
  },
};

export default signalsService;
