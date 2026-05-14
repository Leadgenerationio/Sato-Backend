import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { bankTransactions, costCategories } from '../db/schema/bank-feed.js';
import { and, eq } from 'drizzle-orm';

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;
let txId: string;
let advertisingCatId: string;

describe('Bank-feed categorize — backend persistence end-to-end', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;

    // Ensure the default Advertising category exists so we can categorize against it.
    await request(app)
      .get('/api/v1/finance/bank-feed/categories')
      .set('Authorization', `Bearer ${ownerToken}`);
    const [adCat] = await db
      .select()
      .from(costCategories)
      .where(
        and(
          eq(costCategories.businessId, LEADGEN_BUSINESS_ID),
          eq(costCategories.name, 'Advertising'),
        ),
      );
    if (!adCat) throw new Error('Advertising category was not seeded');
    advertisingCatId = adCat.id;

    // Seed a known bank transaction we can categorize without depending on Xero data.
    const [inserted] = await db
      .insert(bankTransactions)
      .values({
        businessId: LEADGEN_BUSINESS_ID,
        xeroBankTransactionId: `test-tx-${Date.now()}`,
        date: '2026-05-14',
        amount: '-50.00',
        currency: 'GBP',
        vendorName: 'Test Facebook Ads',
        description: 'integration test',
      })
      .returning();
    if (!inserted) throw new Error('Failed to insert test bank transaction');
    txId = inserted.id;
  });

  afterAll(async () => {
    if (txId) {
      await db.delete(bankTransactions).where(eq(bankTransactions.id, txId));
    }
  });

  it('PATCH /transactions/:id/category persists the categoryId so the next list call reflects it', async () => {
    // 1. Confirm baseline: tx is in the uncategorized list.
    const before = await request(app)
      .get('/api/v1/finance/bank-feed/transactions?uncategorized=true&limit=100')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);
    const beforeIds = (before.body.data.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(beforeIds).toContain(txId);

    // 2. Categorize it.
    const patchRes = await request(app)
      .patch(`/api/v1/finance/bank-feed/transactions/${txId}/category`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId: advertisingCatId, learnRule: false, applyRetroactively: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('success');

    // 3. The same uncategorized list call should now NOT contain this tx.
    const afterUncat = await request(app)
      .get('/api/v1/finance/bank-feed/transactions?uncategorized=true&limit=100')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterUncat.status).toBe(200);
    const afterUncatIds = (afterUncat.body.data.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(afterUncatIds).not.toContain(txId);

    // 4. The advertising-filtered list should contain it.
    const afterFiltered = await request(app)
      .get(`/api/v1/finance/bank-feed/transactions?categoryId=${advertisingCatId}&limit=100`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterFiltered.status).toBe(200);
    const afterFilteredIds = (afterFiltered.body.data.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(afterFilteredIds).toContain(txId);

    // 5. The advertising-bucket list should also contain it.
    const afterBucket = await request(app)
      .get('/api/v1/finance/bank-feed/transactions?bucket=advertising&limit=100')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterBucket.status).toBe(200);
    const afterBucketIds = (afterBucket.body.data.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(afterBucketIds).toContain(txId);
  });

  it('PATCH with categoryId=null re-uncategorizes the tx (round-trip)', async () => {
    // Set back to uncategorized.
    const patchRes = await request(app)
      .patch(`/api/v1/finance/bank-feed/transactions/${txId}/category`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categoryId: null });
    expect(patchRes.status).toBe(200);

    const after = await request(app)
      .get('/api/v1/finance/bank-feed/transactions?uncategorized=true&limit=100')
      .set('Authorization', `Bearer ${ownerToken}`);
    const afterIds = (after.body.data.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(afterIds).toContain(txId);
  });
});
