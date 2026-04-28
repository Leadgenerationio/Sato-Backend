import { Router, type Router as RouterType } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { redis } from '../config/redis.js';

export const healthRoutes: RouterType = Router();

/**
 * Public, unauthenticated health check.
 *
 * Returns the deploy + dependency status — used by Railway probes,
 * uptime monitors, and the post-deploy verification agent so they don't
 * have to guess at /healthz vs /health vs /.
 *
 * Response shape is intentionally stable so monitors can match on it:
 *   { ok: boolean, version: string, checks: { db: 'up'|'down', redis: 'up'|'down'|'not_configured' } }
 */
healthRoutes.get('/', async (_req, res) => {
  const checks: { db: 'up' | 'down'; redis: 'up' | 'down' | 'not_configured' } = {
    db: 'down',
    redis: 'not_configured',
  };

  if (db) {
    try {
      await db.execute(sql`select 1`);
      checks.db = 'up';
    } catch {
      checks.db = 'down';
    }
  }

  if (redis) {
    try {
      const pong = await redis.ping();
      checks.redis = pong === 'PONG' ? 'up' : 'down';
    } catch {
      checks.redis = 'down';
    }
  }

  const ok = checks.db === 'up' && (checks.redis === 'up' || checks.redis === 'not_configured');

  res.status(ok ? 200 : 503).json({
    ok,
    version: process.env.npm_package_version ?? 'unknown',
    nodeEnv: process.env.NODE_ENV ?? 'unknown',
    checks,
    timestamp: new Date().toISOString(),
  });
});
