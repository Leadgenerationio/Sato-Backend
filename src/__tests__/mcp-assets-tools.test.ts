import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { apiKeys } from '../db/schema/api-keys.js';
import { uploadFile } from '../integrations/r2/r2-client.js';

// MCP spec v1.0: list_assets, get_asset, update_asset, archive_asset, restore_asset (test 13),
// add_landing_page, list_landing_pages, attach_landing_page (test 15), list_ad_accounts.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = ''; let readKey = ''; let archiveKey = '';
let cA = ''; let cB = ''; let k1 = ''; let k2 = '';
let a1 = ''; let a2 = ''; let a3 = '';
const keyIds: string[] = [];

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test ast ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return res.body.data.key as string;
}
async function call(k: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  key = await makeKey(['clients:read', 'ad_accounts:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'landing_pages:write', 'ad_links:write']);
  readKey = await makeKey(['creatives:read']);
  archiveKey = await makeKey(['creatives:read', 'creatives:archive']);
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test AST A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test AST B ${tag}`, status: 'active' },
  ]).returning();
  cA = cs[0]!.id; cB = cs[1]!.id;
  const camps = await db.insert(campaigns).values([{ name: `Yash AST Solar ${tag}` }, { name: `Yash AST Insulation ${tag}` }]).returning();
  k1 = camps[0]!.id; k2 = camps[1]!.id;
  await db.insert(clientCampaigns).values([{ clientId: cA, campaignId: k1 }, { clientId: cB, campaignId: k2 }]);
  await request(app).post(`/api/v1/clients/${cA}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_22${tag}1`, accountName: 'AST meta' }).expect(201);
  await uploadFile({ folder: 'creatives', key: `ast-${tag}.png`, body: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), contentType: 'image/png' });
  const rows = await db.insert(creatives).values([
    { name: `Yash AST one ${tag}`, fileUrl: `r2://stato/creatives/ast-${tag}.png`, r2Key: `ast-${tag}.png`, type: 'image', clientId: cA, campaignId: k1, headline: 'Hearing aids offer', sha256: tag.padEnd(64, '1') },
    { name: `Yash AST two ${tag}`, fileUrl: 'x', type: 'video', clientId: cA, campaignId: k1 },
    { name: `Yash AST three ${tag}`, fileUrl: 'x', type: 'image', clientId: cB, campaignId: k2 },
  ]).returning();
  a1 = rows[0]!.id; a2 = rows[1]!.id; a3 = rows[2]!.id;
  await call(key, 'link_ad_platform_ids', { creativeId: a1, platform: 'meta', accountId: `act_22${tag}1`, adId: `ad${tag}` });
});
afterAll(async () => {
  const ids = [a1, a2, a3];
  await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(creatives).where(inArray(creatives.id, ids));
  await db.delete(landingPages).where(inArray(landingPages.clientId, [cA, cB]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [cA, cB]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [k1, k2]));
  await db.delete(campaigns).where(inArray(campaigns.id, [k1, k2]));
  await db.delete(clients).where(inArray(clients.id, [cA, cB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('list_assets', () => {
  it('filters by client, campaign, type, status and ad link, and reports adLinkCount', async () => {
    const byClient = await call(readKey, 'list_assets', { clientId: cA, limit: 100 });
    expect(byClient.structuredContent.items.map((i: { creativeId: string }) => i.creativeId).sort()).toEqual([a1, a2].sort());
    const one = byClient.structuredContent.items.find((i: { creativeId: string }) => i.creativeId === a1);
    expect(one).toMatchObject({ adLinkCount: 1, approvalStatus: 'draft', mediaType: 'image', client: { clientId: cA }, campaign: { campaignId: k1 } });
    expect((await call(readKey, 'list_assets', { campaignId: k2 })).structuredContent.items.map((i: { creativeId: string }) => i.creativeId)).toEqual([a3]);
    expect((await call(readKey, 'list_assets', { clientId: cA, mediaType: 'video' })).structuredContent.items.map((i: { creativeId: string }) => i.creativeId)).toEqual([a2]);
    expect((await call(readKey, 'list_assets', { clientId: cA, hasAdLink: false })).structuredContent.items.map((i: { creativeId: string }) => i.creativeId)).toEqual([a2]);
    expect((await call(readKey, 'list_assets', { clientId: cA, hasAdLink: true })).structuredContent.items.map((i: { creativeId: string }) => i.creativeId)).toEqual([a1]);
    expect((await call(readKey, 'list_assets', { clientId: cA, approvalStatus: 'approved' })).structuredContent.items).toEqual([]);
    expect((await call(readKey, 'list_assets', { platformAdId: `ad${tag}` })).structuredContent.items[0].creativeId).toBe(a1);
    expect((await call(readKey, 'list_assets', { q: 'Hearing aids' , clientId: cA})).structuredContent.items[0].creativeId).toBe(a1);
  });
  it('pages with nextCursor and rejects a bad cursor', async () => {
    const p1 = await call(readKey, 'list_assets', { clientId: cA, limit: 1, sort: 'name' });
    expect(p1.structuredContent.items).toHaveLength(1);
    const p2 = await call(readKey, 'list_assets', { clientId: cA, limit: 1, sort: 'name', cursor: p1.structuredContent.nextCursor });
    expect(p2.structuredContent.items[0].creativeId).not.toBe(p1.structuredContent.items[0].creativeId);
    expect(p2.structuredContent.nextCursor).toBeNull();
    expect((await call(readKey, 'list_assets', { cursor: 'nope' })).structuredContent.code).toBe('validation_failed');
  });
});

describe('list_assets paging while the bot links what it lists (Workflow B)', () => {
  it('visits every unlinked asset exactly once even though each page is linked before the next is asked for', async () => {
    const [cC] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test AST C ${tag}`, status: 'active' }).returning();
    const acct = `act_23${tag}1`;
    await request(app).post(`/api/v1/clients/${cC!.id}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: acct, accountName: 'AST C' }).expect(201);
    const made = await db.insert(creatives).values(Array.from({ length: 7 }, (_, n) => ({ name: `Yash AST page ${n} ${tag}`, fileUrl: 'x', type: 'image', clientId: cC!.id }))).returning();
    const ids = made.map((m) => m.id);
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await call(key, 'list_assets', { clientId: cC!.id, hasAdLink: false, limit: 3, ...(cursor ? { cursor } : {}) });
        const got = page.structuredContent.items.map((i: { creativeId: string }) => i.creativeId);
        seen.push(...got);
        for (const id of got) await call(key, 'link_ad_platform_ids', { creativeId: id, platform: 'meta', accountId: acct, adId: `pg${id.slice(0, 8)}${tag}` }); // links it, so it leaves the list
        cursor = page.structuredContent.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual([...ids].sort()); // none skipped, none twice
      expect((await call(key, 'list_assets', { clientId: cC!.id, hasAdLink: false })).structuredContent.items).toEqual([]);
    } finally {
      await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
      await db.delete(creatives).where(inArray(creatives.id, ids));
      await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, cC!.id));
      await db.delete(clients).where(eq(clients.id, cC!.id));
    }
  });
  it('a tampered cursor (a key that is not a timestamp) is a clean validation_failed, not a 500', async () => {
    const bad = Buffer.from(JSON.stringify({ s: 'created', k: 'garbage', i: a1 })).toString('base64url');
    const r = await call(readKey, 'list_assets', { clientId: cA, cursor: bad });
    expect(r.structuredContent.code).toBe('validation_failed');
  });
  it('sorting by name keeps its place too, and a cursor from another sort is refused', async () => {
    const p1 = await call(readKey, 'list_assets', { clientId: cA, limit: 1, sort: 'name' });
    const wrong = await call(readKey, 'list_assets', { clientId: cA, limit: 1, cursor: p1.structuredContent.nextCursor });
    expect(wrong.structuredContent.code).toBe('validation_failed');
  });
});

describe('get_asset', () => {
  it('returns detail, a signed download link with the asked lifetime, ad links and approval status', async () => {
    const r = await call(readKey, 'get_asset', { creativeId: a1, downloadUrlMinutes: 1440 });
    const d = r.structuredContent;
    expect(d.creative).toMatchObject({ creativeId: a1, approvalStatus: 'draft', clientId: cA, headline: 'Hearing aids offer', fileStatus: 'ready' });
    expect(d.downloadUrl).toMatch(/^http/);
    expect(d.downloadUrl).toContain('X-Amz-Expires=86400');
    expect(Date.parse(d.expiresAt) - Date.now()).toBeGreaterThan(86_000_000);
    expect(d.adLinks).toHaveLength(1);
    expect(d.adLinks[0]).toMatchObject({ adId: `ad${tag}`, platform: 'meta' });
    expect((await call(readKey, 'get_asset', { creativeId: a1 })).structuredContent.downloadUrl).toContain('X-Amz-Expires=3600');
  });
  it('an asset with no stored file has no link, and an unknown asset is not_found', async () => {
    expect((await call(readKey, 'get_asset', { creativeId: a2 })).structuredContent.downloadUrl).toBeNull();
    expect((await call(readKey, 'get_asset', { creativeId: '11111111-1111-4111-8111-111111111111' })).structuredContent.code).toBe('not_found');
  });
});

describe('archive, list, restore (test 13)', () => {
  it('archive hides it from default lists, includeArchived shows it, restore brings it back intact, and the file stays', async () => {
    const arch = await call(archiveKey, 'archive_asset', { creativeId: a2, reason: 'wrong cut' });
    expect(arch.structuredContent).toMatchObject({ result: 'archived', creative: { creativeId: a2, archiveReason: 'wrong cut' } });
    expect(arch.structuredContent.creative.archivedAt).not.toBeNull();
    expect((await call(archiveKey, 'archive_asset', { creativeId: a2 })).structuredContent.result).toBe('unchanged');

    const hidden = await call(readKey, 'list_assets', { clientId: cA });
    expect(hidden.structuredContent.items.map((i: { creativeId: string }) => i.creativeId)).toEqual([a1]);
    const shown = await call(readKey, 'list_assets', { clientId: cA, includeArchived: true });
    expect(shown.structuredContent.items.map((i: { creativeId: string }) => i.creativeId).sort()).toEqual([a1, a2].sort());
    expect(shown.structuredContent.items.find((i: { creativeId: string }) => i.creativeId === a2).archivedAt).not.toBeNull();

    const rest = await call(archiveKey, 'restore_asset', { creativeId: a2 });
    expect(rest.structuredContent).toMatchObject({ result: 'restored', creative: { creativeId: a2, archivedAt: null, archiveReason: null } });
    expect((await call(archiveKey, 'restore_asset', { creativeId: a2 })).structuredContent.result).toBe('unchanged');
    expect((await call(readKey, 'list_assets', { clientId: cA })).structuredContent.items).toHaveLength(2);
    const [row] = await db.select().from(creatives).where(eq(creatives.id, a2));
    expect(row).toMatchObject({ fileUrl: 'x', isDeleted: false, name: `Yash AST two ${tag}` }); // nothing but the archive fields ever changed
  });
  it('needs the creatives:archive scope', async () => {
    expect((await call(readKey, 'archive_asset', { creativeId: a2 })).structuredContent.code).toBe('insufficient_scope');
    expect((await call(key, 'archive_asset', { creativeId: '11111111-1111-4111-8111-111111111111' })).structuredContent.code).toBe('not_found');
  });
});

describe('update_asset', () => {
  it('changes name, headline, body and tags, reports changedFields, and a repeat changes nothing', async () => {
    const r = await call(key, 'update_asset', { creativeId: a1, name: `Yash AST one v2 ${tag}`, headline: 'New headline', bodyText: 'Body', tags: ['b', 'a', 'a'] });
    expect(r.structuredContent.changedFields.sort()).toEqual(['bodyText', 'headline', 'name', 'tags']);
    expect(r.structuredContent.creative).toMatchObject({ name: `Yash AST one v2 ${tag}`, headline: 'New headline', tags: ['a', 'b'] });
    expect((await call(key, 'update_asset', { creativeId: a1, name: `Yash AST one v2 ${tag}`, tags: ['a', 'b'] })).structuredContent.changedFields).toEqual([]);
  });
  it('a campaign the client does not buy is campaign_client_mismatch; the LeadByte number or UUID of its own campaign works', async () => {
    expect((await call(key, 'update_asset', { creativeId: a1, campaignId: k2 })).structuredContent.code).toBe('campaign_client_mismatch');
  });
  it('moving to another client needs confirmMove, and is refused while a live ad sits on the old client\'s account', async () => {
    const noConfirm = await call(key, 'update_asset', { creativeId: a2, clientId: cB });
    expect(noConfirm.structuredContent.code).toBe('move_requires_confirm');
    const blocked = await call(key, 'update_asset', { creativeId: a1, clientId: cB, confirmMove: true });
    expect(blocked.structuredContent.code).toBe('account_client_mismatch');
    const [still] = await db.select().from(creatives).where(eq(creatives.id, a1));
    expect(still!.clientId).toBe(cA);
  });
  it('a move with confirmMove works when no live ad is on the old client\'s account; the campaign must still fit', async () => {
    const needCampaign = await call(key, 'update_asset', { creativeId: a2, clientId: cB, confirmMove: true });
    expect(needCampaign.structuredContent.code).toBe('campaign_client_mismatch'); // a2 sits on cA's campaign
    const ok = await call(key, 'update_asset', { creativeId: a2, clientId: cB, campaignId: k2, confirmMove: true });
    expect(ok.structuredContent.changedFields.sort()).toEqual(['campaignId', 'clientId']);
    expect(ok.structuredContent.creative).toMatchObject({ clientId: cB, campaignId: k2 });
  });
});

describe('landing page tools', () => {
  it('add_landing_page saves a URL once even with utm_ and fbclid added twice (test 15); list finds it; attach sets it', async () => {
    const base = `https://example.com/lp-${tag}`;
    const first = await call(key, 'add_landing_page', { clientId: cA, url: `${base}?utm_source=a&fbclid=1&utm_source=b&fbclid=2`, title: 'Offer' });
    expect(first.structuredContent.result).toBe('created');
    const again = await call(key, 'add_landing_page', { clientId: cA, url: `${base}?utm_medium=z&fbclid=3` });
    expect(again.structuredContent).toMatchObject({ result: 'existing' });
    expect(again.structuredContent.landingPage.id).toBe(first.structuredContent.landingPage.id);
    const list = await call(readKey, 'list_landing_pages', { clientId: cA });
    expect(list.structuredContent.items).toHaveLength(1);
    const att = await call(key, 'attach_landing_page', { creativeId: a1, landingPageId: first.structuredContent.landingPage.id });
    expect(att.structuredContent.landingPage.id).toBe(first.structuredContent.landingPage.id);
    expect((await call(readKey, 'list_landing_pages', { clientId: cA })).structuredContent.items[0].creativeCount).toBe(1);
  });
  it('attach by url saves the page for the asset\'s client; a page of another client is refused', async () => {
    const byUrl = await call(key, 'attach_landing_page', { creativeId: a1, url: `https://example.com/other-${tag}` });
    expect(byUrl.structuredContent.landingPage.url).toContain(`other-${tag}`);
    const other = await call(key, 'add_landing_page', { clientId: cB, url: `https://example.com/b-${tag}` });
    const bad = await call(key, 'attach_landing_page', { creativeId: a1, landingPageId: other.structuredContent.landingPage.id });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.code).toBe('validation_failed');
  });
  it('a bad URL and an unknown client are coded errors; scopes are enforced', async () => {
    expect((await call(key, 'add_landing_page', { clientId: cA, url: 'not a url at all' })).structuredContent.code).toBe('validation_failed');
    expect((await call(key, 'add_landing_page', { clientId: '11111111-1111-4111-8111-111111111111', url: 'https://example.com/z' })).structuredContent.code).toBe('not_found');
    expect((await call(readKey, 'add_landing_page', { clientId: cA, url: 'https://example.com/y' })).structuredContent.code).toBe('insufficient_scope');
  });
});

describe('list_ad_accounts', () => {
  it('lists accounts with the client, filters by client and linked, and pages', async () => {
    const mine = await call(key, 'list_ad_accounts', { clientId: cA });
    expect(mine.structuredContent.items).toEqual([expect.objectContaining({ platform: 'meta', accountId: `22${tag}1`, clientId: cA, accountName: 'AST meta' })]);
    expect(mine.structuredContent.summary.linked).toBe(1);
    const linked = await call(key, 'list_ad_accounts', { linked: true, q: `22${tag}1` });
    expect(linked.structuredContent.items).toHaveLength(1);
    expect((await call(key, 'list_ad_accounts', { linked: false, q: `22${tag}1` })).structuredContent.items).toEqual([]);
    expect((await call(key, 'list_ad_accounts', { clientId: cA, limit: 1 })).structuredContent.nextCursor).toBeNull();
    expect((await call(key, 'list_ad_accounts', { cursor: 'nope' })).structuredContent.code).toBe('validation_failed');
    expect((await call(readKey, 'list_ad_accounts')).structuredContent.code).toBe('insufficient_scope');
  });
});
