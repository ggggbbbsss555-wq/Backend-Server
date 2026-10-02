import cors from 'cors';
import config from '../config/env.js';

// CORS for the Telegram Web App (4 quantvexa pages on GitHub Pages) +
// local dev origins. Railway admin dashboard will be added later.
export const corsMiddleware = cors({
  origin(origin, cb) {
    // Allow same-origin / no-origin (curl, server-to-server) requests
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret'],
});

export default corsMiddleware;
