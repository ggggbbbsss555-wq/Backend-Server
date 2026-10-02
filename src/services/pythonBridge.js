// Thin HTTP client for talking to the Python codebase.
// All three Python services (candle, telegram, signals) live in one codebase
// but are exposed on three different ports — we route accordingly.

import config from '../config/env.js';
import logger from '../utils/logger.js';

async function call(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? 8000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.internalSecret,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      logger.warn('python call non-2xx', { url, status: res.status, body: text?.slice(0, 200) });
      const e = new Error(`Python ${url} returned ${res.status}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export const pythonBridge = {
  // ===== Candle server =====
  getCandles(symbol, timeframe = '1m', limit = 200) {
    const u = `${config.python.candleUrl}/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=${limit}`;
    return call(u);
  },
  getSymbols() {
    return call(`${config.python.candleUrl}/symbols`);
  },

  // ===== Telegram bot =====
  // Used when admin replies in the support chat — Node.js forwards the reply
  // to the Python telegram bot, which sends it to the user via Telegram.
  sendTelegramMessage(tgUserId, text) {
    return call(`${config.python.telegramUrl}/send`, {
      method: 'POST',
      body: { tg_user_id: tgUserId, text },
    });
  },
  // Notify user that their subscription was approved / rejected
  notifySubscriptionUpdate(tgUserId, status, planName) {
    return call(`${config.python.telegramUrl}/notify-subscription`, {
      method: 'POST',
      body: { tg_user_id: tgUserId, status, plan_name: planName },
    });
  },

  // ===== Signals bots =====
  // Start/stop a bot for a specific strategy
  controlBot(strategy, action) {
    return call(`${config.python.signalsUrl}/bot/control`, {
      method: 'POST',
      body: { strategy, action },   // action: 'start' | 'stop'
    });
  },
  getBotStatus() {
    return call(`${config.python.signalsUrl}/bot/status`);
  },
  // Fetch recent signals history
  getRecentSignals(limit = 50) {
    return call(`${config.python.signalsUrl}/signals?limit=${limit}`);
  },
};

export default pythonBridge;
