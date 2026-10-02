// Centralized environment configuration.
// All env reads go through here so the rest of the codebase never touches
// process.env directly — easier to mock in tests and to validate at boot.

import dotenv from 'dotenv';
dotenv.config();

function required(name, fallback = '') {
  const v = process.env[name] ?? fallback;
  if (!v && process.env.NODE_ENV === 'production') {
    console.warn(`[config] Missing env var: ${name}`);
  }
  return v;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function int(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: int('PORT', 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  allowedOrigins: list('ALLOWED_ORIGINS', [
    'http://localhost:3000',
    'http://localhost:5173',
  ]),

  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),

  internalSecret: required('INTERNAL_SECRET', 'dev-internal-secret'),

  python: {
    candleUrl:   required('PYTHON_CANDLE_URL',   'http://localhost:9001'),
    telegramUrl: required('PYTHON_TELEGRAM_URL', 'http://localhost:9002'),
    signalsUrl:  required('PYTHON_SIGNALS_URL',  'http://localhost:9003'),
  },

  firebase: {
    projectId:    required('FIREBASE_PROJECT_ID'),
    clientEmail:  required('FIREBASE_CLIENT_EMAIL'),
    privateKey:   required('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },

  plans: {
    basic: int('PLAN_BASIC_PRICE', 50),
    pro:   int('PLAN_PRO_PRICE',   75),
    elite: int('PLAN_ELITE_PRICE', 100),
  },
};

export default config;
