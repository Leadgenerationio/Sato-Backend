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

// Bound the pool and put a ceiling on every connection: an unbounded pool can exhaust the database's connection limit
// under a burst, and a hung query with no statement_timeout holds its connection forever. Defaults are conservative and
// overridable per-environment; statement_timeout is generous (60s) so heavy reports still finish — raise it if needed.
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const client = connectionString
  ? postgres(connectionString, {
      max: num('DB_POOL_MAX', 10),
      idle_timeout: num('DB_IDLE_TIMEOUT_S', 20),
      connect_timeout: num('DB_CONNECT_TIMEOUT_S', 10),
      connection: { statement_timeout: num('DB_STATEMENT_TIMEOUT_MS', 60_000) },
    })
  : (null as unknown as ReturnType<typeof postgres>);

export const db = connectionString
  ? drizzle(client, { schema })
  : (null as unknown as ReturnType<typeof drizzle>);
