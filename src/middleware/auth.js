// Validates Telegram Web App initData and attaches the user to the request.
// If validation fails, the route returns 401.
//
// Usage:  router.get('/me', authMiddleware, handler)

import { extractInitData, verifyInitData } from '../utils/telegram.js';
import { failUnauthorized } from '../utils/response.js';

export function authMiddleware(req, res, next) {
  const raw = extractInitData(req);
  if (!raw) return failUnauthorized(res, 'Missing Telegram initData');

  const result = verifyInitData(raw);
  if (!result || !result.user) return failUnauthorized(res, 'Invalid Telegram initData');

  // Attach the verified Telegram user to the request for downstream handlers
  req.tgUser = {
    id:        String(result.user.id),
    firstName: result.user.first_name || '',
    lastName:  result.user.last_name || '',
    username:  result.user.username || '',
    photoUrl:  result.user.photo_url || '',
    language:  result.user.language_code || 'en',
    // platform is chosen by the user in the Web App, not by Telegram
    platform:  req.headers['x-tg-platform'] || 'QUOTEX',
  };

  next();
}

export default authMiddleware;
