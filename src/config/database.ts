import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env.js';
import * as schema from '../db/schema/index.js';

const connectionString = env.DATABASE_URL;

// In production, refuse to start without a database. Booting against a null
// db would cause every authenticated request to crash later with an opaque
// "Cannot read properties of null" — easier to fail fast at module load.
if (env.NODE_ENV === 'production' && !connectionString) {
  throw new Error('DATABASE_URL must be set in production');
}

// Bound the pool so a burst can't exhaust the database's connection limit, and fail fast on a dead database instead of
// hanging on connect. statement_timeout is deliberately NOT set here: this client is imported by backfill scripts and
// in-process jobs whose long bulk writes/lock-waits would be cancelled, and it breaks against PgBouncer as a startup
// parameter — set a query ceiling at the role level (ALTER ROLE ... SET statement_timeout) instead.
const client = connectionString
  ? postgres(connectionString, {
      max: env.DB_POOL_MAX,
      idle_timeout: env.DB_IDLE_TIMEOUT_S,
      connect_timeout: env.DB_CONNECT_TIMEOUT_S,
    })
  : (null as unknown as ReturnType<typeof postgres>);

export const db = connectionString
  ? drizzle(client, { schema })
  : (null as unknown as ReturnType<typeof drizzle>);
