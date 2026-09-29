import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';

// The browser's sha256 is a hint: for an uploaded file (r2Key) the server
// hashes the stored object and trusts only that.
const SERVER_HASH = 'a'.repeat(64);
const hashObject = vi.fn();
const isR2Configured = vi.fn(() => true);
const deleteFile = vi.fn(async () => {});
vi.mock('../integrations/r2/r2-client.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/r2/r2-client.js')>()),
  hashObject: (...a: unknown[]) => hashObject(...a),
  isR2Configured: () => isR2Configured(),
  deleteFile: (...a: unknown[]) => deleteFile(...a),
}));

import { ObjectTooLargeError } from '../integrations/r2/r2-client.js';
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

  beforeEach(() => {
    hashObject.mockReset();
    deleteFile.mockClear();
    hashObject.mockResolvedValue({ sha256: SERVER_HASH, sizeBytes: 1234, contentType: 'image/png' });
    isR2Configured.mockReturnValue(true);
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
    expect(first.creative.sizeBytes).toBe(1234); // real size, not the client's claim

    // No client hash sent at all: still recognised as the same file.
    const second = await upsertPlatformCreative({ ...base() });
    expect(second.created).toBe(false);
    expect(second.creative.id).toBe(first.creative.id);
  });

  it('keeps the existing file when identical bytes are uploaded again under a new key', async () => {
    const one = { ...base(), sha256: SERVER_HASH };
    const first = await upsertPlatformCreative(one);
    created.push(first.creative.id);
    const dup = await upsertPlatformCreative({ ...base(), sha256: SERVER_HASH });
    expect(dup.creative.id).toBe(first.creative.id);
    expect(dup.creative.r2Key).toBe(first.creative.r2Key);
    expect(deleteFile).toHaveBeenCalledTimes(1); // the duplicate object is cleaned up, not orphaned
  });

  it('maps an oversize object to 413 and any other storage failure to 502', async () => {
    hashObject.mockRejectedValueOnce(new ObjectTooLargeError(50));
    await expect(upsertPlatformCreative(base())).rejects.toMatchObject({ statusCode: 413 });
    hashObject.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(upsertPlatformCreative(base())).rejects.toMatchObject({ statusCode: 502 });
  });

  it('rejects an r2Key that is not in storage (422) when R2 is configured', async () => {
    hashObject.mockResolvedValueOnce(null);
    await expect(upsertPlatformCreative({ ...base(), sha256: SERVER_HASH })).rejects.toMatchObject({ statusCode: 422 });
  });
});
