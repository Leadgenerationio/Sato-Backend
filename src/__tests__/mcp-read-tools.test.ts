import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray, sql } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { apiKeys } from '../db/schema/api-keys.js';

// MCP spec v1.0 test 2 (the data side): list_clients, get_client, list_campaigns, get_campaign.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = ''; let noScopeKey = '';
let otherBiz = ''; let cA = ''; let cB = ''; let cC = ''; let cOther = '';
let k1 = ''; let k2 = ''; let kShared = ''; let kOther = '';
const lb1 = `lb1${tag}`;
const keyIds: string[] = [];

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test rd ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return res.body.data.key as string;
}
async function call(k: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  key = await makeKey(['clients:read']);
  noScopeKey = await makeKey(['creatives:read']);
  const [b2] = await db.insert(businesses).values({ name: `Yash Test Other ${tag}`, slug: `yash-other-${tag}` }).returning();
  otherBiz = b2!.id;
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash RD Alpha ${tag}`, status: 'active', currency: 'GBP', addressCountry: 'UK' },
    { businessId: BIZ, companyName: `Yash RD Beta ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash RD Gamma ${tag}`, status: 'paused' },
    { businessId: otherBiz, companyName: `Yash RD Alpha OTHER ${tag}`, status: 'active' },
  ]).returning();
  [cA, cB, cC, cOther] = cs.map((c) => c.id) as [string, string, string, string];
  const camps = await db.insert(campaigns).values([
    { name: `Yash RD Solar ${tag}`, leadbyteCampaignId: lb1, vertical: 'Solar', status: 'Active' },
    { name: `Yash RD Insulation ${tag}`, vertical: 'Insulation', status: 'Active' },
    { name: `Yash RD Shared ${tag}`, vertical: 'Shared', status: 'Active' },
    { name: `Yash RD OtherOnly ${tag}`, status: 'Active' },
  ]).returning();
  [k1, k2, kShared, kOther] = camps.map((c) => c.id) as [string, string, string, string];
  await db.insert(clientCampaigns).values([
    { clientId: cA, campaignId: k1 }, { clientId: cA, campaignId: k2 }, { clientId: cB, campaignId: k1 }, { clientId: cOther, campaignId: kOther },
  ]);
  await db.insert(clientAdAccounts).values([
    { businessId: BIZ, platform: 'facebook-ads', accountId: `${tag}1`, accountName: 'Alpha Meta', clientId: cA, campaignId: k1 },
    { businessId: BIZ, platform: 'google-ads', accountId: `${tag}2`, clientId: cA },
  ]);
  await db.insert(trafficSources).values({ campaignId: k1, name: `Yash RD src ${tag}`, platform: 'facebook-ads', accountId: `${tag}1` });
  await db.insert(creatives).values([
    { name: `Yash RD cr1 ${tag}`, fileUrl: 'x', clientId: cA, campaignId: k1 },
    { name: `Yash RD cr2 ${tag}`, fileUrl: 'x', clientId: cA, campaignId: k1, archivedAt: new Date() },
    { name: `Yash RD cr3 ${tag}`, fileUrl: 'x', clientId: cA, campaignId: k1, isDeleted: true },
  ]);
  await db.insert(landingPages).values({ clientId: cA, url: `https://example.com/${tag}`, normalisedUrl: `https://example.com/${tag}` });
});
afterAll(async () => {
  const ids = [cA, cB, cC, cOther];
  const cids = [k1, k2, kShared, kOther];
  await db.delete(creatives).where(inArray(creatives.clientId, ids));
  await db.delete(landingPages).where(inArray(landingPages.clientId, ids));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, ids));
  await db.delete(trafficSources).where(inArray(trafficSources.campaignId, cids));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, cids));
  await db.delete(campaigns).where(inArray(campaigns.id, cids));
  await db.delete(clients).where(inArray(clients.id, ids));
  await db.delete(businesses).where(eq(businesses.id, otherBiz));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('list_clients', () => {
  it('finds clients by name, with the ad account count, never another business', async () => {
    const r = await call(key, 'list_clients', { q: `RD Alpha ${tag}` });
    expect(r.structuredContent.items).toEqual([{ clientId: cA, name: `Yash RD Alpha ${tag}`, status: 'active', currency: 'GBP', country: 'UK', adAccountCount: 2 }]);
    const all = await call(key, 'list_clients', { q: `Yash RD`, limit: 100 });
    const names = all.structuredContent.items.map((c: { name: string }) => c.name);
    expect(names).not.toContain(`Yash RD Alpha OTHER ${tag}`);
    expect(names).toHaveLength(3);
  });
  it('filters by status and pages with nextCursor', async () => {
    const paused = await call(key, 'list_clients', { q: 'Yash RD', status: 'paused' });
    expect(paused.structuredContent.items.map((c: { clientId: string }) => c.clientId)).toEqual([cC]);
    const p1 = await call(key, 'list_clients', { q: 'Yash RD', limit: 2 });
    expect(p1.structuredContent.items).toHaveLength(2);
    expect(p1.structuredContent.nextCursor).not.toBeNull();
    const p2 = await call(key, 'list_clients', { q: 'Yash RD', limit: 2, cursor: p1.structuredContent.nextCursor });
    expect(p2.structuredContent.items).toHaveLength(1);
    expect(p2.structuredContent.nextCursor).toBeNull();
    const seen = [...p1.structuredContent.items, ...p2.structuredContent.items].map((c: { clientId: string }) => c.clientId);
    expect(new Set(seen).size).toBe(3);
  });
  it('a bad cursor is validation_failed; a key without clients:read is refused', async () => {
    const bad = await call(key, 'list_clients', { cursor: 'not-a-cursor' });
    expect(bad.structuredContent).toMatchObject({ code: 'validation_failed' });
    expect(bad.structuredContent.fields[0].field).toBe('cursor');
    expect((await call(noScopeKey, 'list_clients')).structuredContent.code).toBe('insufficient_scope');
    // A status the database does not know is refused up front, never a server error.
    const badStatus = await call(key, 'list_clients', { status: 'inactive' });
    expect(badStatus.isError).toBe(true);
  });
});

describe('get_client', () => {
  it('returns accounts as meta/google, the campaigns it buys, and live counts only', async () => {
    const r = await call(key, 'get_client', { clientId: cA });
    const d = r.structuredContent;
    expect(d.client).toMatchObject({ clientId: cA, name: `Yash RD Alpha ${tag}` });
    expect(d.adAccounts).toContainEqual({ platform: 'meta', accountId: `${tag}1`, accountName: 'Alpha Meta', campaignId: k1, campaignName: `Yash RD Solar ${tag}` });
    expect(d.adAccounts).toContainEqual({ platform: 'google', accountId: `${tag}2`, accountName: null, campaignId: null, campaignName: null });
    expect(d.adAccounts.map((a: { platform: string }) => a.platform).sort()).toEqual(['google', 'meta']);
    expect(d.campaigns.map((c: { campaignId: string }) => c.campaignId).sort()).toEqual([k1, k2].sort());
    expect(d.creativeCount).toBe(1); // archived and deleted are not counted
    expect(d.landingPageCount).toBe(1);
  });
  it("another business's client and an unknown ID are not_found", async () => {
    expect((await call(key, 'get_client', { clientId: cOther })).structuredContent.code).toBe('not_found');
    expect((await call(key, 'get_client', { clientId: '11111111-1111-4111-8111-111111111111' })).structuredContent.code).toBe('not_found');
  });
});

describe('list_campaigns', () => {
  it('lists the campaigns a client buys, with the LeadByte number and linked clients', async () => {
    const r = await call(key, 'list_campaigns', { clientId: cA });
    expect(r.structuredContent.items.map((c: { campaignId: string }) => c.campaignId).sort()).toEqual([k1, k2].sort());
    const solar = r.structuredContent.items.find((c: { campaignId: string }) => c.campaignId === k1);
    expect(solar).toMatchObject({ leadbyteId: lb1, vertical: 'Solar' });
    expect(solar.linkedClientIds.sort()).toEqual([cA, cB].sort());
  });
  it('searches by name or the exact LeadByte number; a shared campaign is visible; another business only is not', async () => {
    expect((await call(key, 'list_campaigns', { q: lb1 })).structuredContent.items[0].campaignId).toBe(k1);
    const names = (await call(key, 'list_campaigns', { q: 'Yash RD', limit: 100 })).structuredContent.items.map((c: { campaignId: string }) => c.campaignId);
    expect(names).toContain(kShared);
    expect(names).not.toContain(kOther);
  });
});

describe('get_campaign', () => {
  it('by Stato UUID or LeadByte number: clients, ad accounts and live asset count', async () => {
    for (const ref of [k1, lb1]) {
      const d = (await call(key, 'get_campaign', { campaignId: ref })).structuredContent;
      expect(d.campaign).toMatchObject({ campaignId: k1, leadbyteId: lb1 });
      expect(d.linkedClients.map((c: { clientId: string }) => c.clientId).sort()).toEqual([cA, cB].sort());
      expect(d.adAccounts).toEqual([{ platform: 'meta', accountId: `${tag}1`, accountName: 'Alpha Meta', clientId: cA }]);
      expect(d.creativeCount).toBe(1);
    }
  });
  it("another business's campaign and an unknown reference are not_found", async () => {
    expect((await call(key, 'get_campaign', { campaignId: kOther })).structuredContent.code).toBe('not_found');
    expect((await call(key, 'get_campaign', { campaignId: 'no-such-number' })).structuredContent.code).toBe('not_found');
  });
});

describe('reads never create a campaign', () => {
  it('the campaigns table is unchanged by every read, including an unknown LeadByte number', async () => {
    const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(campaigns))[0]!.n;
    const before = await count();
    await call(key, 'list_campaigns', { limit: 100 });
    await call(key, 'get_campaign', { campaignId: 'brand-new-leadbyte-number' });
    await call(key, 'get_client', { clientId: cA });
    expect(await count()).toBe(before);
  });
});
