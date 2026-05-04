import bcryptjs from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema/index.js';
import { logger } from '../utils/logger.js';
import type { UserRole } from '../types/index.js';

// Stable UUIDs for the dev seed users — tests reference these by name so
// they keep working after the migration from in-memory to DB. Synthetic prefix
// 11111111-… so they're obviously test data and never collide with real
// gen_random_uuid() output.
export const SEED_USER_IDS = {
  OWNER: '11111111-0000-0000-0000-000000000001',
  FINANCE: '11111111-0000-0000-0000-000000000002',
  OPS: '11111111-0000-0000-0000-000000000003',
  CLIENT: '11111111-0000-0000-0000-000000000004',
  READONLY: '11111111-0000-0000-0000-000000000005',
} as const;

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  clientId: string | null;
  isActive: boolean;
  isPrimaryOwner: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Seed default users into the DB. Idempotent (uses onConflictDoNothing on
 * email). NEVER runs in production — these are dev/test creds with well-known
 * passwords. Production seeding is via `pnpm db:seed` (db/seed.ts) with
 * `SEED_*_PASSWORD` env vars.
 */
export async function seedDefaultUsers(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  if (!db) return; // No DB configured (e.g. some unit-test contexts)

  const seed = [
    {
      id: SEED_USER_IDS.OWNER,
      email: 'owner@stato.app',
      password: 'owner123',
      name: 'Sam Owner',
      role: 'owner' as const,
      businessId: LEADGEN_BUSINESS_ID,
      clientId: null,
      isPrimaryOwner: true,
    },
    {
      id: SEED_USER_IDS.FINANCE,
      email: 'finance@stato.app',
      password: 'finance123',
      name: 'Finance Admin',
      role: 'finance_admin' as const,
      businessId: LEADGEN_BUSINESS_ID,
      clientId: null,
      isPrimaryOwner: false,
    },
    {
      id: SEED_USER_IDS.OPS,
      email: 'ops@stato.app',
      password: 'ops123',
      name: 'Ops Manager',
      role: 'ops_manager' as const,
      businessId: LEADGEN_BUSINESS_ID,
      clientId: null,
      isPrimaryOwner: false,
    },
    {
      id: SEED_USER_IDS.CLIENT,
      email: 'client@stato.app',
      password: 'client123',
      name: 'Client User',
      role: 'client' as const,
      businessId: null,
      clientId: DEMO_CLIENT_ID,
      isPrimaryOwner: false,
    },
    {
      id: SEED_USER_IDS.READONLY,
      email: 'readonly@stato.app',
      password: 'readonly123',
      name: 'Readonly User',
      role: 'readonly' as const,
      businessId: LEADGEN_BUSINESS_ID,
      clientId: null,
      isPrimaryOwner: false,
    },
  ];

  for (const u of seed) {
    const passwordHash = await bcryptjs.hash(u.password, 12);
    await db
      .insert(users)
      .values({
        id: u.id,
        email: u.email,
        passwordHash,
        name: u.name,
        role: u.role,
        businessId: u.businessId,
        clientId: u.clientId,
        isPrimaryOwner: u.isPrimaryOwner,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  logger.info({ count: seed.length }, 'Seeded default users (dev only)');
}

/** Backwards-compat helper — DB-backed lookup by email. */
export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row as User | undefined;
}

/** Backwards-compat helper — DB-backed lookup by id. */
export async function findUserById(id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row as User | undefined;
}
