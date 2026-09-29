import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '../config/database.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';
import { purgeApiHousekeeping } from '../services/retention.service.js';

const owner = `hk-${Date.now()}`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe('purgeApiHousekeeping', () => {
  afterAll(async () => { await db.delete(idempotencyKeys).where(like(idempotencyKeys.owner, `${owner}%`)); });

  it('deletes idempotency rows older than 24 h and keeps newer ones', async () => {
    const row = (key: string, createdAt: Date) => ({ owner, key, requestHash: 'c'.repeat(64), status: 201, response: {}, createdAt });
    await db.insert(idempotencyKeys).values([row('old', hoursAgo(30)), row('fresh', hoursAgo(2))]);
    await purgeApiHousekeeping();
    const left = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.owner, owner));
    expect(left.map((r) => r.key)).toEqual(['fresh']);
  });
});
