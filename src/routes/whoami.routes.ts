import { Router, type Router as RouterType } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { businesses } from '../db/schema/businesses.js';
import { users } from '../db/schema/users.js';
import { apiKeyOrJwt, apiKeyRateLimit } from '../middleware/api-key.middleware.js';

// MCP spec v1.0 §2 `whoami`: which key, business and scopes a connection is
// using, so a bot can check it is pointed at the right place before it writes.
// Needs no scope: any valid key may ask what it is. JWT callers get the same
// business block without a key block.
export const whoamiRoutes: RouterType = Router();

whoamiRoutes.get('/', apiKeyOrJwt, apiKeyRateLimit, async (req, res) => {
  const user = req.user!;
  const [business] = user.businessId
    ? await db.select({ id: businesses.id, name: businesses.name }).from(businesses).where(eq(businesses.id, user.businessId)).limit(1)
    : [];

  let key: Record<string, unknown> | null = null;
  let owner: { name: string } | null = null;
  if (req.apiKey) {
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, req.apiKey.id)).limit(1);
    if (row) {
      key = {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      };
      if (row.createdBy) {
        const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)).limit(1);
        owner = u ?? null;
      }
    }
  }

  // Per-key limit; the live count is in the RateLimit-Remaining response header.
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'success',
    data: {
      authType: req.apiKey ? 'api_key' : 'user',
      key,
      owner,
      business: business ?? null,
      rateLimit: req.apiKey ? { limit: 120, windowSeconds: 60 } : null,
    },
  });
});
