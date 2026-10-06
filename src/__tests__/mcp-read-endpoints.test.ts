import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { apiKeys } from '../db/schema/api-keys.js';

// MCP spec v1.0 §2 discovery tools: whoami, and list_ad_accounts with its
// platform / clientId / linked / q filters, both on the public API (X-API-Key).
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACC_LINKED = `88${tag}1`;
const ACC_OTHER = `88${tag}2`;
let owner = '';
let clientId = '';
let readKey = '';
let noReadKey = '';
const keyIds: string[] = [];

async function makeKey(scopes: string[]): Promise<string> {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test read ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return res.body.data.key;
}

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = res.body.data.tokens.accessToken;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test Read ${tag}`, status: 'active' }).returning();
  clientId = c!.id;
  readKey = await makeKey(['clients:read']);
  noReadKey = await makeKey(['creatives:read']);
  await request(app).post(`/api/v1/clients/${clientId}/ad-accounts`).set('Authorization', `Bearer ${owner}`)
    .send({ platform: 'meta', accountId: `act_${ACC_LINKED}`, accountName: `Yash Linked ${tag}` }).expect(201);
});

afterAll(async () => {
  await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, clientId));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe('GET /whoami', () => {
  it('tells a key who it is, with its scopes and business', async () => {
    const res = await request(app).get('/api/v1/whoami').set('X-API-Key', readKey);
    expect(res.status).toBe(200);
    expect(res.body.data.authType).toBe('api_key');
    expect(res.body.data.key.scopes).toEqual(['clients:read']);
    expect(res.body.data.key.name).toBe(`Yash Test read ${tag}`);
    expect(res.body.data.business.id).toBe(BIZ);
    expect(res.body.data.rateLimit).toEqual({ limit: 120, windowSeconds: 60 });
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
  it('answers a key with any scope, and refuses a missing or bad key', async () => {
    expect((await request(app).get('/api/v1/whoami').set('X-API-Key', noReadKey)).status).toBe(200);
    expect((await request(app).get('/api/v1/whoami')).status).toBe(401);
    expect((await request(app).get('/api/v1/whoami').set('X-API-Key', 'stk_nope')).status).toBe(401);
  });
  it('answers a signed-in user without a key block', async () => {
    const res = await request(app).get('/api/v1/whoami').set('Authorization', `Bearer ${owner}`);
    expect(res.body.data.authType).toBe('user');
    expect(res.body.data.key).toBeNull();
  });
});

describe('GET /ad-accounts on the public API', () => {
  const list = (qs: string, key = readKey) => request(app).get(`/api/v1/ad-accounts${qs}`).set('X-API-Key', key);
  it('needs the clients:read scope', async () => {
    const res = await list('', noReadKey);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insufficient_scope');
  });
  it('filters by linked, client, platform and q (ID with or without act_, or name)', async () => {
    const all = await list('?linked=true');
    expect(all.status).toBe(200);
    const ids = (r: request.Response) => r.body.data.accounts.map((a: { accountId: string }) => a.accountId);
    expect(ids(all)).toContain(ACC_LINKED);
    expect(all.body.data.accounts.every((a: { link: unknown }) => a.link)).toBe(true);

    expect(ids(await list('?linked=false'))).not.toContain(ACC_LINKED);
    expect(ids(await list(`?clientId=${clientId}`))).toEqual([ACC_LINKED]);
    expect(ids(await list(`?clientId=${clientId}&platform=meta`))).toEqual([ACC_LINKED]);
    expect(ids(await list(`?clientId=${clientId}&platform=google`))).toEqual([]);
    expect(ids(await list(`?q=act_${ACC_LINKED}`))).toEqual([ACC_LINKED]);
    expect(ids(await list(`?q=${ACC_LINKED}`))).toEqual([ACC_LINKED]);
    expect(ids(await list(`?q=Yash%20Linked%20${tag}`))).toEqual([ACC_LINKED]);
    expect(ids(await list(`?q=${ACC_OTHER}`))).toEqual([]);
  });
  it('rejects a malformed filter', async () => {
    expect((await list('?linked=maybe')).status).toBe(400);
    expect((await list('?clientId=not-a-uuid')).status).toBe(400);
  });
  it('summary counts only the filtered accounts', async () => {
    const res = await list(`?clientId=${clientId}`);
    expect(res.body.data.summary).toMatchObject({ total: 1, linked: 1, unlinked: 0 });
  });
  it('the portal list still works for a signed-in owner', async () => {
    const res = await request(app).get('/api/v1/ad-accounts').set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(res.body.data.options.clients.length).toBeGreaterThan(0);
  });
});
