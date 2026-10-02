// Tiny leveled logger. No deps. Writes JSON in prod, pretty in dev.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function fmt(o) { return JSON.stringify(o); }

function emit(level, msg, meta) {
  if (LEVELS[level] < CURRENT) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta || {}),
  };
  if (process.env.NODE_ENV === 'production') {
    process.stdout.write(fmt(line) + '\n');
  } else {
    const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level];
    process.stdout.write(`${color}[${level.toUpperCase()}]\x1b[0m ${msg}${meta ? ' ' + fmt(meta) : ''}\n`);
  }
}

export const logger = {
  debug: (m, x) => emit('debug', m, x),
  info:  (m, x) => emit('info',  m, x),
  warn:  (m, x) => emit('warn',  m, x),
  error: (m, x) => emit('error', m, x),
};

export default logger;
