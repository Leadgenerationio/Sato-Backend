import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { generalLimiter } from './middleware/rate-limit.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import { router } from './routes/index.js';
import { seedDefaultUsers } from './data/users.js';
import { registerSchedules } from './jobs/schedules.js';

const app: Express = express();

// Behind Railway's proxy — trust the immediate hop so req.ip is the real client
// and express-rate-limit doesn't throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// Security — CORS allow-list.
//
// Dev: a fixed localhost allow-list (no `origin: true` — even in dev we don't
// want every site reading the API). Prod: explicit CORS_ORIGINS env var
// (falls back to FRONTEND_URL for back-compat) — fail at startup if neither
// is set.
const DEV_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];
const configuredOrigins = (env.CORS_ORIGINS || env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (env.NODE_ENV === 'production' && configuredOrigins.length === 0) {
  throw new Error('CORS_ORIGINS must be set in production (comma-separated allow-list)');
}
const ALLOWED_ORIGINS = env.NODE_ENV === 'development' ? DEV_ALLOWED_ORIGINS : configuredOrigins;
console.log('CORS allow-list:', ALLOWED_ORIGINS);
app.use(
  cors({
    origin: (origin, cb) => {
      // Server-to-server / curl / health checks have no Origin header — allow.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`CORS: origin not allowed: ${origin}`));
      }
    },
    credentials: true,
  }),
);
app.use(helmet());

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(generalLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'incoming request');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1', router);

// Error handling
app.use(errorHandler);

// Start server
async function start() {
  await seedDefaultUsers();
  try {
    await registerSchedules();
  } catch (err) {
    logger.error({ err }, 'Failed to register scheduled jobs');
  }
  app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT}`);
  });
}

start();

export default app;
