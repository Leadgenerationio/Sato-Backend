import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { businesses } from '../db/schema/businesses.js';
import { users } from '../db/schema/users.js';
import { clients } from '../db/schema/clients.js';

export interface CallerInfo {
  authType: 'api_key';
  key: {
    id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null;
    /** The clients this key is limited to, or null for every client in the business. */
    allowedClients: Array<{ clientId: string; name: string }> | null;
    agentLabel: string | null;
  };
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
  const allowedClients = row.allowedClientIds
    ? row.allowedClientIds.length === 0 ? [] : await db.select({ clientId: clients.id, name: clients.companyName }).from(clients)
        .where(and(inArray(clients.id, row.allowedClientIds), eq(clients.businessId, businessId))).orderBy(asc(clients.companyName))
    : null;
  return {
    authType: 'api_key',
    key: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      allowedClients,
      agentLabel: row.agentLabel ?? null,
    },
    owner,
    business: business ?? null,
    rateLimit: { limit: 120, windowSeconds: 60 },
  };
}
