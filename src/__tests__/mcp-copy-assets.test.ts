import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { and, eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { copyHash, upsertCopyCreative } from '../services/creative-copy.service.js';
import { businesses } from '../db/schema/businesses.js';

// Copy-only assets (Sam's decision): ad copy with no file, kept in creatives so approvals, ad links and history work.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const DEMO_CLIENT = '00000000-0000-0000-0000-000000000001'; // the seeded portal client
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
const ALL = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'ad_accounts:write', 'ad_links:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'landing_pages:write'];
let owner = ''; let portal = ''; let key = ''; let A = ''; let B = ''; let camp = '';
const keyIds: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}
const copy = (extra: Record<string, unknown>) => call('upload_asset', { mediaType: 'copy', platform: 'meta', platformAccountId: `act_${tag}1`, ...extra });
const rowOf = async (id: string) => (await db.select().from(creatives).where(eq(creatives.id, id)))[0]!;

beforeAll(async () => {
  const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = ownerRes.body.data.tokens.accessToken;
  portal = (await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' })).body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test copy ${tag}`, scopes: ALL });
  keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
  A = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test COPY A ${tag}`, status: 'active' }).returning())[0]!.id;
  B = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test COPY B ${tag}`, status: 'active' }).returning())[0]!.id;
  camp = (await db.insert(campaigns).values({ name: `Yash Test COPY camp ${tag}`, vertical: 'Test', status: 'active', clientId: DEMO_CLIENT }).returning())[0]!.id;
  await db.insert(clientCampaigns).values({ clientId: DEMO_CLIENT, campaignId: camp, leadPrice: '20', currency: 'GBP' }).onConflictDoNothing();
  await call('link_ad_account', { clientId: A, platform: 'meta', accountId: `act_${tag}1` });
  await call('link_ad_account', { clientId: B, platform: 'meta', accountId: `act_${tag}2` });
});
afterAll(async () => {
  const ids = (await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [A, B, DEMO_CLIENT]))).map((r) => r.id).filter(Boolean);
  const mine = (await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.campaignId, camp))).map((r) => r.id);
  const all = [...new Set([...ids, ...mine])].filter((id) => true);
  const testOnes = (await db.select({ id: creatives.id, name: creatives.name }).from(creatives).where(inArray(creatives.id, all.length ? all : ['00000000-0000-4000-8000-000000000000']))).filter((r) => r.name.includes(tag)).map((r) => r.id);
  if (testOnes.length) { await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, testOnes)); await db.delete(creatives).where(inArray(creatives.id, testOnes)); }
  await db.delete(creatives).where(inArray(creatives.clientId, [A, B]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [A, B]));
  await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, camp));
  await db.delete(clients).where(inArray(clients.id, [A, B]));
  await db.delete(campaigns).where(eq(campaigns.id, camp));
  await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
  await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('upload_asset with mediaType copy', () => {
  it('files ad copy with no file: a copy asset, ready at once, no download link', async () => {
    const r = await copy({ headline: `Save 20% on boilers ${tag}`, bodyText: 'Free quote in two minutes.', name: `Yash Test COPY one ${tag}` });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ result: 'created', mediaType: 'copy', fileStatus: 'ready', thumbnailUrl: null });
    expect(r.structuredContent.sizeBytes).toBeGreaterThan(0);
    const row = await rowOf(r.structuredContent.creativeId);
    expect(row).toMatchObject({ clientId: A, type: 'copy', section: 'copy_lp', fileUrl: null, r2Key: null, contentType: 'text/plain', fileStatus: 'ready' });
    expect(row.sha256).toBe(copyHash(`Save 20% on boilers ${tag}`, 'Free quote in two minutes.'));
    const detail = (await call('get_asset', { creativeId: row.id })).structuredContent;
    expect(detail.downloadUrl).toBeNull();
    expect(detail.creative).toMatchObject({ mediaType: 'copy', headline: `Save 20% on boilers ${tag}` });
  });
  it('the same copy for the same client is a duplicate (whitespace and line endings do not matter); another client gets its own', async () => {
    const text = { headline: `Dup headline ${tag}`, bodyText: 'Line one\nLine two' };
    const first = await copy({ ...text, name: `Yash Test COPY dup ${tag}` });
    const again = await copy({ headline: `  Dup headline ${tag}  `, bodyText: 'Line one\r\nLine two\n' });
    expect(first.structuredContent.result).toBe('created');
    expect(again.structuredContent).toMatchObject({ result: 'duplicate', creativeId: first.structuredContent.creativeId });
    const other = await call('upload_asset', { mediaType: 'copy', platform: 'meta', platformAccountId: `act_${tag}2`, ...text, name: `Yash Test COPY dup B ${tag}` });
    expect(other.structuredContent.result).toBe('created');
    expect(other.structuredContent.creativeId).not.toBe(first.structuredContent.creativeId);
  });
  it('the same (platform, platformCreativeId) updates the copy instead of adding a second one', async () => {
    const ad = { platformCreativeId: `copy-pcid-${tag}` };
    const first = await copy({ headline: `First ${tag}`, adLink: ad, name: `Yash Test COPY upd ${tag}` });
    const second = await copy({ headline: `Second ${tag}`, adLink: ad });
    expect(second.structuredContent).toMatchObject({ result: 'updated', creativeId: first.structuredContent.creativeId });
    const row = await rowOf(first.structuredContent.creativeId);
    expect(row.headline).toBe(`Second ${tag}`);
    expect(row.sha256).toBe(copyHash(`Second ${tag}`, ''));
  });
  it('is refused without text, or with a file', async () => {
    expect((await copy({})).structuredContent.code).toBe('validation_failed');
    expect((await copy({ headline: 'x', sourceUrl: 'https://93.184.216.34/a.png' })).structuredContent.code).toBe('validation_failed');
    expect((await copy({ headline: 'x', uploadId: '00000000-0000-4000-8000-000000000000' })).structuredContent.code).toBe('validation_failed');
  });
  it('the account\'s client rules still apply (a mismatch is refused, nothing saved)', async () => {
    const before = (await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [A, B]))).length;
    const r = await copy({ headline: `Mismatch ${tag}`, clientId: B });
    expect(r.structuredContent.code).toBe('account_client_mismatch');
    expect((await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [A, B]))).length).toBe(before);
  });
});

describe('a copy asset works like any other asset', () => {
  let id = '';
  beforeAll(async () => { id = (await copy({ headline: `Lifecycle ${tag}`, bodyText: 'Body', name: `Yash Test COPY life ${tag}` })).structuredContent.creativeId; });
  it('is listed, and filtered by mediaType copy', async () => {
    const all = (await call('list_assets', { q: `Yash Test COPY life ${tag}` })).structuredContent.items;
    expect(all.map((i: any) => i.creativeId)).toContain(id);
    const onlyCopy = (await call('list_assets', { mediaType: 'copy', clientId: A, limit: 100 })).structuredContent.items;
    expect(onlyCopy.length).toBeGreaterThan(0);
    expect(onlyCopy.every((i: any) => i.mediaType === 'copy')).toBe(true);
    expect((await call('list_assets', { mediaType: 'image', q: `Yash Test COPY life ${tag}` })).structuredContent.items).toHaveLength(0);
  });
  it('takes an ad link and a landing page, and can be archived and restored', async () => {
    const link = await call('link_ad_platform_ids', { creativeId: id, platform: 'meta', accountId: `act_${tag}1`, adId: `copy-ad-${tag}` });
    expect(link.structuredContent.result).toBe('created');
    expect((await call('find_asset_by_platform_id', { platform: 'meta', adId: `copy-ad-${tag}` })).structuredContent.creative.id).toBe(id);
    expect((await call('attach_landing_page', { creativeId: id, url: `https://example.com/copy-${tag}` })).isError).toBeUndefined();
    expect((await call('archive_asset', { creativeId: id })).structuredContent.result).toBe('archived');
    expect((await call('restore_asset', { creativeId: id })).structuredContent.result).toBe('restored');
  });
  it('editing the text keeps its hash in step, refuses a copy that matches another, and refuses emptying it', async () => {
    const other = (await copy({ headline: `Other ${tag}`, name: `Yash Test COPY other ${tag}` })).structuredContent.creativeId;
    const edited = await call('update_asset', { creativeId: id, headline: `Lifecycle edited ${tag}` });
    expect(edited.structuredContent.changedFields).toContain('headline');
    expect((await rowOf(id)).sha256).toBe(copyHash(`Lifecycle edited ${tag}`, 'Body'));
    const clash = await call('update_asset', { creativeId: id, headline: `Other ${tag}`, bodyText: '' });
    expect(clash.structuredContent.code).toBe('duplicate');
    expect(clash.structuredContent.details.creativeId).toBe(other);
    const empty = await call('update_asset', { creativeId: id, headline: '', bodyText: '' });
    expect(empty.structuredContent.code).toBe('validation_failed');
    expect((await rowOf(id)).headline).toBe(`Lifecycle edited ${tag}`);
  });
});

describe('the portal and the library show the copy', () => {
  it('REST library list returns the copy asset with its text and no file', async () => {
    const r = await copy({ headline: `Library ${tag}`, bodyText: 'Library body', name: `Yash Test COPY lib ${tag}` });
    const list = await request(app).get('/api/v1/creatives').query({ q: `Yash Test COPY lib ${tag}` }).set('Authorization', `Bearer ${owner}`);
    expect(list.status).toBe(200);
    const item = list.body.data.creatives.find((c: any) => c.id === r.structuredContent.creativeId);
    expect(item).toMatchObject({ mediaType: 'copy', headline: `Library ${tag}`, bodyText: 'Library body', fileUrl: null });
  });
  it('the buyer\'s portal lists a submitted copy asset with its headline and body text', async () => {
    const r = await call('upload_asset', { mediaType: 'copy', clientId: DEMO_CLIENT, campaignId: camp, headline: `Portal ${tag}`, bodyText: 'Portal body', name: `Yash Test COPY portal ${tag}` });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    const id = r.structuredContent.creativeId;
    // A draft is invisible to the buyer; once submitted it shows up.
    const hidden = await request(app).get('/api/v1/portal/creatives').set('Authorization', `Bearer ${portal}`);
    expect(JSON.stringify(hidden.body)).not.toContain(id);
    await db.update(creatives).set({ status: 'sent_for_approval', submittedAt: new Date() }).where(eq(creatives.id, id));
    const lists = await request(app).get('/api/v1/portal/creatives').set('Authorization', `Bearer ${portal}`);
    const item = [...(lists.body.data.copyLp ?? []), ...(lists.body.data.media ?? [])].find((c: any) => c.id === id);
    expect(item, 'the copy asset is in the portal list').toBeTruthy();
    expect(item).toMatchObject({ type: 'copy', section: 'copy_lp', headline: `Portal ${tag}`, bodyText: 'Portal body', fileUrl: '', signedUrl: null });
    const compliance = await request(app).get('/api/v1/portal/compliance').set('Authorization', `Bearer ${portal}`);
    const rows = (compliance.body.data.compliance ?? compliance.body.data ?? []) as Array<{ creatives: any[] }>;
    const inCompliance = (Array.isArray(rows) ? rows : []).flatMap((c) => c.creatives).find((c: any) => c.id === id);
    expect(inCompliance).toMatchObject({ type: 'copy', headline: `Portal ${tag}`, bodyText: 'Portal body' });
  });
});

// Review of #97: a copy upsert by platformCreativeId must not touch another business's or another client's creative.
describe('copy upsert by platformCreativeId is scoped', () => {
  let biz2 = ''; let c2 = ''; const pid = `copy-scope-${tag}`;
  beforeAll(async () => {
    biz2 = (await db.insert(businesses).values({ name: `Yash Test COPY biz2 ${tag}`, slug: `yash-test-copy-${tag}` }).returning())[0]!.id;
    c2 = (await db.insert(clients).values({ businessId: biz2, companyName: `Yash Test COPY other ${tag}`, status: 'active' }).returning())[0]!.id;
  });
  afterAll(async () => {
    await db.delete(creatives).where(eq(creatives.platformCreativeId, pid));
    await db.delete(clients).where(eq(clients.id, c2));
    await db.delete(businesses).where(eq(businesses.id, biz2));
  });
  it('another business filing the same platformCreativeId is refused and the first headline survives', async () => {
    const theirs = await upsertCopyCreative({ businessId: biz2, clientId: c2, platform: 'meta', platformCreativeId: pid, headline: `Their secret headline ${tag}` });
    await expect(upsertCopyCreative({ businessId: BIZ, clientId: A, platform: 'meta', platformCreativeId: pid, headline: `Overwritten by business 1 ${tag}` }))
      .rejects.toMatchObject({ statusCode: 409 });
    const after = await rowOf(theirs.creative.id);
    expect(after.headline).toBe(`Their secret headline ${tag}`);
    expect(after.clientId).toBe(c2);
  });
  it('another client of the same business is refused too', async () => {
    const pidB = `${pid}-b`;
    const first = await upsertCopyCreative({ businessId: BIZ, clientId: B, platform: 'meta', platformCreativeId: pidB, headline: `B headline ${tag}` });
    await expect(upsertCopyCreative({ businessId: BIZ, clientId: A, platform: 'meta', platformCreativeId: pidB, headline: `Hijacked ${tag}` }))
      .rejects.toMatchObject({ statusCode: 409 });
    const after = await rowOf(first.creative.id);
    expect(after.headline).toBe(`B headline ${tag}`);
    expect(after.clientId).toBe(B);
    await db.delete(creatives).where(eq(creatives.platformCreativeId, pidB));
  });
  it('the same client sending the same platformCreativeId still updates its own copy', async () => {
    const pidC = `${pid}-c`;
    const first = await upsertCopyCreative({ businessId: BIZ, clientId: A, platform: 'meta', platformCreativeId: pidC, headline: `One ${tag}` });
    const again = await upsertCopyCreative({ businessId: BIZ, clientId: A, platform: 'meta', platformCreativeId: pidC, headline: `Two ${tag}` });
    expect(again.created).toBe(false);
    expect(again.creative.id).toBe(first.creative.id);
    expect((await rowOf(first.creative.id)).headline).toBe(`Two ${tag}`);
    await db.delete(creatives).where(eq(creatives.platformCreativeId, pidC));
  });
});
