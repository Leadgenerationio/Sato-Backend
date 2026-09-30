import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';

// Retest R2-1: creatives whose stored file is gone from storage signed a link
// that answered R2's NoSuchKey XML. The detail endpoint must say so instead.
const exists = vi.hoisted(() => ({ value: false }));
vi.mock('../integrations/r2/r2-client.js', async (orig) => {
  const real = await orig<typeof import('../integrations/r2/r2-client.js')>();
  return { ...real, objectExists: vi.fn(async () => exists.value), isR2Configured: () => true };
});

import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let token = ''; let clientId = ''; let creativeId = ''; let campaignId = '';

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  token = res.body.data.tokens.accessToken;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test Missing File ${Date.now()}`, status: 'active' }).returning();
  clientId = c!.id;
  const [cr] = await db.insert(creatives).values({
    clientId, name: 'Yash Missing File', type: 'image', fileUrl: 'creatives/gone/ad.png', r2Key: 'gone/ad.png', contentType: 'image/png',
  }).returning();
  creativeId = cr!.id;
  const [camp] = await db.insert(campaigns).values({ name: `Yash Test Missing File ${Date.now()}`, vertical: 'Test', status: 'active', clientId }).returning();
  campaignId = camp!.id;
});

afterAll(async () => {
  await db.delete(creatives).where(eq(creatives.campaignId, campaignId));
  await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  await db.delete(creatives).where(eq(creatives.id, creativeId));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe('creative detail when the stored file is gone', () => {
  it('flags fileMissing and hands out no dead link', async () => {
    exists.value = false;
    const res = await request(app).get(`/api/v1/creatives/${creativeId}`).set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data.creative.fileMissing).toBe(true);
    expect(res.body.data.creative.fileUrl).toBeNull();
  });

  it('still signs a link when the file is there', async () => {
    exists.value = true;
    const res = await request(app).get(`/api/v1/creatives/${creativeId}`).set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data.creative.fileMissing).toBe(false);
    expect(typeof res.body.data.creative.fileUrl).toBe('string');
  });
});

describe('creative create when the browser upload never landed (R2-1 root cause)', () => {
  const body = () => ({ campaignId, name: 'Yash Ghost', type: 'image', fileUrl: 'http://localhost:9000/stato-test/creatives/ghost.png', r2Key: 'ghost.png', sizeBytes: 10, contentType: 'image/png' });

  it('refuses with a plain message and saves no row', async () => {
    exists.value = false;
    const res = await request(app).post('/api/v1/creatives').set({ Authorization: `Bearer ${token}` }).send(body());
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/didn't finish uploading/);
    const rows = await db.select().from(creatives).where(eq(creatives.campaignId, campaignId));
    expect(rows).toHaveLength(0);
  });

  it('saves the row when the file is there', async () => {
    exists.value = true;
    const res = await request(app).post('/api/v1/creatives').set({ Authorization: `Bearer ${token}` }).send(body());
    expect(res.status).toBe(201);
  });
});

describe('Settings → Clean up lists and hides creatives with no file', () => {
  it('flags the ghost row, then hides it (row kept, is_deleted)', async () => {
    exists.value = false;
    const auth = { Authorization: `Bearer ${token}` };
    const report = await request(app).get('/api/v1/admin/cleanup').set(auth);
    expect(report.status).toBe(200);
    const flagged = report.body.data.creativesMissingFile.find((r: { id: string }) => r.id === creativeId);
    expect(flagged).toBeDefined();

    const apply = await request(app).post('/api/v1/admin/cleanup/apply').set(auth).send({ hideCreativeIds: [creativeId] });
    expect(apply.status).toBe(200);
    expect(apply.body.data.hiddenCreatives).toBe(1);
    const [row] = await db.select().from(creatives).where(eq(creatives.id, creativeId));
    expect(row?.isDeleted).toBe(true);
  });
});
