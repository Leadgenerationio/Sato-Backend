import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { domainEvents } from '../services/events.js';

// MCP spec v1.0 upload_asset (files by sourceUrl): tests 8 and 11 (the parts that
// run today), the rules in 2.1 and the several-campaigns rule.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACC = `44${tag}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = ''; let keyId = ''; let readKey = '';
let clientA = ''; let clientB = ''; let c1 = ''; let c2 = '';
const keyIds: string[] = [];
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const files = new Map<string, { bytes: Buffer; type: string; length?: string }>();
let fetchSpy: ReturnType<typeof vi.spyOn>;

const png = (seed: string) => Buffer.concat([PNG_HEAD, Buffer.from(`${seed}-${tag}`)]);
const url = (n: string) => `https://93.184.216.34/${tag}/${n}.png`;

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test up ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key as string, id: res.body.data.apiKey.id as string };
}
async function call(k: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_asset', arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
}
const link = (clientId: string, accountId: string, campaignId?: string) =>
  request(app).post(`/api/v1/clients/${clientId}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId, campaignId }).expect(201);

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  ({ key, id: keyId } = await makeKey(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'ad_links:write']));
  readKey = (await makeKey(['creatives:read'])).key;
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test UP A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test UP B ${tag}`, status: 'active' },
  ]).returning();
  clientA = cs[0]!.id; clientB = cs[1]!.id;
  const camps = await db.insert(campaigns).values([{ name: `Yash UP Solar ${tag}` }, { name: `Yash UP Insulation ${tag}` }]).returning();
  c1 = camps[0]!.id; c2 = camps[1]!.id;
  await db.insert(clientCampaigns).values([{ clientId: clientA, campaignId: c1 }, { clientId: clientA, campaignId: c2 }]);
  await link(clientA, `act_${ACC}1`, c1);
  await link(clientB, `act_${ACC}2`);
  await link(clientA, `act_${ACC}3`);
  await db.insert(trafficSources).values([
    { campaignId: c1, name: `Yash UP s1 ${tag}`, platform: 'facebook-ads', accountId: `${ACC}3` },
    { campaignId: c2, name: `Yash UP s2 ${tag}`, platform: 'facebook-ads', accountId: `${ACC}3` },
  ]);
});
afterAll(async () => {
  const rows = await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [clientA, clientB]));
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(creatives).where(inArray(creatives.clientId, [clientA, clientB]));
  await db.delete(landingPages).where(inArray(landingPages.clientId, [clientA, clientB]));
  await db.delete(trafficSources).where(inArray(trafficSources.campaignId, [c1, c2]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [clientA, clientB]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [c1, c2]));
  await db.delete(campaigns).where(inArray(campaigns.id, [c1, c2]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});
beforeEach(() => {
  const real = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input);
    const f = files.get(u);
    if (!f) return real(input, init);
    return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.type, ...(f.length ? { 'content-length': f.length } : {}) } });
  });
});
afterEach(() => fetchSpy.mockRestore());

const base = (n: string, extra: Record<string, unknown> = {}) => ({ mediaType: 'image', sourceUrl: url(n), name: `Yash UP ${n} ${tag}`, platform: 'meta', platformAccountId: `act_${ACC}1`, ...extra });

describe('upload_asset', () => {
  it('files an image under the client that owns the account, marks it as mcp, and fires creative.added', async () => {
    files.set(url('one'), { bytes: png('one'), type: 'image/png' });
    const added: unknown[] = [];
    const on = (e: unknown) => added.push(e);
    domainEvents.on('creative.added', on);
    const r = await call(key, base('one', { headline: 'Hearing aids', tags: ['summer', 'ch'] }));
    domainEvents.off('creative.added', on);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ result: 'created', replayed: false, mediaType: 'image', fileStatus: 'ready', approvalStatus: 'draft', adLink: null });
    const [row] = await db.select().from(creatives).where(eq(creatives.id, r.structuredContent.creativeId));
    expect(row).toMatchObject({ clientId: clientA, campaignId: c1, source: 'mcp', createdByKeyId: keyId, headline: 'Hearing aids' });
    expect([...row!.tags].sort()).toEqual(['ch', 'summer']);
    expect(added).toHaveLength(1);
  });
  it('same idempotencyKey replays the first answer; the same file with a new key is a duplicate (test 8)', async () => {
    files.set(url('two'), { bytes: png('two'), type: 'image/png' });
    const first = await call(key, base('two', { idempotencyKey: `k-${tag}` }));
    expect(first.structuredContent).toMatchObject({ result: 'created', replayed: false });
    const replay = await call(key, base('two', { idempotencyKey: `k-${tag}` }));
    expect(replay.structuredContent).toMatchObject({ result: 'created', replayed: true, creativeId: first.structuredContent.creativeId });
    expect(replay.content[0]!.text).toContain('idempotencyKey');
    const dup = await call(key, base('two', { idempotencyKey: `k2-${tag}` }));
    expect(dup.structuredContent).toMatchObject({ result: 'duplicate', replayed: false, creativeId: first.structuredContent.creativeId });
    expect(await db.select().from(creatives).where(eq(creatives.name, `Yash UP two ${tag}`))).toHaveLength(1);
  });
  it('the same key with a different request is refused', async () => {
    const r = await call(key, base('two', { idempotencyKey: `k-${tag}`, headline: 'Different' }));
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('validation_failed');
    expect(r.structuredContent.fields[0].field).toBe('idempotencyKey');
  });
  it('rejects a clientId that does not own the account, saving nothing (rule: account_client_mismatch)', async () => {
    files.set(url('three'), { bytes: png('three'), type: 'image/png' });
    const r = await call(key, base('three', { clientId: clientB }));
    expect(r.structuredContent.code).toBe('account_client_mismatch');
    expect(await db.select().from(creatives).where(eq(creatives.name, `Yash UP three ${tag}`))).toHaveLength(0);
  });
  it('an unlinked account is account_not_linked and nothing is saved (test 6)', async () => {
    files.set(url('four'), { bytes: png('four'), type: 'image/png' });
    const r = await call(key, base('four', { platformAccountId: `${ACC}9` }));
    expect(r.structuredContent.code).toBe('account_not_linked');
    expect(r.structuredContent.hint).toContain('link_ad_account');
    expect(await db.select().from(creatives).where(eq(creatives.name, `Yash UP four ${tag}`))).toHaveLength(0);
  });
  it('an account that feeds several campaigns needs campaignId; with one it works', async () => {
    files.set(url('five'), { bytes: png('five'), type: 'image/png' });
    const need = await call(key, base('five', { platformAccountId: `${ACC}3` }));
    expect(need.structuredContent.code).toBe('validation_failed');
    expect(need.structuredContent.fields[0].field).toBe('campaignId');
    expect(need.structuredContent.details.campaigns.map((c: { campaignId: string }) => c.campaignId).sort()).toEqual([c1, c2].sort());
    const ok = await call(key, base('five', { platformAccountId: `${ACC}3`, campaignId: c2 }));
    expect(ok.structuredContent.result).toBe('created');
    const [row] = await db.select().from(creatives).where(eq(creatives.id, ok.structuredContent.creativeId));
    expect(row!.campaignId).toBe(c2);
  });
  it('a campaign the client does not buy is campaign_client_mismatch', async () => {
    files.set(url('six'), { bytes: png('six'), type: 'image/png' });
    const [other] = await db.insert(campaigns).values({ name: `Yash UP Other ${tag}` }).returning();
    await db.insert(clientCampaigns).values({ clientId: clientB, campaignId: other!.id });
    const r = await call(key, base('six', { campaignId: other!.id }));
    expect(r.structuredContent.code).toBe('campaign_client_mismatch');
    await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, other!.id));
    await db.delete(campaigns).where(eq(campaigns.id, other!.id));
  });
  it('works with clientId alone, and needs one of the two', async () => {
    files.set(url('seven'), { bytes: png('seven'), type: 'image/png' });
    const ok = await call(key, { mediaType: 'image', sourceUrl: url('seven'), name: `Yash UP seven ${tag}`, clientId: clientA });
    expect(ok.structuredContent.result).toBe('created');
    const none = await call(key, { mediaType: 'image', sourceUrl: url('seven') });
    expect(none.structuredContent.code).toBe('validation_failed');
  });
});

describe('upload_asset with adLink in the same call', () => {
  it('records the ad; a repeat with the same platform creative ID updates instead of copying', async () => {
    files.set(url('ad1'), { bytes: png('ad1'), type: 'image/png' });
    const r = await call(key, base('ad1', { adLink: { platformCampaignId: '120200000001', adsetId: '120200000002', adId: `ad${tag}`, platformCreativeId: `pc${tag}` } }));
    expect(r.structuredContent.result).toBe('created');
    expect(r.structuredContent.adLink).toMatchObject({ adId: `ad${tag}`, platformCreativeId: `pc${tag}`, accountId: `${ACC}1`, platform: 'meta', source: 'mcp' });
    const again = await call(key, base('ad1', { headline: 'New headline', adLink: { adId: `ad${tag}`, platformCreativeId: `pc${tag}` } }));
    expect(again.structuredContent).toMatchObject({ result: 'updated', creativeId: r.structuredContent.creativeId });
    expect(await db.select().from(creatives).where(eq(creatives.platformCreativeId, `pc${tag}`))).toHaveLength(1);
  });
  it("never takes over another client's asset through its platform creative ID (nothing changes, nothing saved)", async () => {
    files.set(url('own-a'), { bytes: png('own-a'), type: 'image/png' });
    files.set(url('own-b'), { bytes: png('own-b-different'), type: 'image/png' });
    const mine = await call(key, base('own-a', { adLink: { adId: `adx${tag}`, platformCreativeId: `pcx${tag}` } }));
    expect(mine.structuredContent.result).toBe('created');
    const [before] = await db.select().from(creatives).where(eq(creatives.id, mine.structuredContent.creativeId));
    // client B's account sends client A's Meta creative ID with its own file
    const theirs = await call(key, base('own-b', { platformAccountId: `act_${ACC}2`, name: `Yash UP stolen ${tag}`, adLink: { adId: `ady${tag}`, platformCreativeId: `pcx${tag}` } }));
    expect(theirs.isError).toBe(true);
    const [after] = await db.select().from(creatives).where(eq(creatives.id, before!.id));
    expect(after).toMatchObject({ clientId: clientA, campaignId: before!.campaignId, name: before!.name, r2Key: before!.r2Key, sha256: before!.sha256 });
    expect(await db.select().from(creatives).where(eq(creatives.platformCreativeId, `pcx${tag}`))).toHaveLength(1);
  });
  it('keeps the asset when the ad is already linked elsewhere, and says so', async () => {
    files.set(url('ad2'), { bytes: png('ad2'), type: 'image/png' });
    const r = await call(key, base('ad2', { adLink: { adId: `ad${tag}`, platformCreativeId: `pc2${tag}` } }));
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ result: 'created', adLinkResult: 'duplicate' });
    const [saved] = await db.select().from(creatives).where(eq(creatives.id, r.structuredContent.creativeId));
    expect(saved).toBeDefined();
    expect(r.structuredContent.adLink.creativeId).not.toBe(r.structuredContent.creativeId); // the asset that already holds the ad
    expect(r.content[0]!.text).toContain('unlink it first');
  });
  it('adLink also needs the ad_links:write scope, and nothing is saved without it', async () => {
    const noLinks = (await makeKey(['clients:read', 'creatives:write'])).key;
    files.set(url('ad4'), { bytes: png('ad4'), type: 'image/png' });
    const r = await call(noLinks, base('ad4', { adLink: { adId: `ad9${tag}` } }));
    expect(r.structuredContent.code).toBe('insufficient_scope');
    expect(r.structuredContent.message).toContain('ad_links:write');
    expect(await db.select().from(creatives).where(eq(creatives.name, `ad4-${tag}`))).toHaveLength(0);
  });
  it('adLink needs an ad account', async () => {
    files.set(url('ad3'), { bytes: png('ad3'), type: 'image/png' });
    const r = await call(key, { mediaType: 'image', sourceUrl: url('ad3'), clientId: clientA, adLink: { adId: 'x' } });
    expect(r.structuredContent.code).toBe('validation_failed');
  });
});

describe('upload_asset refusals (test 11, the parts that run today)', () => {
  it('a file that is not an image or video is unsupported_type', async () => {
    files.set(url('page'), { bytes: Buffer.from('<html>not a picture</html>'), type: 'text/html' });
    const r = await call(key, base('page'));
    expect(r.structuredContent.code).toBe('unsupported_type');
  });
  it('an internal address is source_unreachable and no request is made to it', async () => {
    for (const bad of ['http://127.0.0.1:3001/x.png', 'http://169.254.169.254/latest/meta-data', 'http://localhost/x.png']) {
      fetchSpy.mockClear();
      const r = await call(key, base('x', { sourceUrl: bad }));
      expect(r.structuredContent.code).toBe('source_unreachable');
      expect(fetchSpy.mock.calls.filter(([i]) => String(i) === bad)).toHaveLength(0);
    }
  });
  it('a file declared over 1 GB is file_too_large before anything is stored', async () => {
    files.set(url('big'), { bytes: png('big'), type: 'image/png', length: String(2 * 1024 * 1024 * 1024) });
    const r = await call(key, base('big'));
    expect(r.structuredContent.code).toBe('file_too_large');
    expect(r.structuredContent.hint).toContain('create_upload');
    expect(await db.select().from(creatives).where(eq(creatives.name, `Yash UP big ${tag}`))).toHaveLength(0);
  });
  it('a file declared between 50 MB and 1 GB is copied in the background: upload_incomplete with an uploadId, nothing filed yet', async () => {
    files.set(url('mid'), { bytes: png('mid'), type: 'image/png', length: String(60 * 1024 * 1024) });
    const r = await call(key, base('mid'));
    expect(r.structuredContent).toMatchObject({ code: 'upload_incomplete', retryable: true });
    expect(r.structuredContent.details.uploadId).toBeTruthy();
    expect(await db.select().from(creatives).where(eq(creatives.name, `Yash UP mid ${tag}`))).toHaveLength(0);
  });
  it('needs the creatives:write scope', async () => {
    files.set(url('scope'), { bytes: png('scope'), type: 'image/png' });
    expect((await call(readKey, base('scope'))).structuredContent.code).toBe('insufficient_scope');
  });
});

describe('review of #78', () => {
  it('a non-UUID clientId is validation_failed naming clientId, not internal_error', async () => {
    const r = await call(key, { mediaType: 'image', sourceUrl: url('nouuid'), clientId: 'abc' });
    expect(r.structuredContent).toMatchObject({ code: 'validation_failed', fields: [{ field: 'clientId' }] });
  });
});
