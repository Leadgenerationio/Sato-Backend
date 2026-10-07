import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { callWithinClientScope, TOOLS_WITH_CLIENT_RULES } from '../mcp/client-scope.js';
import { getTools } from '../mcp/tools/registry.js';
import type { StatoTool, ToolContext } from '../mcp/types.js';

// MCP spec v1.0 §3, step 1h: a key limited to some clients. Key L is limited to
// client A. Client B is in the same business, with its own account, campaign,
// asset, ad link and landing page. L must not see or touch anything of B's:
// every way in answers as if B's data did not exist, and nothing is saved.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
const ALL_SCOPES = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'ad_links:write', 'landing_pages:write'];

let owner = '';
let limited = ''; let open = '';
const keyIds: string[] = [];
const ids = {} as Record<'clientA' | 'clientB' | 'otherBiz' | 'otherClient' | 'campA' | 'campB' | 'crA' | 'crB' | 'lpA' | 'lpB' | 'linkB', string>;
const acct = (n: 'A' | 'B') => `act_77${tag}${n === 'A' ? 1 : 2}`;

async function call(k: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}
const codeOf = (r: { isError?: boolean; structuredContent: Record<string, any> }) => (r.isError ? r.structuredContent.code : 'ok');

async function makeKey(body: Record<string, unknown>) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Hari Test scope ${tag}`, scopes: ALL_SCOPES, ...body });
  if (res.status === 201) keyIds.push(res.body.data.apiKey.id);
  return res;
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  for (const n of ['A', 'B'] as const) {
    const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Hari Test SCOPE ${n} ${tag}`, status: 'active' }).returning();
    ids[`client${n}`] = c!.id;
    await db.insert(clientAdAccounts).values({ businessId: BIZ, clientId: c!.id, platform: 'facebook-ads', accountId: acct(n).replace('act_', ''), accountName: `Hari Test ${n}` });
    const [k] = await db.insert(campaigns).values({ name: `Hari Test SCOPE camp ${n} ${tag}`, clientId: c!.id }).returning();
    ids[`camp${n}`] = k!.id;
    await db.insert(clientCampaigns).values({ clientId: c!.id, campaignId: k!.id });
    const [cr] = await db.insert(creatives).values({ name: `Hari Test SCOPE asset ${n} ${tag}`, clientId: c!.id, campaignId: k!.id, type: 'image', platform: 'meta', source: 'mcp' }).returning();
    ids[`cr${n}`] = cr!.id;
    const [lp] = await db.insert(landingPages).values({ clientId: c!.id, url: `https://scope-${n.toLowerCase()}-${tag}.example.com/` }).returning();
    ids[`lp${n}`] = lp!.id;
  }
  const [l] = await db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: ids.crB, clientId: ids.clientB, platform: 'meta', platformAccountId: acct('B').replace('act_', ''), platformAdId: `9${tag}2` }).returning();
  ids.linkB = l!.id;
  const [b] = await db.insert(businesses).values({ name: `Hari Test other ${tag}`, slug: `hari-test-other-${tag}` }).returning();
  ids.otherBiz = b!.id;
  const [oc] = await db.insert(clients).values({ businessId: ids.otherBiz, companyName: `Hari Test OTHER ${tag}`, status: 'active' }).returning();
  ids.otherClient = oc!.id;

  const made = await makeKey({ allowedClientIds: [ids.clientA], agentLabel: 'scope-bot' });
  expect(made.status).toBe(201);
  expect(made.body.data.apiKey).toMatchObject({ allowedClientIds: [ids.clientA], allowedClients: [{ id: ids.clientA, name: `Hari Test SCOPE A ${tag}` }], agentLabel: 'scope-bot' });
  limited = made.body.data.key;
  open = (await makeKey({})).body.data.key;
});

afterAll(async () => {
  await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, [ids.crA, ids.crB]));
  await db.delete(creatives).where(inArray(creatives.id, [ids.crA, ids.crB]));
  await db.delete(landingPages).where(inArray(landingPages.id, [ids.lpA, ids.lpB]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [ids.campA, ids.campB]));
  await db.delete(campaigns).where(inArray(campaigns.id, [ids.campA, ids.campB]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [ids.clientA, ids.clientB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  await db.delete(clients).where(inArray(clients.id, [ids.clientA, ids.clientB, ids.otherClient]));
  await db.delete(businesses).where(eq(businesses.id, ids.otherBiz));
});

describe('a key limited to client A', () => {
  it('whoami shows the limit and the agent label', async () => {
    const r = await call(limited, 'whoami');
    expect(r.structuredContent.key.allowedClients).toEqual([{ clientId: ids.clientA, name: `Hari Test SCOPE A ${tag}` }]);
    expect(r.structuredContent.key.agentLabel).toBe('scope-bot');
  });

  it('lists only client A, its campaign, its asset, its ad account and its landing page', async () => {
    const cl = (await call(limited, 'list_clients', { q: `SCOPE`, limit: 100 })).structuredContent.items.map((c: any) => c.clientId);
    expect(cl).toContain(ids.clientA);
    expect(cl).not.toContain(ids.clientB);
    const camps = (await call(limited, 'list_campaigns', { q: `Hari Test SCOPE camp`, limit: 100 })).structuredContent.items.map((c: any) => c.campaignId);
    expect(camps).toEqual([ids.campA]);
    const assets = (await call(limited, 'list_assets', { q: `Hari Test SCOPE asset`, limit: 100 })).structuredContent.items.map((c: any) => c.creativeId);
    expect(assets).toEqual([ids.crA]);
    const accounts = (await call(limited, 'list_ad_accounts', { q: `77${tag}` })).structuredContent.items.map((a: any) => a.clientId);
    expect(accounts).toEqual([ids.clientA]);
    const pages = (await call(limited, 'list_landing_pages', {})).structuredContent.items.map((p: any) => p.landingPageId);
    expect(pages).toContain(ids.lpA);
    expect(pages).not.toContain(ids.lpB);
  });

  it("answers not_found for every way to client B's data", async () => {
    const tries: Array<[string, Record<string, unknown>]> = [
      ['get_client', { clientId: ids.clientB }],
      ['list_assets', { clientId: ids.clientB }],
      ['list_campaigns', { clientId: ids.clientB }],
      ['list_landing_pages', { clientId: ids.clientB }],
      ['get_campaign', { campaignId: ids.campB }],
      ['get_asset', { creativeId: ids.crB }],
      ['find_client_by_ad_account', { platform: 'meta', accountId: acct('B') }],
      ['unlink_ad_platform_ids', { adLinkId: ids.linkB }],
    ];
    for (const [tool, args] of tries) expect([tool, codeOf(await call(limited, tool, args))]).toEqual([tool, 'not_found']);
    const found = await call(limited, 'find_asset_by_platform_id', { platform: 'meta', adId: `9${tag}2` });
    expect(found.structuredContent).toMatchObject({ found: false, creative: null });
    // The same calls on client A work.
    expect(codeOf(await call(limited, 'get_client', { clientId: ids.clientA }))).toBe('ok');
    expect(codeOf(await call(limited, 'get_asset', { creativeId: ids.crA }))).toBe('ok');
    expect(codeOf(await call(limited, 'get_campaign', { campaignId: ids.campA }))).toBe('ok');
  });

  it("changes nothing of client B's, and cannot pull B's account or asset over to A", async () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      ['archive_asset', { creativeId: ids.crB, reason: 'x' }],
      ['update_asset', { creativeId: ids.crB, name: 'renamed' }],
      ['update_asset', { creativeId: ids.crA, clientId: ids.clientB, confirmMove: true }],
      ['link_ad_account', { clientId: ids.clientA, platform: 'meta', accountId: acct('B'), confirmMove: true }],
      ['link_ad_account', { clientId: ids.clientB, platform: 'meta', accountId: `act_77${tag}9` }],
      ['link_ad_platform_ids', { creativeId: ids.crB, platform: 'meta', accountId: acct('B'), adId: `9${tag}3` }],
      ['link_ad_platform_ids', { creativeId: ids.crA, platform: 'meta', accountId: acct('B'), adId: `9${tag}4` }],
      ['attach_landing_page', { creativeId: ids.crA, landingPageId: ids.lpB }],
      ['add_landing_page', { clientId: ids.clientB, url: `https://scope-new-${tag}.example.com/` }],
      ['upload_asset', { platform: 'meta', platformAccountId: acct('B'), sourceUrl: 'https://scope.invalid/a.png', name: 'x' }],
    ];
    for (const [tool, args] of writes) expect([tool, codeOf(await call(limited, tool, args))]).toEqual([tool, 'not_found']);

    const [b] = await db.select().from(creatives).where(eq(creatives.id, ids.crB));
    expect(b!.archivedAt).toBeNull();
    expect(b!.name).toBe(`Hari Test SCOPE asset B ${tag}`);
    const [a] = await db.select().from(creatives).where(eq(creatives.id, ids.crA));
    expect(a!.clientId).toBe(ids.clientA);
    expect(a!.landingPageId).toBeNull();
    const [acc] = await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, acct('B').replace('act_', '')));
    expect(acc!.clientId).toBe(ids.clientB);
    expect(await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, `77${tag}9`))).toHaveLength(0);
    expect(await db.select().from(creativeAdLinks).where(inArray(creativeAdLinks.platformAdId, [`9${tag}3`, `9${tag}4`]))).toHaveLength(0);
  });

  it('must name a client when uploading, and send platform with an account', async () => {
    expect(codeOf(await call(limited, 'upload_asset', { sourceUrl: 'https://scope.invalid/a.png', name: 'x', platform: 'meta' }))).toBe('validation_failed');
    const r = await call(limited, 'upload_asset', { sourceUrl: 'https://scope.invalid/a.png', name: 'x', platformAccountId: acct('B') });
    expect(r.structuredContent).toMatchObject({ code: 'validation_failed', fields: [{ field: 'platform' }] });
  });

  it('is refused on the REST routes, which do not check the limit, but works on whoami', async () => {
    const rest = await request(app).get('/api/v1/creatives').set('X-API-Key', limited);
    expect(rest.status).toBe(403);
    expect(rest.body.code).toBe('insufficient_scope');
    expect((await request(app).get('/api/v1/whoami').set('X-API-Key', limited)).status).toBe(200);
  });
});

describe('a key with no client limit', () => {
  it('sees both clients, as before', async () => {
    const cl = (await call(open, 'list_clients', { q: `Hari Test SCOPE`, limit: 100 })).structuredContent.items.map((c: any) => c.clientId);
    expect(cl).toEqual(expect.arrayContaining([ids.clientA, ids.clientB]));
    expect(codeOf(await call(open, 'get_asset', { creativeId: ids.crB }))).toBe('ok');
    expect((await call(open, 'whoami')).structuredContent.key.allowedClients).toBeNull();
  });
});

describe('setting the limit', () => {
  it('refuses a client from another business, or an empty list', async () => {
    expect((await makeKey({ allowedClientIds: [ids.otherClient] })).status).toBe(422);
    expect((await makeKey({ allowedClientIds: [] })).status).toBe(400);
  });

  it('PATCH changes the limit, and the next call follows it', async () => {
    const made = await makeKey({});
    const id = made.body.data.apiKey.id; const k = made.body.data.key;
    expect(codeOf(await call(k, 'get_client', { clientId: ids.clientB }))).toBe('ok');
    const patched = await request(app).patch(`/api/v1/api-keys/${id}`).set('Authorization', `Bearer ${owner}`).send({ allowedClientIds: [ids.clientA] });
    expect(patched.status).toBe(200);
    expect(patched.body.data.apiKey.allowedClientIds).toEqual([ids.clientA]);
    const listed = (await request(app).get('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`)).body.data.apiKeys.find((x: any) => x.id === id);
    expect(listed.allowedClients).toEqual([{ id: ids.clientA, name: `Hari Test SCOPE A ${tag}` }]);
    expect(codeOf(await call(k, 'get_client', { clientId: ids.clientB }))).toBe('not_found');
    expect((await request(app).patch(`/api/v1/api-keys/${id}`).set('Authorization', `Bearer ${owner}`).send({ allowedClientIds: [ids.otherClient] })).status).toBe(422);
    await request(app).patch(`/api/v1/api-keys/${id}`).set('Authorization', `Bearer ${owner}`).send({ allowedClientIds: null }).expect(200);
    expect(codeOf(await call(k, 'get_client', { clientId: ids.clientB }))).toBe('ok');
  });
});

describe('a tool without a client rule', () => {
  it('is refused for a limited key, so a new tool cannot leak by default', async () => {
    const ctx = { businessId: BIZ, allowedClientIds: [ids.clientA] } as unknown as ToolContext;
    const tool = { name: 'new_tool_without_rule', handler: async () => ({ summary: 'leak', data: {} }) } as unknown as StatoTool;
    await expect(callWithinClientScope(tool, {}, ctx)).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(callWithinClientScope(tool, {}, { ...ctx, allowedClientIds: null })).resolves.toMatchObject({ summary: 'leak' });
  });

  it('every tool that exists today has a rule', async () => {
    const names = (await getTools()).map((t) => t.name);
    expect(names.filter((n) => !TOOLS_WITH_CLIENT_RULES.includes(n))).toEqual([]);
  });
});
