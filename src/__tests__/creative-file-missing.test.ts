import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';

// Retest R2-1: creatives whose stored file is gone from storage signed a link
// that answered R2's NoSuchKey XML. The detail endpoint must say so instead.
const exists = vi.hoisted(() => ({ value: false }));
vi.mock('../integrations/r2/r2-client.js', async (orig) => {
  const real = await orig<typeof import('../integrations/r2/r2-client.js')>();
  return { ...real, objectExists: vi.fn(async () => exists.value) };
});

import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let token = ''; let clientId = ''; let creativeId = '';

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  token = res.body.data.tokens.accessToken;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test Missing File ${Date.now()}`, status: 'active' }).returning();
  clientId = c!.id;
  const [cr] = await db.insert(creatives).values({
    clientId, name: 'Yash Missing File', type: 'image', fileUrl: 'creatives/gone/ad.png', r2Key: 'gone/ad.png', contentType: 'image/png',
  }).returning();
  creativeId = cr!.id;
});

afterAll(async () => {
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
