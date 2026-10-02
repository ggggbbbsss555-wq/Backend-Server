// Entry point — boots Express + WebSocket server.

import http from 'http';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import config from './config/env.js';
import logger from './utils/logger.js';
import { corsMiddleware } from './middleware/cors.js';
import { notFound, errorHandler } from './middleware/error.js';

import authRouter from './routes/auth.js';
import plansRouter from './routes/plans.js';
import subscriptionsRouter from './routes/subscriptions.js';
import signalsRouter from './routes/signals.js';
import candlesRouter from './routes/candles.js';
import supportRouter from './routes/support.js';
import botsRouter from './routes/bots.js';
import adminRouter from './routes/admin.js';
import webhooksRouter from './webhooks/index.js';

import { setupWebSocket } from './ws/index.js';

const app = express();

// --- Security / reliability middleware ---
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '5mb' }));  // 5mb to allow receipt images
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware);

// Logging
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// Rate limiter — protect against abuse from the Web App
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Internal webhooks get a separate, more lenient limiter (Python is trusted)
app.use('/internal', rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
}));

// --- Health check (Railway / Docker use this) ---
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- REST API routes ---
app.use('/api/auth',           authRouter);
app.use('/api/plans',          plansRouter);
app.use('/api/subscriptions',  subscriptionsRouter);
app.use('/api/signals',        signalsRouter);
app.use('/api/candles',        candlesRouter);
app.use('/api/symbols',        candlesRouter);   // alias for /api/candles/symbols
app.use('/api/support',        supportRouter);
app.use('/api/bots',           botsRouter);
app.use('/api/admin',          adminRouter);

// --- Internal webhooks (Python → Node.js) ---
app.use('/internal', webhooksRouter);

// --- 404 + error handlers (must be last) ---
app.use(notFound);
app.use(errorHandler);

// --- Boot ---
const server = http.createServer(app);
setupWebSocket(server);

server.listen(config.port, () => {
  logger.info('🚀 Backend server ready', {
    port: config.port,
    env: config.nodeEnv,
    wsPath: '/ws',
    python: config.python,
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});

export default app;
