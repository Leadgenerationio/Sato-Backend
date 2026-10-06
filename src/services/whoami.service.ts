import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { businesses } from '../db/schema/businesses.js';
import { users } from '../db/schema/users.js';

export interface CallerInfo {
  authType: 'api_key';
  key: { id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null };
  owner: { name: string } | null;
  business: { id: string; name: string } | null;
  rateLimit: { limit: number; windowSeconds: number };
}

/** Which key, owner and business a connection is using (MCP spec `whoami`). */
export async function describeApiKeyCaller(apiKeyId: string, businessId: string): Promise<CallerInfo | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1);
  if (!row) return null;
  const [business] = await db.select({ id: businesses.id, name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  let owner: { name: string } | null = null;
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)).limit(1);
    owner = u ?? null;
  }
  return {
    authType: 'api_key',
    key: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    },
    owner,
    business: business ?? null,
    rateLimit: { limit: 120, windowSeconds: 60 },
  };
}
