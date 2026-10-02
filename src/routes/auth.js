// POST /api/auth/telegram
// Body: { init_data: "user=...&hash=..." }
// Returns: { user, session_token } — the Web App stores the token for subsequent calls.
//
// Note: for now the "session token" is just the initData itself (it's signed by
// Telegram and valid for 24h). When we add Firebase Auth later, we'll mint a
// proper Firebase custom token here.

import { Router } from 'express';
import { verifyInitData } from '../utils/telegram.js';
import { ok, failBadRequest, failUnauthorized } from '../utils/response.js';
import dataStore from '../services/dataStore.js';

export const authRouter = Router();

authRouter.post('/telegram', (req, res) => {
  const { init_data } = req.body || {};
  if (!init_data) return failBadRequest(res, 'Missing init_data');

  const result = verifyInitData(init_data);
  if (!result || !result.user) return failUnauthorized(res, 'Invalid Telegram initData');

  // Persist the user in our store (so the admin dashboard can see them)
  const u = dataStore.upsertUser({
    id:        String(result.user.id),
    firstName: result.user.first_name || '',
    lastName:  result.user.last_name || '',
    username:  result.user.username || '',
    photoUrl:  result.user.photo_url || '',
    language:  result.user.language_code || 'en',
    platform:  'QUOTEX',
    lastSeen:  Date.now(),
  });

  return ok(res, {
    user: {
      id:        u.id,
      name:      [u.firstName, u.lastName].filter(Boolean).join(' '),
      username:  u.username,
      photoUrl:  u.photoUrl,
      language:  u.language,
    },
    // The "session token" is just the initData — the Web App sends it back
    // in the Authorization header on every subsequent call. Our authMiddleware
    // re-verifies it on each request.
    session_token: init_data,
  });
});

export default authRouter;
