import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { apiKeys, apiKeyUsage, type ApiKeyRow } from '../db/schema/api-keys.js';
import { AppError } from '../utils/errors.js';

// Public API keys (plan phase 2). Keys look like `stk_<43 base64url chars>`;
// only their SHA-256 is stored. Every key is limited to the scopes below.
export const API_SCOPES = ['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'landing_pages:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const KEY_MARKER = 'stk_';
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  /** Calls logged in the last 30 days (Settings → API keys). */
  usage30d: number;
}

const dto = (r: ApiKeyRow, usage30d = 0): ApiKeyDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
  createdAt: r.createdAt?.toISOString() ?? null,
  usage30d,
});

export async function createApiKey(
  businessId: string, createdBy: string | null, input: { name: string; scopes: ApiScope[]; expiresAt?: string | null },
): Promise<{ key: string; apiKey: ApiKeyDto }> {
  const secret = randomBytes(32).toString('base64url');
  const key = `${KEY_MARKER}${secret}`;
  const [row] = await db.insert(apiKeys).values({
    businessId,
    name: input.name,
    prefix: secret.slice(0, 8),
    hash: hashKey(key),
    scopes: [...new Set(input.scopes)],
    createdBy,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  }).returning();
  return { key, apiKey: dto(row!) };
}

export async function listApiKeys(businessId: string): Promise<ApiKeyDto[]> {
  const rows = await db
    .select({
      k: apiKeys,
      n: sql<number>`(select count(*)::int from api_key_usage u where u.api_key_id = "api_keys"."id" and u.at > now() - interval '30 days')`,
    })
    .from(apiKeys).where(eq(apiKeys.businessId, businessId)).orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => dto(r.k, r.n));
}

export async function revokeApiKey(businessId: string, id: string): Promise<void> {
  const [row] = await db.update(apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.businessId, businessId), isNull(apiKeys.revokedAt))).returning();
  if (!row) {
    const [exists] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.businessId, businessId)));
    if (!exists) throw new AppError(404, 'API key not found');
  }
}

/** Returns the live key row, or null for unknown / revoked / expired keys. */
export async function verifyApiKey(key: string): Promise<ApiKeyRow | null> {
  if (!key.startsWith(KEY_MARKER) || key.length > 200) return null;
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hashKey(key)));
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // A key acts as the person who made it: deactivating that user switches the key off too.
  if (row.createdBy) {
    const [creator] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, row.createdBy));
    if (!creator?.isActive) return null;
  }
  // Throttled: at most one write a minute per key.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
  }
  return row;
}

export function logApiKeyUse(apiKeyId: string, method: string, path: string, status: number): void {
  void db.insert(apiKeyUsage).values({ apiKeyId, method: method.slice(0, 8), path: path.slice(0, 300), status }).catch(() => {});
}

export async function listApiKeyUsage(businessId: string, id: string, limit = 100) {
  const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.businessId, businessId)));
  if (!key) throw new AppError(404, 'API key not found');
  const rows = await db.select().from(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, id)).orderBy(desc(apiKeyUsage.at)).limit(limit);
  return rows.map((r) => ({ method: r.method, path: r.path, status: r.status, at: r.at?.toISOString() ?? null }));
}
