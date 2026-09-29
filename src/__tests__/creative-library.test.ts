import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { inArray, eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { domainEvents, type DomainEventPayload } from '../services/events.js';

// Creative library (Sam feedback round 1, M2): creatives filed under a client,
// found from the ad account, deduped, with landing pages as their own records.

const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `m2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let owner: string;
let finance: string;
let buyerA: string;
let buyerB: string;
let solo: string;
let shared: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  [owner, finance] = await Promise.all([login('owner@stato.app', 'owner123'), login('finance@stato.app', 'finance123')]);
  const [a, b, s] = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test Buyer A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test Buyer B ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test Solo ${tag}`, status: 'active' },
  ]).returning();
  buyerA = a!.id; buyerB = b!.id; solo = s!.id;
  const [k] = await db.insert(campaigns).values({ name: `Yash Test Shared ${tag}` }).returning();
  shared = k!.id;
  await db.insert(clientCampaigns).values([{ clientId: buyerA, campaignId: shared }, { clientId: buyerB, campaignId: shared }]);
  // Meta account → Buyer A (stored with the canonical platform, as 0041 does).
  await db.insert(clientAdAccounts).values({ businessId: BIZ, platform: 'facebook-ads', accountId: `${tag}-meta`, clientId: buyerA, campaignId: shared });
});

afterAll(async () => {
  const ids = [buyerA, buyerB, solo];
  await db.delete(creatives).where(inArray(creatives.clientId, ids));
  await db.delete(creatives).where(eq(creatives.campaignId, shared));
  await db.delete(landingPages).where(inArray(landingPages.clientId, ids));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, ids));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.clientId, ids));
  await db.delete(campaigns).where(eq(campaigns.id, shared));
  await db.delete(clients).where(inArray(clients.id, ids));
});

const metaCreative = (n: number, extra: Record<string, unknown> = {}) => ({
  platform: 'meta', platformAccountId: `${tag}-meta`, platformAdId: `${tag}-ad-${n}`, platformCreativeId: `${tag}-cr-${n}`,
  mediaType: 'image', r2Key: `${tag}-${n}.png`, contentType: 'image/png', sizeBytes: 1234, name: `Ad ${n}`, ...extra,
});

describe('POST /api/v1/creatives (library)', () => {
  it('files a Meta creative under the client that owns the ad account', async () => {
    const events: DomainEventPayload[] = [];
    const on = (p: DomainEventPayload) => events.push(p);
    domainEvents.on('creative.added', on);
    const res = await request(app).post('/api/v1/creatives').set(auth(owner))
      .send(metaCreative(1, { landingPageUrl: 'https://LP.example.com/ch/?utm_source=fb&fbclid=1' }));
    domainEvents.off('creative.added', on);
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(true);
    const c = res.body.data.creative;
    expect(c.clientId).toBe(buyerA);
    expect(c.campaignId).toBe(shared);
    expect(c.platform).toBe('meta');
    expect(c.landingPage.url).toBe('https://LP.example.com/ch/?utm_source=fb&fbclid=1');
    expect(events.some((e) => e.data.creativeId === c.id && e.businessId === BIZ)).toBe(true);
  });

  it('sending the same platform creative again updates it instead of copying', async () => {
    const res = await request(app).post('/api/v1/creatives').set(auth(owner))
      .send(metaCreative(1, { headline: 'New headline', landingPageUrl: 'https://lp.example.com/ch?gclid=9' }));
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    const rows = await db.select().from(creatives).where(eq(creatives.platformCreativeId, `${tag}-cr-1`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.headline).toBe('New headline');
    // Different tracking params → the same landing page record.
    const pages = await db.select().from(landingPages).where(eq(landingPages.clientId, buyerA));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.normalisedUrl).toBe('https://lp.example.com/ch');
  });

  it('refuses an ad account nobody has linked, with a plain message', async () => {
    const res = await request(app).post('/api/v1/creatives').set(auth(owner))
      .send(metaCreative(2, { platformAccountId: `${tag}-unlinked` }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/No client is linked to meta ad account/);
  });

  it('refuses non-media files', async () => {
    const res = await request(app).post('/api/v1/creatives').set(auth(owner))
      .send(metaCreative(3, { contentType: 'application/x-msdownload' }));
    expect(res.status).toBe(422);
  });

  it('accepts several at once and reports each', async () => {
    const res = await request(app).post('/api/v1/creatives').set(auth(owner)).send({
      creatives: [
        { clientId: solo, mediaType: 'video', r2Key: `${tag}-v.mp4`, contentType: 'video/mp4', name: 'Solo video' },
        metaCreative(4, { platformAccountId: `${tag}-unlinked` }),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0].created).toBe(true);
    expect(res.body.data.results[1].status).toBe(422);
  });

  it('Finance can read the library but not write to it', async () => {
    expect((await request(app).get('/api/v1/creatives').set(auth(finance))).status).toBe(200);
    expect((await request(app).post('/api/v1/creatives').set(auth(finance)).send(metaCreative(5))).status).toBe(403);
  });
});

describe('GET /api/v1/creatives', () => {
  beforeAll(async () => {
    // A pre-library creative shared on the campaign (client_id NULL).
    await db.insert(creatives).values({ campaignId: shared, name: `Shared legacy ${tag}`, fileUrl: 'https://x/creatives/s.png', type: 'image' });
  });

  it('a shared campaign creative shows under every buyer; a client creative only under its client', async () => {
    const forA = await request(app).get(`/api/v1/creatives?clientId=${buyerA}`).set(auth(owner));
    const forB = await request(app).get(`/api/v1/creatives?clientId=${buyerB}`).set(auth(owner));
    const names = (r: request.Response) => r.body.data.creatives.map((c: { name: string }) => c.name);
    expect(names(forA)).toEqual(expect.arrayContaining(['Ad 1', `Shared legacy ${tag}`]));
    expect(names(forB)).toContain(`Shared legacy ${tag}`);
    expect(names(forB)).not.toContain('Ad 1');
  });

  it('filters by platform and searches headline text', async () => {
    const res = await request(app).get(`/api/v1/creatives?platform=meta&q=${encodeURIComponent('New headline')}`).set(auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.creatives.map((c: { name: string }) => c.name)).toEqual(['Ad 1']);
  });

  it.each(['created', 'last_seen', 'name'])('sorts by %s', async (sort) => {
    for (const order of ['asc', 'desc']) {
      const res = await request(app).get(`/api/v1/creatives?clientId=${buyerA}&sort=${sort}&order=${order}&page=1&limit=5`).set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.body.data.pageSize).toBe(5);
    }
  });

  it('rejects bad filters with 400, not 500', async () => {
    expect((await request(app).get('/api/v1/creatives?platform=myspace').set(auth(owner))).status).toBe(400);
  });
});

describe('edit, bulk and landing pages', () => {
  it('moving a creative to another client drops the old client\'s landing page', async () => {
    const [row] = await db.select().from(creatives).where(eq(creatives.platformCreativeId, `${tag}-cr-1`));
    const res = await request(app).patch(`/api/v1/creatives/${row!.id}`).set(auth(owner)).send({ clientId: buyerB });
    expect(res.status).toBe(200);
    expect(res.body.data.creative.clientId).toBe(buyerB);
    expect(res.body.data.creative.landingPage).toBeNull();
  });

  it('bulk-assigns a landing page by URL, creating it for the client once', async () => {
    const rows = await db.select().from(creatives).where(eq(creatives.clientId, buyerB));
    const res = await request(app).post('/api/v1/creatives/bulk').set(auth(owner))
      .send({ action: 'assign_landing_page', ids: rows.map((r) => r.id), url: 'https://lp.example.com/b?utm_source=x' });
    expect(res.status).toBe(200);
    expect(res.body.data.failed).toEqual([]);
    const lps = await request(app).get(`/api/v1/clients/${buyerB}/landing-pages`).set(auth(finance));
    expect(lps.status).toBe(200);
    expect(lps.body.data.landingPages).toHaveLength(1);
    expect(lps.body.data.landingPages[0].creativeCount).toBe(rows.length);
  });

  it('list rows carry what the admin screens read (fileUrl, landing page fields, LP client name)', async () => {
    const list = await request(app).get(`/api/v1/creatives?clientId=${buyerA}`).set(auth(owner));
    expect(list.status).toBe(200);
    for (const c of list.body.data.creatives) {
      expect(c).toHaveProperty('fileUrl');
      expect(c).toHaveProperty('landingPageId');
      expect(c).toHaveProperty('landingPageUrl');
    }
    const lp = await request(app).post('/api/v1/landing-pages').set(auth(owner)).send({ clientId: buyerA, url: `https://example.com/${tag}/lp-fields?utm_source=x` });
    const pages = await request(app).get(`/api/v1/landing-pages?clientId=${buyerA}`).set(auth(owner));
    const row = pages.body.data.landingPages.find((x: { id: string }) => x.id === (lp.body.data.landingPage ?? lp.body.data).id);
    expect(row.clientName).toMatch(/Yash Test Buyer A/);
    expect(row.creativesCount).toBe(row.creativeCount);
  });

  it('landing pages: create is idempotent per client, rename, archive', async () => {
    const one = await request(app).post('/api/v1/landing-pages').set(auth(owner)).send({ clientId: solo, url: 'https://lp.example.com/solo', title: 'Solo LP' });
    const two = await request(app).post('/api/v1/landing-pages').set(auth(owner)).send({ clientId: solo, url: 'lp.example.com/solo/?utm_campaign=z' });
    expect(one.status).toBe(201);
    expect(two.status).toBe(200);
    expect(two.body.data.landingPage.id).toBe(one.body.data.landingPage.id);
    const id = one.body.data.landingPage.id;
    expect((await request(app).patch(`/api/v1/landing-pages/${id}`).set(auth(owner)).send({ title: 'Renamed' })).body.data.landingPage.title).toBe('Renamed');
    expect((await request(app).post('/api/v1/landing-pages').set(auth(owner)).send({ clientId: solo, url: 'javascript:alert(1)' })).status).toBe(422);
    expect((await request(app).delete(`/api/v1/landing-pages/${id}`).set(auth(owner))).status).toBe(200);
    const after = await request(app).get(`/api/v1/landing-pages?clientId=${solo}`).set(auth(owner));
    expect(after.body.data.landingPages).toHaveLength(0);
  });
});

describe('sourceUrl', () => {
  it('downloads the file from a public URL, fingerprints it, and dedupes the same bytes', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }));
    try {
      const body = { clientId: solo, mediaType: 'image', sourceUrl: 'https://93.184.216.34/ad.png', name: 'From URL' };
      const first = await request(app).post('/api/v1/creatives').set(auth(owner)).send(body);
      const again = await request(app).post('/api/v1/creatives').set(auth(owner)).send({ ...body, name: 'Same bytes' });
      expect(first.status).toBe(201);
      expect(first.body.data.creative.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(again.status).toBe(200);
      expect(again.body.data.creative.id).toBe(first.body.data.creative.id);
      const internal = await request(app).post('/api/v1/creatives').set(auth(owner)).send({ ...body, sourceUrl: 'http://127.0.0.1:3001/x.png' });
      expect(internal.status).toBe(422);
    } finally {
      spy.mockRestore();
    }
  });
});
