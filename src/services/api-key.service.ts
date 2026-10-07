import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { clients } from '../db/schema/clients.js';
import { apiKeys, apiKeyUsage, idempotencyKeys, type ApiKeyRow } from '../db/schema/api-keys.js';
import { AppError } from '../utils/errors.js';

// Public API keys (plan phase 2). Keys look like `stk_<43 base64url chars>`;
// only their SHA-256 is stored. Every key is limited to the scopes below.
// The first five are the original public API; the rest were added for the MCP
// connector (spec v1.0 §3). Scopes are only ever added, never renamed, so
// existing keys keep working.
export const API_SCOPES = [
  'clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'landing_pages:write',
  'campaigns:read', 'ad_accounts:read', 'uploads:write', 'ad_links:write', 'creatives:archive',
] as const;
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
  /** The clients this key is limited to, or null for every client in the business (MCP spec §3, step 1h). */
  allowedClientIds: string[] | null;
  /** The same clients with their names, for the keys screen (a client deleted since is left out). */
  allowedClients: Array<{ id: string; name: string }> | null;
  /** Bot name used in the activity log when a call sends no X-Stato-Agent header. */
  agentLabel: string | null;
  /** Calls logged in the last 30 days (Settings → API keys). */
  usage30d: number;
}

/** Names of every client any of these keys is limited to, in one query. */
async function clientNames(businessId: string, rows: ApiKeyRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => r.allowedClientIds ?? []))];
  if (!ids.length) return new Map();
  const found = await db.select({ id: clients.id, name: clients.companyName }).from(clients).where(and(inArray(clients.id, ids), eq(clients.businessId, businessId)));
  return new Map(found.map((c) => [c.id, c.name]));
}

const dto = (r: ApiKeyRow, usage30d = 0, names: Map<string, string> = new Map()): ApiKeyDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
  createdAt: r.createdAt?.toISOString() ?? null,
  allowedClientIds: r.allowedClientIds ?? null,
  allowedClients: r.allowedClientIds ? r.allowedClientIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })) : null,
  agentLabel: r.agentLabel ?? null,
  usage30d,
});

export interface KeyLimits {
  /** null or absent = every client in the business. At least one client when given. */
  allowedClientIds?: string[] | null;
  agentLabel?: string | null;
}

/** Every listed client must be in this business, so a key can never be pointed at another business's client. */
async function checkClientsInBusiness(businessId: string, ids: string[] | null | undefined): Promise<string[] | null> {
  if (!ids) return null;
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new AppError(422, 'allowedClientIds needs at least one client; send null for every client');
  const found = await db.select({ id: clients.id }).from(clients).where(and(inArray(clients.id, unique), eq(clients.businessId, businessId)));
  if (found.length !== unique.length) throw new AppError(422, 'allowedClientIds lists a client that is not in this business');
  return unique;
}

export async function createApiKey(
  businessId: string, createdBy: string | null, input: { name: string; scopes: ApiScope[]; expiresAt?: string | null } & KeyLimits,
): Promise<{ key: string; apiKey: ApiKeyDto }> {
  const allowedClientIds = await checkClientsInBusiness(businessId, input.allowedClientIds);
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
    allowedClientIds,
    agentLabel: input.agentLabel?.trim() || null,
  }).returning();
  return { key, apiKey: dto(row!, 0, await clientNames(businessId, [row!])) };
}

/** Change a key's client limit or agent label. Takes effect on the key's next call. A revoked key cannot be changed. */
export async function updateApiKeyLimits(businessId: string, id: string, input: KeyLimits): Promise<ApiKeyDto> {
  const set: Partial<typeof apiKeys.$inferInsert> = {};
  if (input.allowedClientIds !== undefined) set.allowedClientIds = await checkClientsInBusiness(businessId, input.allowedClientIds);
  if (input.agentLabel !== undefined) set.agentLabel = input.agentLabel?.trim() || null;
  const where = and(eq(apiKeys.id, id), eq(apiKeys.businessId, businessId), isNull(apiKeys.revokedAt));
  const [row] = Object.keys(set).length
    ? await db.update(apiKeys).set(set).where(where).returning()
    : await db.select().from(apiKeys).where(where);
  if (!row) throw new AppError(404, 'API key not found');
  // A stored idempotencyKey answer may name a client the key can no longer see: replays must not outlive a change of limit (issue #94).
  if (set.allowedClientIds !== undefined) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.owner, [`mcp:key:${row.id}`, `key:${row.id}`]));
  }
  return dto(row, 0, await clientNames(businessId, [row]));
}

export async function listApiKeys(businessId: string): Promise<ApiKeyDto[]> {
  const rows = await db
    .select({
      k: apiKeys,
      n: sql<number>`(select count(*)::int from api_key_usage u where u.api_key_id = "api_keys"."id" and u.at > now() - interval '30 days')`,
    })
    .from(apiKeys).where(eq(apiKeys.businessId, businessId)).orderBy(desc(apiKeys.createdAt));
  const names = await clientNames(businessId, rows.map((r) => r.k));
  return rows.map((r) => dto(r.k, r.n, names));
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
