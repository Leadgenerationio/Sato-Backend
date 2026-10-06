import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { domainEvents } from '../services/events.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { businesses } from '../db/schema/businesses.js';
import { linkAdPlatformIds } from '../services/creative-ad-links.service.js';

// MCP spec v1.0 tests 4, 5, 15 (landing page side) and the no-duplicate rule for ads.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACC = `55${tag}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = '';
let key = ''; let keyId = ''; let readKey = '';
let clientA = ''; let clientB = '';
let cr1 = ''; let cr2 = ''; let crB = '';
const keyIds: string[] = [];

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test adl ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key as string, id: res.body.data.apiKey.id as string };
}
async function call(k: string, name: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}
const linkRows = (creativeId: string) => db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, creativeId));

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  ({ key, id: keyId } = await makeKey(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'ad_links:write']));
  readKey = (await makeKey(['creatives:read'])).key;
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test ADL A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test ADL B ${tag}`, status: 'active' },
  ]).returning();
  clientA = cs[0]!.id; clientB = cs[1]!.id;
  const rows = await db.insert(creatives).values([
    { name: `Yash ADL one ${tag}`, fileUrl: 'x', clientId: clientA, sha256: `a${tag}`.padEnd(64, '0') },
    { name: `Yash ADL two ${tag}`, fileUrl: 'x', clientId: clientA },
    { name: `Yash ADL B ${tag}`, fileUrl: 'x', clientId: clientB },
  ]).returning();
  cr1 = rows[0]!.id; cr2 = rows[1]!.id; crB = rows[2]!.id;
  await call(key, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `act_${ACC}1` });
  await call(key, 'link_ad_account', { clientId: clientB, platform: 'meta', accountId: `act_${ACC}2` });
});
afterAll(async () => {
  const ids = [cr1, cr2, crB];
  await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(creatives).where(inArray(creatives.id, ids));
  await db.delete(landingPages).where(inArray(landingPages.clientId, [clientA, clientB]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [clientA, clientB]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('link_ad_platform_ids', () => {
  const full = (extra: Record<string, unknown> = {}) => ({
    creativeId: cr1, platform: 'meta', accountId: `act_${ACC}1`, platformCampaignId: '120200000001', platformCampaignName: 'Hearing Aids CH',
    adsetId: '120200000002', adsetName: 'Adset', adId: `ad${tag}`, adName: 'Ad one', platformCreativeId: '120200000004', platformAssetId: '99887766', ...extra,
  });
  it('records every ID with the account as act_… and stores digits (test 4)', async () => {
    const events: unknown[] = [];
    const on = (e: unknown) => events.push(e);
    domainEvents.on('creative.changed', on);
    const r = await call(key, 'link_ad_platform_ids', full());
    domainEvents.off('creative.changed', on);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.result).toBe('created');
    expect(r.structuredContent.adLink).toMatchObject({
      creativeId: cr1, clientId: clientA, platform: 'meta', accountId: `${ACC}1`, platformCampaignId: '120200000001', adsetId: '120200000002',
      adId: `ad${tag}`, platformCreativeId: '120200000004', platformAssetId: '99887766', status: 'active', source: 'mcp',
    });
    const [row] = await linkRows(cr1);
    expect(row).toMatchObject({ createdByKeyId: keyId, platformAccountId: `${ACC}1` });
    expect(events).toHaveLength(1); // the creative.changed webhook event fires
    const [c] = await db.select().from(creatives).where(eq(creatives.id, cr1));
    expect(c).toMatchObject({ platform: 'meta', platformAccountId: `${ACC}1`, platformAdId: `ad${tag}`, platformCreativeId: '120200000004' }); // legacy columns filled from the first link
  });
  it('the same call again is unchanged; a changed name updates the one link', async () => {
    expect((await call(key, 'link_ad_platform_ids', full())).structuredContent.result).toBe('unchanged');
    const upd = await call(key, 'link_ad_platform_ids', full({ adName: 'Renamed' }));
    expect(upd.structuredContent.result).toBe('updated');
    expect(upd.structuredContent.adLink.adName).toBe('Renamed');
    expect(await linkRows(cr1)).toHaveLength(1);
  });
  it('refuses an account that belongs to a different client, saving nothing (test 5)', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `act_${ACC}2`, adId: `adB${tag}` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'account_client_mismatch', retryable: false });
    expect(await linkRows(cr1)).toHaveLength(1);
  });
  it('refuses an unlinked account with account_not_linked', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}9`, adId: `adX${tag}` });
    expect(r.structuredContent.code).toBe('account_not_linked');
    expect(r.structuredContent.hint).toContain('link_ad_account');
  });
  it('the same ad on another asset is result duplicate (not an error), naming the existing link, and saves nothing', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr2, platform: 'meta', accountId: `${ACC}1`, adId: `ad${tag}`, landingPageUrl: `https://dup-${tag}.example.com/` });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.result).toBe('duplicate');
    expect(r.structuredContent.adLink).toMatchObject({ creativeId: cr1, adId: `ad${tag}` });
    expect(await linkRows(cr2)).toHaveLength(0);
    expect(await db.select().from(landingPages).where(eq(landingPages.url, `https://dup-${tag}.example.com/`))).toHaveLength(0);
  });
  it('needs one platform ID; an unknown asset is not_found; a read-only key is refused', async () => {
    const none = await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}1` });
    expect(none.structuredContent.code).toBe('validation_failed');
    expect(none.structuredContent.fields[0].field).toBe('adId');
    const missing = await call(key, 'link_ad_platform_ids', { creativeId: '11111111-1111-4111-8111-111111111111', platform: 'meta', accountId: `${ACC}1`, adId: 'z' });
    expect(missing.structuredContent.code).toBe('not_found');
    expect((await call(readKey, 'link_ad_platform_ids', full({ adId: 'q' }))).structuredContent.code).toBe('insufficient_scope');
  });
  it('an asset can be in several ads: a second ad on the same asset adds a second link', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}1`, adId: `ad2${tag}` });
    expect(r.structuredContent.result).toBe('created');
    expect(await linkRows(cr1)).toHaveLength(2);
  });
  it('the landing page URL is saved once even with utm_ and fbclid added twice (test 15)', async () => {
    const base = `https://example.com/offer-${tag}`;
    await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}1`, adId: `ad3${tag}`, landingPageUrl: `${base}?utm_source=a&fbclid=1&utm_source=b&fbclid=2` });
    await call(key, 'link_ad_platform_ids', { creativeId: cr2, platform: 'meta', accountId: `${ACC}1`, adId: `ad4${tag}`, landingPageUrl: `${base}?utm_medium=z&fbclid=3` });
    const pages = await db.select().from(landingPages).where(eq(landingPages.clientId, clientA));
    expect(pages).toHaveLength(1);
    const links = await db.select().from(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, [cr1, cr2]));
    expect(new Set(links.map((l) => l.landingPageId).filter(Boolean)).size).toBe(1);
  });
});

describe('find_asset_by_platform_id', () => {
  it('finds by ad ID, creative ID, asset ID and file hash; not found is an answer', async () => {
    const byAd = await call(readKey, 'find_asset_by_platform_id', { platform: 'meta', adId: `ad${tag}` });
    expect(byAd.structuredContent).toMatchObject({ found: true, creative: { id: cr1 }, adLink: { adId: `ad${tag}` } });
    expect((await call(readKey, 'find_asset_by_platform_id', { platform: 'facebook-ads', platformCreativeId: '120200000004' })).structuredContent.creative.id).toBe(cr1);
    expect((await call(readKey, 'find_asset_by_platform_id', { platform: 'meta', platformAssetId: '99887766' })).structuredContent.creative.id).toBe(cr1);
    expect((await call(readKey, 'find_asset_by_platform_id', { sha256: `a${tag}`.padEnd(64, '0') })).structuredContent.creative.id).toBe(cr1);
    const none = await call(readKey, 'find_asset_by_platform_id', { platform: 'meta', adId: 'does-not-exist' });
    expect(none.isError).toBeUndefined();
    expect(none.structuredContent).toEqual({ found: false, creative: null, adLink: null });
  });
  it('needs a platform with an ad ID', async () => {
    expect((await call(readKey, 'find_asset_by_platform_id', { adId: 'x' })).structuredContent.code).toBe('validation_failed');
  });
});

describe('unlink_ad_platform_ids', () => {
  it('marks the link removed and keeps it; repeating is unchanged; the ad can then go to another asset', async () => {
    const [target] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.platformAdId, `ad2${tag}`));
    const r = await call(key, 'unlink_ad_platform_ids', { adLinkId: target!.id, reason: 'wrong asset' });
    expect(r.structuredContent).toMatchObject({ result: 'removed', adLinkId: target!.id });
    expect(r.structuredContent.removedAt).not.toBeNull();
    const [kept] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.id, target!.id));
    expect(kept).toMatchObject({ status: 'removed' }); // history is kept
    expect((await call(key, 'unlink_ad_platform_ids', { adLinkId: target!.id })).structuredContent.result).toBe('unchanged');
    const again = await call(key, 'link_ad_platform_ids', { creativeId: cr2, platform: 'meta', accountId: `${ACC}1`, adId: `ad2${tag}` });
    expect(again.structuredContent.result).toBe('created');
  });
  it('an unknown link is not_found', async () => {
    expect((await call(key, 'unlink_ad_platform_ids', { adLinkId: '11111111-1111-4111-8111-111111111111' })).structuredContent.code).toBe('not_found');
  });
});

describe('review of #76', () => {
  const caller = { businessId: BIZ, userId: null, keyId: null, source: 'mcp' as const };
  const extra: { creatives: string[]; campaigns: string[]; biz: string[]; clients: string[] } = { creatives: [], campaigns: [], biz: [], clients: [] };
  afterAll(async () => {
    await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, extra.creatives));
    await db.delete(creatives).where(inArray(creatives.id, extra.creatives));
    await db.delete(trafficSources).where(inArray(trafficSources.campaignId, extra.campaigns));
    await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, extra.campaigns));
    await db.delete(campaigns).where(inArray(campaigns.id, extra.campaigns));
    await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, extra.clients));
    await db.delete(clients).where(inArray(clients.id, extra.clients));
    await db.delete(businesses).where(inArray(businesses.id, extra.biz));
  });
  const newCreative = async (name: string, clientId: string, platform?: string) => {
    const [c] = await db.insert(creatives).values({ name: `${name} ${tag}`, fileUrl: 'x', clientId, ...(platform ? { platform } : {}) }).returning();
    extra.creatives.push(c!.id);
    return c!.id;
  };

  it('a non-UUID creativeId or adLinkId is validation_failed naming the field', async () => {
    const a = await call(key, 'link_ad_platform_ids', { creativeId: 'not-a-uuid', platform: 'meta', accountId: `${ACC}1`, adId: 'q' });
    expect(a.structuredContent).toMatchObject({ code: 'validation_failed', fields: [{ field: 'creativeId' }] });
    const b = await call(key, 'unlink_ad_platform_ids', { adLinkId: 'nope' });
    expect(b.structuredContent).toMatchObject({ code: 'validation_failed', fields: [{ field: 'adLinkId' }] });
  });

  it('a link cannot be created as removed', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}1`, adId: `rm${tag}`, status: 'removed' });
    expect(r.structuredContent.code).toBe('validation_failed');
    await expect(linkAdPlatformIds(caller, { creativeId: cr1, platform: 'meta', accountId: `${ACC}1`, adId: `rm${tag}`, status: 'removed' as never })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.platformAdId, `rm${tag}`))).toHaveLength(0);
  });

  it('a second ad-less link on the same asset (another video ID) is a second link, not internal_error', async () => {
    const c = await newCreative('Yash ADL vids', clientA);
    const one = await call(key, 'link_ad_platform_ids', { creativeId: c, platform: 'meta', accountId: `${ACC}1`, platformAssetId: `vid1${tag}` });
    const two = await call(key, 'link_ad_platform_ids', { creativeId: c, platform: 'meta', accountId: `${ACC}1`, platformAssetId: `vid2${tag}` });
    expect(one.structuredContent.result).toBe('created');
    expect(two.structuredContent.result).toBe('created');
    expect(two.isError).toBeUndefined();
    expect((await call(key, 'link_ad_platform_ids', { creativeId: c, platform: 'meta', accountId: `${ACC}1`, platformAssetId: `vid1${tag}` })).structuredContent.result).toBe('unchanged');
    expect(await linkRows(c)).toHaveLength(2);
  });

  it('losing a race on the unique index (wrapped 23505) settles on the winner, not internal_error', async () => {
    const c = await newCreative('Yash ADL race', clientA);
    const input = { creativeId: c, platform: 'meta', accountId: `${ACC}1`, adId: `race${tag}` };
    const realInsert = db.insert.bind(db);
    const spy = vi.spyOn(db, 'insert').mockImplementationOnce(((table: typeof creativeAdLinks) => ({
      values: (v: typeof creativeAdLinks.$inferInsert) => ({
        returning: async () => {
          await realInsert(table).values(v).returning();
          throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } }); // how Drizzle reports it
        },
      }),
    })) as unknown as typeof db.insert);
    const out = await linkAdPlatformIds(caller, input);
    spy.mockRestore();
    expect(out.result).toBe('unchanged');
    expect(await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.platformAdId, `race${tag}`))).toHaveLength(1);
  });

  it('an ad that another business already holds is duplicate without showing its IDs', async () => {
    const [other] = await db.insert(businesses).values({ name: `Yash Test Biz ${tag}`, slug: `yash-adl-${tag}` }).returning();
    extra.biz.push(other!.id);
    const [oc] = await db.insert(clients).values({ businessId: other!.id, companyName: `Yash Test ADL Other ${tag}`, status: 'active' }).returning();
    extra.clients.push(oc!.id);
    const [ocr] = await db.insert(creatives).values({ name: `Yash ADL other ${tag}`, fileUrl: 'x', clientId: oc!.id }).returning();
    extra.creatives.push(ocr!.id);
    await db.insert(creativeAdLinks).values({ businessId: other!.id, creativeId: ocr!.id, platform: 'meta', platformAdId: `xb${tag}` });
    const c = await newCreative('Yash ADL xbiz', clientA);
    const r = await call(key, 'link_ad_platform_ids', { creativeId: c, platform: 'meta', accountId: `${ACC}1`, adId: `xb${tag}` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('duplicate');
    expect(JSON.stringify(r.structuredContent)).not.toContain(ocr!.id);
  });

  it('an account that feeds several campaigns makes the caller send the Stato campaignId', async () => {
    const camps = await db.insert(campaigns).values([{ name: `Yash ADL Solar ${tag}` }, { name: `Yash ADL Heat ${tag}` }, { name: `Yash ADL Other ${tag}` }]).returning();
    extra.campaigns.push(...camps.map((x) => x.id));
    const [c1, c2, c3] = camps.map((x) => x.id) as [string, string, string];
    await db.insert(clientCampaigns).values([{ clientId: clientA, campaignId: c1 }, { clientId: clientA, campaignId: c2 }, { clientId: clientB, campaignId: c3 }]);
    const acc = `${ACC}5`;
    await call(key, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: acc, campaignId: c1 });
    await db.insert(trafficSources).values({ campaignId: c2, name: `Yash ADL src ${tag}`, platform: 'facebook-ads', accountId: acc });
    const cr = await newCreative('Yash ADL multi', clientA);

    const asked = await call(key, 'link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: acc, adId: `m1${tag}` });
    expect(asked.structuredContent).toMatchObject({ code: 'validation_failed', fields: [{ field: 'campaignId' }] });
    expect(asked.structuredContent.hint).toContain(c2);
    expect(await linkRows(cr)).toHaveLength(0);

    const chosen = await call(key, 'link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: acc, adId: `m1${tag}`, campaignId: c2 });
    expect(chosen.structuredContent.result).toBe('created');
    expect(chosen.structuredContent.adLink.campaignId).toBe(c2);

    const wrong = await call(key, 'link_ad_platform_ids', { creativeId: cr, platform: 'meta', accountId: acc, adId: `m2${tag}`, campaignId: c3 });
    expect(wrong.structuredContent.code).toBe('campaign_client_mismatch');
  });

  it('the first link fills the legacy platform columns even when the asset was uploaded in the portal (platform manual)', async () => {
    const c = await newCreative('Yash ADL manual', clientA, 'manual');
    await call(key, 'link_ad_platform_ids', { creativeId: c, platform: 'meta', accountId: `${ACC}1`, adId: `man${tag}` });
    const [row] = await db.select().from(creatives).where(eq(creatives.id, c));
    expect(row).toMatchObject({ platform: 'meta', platformAdId: `man${tag}` });
  });

  it('link and unlink need ad_links:write, creatives:write alone is not enough', async () => {
    const cw = (await makeKey(['creatives:write'])).key;
    expect((await call(cw, 'link_ad_platform_ids', { creativeId: cr1, platform: 'meta', accountId: `${ACC}1`, adId: 'q2' })).structuredContent.code).toBe('insufficient_scope');
    expect((await call(cw, 'unlink_ad_platform_ids', { adLinkId: '11111111-1111-4111-8111-111111111111' })).structuredContent.code).toBe('insufficient_scope');
  });
});
