import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { users } from '../db/schema/users.js';

// Public API (plan phase 2): API keys with scopes, Idempotency-Key, lookup by
// ad-account IDs, OpenAPI docs.

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `api-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let owner: string;
let ops: string;
let clientId: string;
const keyIds: string[] = [];

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken;
}
async function makeKey(scopes: string[], extra: Record<string, unknown> = {}): Promise<{ key: string; id: string }> {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test ${tag}`, scopes, ...extra });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key, id: res.body.data.apiKey.id };
}

beforeAll(async () => {
  [owner, ops] = await Promise.all([login('owner@stato.app', 'owner123'), login('ops@stato.app', 'ops123')]);
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test API client ${tag}`, status: 'active' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await db.delete(creatives).where(eq(creatives.clientId, clientId));
  await db.delete(landingPages).where(eq(landingPages.clientId, clientId));
  await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, clientId));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe('API key management', () => {
  it('owner creates a key that is shown once; lists never expose it', async () => {
    const { key, id } = await makeKey(['creatives:read']);
    expect(key).toMatch(/^stk_[A-Za-z0-9_-]{43}$/);
    const list = await request(app).get('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`);
    const row = list.body.data.apiKeys.find((k: { id: string }) => k.id === id);
    expect(row.scopes).toEqual(['creatives:read']);
    expect(JSON.stringify(list.body)).not.toContain(key);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(stored!.hash).not.toContain(key);
  });

  it('only the owner can manage keys', async () => {
    expect((await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${ops}`).send({ name: 'x', scopes: ['creatives:read'] })).status).toBe(403);
  });

  it('rejects unknown scopes', async () => {
    expect((await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: 'x', scopes: ['everything'] })).status).toBe(400);
  });
});

describe('X-API-Key auth and scopes', () => {
  it('a read-only key can list but not create (403 insufficient_scope)', async () => {
    const { key } = await makeKey(['creatives:read']);
    expect((await request(app).get('/api/v1/creatives').set('X-API-Key', key)).status).toBe(200);
    const res = await request(app).post('/api/v1/creatives').set('X-API-Key', key).send({ clientId, mediaType: 'image', r2Key: `${tag}-a.png`, contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insufficient_scope');
  });

  it('revoked, expired and made-up keys get 401', async () => {
    const { key, id } = await makeKey(['creatives:read']);
    expect((await request(app).delete(`/api/v1/api-keys/${id}`).set('Authorization', `Bearer ${owner}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/creatives').set('X-API-Key', key)).status).toBe(401);
    const expired = await makeKey(['creatives:read']);
    await db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, expired.id));
    expect((await request(app).get('/api/v1/creatives').set('X-API-Key', expired.key)).status).toBe(401);
    expect((await request(app).get('/api/v1/creatives').set('X-API-Key', 'stk_not-a-real-key')).status).toBe(401);
  });

  it('JWT-only routes refuse an API key', async () => {
    const { key } = await makeKey(['creatives:write', 'creatives:read']);
    expect((await request(app).get('/api/v1/ad-accounts/sync-status').set('X-API-Key', key)).status).toBe(401);
    expect((await request(app).post('/api/v1/creatives/bulk').set('X-API-Key', key).send({ action: 'submit_for_approval', ids: [] })).status).toBe(401);
  });

  it('every call is logged against the key', async () => {
    const { key, id } = await makeKey(['creatives:read']);
    await request(app).get('/api/v1/creatives?limit=1').set('X-API-Key', key);
    await new Promise((r) => setTimeout(r, 200));
    const usage = await request(app).get(`/api/v1/api-keys/${id}/usage`).set('Authorization', `Bearer ${owner}`);
    expect(usage.body.data.usage[0]).toMatchObject({ method: 'GET', path: '/api/v1/creatives', status: 200 });
    const list = await request(app).get('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`);
    expect(list.body.data.apiKeys.find((k: { id: string }) => k.id === id).usage30d).toBe(1);
  });
});

describe('ad account → client, by IDs', () => {
  it('links an account and looks the client up by platform + account id (never by name)', async () => {
    const writer = await makeKey(['ad_accounts:write']);
    const reader = await makeKey(['clients:read']);
    const link = await request(app).post(`/api/v1/clients/${clientId}/ad-accounts`).set('X-API-Key', writer.key)
      .send({ platform: 'taboola', accountId: `${tag}-willwriting-sc`, accountName: 'Hearing Aids Poland' });
    expect(link.status).toBe(201);
    const hit = await request(app).get(`/api/v1/clients/lookup?platform=taboola&accountId=${tag}-willwriting-sc`).set('X-API-Key', reader.key);
    expect(hit.status).toBe(200);
    expect(hit.body.data.client.id).toBe(clientId);
    const byName = await request(app).get(`/api/v1/clients/lookup?platform=taboola&accountId=${encodeURIComponent('Hearing Aids Poland')}`).set('X-API-Key', reader.key);
    expect(byName.status).toBe(404);
    // A clients:read key can't write links.
    expect((await request(app).post(`/api/v1/clients/${clientId}/ad-accounts`).set('X-API-Key', reader.key).send({ platform: 'meta', accountId: 'x' })).status).toBe(403);
  });
});

describe('Idempotency-Key', () => {
  it('replays the first response for a retry and refuses a different body', async () => {
    const { key } = await makeKey(['creatives:write', 'creatives:read']);
    const body = { clientId, mediaType: 'image', r2Key: `${tag}-idem.png`, contentType: 'image/png', name: 'Idem', platform: 'taboola', platformCreativeId: `${tag}-item-1` };
    const first = await request(app).post('/api/v1/creatives').set('X-API-Key', key).set('Idempotency-Key', `${tag}-k1`).send(body);
    const retry = await request(app).post('/api/v1/creatives').set('X-API-Key', key).set('Idempotency-Key', `${tag}-k1`).send(body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    const rows = await db.select().from(creatives).where(eq(creatives.platformCreativeId, `${tag}-item-1`));
    expect(rows).toHaveLength(1);
    const clash = await request(app).post('/api/v1/creatives').set('X-API-Key', key).set('Idempotency-Key', `${tag}-k1`).send({ ...body, name: 'Different' });
    expect(clash.status).toBe(422);
    expect(clash.body.code).toBe('idempotency_key_reused');
  });

  it('landing pages and attach work with a key', async () => {
    const { key } = await makeKey(['creatives:write', 'landing_pages:write']);
    const lp = await request(app).post('/api/v1/landing-pages').set('X-API-Key', key).send({ clientId, url: 'https://lp.example.com/api?utm_source=x' });
    expect(lp.status).toBe(201);
    const [row] = await db.select().from(creatives).where(eq(creatives.platformCreativeId, `${tag}-item-1`));
    const att = await request(app).post(`/api/v1/creatives/${row!.id}/landing-page`).set('X-API-Key', key).send({ landingPageId: lp.body.data.landingPage.id });
    expect(att.status).toBe(200);
    expect(att.body.data.creative.landingPage.id).toBe(lp.body.data.landingPage.id);
  });
});

describe('published docs', () => {
  it('GET /openapi.json is public and documents the key-authenticated endpoints', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.components.securitySchemes.ApiKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/clients/lookup', '/clients/{id}/ad-accounts', '/creatives', '/creatives/{id}/landing-page', '/landing-pages']));
    const body = res.body.paths['/creatives'].post.requestBody.content['application/json'].schema;
    expect(JSON.stringify(body)).toContain('platformCreativeId');
  });

  it('GET /docs serves the reference page with a CSP that allows its script', async () => {
    const res = await request(app).get('/api/v1/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/api/v1/openapi.json');
    expect(res.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
  });
});

describe('review fixes', () => {
  it('a key stops working when the user who created it is deactivated', async () => {
    const { key, id } = await makeKey(['creatives:read']);
    const [opsUser] = await db.select().from(users).where(eq(users.email, 'ops@stato.app'));
    await db.update(apiKeys).set({ createdBy: opsUser!.id }).where(eq(apiKeys.id, id));
    try {
      expect((await request(app).get('/api/v1/creatives').set('X-API-Key', key)).status).toBe(200);
      await db.update(users).set({ isActive: false }).where(eq(users.id, opsUser!.id));
      expect((await request(app).get('/api/v1/creatives').set('X-API-Key', key)).status).toBe(401);
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.id, opsUser!.id));
    }
  });

  it('a rejected (4xx) request is not stored against its Idempotency-Key', async () => {
    const { key } = await makeKey(['creatives:write']);
    const bad = await request(app).post('/api/v1/creatives').set('X-API-Key', key).set('Idempotency-Key', `${tag}-fix4xx`).send({ clientId, mediaType: 'image' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const good = await request(app).post('/api/v1/creatives').set('X-API-Key', key).set('Idempotency-Key', `${tag}-fix4xx`)
      .send({ clientId, mediaType: 'image', r2Key: `${tag}-fix.png`, contentType: 'image/png', sizeBytes: 10, name: 'Fixed body' });
    expect(good.status).toBe(201);
  });
});
