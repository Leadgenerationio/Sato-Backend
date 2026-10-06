import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  ({ key, id: keyId } = await makeKey(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write']));
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
    creativeId: cr1, platform: 'meta', accountId: `act_${ACC}1`, campaignId: '120200000001', campaignName: 'Hearing Aids CH',
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
  it('the same ad on another asset is the error duplicate, naming the existing link', async () => {
    const r = await call(key, 'link_ad_platform_ids', { creativeId: cr2, platform: 'meta', accountId: `${ACC}1`, adId: `ad${tag}` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'duplicate' });
    expect(r.structuredContent.details.creativeId).toBe(cr1);
    expect(await linkRows(cr2)).toHaveLength(0);
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
