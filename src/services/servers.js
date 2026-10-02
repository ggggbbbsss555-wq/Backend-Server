// Server status service — talks to the Python signals bots to find out
// which strategies/platforms are running. Used by the admin dashboard
// (and later the Web App's "is QUOTEX server up?" check).

import pythonBridge from './pythonBridge.js';
import logger from '../utils/logger.js';

// Local cache of the admin's intended state (so the dashboard works even
// if Python is briefly unreachable)
const localState = {
  platforms: [
    { id: 'QUOTEX',  name: 'QUOTEX',  description: 'Binary options trading', running: true, color: '#00d2ff' },
    { id: 'BINOLLA', name: 'BINOLLA', description: 'Smart advanced trading',  running: true, color: '#00ff88' },
  ],
  strategies: [
    { id: 'strong', name: 'Strong', enabled: true,  color: '#00ff88' },
    { id: 'medium', name: 'Medium', enabled: true,  color: '#00d2ff' },
    { id: 'pro',    name: 'Pro',    enabled: true,  color: '#ab82ff' },
  ],
};

export const serversService = {
  async listPlatforms() {
    // Try Python first; fall back to local state
    try {
      const status = await pythonBridge.getBotStatus();
      if (status?.platforms) return status.platforms;
    } catch (_) { /* fall through */ }
    return localState.platforms;
  },

  async togglePlatform(id, running) {
    const p = localState.platforms.find(x => x.id === id);
    if (p) p.running = running;
    // Tell Python to actually start/stop the server (best effort)
    try { await pythonBridge.controlBot(id.toLowerCase(), running ? 'start' : 'stop'); }
    catch (err) { logger.warn('python controlBot failed', { id, err: err.message }); }
    return p;
  },

  listStrategies() {
    return localState.strategies;
  },

  async toggleStrategy(id, enabled) {
    const s = localState.strategies.find(x => x.id === id);
    if (s) s.enabled = enabled;
    try { await pythonBridge.controlBot(id, enabled ? 'start' : 'stop'); }
    catch (err) { logger.warn('python controlBot failed', { id, err: err.message }); }
    return s;
  },
};

export default serversService;
