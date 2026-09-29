import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';
import { upsertPlatformCreative } from '../services/creative-library.service.js';

// A presigned r2 key is not bound to a business, so registering a key that
// another business's creative already holds would hand out a signed download
// URL for that business's file.

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `r2t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let otherBiz: string;
let mine: string;
let theirs: string;

beforeAll(async () => {
  const [b] = await db.insert(businesses).values({ name: `Yash Test Business ${tag}`, slug: tag } as never).returning();
  otherBiz = b!.id;
  const [a, c] = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test Mine ${tag}`, status: 'active' },
    { businessId: otherBiz, companyName: `Yash Test Theirs ${tag}`, status: 'active' },
  ]).returning();
  mine = a!.id; theirs = c!.id;
});

afterAll(async () => {
  await db.delete(creatives).where(inArray(creatives.clientId, [mine, theirs]));
  await db.delete(clients).where(inArray(clients.id, [mine, theirs]));
  await db.delete(businesses).where(eq(businesses.id, otherBiz));
});

const base = { platform: 'manual', mediaType: 'image' as const, contentType: 'image/png', sizeBytes: 10 };

describe('r2Key is not claimable across businesses', () => {
  it('refuses a key another business already holds, allows a fresh one and the owner re-registering', async () => {
    const key = `${tag}-secret.png`;
    await upsertPlatformCreative({ ...base, businessId: otherBiz, clientId: theirs, name: 'Theirs', r2Key: key } as never);
    await expect(
      upsertPlatformCreative({ ...base, businessId: BIZ, clientId: mine, name: 'Stolen', r2Key: key } as never),
    ).rejects.toMatchObject({ statusCode: 409 });
    const ok = await upsertPlatformCreative({ ...base, businessId: BIZ, clientId: mine, name: 'Mine', r2Key: `${tag}-mine.png` } as never);
    expect(ok.created).toBe(true);
  });
});
