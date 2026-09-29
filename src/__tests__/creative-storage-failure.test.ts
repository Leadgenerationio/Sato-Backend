import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// Storage down used to surface as a bare 500 "Internal server error".
vi.mock('../integrations/r2/r2-client.js', async (orig) => {
  const real = await orig<typeof import('../integrations/r2/r2-client.js')>();
  return { ...real, uploadFile: vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9000'); }) };
});

import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let token = ''; let clientId = '';

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  token = res.body.data.tokens.accessToken;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test Storage ${Date.now()}`, status: 'active' }).returning();
  clientId = c!.id;
});

describe('creative upload when storage is down', () => {
  it('answers 502 with a plain message saying nothing was saved', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }));
    try {
      const res = await request(app).post('/api/v1/creatives').set({ Authorization: `Bearer ${token}` })
        .send({ clientId, mediaType: 'image', sourceUrl: 'https://93.184.216.34/ad.png', name: 'Storage down' });
      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/nothing was saved/);
    } finally { spy.mockRestore(); }
  });
});
