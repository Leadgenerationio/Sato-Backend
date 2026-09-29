import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';

// Sam S13 (2026-09-29): bulk-link ad accounts to clients (and optionally a
// campaign), matched on (platform, accountId) — never on the account name.

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `s13-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const acct = (n: number) => `${tag}-acc-${n}`;
const MISSING_UUID = '00000000-0000-0000-0000-00000000dead';

let ownerToken: string;
let opsToken: string;
let financeToken: string;
let clientToken: string;
let clientA: string;
let clientB: string;
let campaignId: string;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken;
}

beforeAll(async () => {
  [ownerToken, opsToken, financeToken, clientToken] = await Promise.all([
    login('owner@stato.app', 'owner123'),
    login('ops@stato.app', 'ops123'),
    login('finance@stato.app', 'finance123'),
    login('client@stato.app', 'client123'),
  ]);
  const [a, b] = await db.insert(clients).values([
    { businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test Sonova ${tag}`, currency: 'EUR', status: 'active' },
    { businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test Copious ${tag}`, currency: 'GBP', status: 'active' },
  ]).returning();
  clientA = a.id;
  clientB = b.id;
  const [c] = await db.insert(campaigns).values({ name: `Hearing Aids (CH) ${tag}`, vertical: 'Hearing Aids', status: 'active', clientId: null }).returning();
  campaignId = c.id;
  // Account 1: Meta, spend ingested 3× (Catchr authorization ids) → 1000 once.
  // Account 2: Taboola, a NAME that doesn't match its id (Sam's example).
  // Account 3: referenced by a campaign's Ad Account Links, no spend yet.
  for (const authorizationId of [1, 2, 3]) {
    await db.insert(adSpend).values({
      platform: 'facebook-ads', authorizationId, accountId: acct(1), accountName: 'CH Hearing',
      campaignId: 'fb-1', date: today(), spend: '1000', currency: 'GBP',
    });
  }
  await db.insert(adSpend).values({
    platform: 'taboola', authorizationId: 1, accountId: acct(2), accountName: 'Hearing Aids Poland',
    campaignId: 'tb-1', date: today(), spend: '250.5', currency: 'EUR',
  });
  await db.insert(trafficSources).values({ campaignId, name: 'Google - CH', platform: 'google', accountId: acct(3), accountIds: [] });
});

afterAll(async () => {
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.accountId, [acct(1), acct(2), acct(3)]));
  await db.delete(adSpend).where(inArray(adSpend.accountId, [acct(1), acct(2), acct(3)]));
  await db.delete(trafficSources).where(inArray(trafficSources.accountId, [acct(3)]));
  await db.delete(campaigns).where(inArray(campaigns.id, [campaignId]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
});

const mine = (accounts: Array<{ accountId: string }>) => accounts.filter((a) => a.accountId.startsWith(tag));

describe('GET /api/v1/ad-accounts', () => {
  it('lists every known account once — spend deduped, traffic-source-only accounts included — unlinked first', async () => {
    const res = await request(app).get('/api/v1/ad-accounts').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const rows = mine(res.body.data.accounts);
    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map((r: { accountId: string }) => [r.accountId, r]));
    expect(byId[acct(1)]).toMatchObject({ platform: 'facebook-ads', platformLabel: 'Facebook', spend: 1000, link: null });
    expect(byId[acct(2)]).toMatchObject({ platform: 'taboola', accountName: 'Hearing Aids Poland', spend: 250.5, currency: 'EUR' });
    expect(byId[acct(3)]).toMatchObject({ platform: 'google-ads', spend: 0, campaigns: [{ campaignId, campaignName: `Hearing Aids (CH) ${tag}` }] });
    expect(res.body.data.summary.unlinkedSpend).toBeGreaterThanOrEqual(1250.5);
    // £ and € never added together.
    expect(res.body.data.summary.unlinkedSpendByCurrency.GBP).toBeGreaterThanOrEqual(1000);
    expect(res.body.data.summary.unlinkedSpendByCurrency.EUR).toBeGreaterThanOrEqual(250.5);
    // Picker options come with the list: clients of this business, Sato campaigns by UUID.
    const clientIds = res.body.data.options.clients.map((c: { id: string }) => c.id);
    expect(clientIds).toEqual(expect.arrayContaining([clientA, clientB]));
    expect(res.body.data.options.campaigns).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: campaignId, name: `Hearing Aids (CH) ${tag}` })]),
    );
  });

  it('is refused for client portal users', async () => {
    const res = await request(app).get('/api/v1/ad-accounts').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/v1/ad-accounts/links', () => {
  it('links many accounts in one save and reports what changed', async () => {
    const res = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${opsToken}`).send({
      links: [
        // FE-style spelling must land on the same canonical row.
        { platform: 'Facebook', accountId: acct(1), clientId: clientA, campaignId },
        { platform: 'taboola', accountId: acct(2), clientId: clientA },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 2, updated: 0, removed: 0, unchanged: 0 });
    expect(res.body.data.results[0]).toMatchObject({ platform: 'facebook-ads', action: 'created', clientName: `Yash Test Sonova ${tag}` });
  });

  it('updates, keeps, and removes in the same save', async () => {
    const res = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${ownerToken}`).send({
      links: [
        { platform: 'facebook-ads', accountId: acct(1), clientId: clientB, campaignId: null },
        { platform: 'taboola', accountId: acct(2), clientId: clientA },
        { platform: 'google', accountId: acct(3), clientId: null },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 0, updated: 1, unchanged: 2, removed: 0 });
    const list = await request(app).get('/api/v1/ad-accounts').set('Authorization', `Bearer ${ownerToken}`);
    const rows = mine(list.body.data.accounts);
    // The one still-unlinked account sorts first.
    expect(rows[0].accountId).toBe(acct(3));
    const fb = rows.find((r: { accountId: string }) => r.accountId === acct(1));
    expect(fb.link).toMatchObject({ clientId: clientB, campaignId: null });

    const unlink = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${ownerToken}`)
      .send({ links: [{ platform: 'taboola', accountId: acct(2), clientId: null }] });
    expect(unlink.body.data).toMatchObject({ removed: 1 });
  });

  it('rejects the whole batch when one client id is unknown — nothing written', async () => {
    const res = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${ownerToken}`).send({
      links: [
        { platform: 'google', accountId: acct(3), clientId: clientA },
        { platform: 'taboola', accountId: acct(2), clientId: MISSING_UUID },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing was saved/);
    const rows = await db.select().from(clientAdAccounts).where(inArray(clientAdAccounts.accountId, [acct(3), acct(2)]));
    expect(rows).toHaveLength(0);
  });

  it('rejects the same account twice in one save (Facebook and facebook-ads are the same account)', async () => {
    const res = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${ownerToken}`).send({
      links: [
        { platform: 'Facebook', accountId: acct(1), clientId: clientA },
        { platform: 'facebook-ads', accountId: acct(1), clientId: clientB },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('is refused for finance admins (owner/ops only)', async () => {
    const res = await request(app).put('/api/v1/ad-accounts/links').set('Authorization', `Bearer ${financeToken}`)
      .send({ links: [{ platform: 'google', accountId: acct(3), clientId: clientA }] });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/clients/lookup', () => {
  it('finds the client that owns an ad account by id, whatever the platform spelling', async () => {
    const res = await request(app)
      .get('/api/v1/clients/lookup')
      .query({ platform: 'meta', accountId: acct(1) })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ platform: 'facebook-ads', client: { id: clientB, companyName: `Yash Test Copious ${tag}` }, campaign: null });
  });

  it('404s for an account nobody has linked, and never matches on the account name', async () => {
    const res = await request(app)
      .get('/api/v1/clients/lookup')
      .query({ platform: 'taboola', accountId: 'Hearing Aids Poland' })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('400s without platform/accountId, and does not fall through to GET /clients/:id', async () => {
    const res = await request(app).get('/api/v1/clients/lookup').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });
});
