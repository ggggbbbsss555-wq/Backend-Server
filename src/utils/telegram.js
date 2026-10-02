// Telegram Web App initData validation.
// Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// The Web App sends Telegram initData in the Authorization header (or tg-init-data
// query param). We verify the HMAC signature against our bot token so we know the
// request really came from a Telegram user, then we extract the user object.

import crypto from 'crypto';
import config from '../config/env.js';

// Parse the query string format: "user=...&chat_instance=...&hash=..."
export function parseInitData(raw) {
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

// Verify the HMAC signature Telegram attaches to initData.
export function verifyInitData(raw, botToken = config.telegramBotToken) {
  if (!raw || !botToken) return null;
  const parsed = parseInitData(raw);
  const hash = parsed.hash;
  if (!hash) return null;

  // Reconstruct the data-check string (alphabetical, excluding hash)
  const dataCheckString = Object.keys(parsed)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${parsed[k]}`)
    .join('\n');

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  // calculated_hash = HMAC_SHA256(secret_key, data_check_string)
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Timing-safe compare
  if (calcHash.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calcHash), Buffer.from(hash))) return null;

  // Parse the user object (it's URL-encoded JSON inside the query string)
  let user = null;
  try { if (parsed.user) user = JSON.parse(parsed.user); } catch { /* ignore */ }

  // Check auth_date freshness (24h window)
  const authDate = parseInt(parsed.auth_date ?? '0', 10);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return null;

  return { parsed, user };
}

// Helper: pull initData from a request (Authorization header or query param)
export function extractInitData(req) {
  const auth = req.get('Authorization') || '';
  if (auth.startsWith('tma ')) return auth.slice(4);
  if (auth.startsWith('Telegram ')) return auth.slice(9);
  if (req.query['tg-init-data']) return String(req.query['tg-init-data']);
  return null;
}
