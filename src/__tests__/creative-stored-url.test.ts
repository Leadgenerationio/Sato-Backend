import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { stripPresignedQuery } from '../integrations/r2/r2-client.js';

// N8 (Sam feedback round 1, 29 Sep 2026): "Saved creatives carry an expired
// download link from May." The upload-time presigned URL must never be
// persisted; the API mints a fresh one on every read.

const tag = `n8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const PRESIGNED =
  'http://localhost:9000/stato-test/creatives/1717000000000-ad.png' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20260520%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260520T100000Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host';

describe('stripPresignedQuery', () => {
  it('drops the X-Amz signing query but keeps the object path', () => {
    expect(stripPresignedQuery(PRESIGNED)).toBe('http://localhost:9000/stato-test/creatives/1717000000000-ad.png');
  });
  it('leaves ordinary URLs (landing pages with their own query) untouched', () => {
    expect(stripPresignedQuery('https://example.com/lp?utm_source=meta')).toBe('https://example.com/lp?utm_source=meta');
  });
  it('leaves non-URLs untouched', () => {
    expect(stripPresignedQuery('creatives/static-a.jpg')).toBe('creatives/static-a.jpg');
  });
});

describe('creatives never persist a presigned URL (N8)', () => {
  let ownerToken: string;
  const campaignIds: string[] = [];

  beforeAll(async () => {
    await db.insert(clients).values({
      id: DEMO_CLIENT_ID, businessId: LEADGEN_BUSINESS_ID, companyName: 'Apex Media Ltd',
      contactEmail: 'contact@apex.test', currency: 'GBP', status: 'active',
    }).onConflictDoNothing();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;
    const [c] = await db.insert(campaigns).values({ name: `N8 ${tag}`, vertical: 'Test', status: 'active', clientId: DEMO_CLIENT_ID }).returning();
    campaignIds.push(c.id);
  });

  afterAll(async () => {
    await db.delete(creatives).where(inArray(creatives.campaignId, campaignIds));
    await db.delete(campaigns).where(inArray(campaigns.id, campaignIds));
  });

  it('stores the stable object URL and serves a fresh signed URL on read', async () => {
    const create = await request(app)
      .post('/api/v1/creatives')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        campaignId: campaignIds[0], name: `ad-${tag}`, type: 'image',
        r2Key: '1717000000000-ad.png', fileUrl: PRESIGNED,
        sizeBytes: 1024, contentType: 'image/png', section: 'media',
      });
    expect(create.status).toBe(201);
    const id = create.body.data.creative.id as string;

    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.fileUrl).toBe('http://localhost:9000/stato-test/creatives/1717000000000-ad.png');
    expect(row.fileUrl).not.toMatch(/X-Amz-/);

    const signed = await request(app)
      .get(`/api/v1/creatives/${id}/signed-url`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(signed.status).toBe(200);
    const url = new URL(JSON.stringify(signed.body.data).match(/https?:\/\/[^"]+/)![0]);
    // Still resolves to the same folder/key, freshly signed (not the stored May signature).
    expect(url.pathname).toContain('/creatives/1717000000000-ad.png');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe('deadbeef');
  });
});
