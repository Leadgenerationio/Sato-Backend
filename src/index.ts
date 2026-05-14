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
import { startWorkers } from './jobs/worker-entry.js';
import { redis } from './config/redis.js';

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
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];
const configuredOrigins = (env.CORS_ORIGINS || env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (env.NODE_ENV === 'production' && configuredOrigins.length === 0) {
  throw new Error('CORS_ORIGINS must be set in production (comma-separated allow-list)');
}
// In dev, union the hardcoded localhost defaults with whatever FRONTEND_URL /
// CORS_ORIGINS the user set — so when Vite picks a non-default port (5174,
// 5175 etc. when 5173 is busy) the user can set FRONTEND_URL and not have to
// edit code.
const ALLOWED_ORIGINS = env.NODE_ENV === 'development'
  ? Array.from(new Set([...DEV_ALLOWED_ORIGINS, ...configuredOrigins]))
  : configuredOrigins;
logger.info({ allowedOrigins: ALLOWED_ORIGINS }, 'CORS allow-list configured');
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

// Body parsing — capture raw body for webhook routes so HMAC signature
// verification has access to the exact bytes the provider signed. Mounted
// BEFORE the global json parser so the verify hook fires first on /webhooks.
app.use(
  '/api/v1/webhooks',
  express.json({
    limit: '1mb',
    verify: (req: import('express').Request & { rawBody?: string }, _res, buf: Buffer) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);
// Larger JSON limit ONLY for routes that legitimately accept big bodies
// (invoice attachments JSON, R2 presign requests with metadata, etc.).
// The narrower mounts run before the global parser so they capture their
// route paths. Both routes use multipart for the actual file bytes — the
// JSON here is just metadata.
app.use('/api/v1/uploads', express.json({ limit: '10mb' }));
app.use('/api/v1/invoices', express.json({ limit: '5mb' }));

// Global JSON parser. 1mb is plenty for every other endpoint (auth, list
// queries, status updates) and shrinks the parser CPU + DoS surface area
// on the bulk of requests. Webhook router (1mb, with rawBody capture)
// already mounted above for /api/v1/webhooks.
app.use(express.json({ limit: '1mb' }));

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

// Short-TTL Cache-Control on API GETs. Most list/detail endpoints are
// per-user (auth-scoped) so we mark them `private` to prevent shared CDN
// caching, but a 5-second max-age + 30s stale-while-revalidate smooths
// rapid tab-thrashing and lets the browser back/forward cache feel instant
// without ever serving cross-user data. Mutations (POST/PUT/PATCH/DELETE)
// stay uncached. Webhooks already mounted earlier.
app.use('/api/v1', (req, res, next) => {
  if (req.method === 'GET' && !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'private, max-age=5, stale-while-revalidate=30');
  }
  next();
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
  // Spawn BullMQ workers in-process so scheduled jobs (LeadByte sync,
  // cache prewarm, overdue chase, bank-feed sync, etc.) actually fire on
  // Railway's single-service deployment. Without this, schedules go into
  // Redis but no one consumes them — silently dead. If we ever scale to
  // multiple instances, move this to a separate Railway service running
  // `pnpm worker` and remove this call.
  try {
    startWorkers();
  } catch (err) {
    logger.error({ err }, 'Failed to start workers');
  }
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT}`);
  });

  // Graceful shutdown — Railway sends SIGTERM on redeploy/scale-down.
  // Stop accepting new connections, drain in-flight requests, close Redis,
  // then exit. Hard-exit after 10s in case a connection refuses to drain.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal — closing server');

    const forceTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 10s — exiting');
      process.exit(0);
    }, 10_000);
    forceTimer.unref();

    const closeServer = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.error({ err }, 'Error during server.close()');
        else logger.info('HTTP server closed');
        resolve();
      });
    });

    closeServer
      .then(async () => {
        try {
          await redis?.quit();
          if (redis) logger.info('Redis connection closed');
        } catch (err) {
          logger.error({ err }, 'Error closing Redis');
        }
      })
      .then(() => {
        clearTimeout(forceTimer);
        logger.info('Shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        logger.error({ err }, 'Unexpected error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();

export default app;
