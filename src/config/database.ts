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

const client = connectionString
  ? postgres(connectionString)
  : (null as unknown as ReturnType<typeof postgres>);

export const db = connectionString
  ? drizzle(client, { schema })
  : (null as unknown as ReturnType<typeof drizzle>);
