import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { costCategories } from '../db/schema/bank-feed.js';
import { and, eq } from 'drizzle-orm';

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;

async function clearDefaultAdvertisingCategory() {
  await db
    .delete(costCategories)
    .where(
      and(
        eq(costCategories.businessId, LEADGEN_BUSINESS_ID),
        eq(costCategories.bucket, 'advertising'),
        eq(costCategories.name, 'Advertising'),
      ),
    );
}

describe('Bank-feed categories — default Advertising seed', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;
  });

  it('listCategories seeds a default Advertising (advertising bucket) category when none exists', async () => {
    await clearDefaultAdvertisingCategory();

    const res = await request(app)
      .get('/api/v1/finance/bank-feed/categories')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const cats: Array<{ name: string; bucket: string }> = res.body.data.categories;
    const advertising = cats.filter((c) => c.bucket === 'advertising' && c.name === 'Advertising');
    expect(advertising).toHaveLength(1);
  });

  it('listCategories is idempotent — calling it twice does not duplicate the default Advertising row', async () => {
    await clearDefaultAdvertisingCategory();

    await request(app)
      .get('/api/v1/finance/bank-feed/categories')
      .set('Authorization', `Bearer ${ownerToken}`);
    const res = await request(app)
      .get('/api/v1/finance/bank-feed/categories')
      .set('Authorization', `Bearer ${ownerToken}`);

    const cats: Array<{ name: string; bucket: string }> = res.body.data.categories;
    const advertising = cats.filter((c) => c.bucket === 'advertising' && c.name === 'Advertising');
    expect(advertising).toHaveLength(1);
  });

  it('POST /categories accepts bucket=advertising (validation schema includes it)', async () => {
    const name = `Test Ads ${Date.now()}`;
    const res = await request(app)
      .post('/api/v1/finance/bank-feed/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name, bucket: 'advertising' });

    expect(res.status).toBe(201);
    expect(res.body.data.category.bucket).toBe('advertising');
    expect(res.body.data.category.name).toBe(name);

    await db.delete(costCategories).where(eq(costCategories.id, res.body.data.category.id));
  });
});
