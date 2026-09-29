import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';

// The browser's sha256 is a hint: for an uploaded file (r2Key) the server
// hashes the stored object and trusts only that.
const SERVER_HASH = 'a'.repeat(64);
vi.mock('../integrations/r2/r2-client.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/r2/r2-client.js')>()),
  hashObject: vi.fn(async () => SERVER_HASH),
}));

import { upsertPlatformCreative } from '../services/creative-library.service.js';

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `hash-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('r2Key uploads are hashed by the server', () => {
  let clientId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const [c] = await db.insert(clients).values({
      businessId: LEADGEN_BUSINESS_ID, companyName: `Hash ${tag}`, contactEmail: `${tag}@x.test`, currency: 'GBP', status: 'active',
    }).returning();
    clientId = c!.id;
  });

  afterAll(async () => {
    for (const id of created) await db.delete(creatives).where(eq(creatives.id, id));
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  const base = () => ({
    businessId: LEADGEN_BUSINESS_ID, clientId, platform: 'manual' as const, mediaType: 'image' as const,
    r2Key: `${tag}-${Math.random()}.png`, contentType: 'image/png', sizeBytes: 10,
  });

  it('rejects a client hash that does not match the stored file', async () => {
    await expect(upsertPlatformCreative({ ...base(), sha256: 'b'.repeat(64) }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('stores the server hash, and dedupes a second upload of the same bytes', async () => {
    const first = await upsertPlatformCreative({ ...base(), sha256: SERVER_HASH });
    created.push(first.creative.id);
    expect(first.created).toBe(true);
    expect(first.creative.sha256).toBe(SERVER_HASH);

    // No client hash sent at all: still recognised as the same file.
    const second = await upsertPlatformCreative({ ...base() });
    expect(second.created).toBe(false);
    expect(second.creative.id).toBe(first.creative.id);
  });
});
