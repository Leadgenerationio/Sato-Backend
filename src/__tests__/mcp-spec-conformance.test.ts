import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';

// Spec v1.0 section 2: every tool has the inputs and outputs the table lists, and descriptions and annotations written for
// an AI reader. This is the contract: a new tool or a renamed field that breaks it fails here.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
const ALL = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'ad_accounts:write', 'ad_links:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'landing_pages:write'];
let owner = ''; let key = ''; let clientA = ''; let campA = '';
const keyIds: string[] = [];
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`conf-${tag}`)]);
const real = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.spyOn>;

const SPEC: Record<string, { in: string[]; out: string[] }> = {
  whoami: { in: [], out: ['keyName', 'owner', 'business', 'scopes', 'rateLimit'] },
  list_clients: { in: ['q', 'status', 'limit', 'cursor'], out: ['clientId', 'name', 'status', 'currency', 'country', 'adAccountCount'] },
  get_client: { in: ['clientId'], out: ['client', 'adAccounts', 'campaigns'] },
  list_campaigns: { in: ['clientId', 'status', 'vertical', 'q', 'limit', 'cursor'], out: ['campaignId', 'name', 'vertical', 'status', 'currency', 'linkedClientIds'] },
  get_campaign: { in: ['campaignId'], out: ['campaign', 'linkedClients', 'adAccounts'] },
  list_ad_accounts: { in: ['platform', 'clientId', 'campaignId', 'linked', 'q'], out: ['platform', 'accountId', 'accountName', 'clientId', 'campaignId', 'spend30d', 'currency'] },
  find_client_by_ad_account: { in: ['platform', 'accountId'], out: [] },
  link_ad_account: { in: ['clientId', 'platform', 'accountId', 'campaignId', 'accountName', 'currency', 'confirmMove'], out: ['link', 'result'] },
  create_upload: { in: ['filename', 'contentType', 'sizeBytes', 'sha256'], out: ['uploadId', 'uploadUrl', 'parts', 'expiresAt'] },
  complete_upload: { in: ['uploadId', 'parts'], out: ['uploadId', 'status', 'sizeBytes', 'sha256'] },
  upload_asset: { in: ['mediaType', 'name', 'sourceUrl', 'uploadId', 'clientId', 'platform', 'platformAccountId', 'campaignId', 'headline', 'bodyText', 'landingPageUrl', 'tags', 'adLink', 'idempotencyKey'], out: ['creativeId', 'result', 'fileStatus', 'thumbnailUrl', 'portalUrl'] },
  list_assets: { in: ['clientId', 'campaignId', 'platform', 'platformAccountId', 'platformAdId', 'landingPageId', 'mediaType', 'approvalStatus', 'hasAdLink', 'q', 'from', 'to', 'includeArchived', 'sort', 'limit', 'cursor'], out: ['creativeId', 'name', 'mediaType', 'thumbnailUrl', 'client', 'campaign', 'approvalStatus', 'adLinkCount'] },
  get_asset: { in: ['creativeId', 'downloadUrlMinutes'], out: ['creative', 'downloadUrl', 'expiresAt', 'adLinks', 'landingPage', 'history'] },
  update_asset: { in: ['creativeId', 'name', 'headline', 'bodyText', 'tags', 'campaignId', 'clientId', 'confirmMove'], out: ['creative', 'changedFields'] },
  archive_asset: { in: ['creativeId', 'reason'], out: ['creative'] },
  restore_asset: { in: ['creativeId', 'reason'], out: ['creative'] },
  link_ad_platform_ids: { in: ['creativeId', 'platform', 'accountId', 'campaignId', 'campaignName', 'adsetId', 'adsetName', 'adId', 'adName', 'platformCreativeId', 'platformAssetId', 'landingPageUrl', 'status'], out: ['adLinkId', 'result'] },
  unlink_ad_platform_ids: { in: ['adLinkId', 'reason'], out: ['adLinkId', 'removedAt'] },
  find_asset_by_platform_id: { in: ['platform', 'adId', 'platformCreativeId', 'platformAssetId', 'sha256'], out: ['creative', 'adLink', 'found'] },
  add_landing_page: { in: ['clientId', 'url', 'title', 'campaignId'], out: ['landingPage', 'result'] },
  list_landing_pages: { in: ['clientId', 'campaignId', 'q'], out: ['landingPageId', 'url', 'title'] },
  attach_landing_page: { in: ['creativeId', 'landingPageId', 'url'], out: ['creativeId', 'landingPage'] },
};

async function rpc(k: string, method: string, params: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method, params });
  expect(res.status).toBe(200);
  return res.body.result;
}
const call = (name: string, args: Record<string, unknown> = {}) => rpc(key, 'tools/call', { name, arguments: args }) as Promise<{ isError?: boolean; structuredContent: Record<string, any> }>;
const props = (schema: any): Set<string> => {
  const out = new Set<string>();
  const walk = (s: any) => { if (!s || typeof s !== 'object') return; for (const [k, v] of Object.entries<any>(s.properties ?? {})) { out.add(k); walk(v); if (v.items) walk(v.items); } if (s.items) walk(s.items); };
  walk(schema);
  return out;
};

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test conf ${tag}`, scopes: ALL });
  keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test CONF ${tag}`, status: 'active' }).returning();
  clientA = c!.id;
  const [camp] = await db.insert(campaigns).values({ name: `Yash Test CONF camp ${tag}`, leadbyteCampaignId: `CONF-${tag}` }).returning();
  campA = camp!.id;
  await db.insert(clientCampaigns).values({ clientId: clientA, campaignId: campA });
  await request(app).post(`/api/v1/clients/${clientA}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_22${tag}1`, campaignId: campA }).expect(201);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const href = String(input instanceof URL ? input.href : input);
    if (href.startsWith('https://93.184.216.34/')) return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
    return real(input, init);
  });
});
afterAll(async () => {
  fetchSpy.mockRestore();
  const ids = (await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, clientA))).map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(creatives).where(eq(creatives.clientId, clientA));
  await db.delete(landingPages).where(eq(landingPages.clientId, clientA));
  await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, clientA));
  await db.delete(clientCampaigns).where(eq(clientCampaigns.clientId, clientA));
  await db.delete(clients).where(eq(clients.id, clientA));
  await db.delete(campaigns).where(eq(campaigns.id, campA));
  if (keyIds.length) { await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds)); await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds)); }
});

describe('spec v1.0 section 2: the tool table', () => {
  it('lists exactly the 22 spec tools, each with every input and output the table names', async () => {
    const tools = (await rpc(key, 'tools/list')).tools as Array<{ name: string; inputSchema: any; outputSchema: any }>;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(SPEC).sort());
    const gaps: string[] = [];
    for (const t of tools) {
      const ins = props(t.inputSchema); const outs = props(t.outputSchema);
      for (const k of SPEC[t.name]!.in) if (!ins.has(k)) gaps.push(`${t.name} input ${k}`);
      for (const k of SPEC[t.name]!.out) if (!outs.has(k)) gaps.push(`${t.name} output ${k}`);
    }
    expect(gaps).toEqual([]);
  });
  it('writes descriptions and annotations for an AI reader on every tool', async () => {
    const tools = (await rpc(key, 'tools/list')).tools as Array<{ name: string; title?: string; description?: string; annotations?: Record<string, unknown>; outputSchema?: unknown }>;
    const bad: string[] = [];
    for (const t of tools) {
      const a = t.annotations ?? {};
      if (!t.title) bad.push(`${t.name}: no title`);
      if ((t.description ?? '').length < 80) bad.push(`${t.name}: description under 80 characters`);
      if (!/IDs are strings/i.test(t.description ?? '')) bad.push(`${t.name}: does not say IDs are strings`);
      if (typeof a.readOnlyHint !== 'boolean') bad.push(`${t.name}: no readOnlyHint`);
      if (typeof a.idempotentHint !== 'boolean') bad.push(`${t.name}: no idempotentHint`);
      if (a.readOnlyHint === false && typeof a.destructiveHint !== 'boolean') bad.push(`${t.name}: write tool without destructiveHint`);
      if (!t.outputSchema) bad.push(`${t.name}: no outputSchema`);
    }
    expect(bad).toEqual([]);
  });
});

describe('the six gaps found in the spec check', () => {
  it('whoami returns keyName and how many calls are left this minute', async () => {
    const a = (await call('whoami')).structuredContent;
    expect(a.keyName).toBe(`Yash Test conf ${tag}`);
    expect(a.rateLimit).toMatchObject({ limit: 120, windowSeconds: 60 });
    expect(typeof a.rateLimit.remaining).toBe('number');
    const b = (await call('whoami')).structuredContent;
    expect(b.rateLimit.remaining).toBe(a.rateLimit.remaining - 1);
    expect(b.rateLimit.resetsInSeconds).toBeGreaterThan(0);
  });
  it('upload_asset returns thumbnailUrl and a portalUrl that opens the asset', async () => {
    const r = (await call('upload_asset', { sourceUrl: `https://93.184.216.34/${tag}/a.png`, mediaType: 'image', platform: 'meta', platformAccountId: `act_22${tag}1`, name: `Yash Test CONF asset ${tag}` })).structuredContent;
    expect(r.result).toBe('created');
    expect(r).toHaveProperty('thumbnailUrl');
    expect(r.portalUrl).toMatch(/\/creatives\?creative=[0-9a-f-]{36}$/);
    expect(r.portalUrl.endsWith(r.creativeId)).toBe(true);
  });
  it('get_asset shows the recent history: which key did what, newest first', async () => {
    const [cr] = await db.select().from(creatives).where(eq(creatives.clientId, clientA));
    await call('link_ad_platform_ids', { creativeId: cr!.id, platform: 'meta', accountId: `act_22${tag}1`, adId: `conf-ad-${tag}`, campaignName: 'Spring campaign' });
    await call('update_asset', { creativeId: cr!.id, tags: ['conf'] });
    await new Promise((r) => setTimeout(r, 500)); // the audit row is written after the response
    const detail = (await call('get_asset', { creativeId: cr!.id })).structuredContent;
    expect(detail.history.length).toBeGreaterThanOrEqual(3);
    expect(detail.history.slice(0, 3).map((h: any) => h.tool)).toEqual(['update_asset', 'link_ad_platform_ids', 'upload_asset']);
    expect(detail.history[0]).toMatchObject({ by: `Yash Test conf ${tag}`, transport: 'mcp', result: 'ok' });
  });
  it('link_ad_platform_ids takes campaignName and stores it as the platform campaign name', async () => {
    const [cr] = await db.select().from(creatives).where(eq(creatives.clientId, clientA));
    const links = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, cr!.id));
    expect(links.find((l) => l.platformAdId === `conf-ad-${tag}`)?.platformCampaignName).toBe('Spring campaign');
  });
  it('restore_asset takes a reason (kept in the audit log)', async () => {
    const [cr] = await db.select().from(creatives).where(eq(creatives.clientId, clientA));
    await call('archive_asset', { creativeId: cr!.id, reason: 'conf' });
    const r = await call('restore_asset', { creativeId: cr!.id, reason: 'restored by the conformance test' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.result).toBe('restored');
    await new Promise((x) => setTimeout(x, 500));
    const rows = await db.select().from(apiAuditLog).where(eq(apiAuditLog.tool, 'restore_asset'));
    expect(JSON.stringify(rows.map((x) => x.args))).toContain('restored by the conformance test');
  });
  it('list_landing_pages filters by campaignId', async () => {
    const withCamp = await call('add_landing_page', { clientId: clientA, url: `https://example.com/conf-${tag}-a`, campaignId: campA });
    await call('add_landing_page', { clientId: clientA, url: `https://example.com/conf-${tag}-b` });
    const all = (await call('list_landing_pages', { clientId: clientA })).structuredContent.items;
    const some = (await call('list_landing_pages', { campaignId: campA })).structuredContent.items;
    expect(all).toHaveLength(2);
    expect(some.map((p: any) => p.landingPageId)).toEqual([withCamp.structuredContent.landingPage.id]);
    expect((await call('list_landing_pages', { campaignId: 'abc' })).structuredContent.code).toBe('validation_failed');
  });
});

describe('review follow-ups on the six gaps', () => {
  it('a signed thumbnail link is never kept in the 24 h replay store: it is signed when the answer is made', async () => {
    const args = { sourceUrl: `https://93.184.216.34/${tag}/replay.png`, mediaType: 'image', platform: 'meta', platformAccountId: `act_22${tag}1`, name: `Yash Test CONF replay ${tag}`, idempotencyKey: `conf-${tag}-thumb` };
    const first = (await call('upload_asset', args)).structuredContent;
    const stored = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, `conf-${tag}-thumb`));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]!.response)).not.toMatch(/thumbnailUrl|X-Amz|Signature/i);
    const replay = (await call('upload_asset', args)).structuredContent;
    expect(replay.creativeId).toBe(first.creativeId);
    expect(replay).toHaveProperty('thumbnailUrl');
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, `conf-${tag}-thumb`));
  });
  it('get_asset history looks back 90 days only', async () => {
    const [cr] = await db.select().from(creatives).where(eq(creatives.clientId, clientA));
    await db.insert(apiAuditLog).values({ businessId: BIZ, apiKeyId: keyIds[0]!, keyName: 'old key', transport: 'mcp', tool: 'ancient_call', recordsTouched: [{ type: 'creative', id: cr!.id }], at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) } as any);
    await db.insert(apiAuditLog).values({ businessId: BIZ, apiKeyId: keyIds[0]!, keyName: 'recent key', transport: 'mcp', tool: 'recent_call', recordsTouched: [{ type: 'creative', id: cr!.id }], at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } as any);
    const tools = ((await call('get_asset', { creativeId: cr!.id })).structuredContent.history as Array<{ tool: string }>).map((h) => h.tool);
    expect(tools).toContain('recent_call');
    expect(tools).not.toContain('ancient_call');
  });
});

