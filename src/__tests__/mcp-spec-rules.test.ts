import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// MCP spec v1.0 section 2.1, "Rules the tools must enforce", one describe per rule, through the real tools.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
const ALL = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'ad_accounts:write', 'ad_links:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'landing_pages:write'];
let owner = ''; let key = ''; let A = ''; let B = ''; let CA = ''; let CB = ''; let CS = '';
const keyIds: string[] = []; const campIds: string[] = [];
const png = (seed: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`${seed}-${tag}`)]);
const files = new Map<string, Buffer>();
const real = globalThis.fetch; let spy: ReturnType<typeof vi.spyOn>;
const url = (n: string) => `https://93.184.216.34/${tag}/${n}.png`;
const acct = (n: number) => `${tag}${n}`; // digits only: the stored form of a Meta account

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}
const upload = (n: string, extra: Record<string, unknown> = {}) => { files.set(url(n), png(n)); return call('upload_asset', { sourceUrl: url(n), mediaType: 'image', name: `Yash Test RULES ${n} ${tag}`, ...extra }); };
const countCreatives = async () => (await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [A, B]))).length;

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test rules ${tag}`, scopes: ALL });
  keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
  A = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test RULES A ${tag}`, status: 'active' }).returning())[0]!.id;
  B = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test RULES B ${tag}`, status: 'active' }).returning())[0]!.id;
  const camp = async (n: string, buyer?: string) => { const c = (await db.insert(campaigns).values({ name: `Yash Test RULES camp ${n} ${tag}`, leadbyteCampaignId: `RULES-${n}-${tag}` }).returning())[0]!.id; campIds.push(c); if (buyer) await db.insert(clientCampaigns).values({ clientId: buyer, campaignId: c }); return c; };
  CA = await camp('A', A); CB = await camp('B', B); CS = await camp('S');
  await call('link_ad_account', { clientId: A, platform: 'meta', accountId: `act_${acct(1)}` });
  await call('link_ad_account', { clientId: B, platform: 'meta', accountId: acct(2) });
  spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const href = String(input instanceof URL ? input.href : input);
    const f = files.get(href);
    if (!f) return real(input, init);
    return new Response(new Uint8Array(f), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(f.length) } });
  });
});
afterAll(async () => {
  spy.mockRestore();
  const ids = (await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [A, B]))).map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(creatives).where(inArray(creatives.clientId, [A, B]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [A, B]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.clientId, [A, B]));
  await db.delete(clients).where(inArray(clients.id, [A, B]));
  await db.delete(campaigns).where(inArray(campaigns.id, campIds));
  await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
  await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('Client from account', () => {
  it('an upload with platform + accountId is filed under the client the account is linked to', async () => {
    const r = await upload('cfa1', { platform: 'meta', platformAccountId: `act_${acct(1)}` });
    expect(r.isError).toBeUndefined();
    const [row] = await db.select().from(creatives).where(eq(creatives.id, r.structuredContent.creativeId));
    expect(row!.clientId).toBe(A);
  });
  it('a clientId that does not match the account is account_client_mismatch, and nothing is saved', async () => {
    const before = await countCreatives();
    const r = await upload('cfa2', { platform: 'meta', platformAccountId: `act_${acct(1)}`, clientId: B });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('account_client_mismatch');
    expect(await countCreatives()).toBe(before);
  });
  it('a clientId that does match is accepted as a cross-check', async () => {
    expect((await upload('cfa3', { platform: 'meta', platformAccountId: `act_${acct(1)}`, clientId: A })).isError).toBeUndefined();
  });
  it('an ad link whose account belongs to another client than the asset is account_client_mismatch, nothing saved', async () => {
    const cr = (await upload('cfa4', { platform: 'meta', platformAccountId: acct(2) })).structuredContent.creativeId; // B's asset
    const r = await call('link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: acct(1), adId: `cfa-ad-${tag}` }); // A's account
    expect(r.structuredContent.code).toBe('account_client_mismatch');
    expect(await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, cr))).toHaveLength(0);
  });
});

describe('Unlinked account', () => {
  it('upload and ad link both refuse with account_not_linked and a hint to use link_ad_account', async () => {
    const before = await countCreatives();
    const u = await upload('unl1', { platform: 'meta', platformAccountId: `${tag}9999` });
    expect(u.structuredContent.code).toBe('account_not_linked');
    expect(u.structuredContent.hint).toContain('link_ad_account');
    expect(await countCreatives()).toBe(before);
    const cr = (await upload('unl2', { platform: 'meta', platformAccountId: acct(1) })).structuredContent.creativeId;
    const l = await call('link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: `${tag}9999`, adId: `unl-${tag}` });
    expect(l.structuredContent.code).toBe('account_not_linked');
    expect(l.structuredContent.hint).toContain('link_ad_account');
  });
  it('never guesses from names: an unlinked account that carries a client\'s name is still not linked', async () => {
    const r = await call('find_client_by_ad_account', { platform: 'meta', accountId: `${tag}8888` });
    expect(r.structuredContent.code).toBe('account_not_linked');
    expect(r.structuredContent.hint).toMatch(/Do not guess from names/i);
  });
});

describe('Campaign check', () => {
  it('a campaign that belongs to another client is campaign_client_mismatch (upload, ad link, account link), nothing saved', async () => {
    const before = await countCreatives();
    const u = await upload('cmp1', { platform: 'meta', platformAccountId: acct(1), campaignId: CB });
    expect(u.structuredContent.code).toBe('campaign_client_mismatch');
    expect(await countCreatives()).toBe(before);
    const cr = (await upload('cmp2', { platform: 'meta', platformAccountId: acct(1), campaignId: CA })).structuredContent.creativeId;
    expect((await call('link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: acct(1), adId: `cmp-${tag}`, campaignId: CB })).structuredContent.code).toBe('campaign_client_mismatch');
    expect((await call('link_ad_account', { clientId: A, platform: 'meta', accountId: `${tag}7777`, campaignId: CB })).structuredContent.code).toBe('campaign_client_mismatch');
  });
  it('the client\'s own campaign is accepted, by Stato UUID or by LeadByte number', async () => {
    expect((await upload('cmp3', { platform: 'meta', platformAccountId: acct(1), campaignId: CA })).isError).toBeUndefined();
    expect((await upload('cmp4', { platform: 'meta', platformAccountId: acct(1), campaignId: `RULES-A-${tag}` })).isError).toBeUndefined();
  });
  it('a shared campaign with no client is accepted', async () => {
    const r = await upload('cmp5', { platform: 'meta', platformAccountId: acct(1), campaignId: CS });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  });
});

describe('Normalise IDs on the way in and store one form', () => {
  it('platform names: facebook-ads, google-ads and tik-tok come back as meta, google and tiktok', async () => {
    const out: string[] = [];
    for (const [p, id] of [['facebook-ads', `${tag}11`], ['google-ads', `${tag}22`], ['tik-tok', `${tag}33`]] as const) out.push((await call('link_ad_account', { clientId: A, platform: p, accountId: id })).structuredContent.link.platform);
    expect(out).toEqual(['meta', 'google', 'tiktok']);
  });
  it('Meta accounts work with or without act_ and return the stored form (digits)', async () => {
    const a = await call('find_client_by_ad_account', { platform: 'meta', accountId: `act_${acct(1)}` });
    const b = await call('find_client_by_ad_account', { platform: 'meta', accountId: acct(1) });
    const c = await call('find_client_by_ad_account', { platform: 'facebook-ads', accountId: `ACT_${acct(1)}` });
    for (const r of [a, b, c]) { expect(r.structuredContent.accountId).toBe(acct(1)); expect(r.structuredContent.client.clientId).toBe(A); }
  });
  it('Google customer IDs work with or without dashes and return the stored form (digits)', async () => {
    const digits = `${tag}0`.slice(0, 10); const dashed = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    const linked = await call('link_ad_account', { clientId: A, platform: 'google', accountId: dashed });
    expect(linked.structuredContent.link.accountId).toBe(digits);
    for (const id of [dashed, digits]) expect((await call('find_client_by_ad_account', { platform: 'google', accountId: id })).structuredContent.client.clientId).toBe(A);
  });
  it('TikTok 19-digit IDs are kept exactly, as strings', async () => {
    const id = `7${tag}`.padEnd(19, '1');
    expect((await call('link_ad_account', { clientId: A, platform: 'tiktok', accountId: id })).structuredContent.link.accountId).toBe(id);
  });
});

describe('No duplicates', () => {
  it('the same (platform, adId) is one ad link; the same ad on another asset is result duplicate with the existing link, not an error', async () => {
    const c1 = (await upload('dup1', { platform: 'meta', platformAccountId: acct(1) })).structuredContent.creativeId;
    const c2 = (await upload('dup2', { platform: 'meta', platformAccountId: acct(1) })).structuredContent.creativeId;
    const first = await call('link_ad_platform_ids', { creativeId: c1, platform: 'meta', accountId: acct(1), adId: `dup-ad-${tag}` });
    const again = await call('link_ad_platform_ids', { creativeId: c1, platform: 'meta', accountId: acct(1), adId: `dup-ad-${tag}` });
    const other = await call('link_ad_platform_ids', { creativeId: c2, platform: 'meta', accountId: acct(1), adId: `dup-ad-${tag}` });
    expect(first.structuredContent.result).toBe('created');
    expect(again.structuredContent.result).toBe('unchanged');
    expect(other.isError).toBeUndefined();
    expect(other.structuredContent.result).toBe('duplicate');
    expect(other.structuredContent.adLink.creativeId).toBe(c1);
    expect(await db.select().from(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, [c1, c2]))).toHaveLength(1);
  });
  it('the same file for the same client is one creative (result duplicate with the existing ID); another client gets its own', async () => {
    files.set(url('same'), png('same'));
    const a1 = await call('upload_asset', { sourceUrl: url('same'), mediaType: 'image', platform: 'meta', platformAccountId: acct(1), name: `Yash Test RULES same ${tag}` });
    const a2 = await call('upload_asset', { sourceUrl: url('same'), mediaType: 'image', platform: 'meta', platformAccountId: acct(1), name: `Yash Test RULES same again ${tag}` });
    const b1 = await call('upload_asset', { sourceUrl: url('same'), mediaType: 'image', platform: 'meta', platformAccountId: acct(2), name: `Yash Test RULES same B ${tag}` });
    expect(a1.structuredContent.result).toBe('created');
    expect(a2.isError).toBeUndefined();
    expect(a2.structuredContent).toMatchObject({ result: 'duplicate', creativeId: a1.structuredContent.creativeId });
    expect(b1.structuredContent.result).toBe('created');
    expect(b1.structuredContent.creativeId).not.toBe(a1.structuredContent.creativeId);
  });
  it('the same (platform, platformCreativeId) updates rather than copies', async () => {
    const ad = { platformCreativeId: `pcid-${tag}` };
    const first = await upload('pc1', { platform: 'meta', platformAccountId: acct(1), adLink: ad, headline: 'First headline' });
    files.set(url('pc2'), png('pc2'));
    const second = await call('upload_asset', { sourceUrl: url('pc2'), mediaType: 'image', platform: 'meta', platformAccountId: acct(1), adLink: ad, headline: 'Second headline', name: `Yash Test RULES pc ${tag}` });
    expect(second.structuredContent.creativeId).toBe(first.structuredContent.creativeId);
    expect(second.structuredContent.result).toBe('updated');
    expect(await db.select().from(creatives).where(eq(creatives.platformCreativeId, `pcid-${tag}`))).toHaveLength(1);
  });
});

describe('Platform field meanings', () => {
  it('adsetId and platformAssetId are stored as given for Meta, Google and TikTok; Taboola has no ad set', async () => {
    const cr = (await upload('pfm1', { platform: 'meta', platformAccountId: acct(1) })).structuredContent.creativeId;
    for (const [p, acc] of [['meta', acct(1)], ['google', `${tag}0`.slice(0, 10)], ['tiktok', `7${tag}`.padEnd(19, '1')]] as const) {
      const r = await call('link_ad_platform_ids', { creativeId: cr, platform: p, accountId: acc, adsetId: `0123${tag}`, adId: `pfm-${p}-${tag}`, platformAssetId: `asset-${p}-${tag}` });
      expect(r.isError, `${p}: ${JSON.stringify(r.structuredContent).slice(0, 160)}`).toBeUndefined();
      expect(r.structuredContent.adLink).toMatchObject({ adsetId: `0123${tag}`, platformAssetId: `asset-${p}-${tag}` });
    }
  });
  it('the tool descriptions say what adsetId and platformAssetId mean for each platform', async () => {
    const tools = (await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as Array<{ name: string; inputSchema: any }>;
    const props = tools.find((t) => t.name === 'link_ad_platform_ids')!.inputSchema.properties;
    expect(props.adsetId.description).toMatch(/Meta ad set.*Google ad group.*TikTok ad group.*Taboola has none/i);
    expect(props.platformAssetId.description).toMatch(/Meta image hash or video ID.*Google asset resource name.*TikTok video or image ID/i);
  });
});
