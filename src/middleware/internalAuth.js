// Internal webhook auth — Python codebase calls our /internal/* endpoints
// with X-Internal-Secret: <INTERNAL_SECRET>. We check it here so untrusted
// callers can't push fake signals / fake support messages.

import config from '../config/env.js';
import { failUnauthorized } from '../utils/response.js';

export function internalAuth(req, res, next) {
  const secret = req.get('X-Internal-Secret');
  if (!secret || secret !== config.internalSecret) {
    return failUnauthorized(res, 'Invalid internal secret');
  }
  next();
}

export default internalAuth;
