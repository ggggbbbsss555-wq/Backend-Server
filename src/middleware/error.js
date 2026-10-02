// Centralized error handler — mounted at the end of the Express app.
// Catches sync throws, async rejections (via express-async-errors or try/catch
// in handlers), and unknown routes.

import logger from '../utils/logger.js';

export function notFound(req, res) {
  return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` } });
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';
  logger.error('request failed', {
    method: req.method,
    path: req.path,
    status,
    code,
    message: err.message,
    stack: err.stack?.split('\n').slice(0, 3).join(' | '),
  });
  return res.status(status).json({
    ok: false,
    error: { code, message: err.message || 'Internal server error' },
  });
}

export default errorHandler;
