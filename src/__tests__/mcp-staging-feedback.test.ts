import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { getTools } from '../mcp/tools/registry.js';
import { dropNullOptionalArgs, rejectInvalidToolCall } from '../mcp/server.js';
import { fetchRemoteMedia, httpStatusError } from '../utils/remote-media.js';
import { MediaSourceError } from '../utils/errors.js';
import { ApiError } from '../utils/api-error.js';
import { toApiError } from '../utils/to-api-error.js';
import { thumbnailStatusOf } from '../services/mcp-assets.service.js';

// Sam's staging run (15 Oct 2026) passed all 10 steps and noted five rough edges. One test group per note.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = '';
let key = { key: '', id: '' };
let client = ''; let linkedCamp = ''; let sourceCamp = '';
const accLinkOnly = `${tag}71`;
const accBoth = `${tag}72`;

async function call(k: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT).set('X-Stato-Agent', `Yash Test fb ${tag}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}

beforeAll(async () => {
  owner = (await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' })).body.data.tokens.accessToken;
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`)
    .send({ name: `Yash Test fb ${tag}`, scopes: ['clients:read', 'campaigns:read', 'ad_accounts:read'] });
  expect(res.status).toBe(201);
  key = { key: res.body.data.key, id: res.body.data.apiKey.id };
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test fb ${tag}`, status: 'active' }).returning();
  client = c!.id;
  const camps = await db.insert(campaigns).values([
    { name: `Yash Test fb linked ${tag}`, status: 'Active' },
    { name: `Yash Test fb source ${tag}`, status: 'Active' },
  ]).returning();
  [linkedCamp, sourceCamp] = camps.map((x) => x.id) as [string, string];
  await db.insert(clientCampaigns).values([{ clientId: client, campaignId: linkedCamp }, { clientId: client, campaignId: sourceCamp }]);
  await db.insert(clientAdAccounts).values([
    // Linked with a campaign and in no traffic source: Sam's case (campaignName filled, campaigns empty).
    { businessId: BIZ, platform: 'facebook-ads', accountId: accLinkOnly, clientId: client, campaignId: linkedCamp },
    // Linked with a campaign that a traffic source also lists, plus a second traffic-source campaign.
    { businessId: BIZ, platform: 'facebook-ads', accountId: accBoth, clientId: client, campaignId: linkedCamp },
  ]);
  await db.insert(trafficSources).values([
    { campaignId: linkedCamp, name: `Yash Test fb src1 ${tag}`, platform: 'facebook-ads', accountId: accBoth },
    { campaignId: sourceCamp, name: `Yash Test fb src2 ${tag}`, platform: 'facebook-ads', accountId: accBoth },
  ]);
});

afterAll(async () => {
  await db.delete(trafficSources).where(inArray(trafficSources.campaignId, [linkedCamp, sourceCamp]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [client]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.clientId, [client]));
  await db.delete(campaigns).where(inArray(campaigns.id, [linkedCamp, sourceCamp]));
  await db.delete(clients).where(inArray(clients.id, [client]));
  await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, [key.id]));
  await db.delete(apiKeys).where(inArray(apiKeys.id, [key.id]));
});

describe('null for an optional input means "not set" (Sam: list_campaigns { clientId: null } was validation_failed)', () => {
  it('drops null optional arguments, keeps null on a required one so it still fails', async () => {
    const tools = await getTools();
    const optional = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_campaigns', arguments: { clientId: null, status: null, q: 'x' } } };
    expect(dropNullOptionalArgs(tools, optional)).toEqual(['clientId', 'status']);
    expect(optional.params.arguments).toEqual({ q: 'x' });
    expect(rejectInvalidToolCall(tools, optional, null)).toBeNull();

    const required = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_client', arguments: { clientId: null } } };
    expect(dropNullOptionalArgs(tools, required)).toEqual([]);
    expect(rejectInvalidToolCall(tools, required, null)?.errorCode).toBe('validation_failed');
  });
  it('a list_campaigns call with clientId: null now works over /mcp', async () => {
    const r = await call(key.key, 'list_campaigns', { clientId: null, limit: 5 });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.structuredContent.items)).toBe(true);
  });
});

describe('list_ad_accounts "campaigns" includes the linked campaign (Sam: campaigns empty while campaignName filled)', () => {
  it('lists the linked campaign first, then traffic-source campaigns, without repeats', async () => {
    const r = await call(key.key, 'list_ad_accounts', { clientId: client });
    expect(r.isError).toBeFalsy();
    const byId = new Map((r.structuredContent.items as any[]).map((i) => [i.accountId, i]));
    const linkOnly = byId.get(accLinkOnly);
    expect(linkOnly.campaignId).toBe(linkedCamp);
    expect(linkOnly.campaigns).toEqual([{ campaignId: linkedCamp, campaignName: `Yash Test fb linked ${tag}` }]);
    const both = byId.get(accBoth);
    expect(both.campaigns.map((c: any) => c.campaignId)).toEqual([linkedCamp, sourceCamp]);
  });
});

describe('source_unreachable is retryable only when it can pass later (Sam: blocked internal address said retryable: true)', () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  it('a private or malformed address is retryable: false', async () => {
    const blocked = await fetchRemoteMedia('http://169.254.169.254/latest/meta-data/').catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(MediaSourceError);
    expect((blocked as MediaSourceError).retryable).toBe(false);
    const mapped = (() => { try { toApiError(blocked); } catch (e) { return e as ApiError; } })()!;
    expect(mapped).toMatchObject({ code: 'source_unreachable', retryable: false });
    expect(mapped.hint).toContain('Send a different URL');

    const notUrl = await fetchRemoteMedia('not a url').catch((e: unknown) => e);
    expect((notUrl as MediaSourceError).retryable).toBe(false);
    const ftp = await fetchRemoteMedia('ftp://example.com/a.png', { lookup: publicLookup }).catch((e: unknown) => e);
    expect((ftp as MediaSourceError).retryable).toBe(false);
  });
  it('an HTTP error is retryable only for 5xx, 429 and 408', () => {
    expect(httpStatusError(404).retryable).toBe(false);
    expect(httpStatusError(403).retryable).toBe(false);
    expect(httpStatusError(503).retryable).toBe(true);
    expect(httpStatusError(429).retryable).toBe(true);
    expect(httpStatusError(408).retryable).toBe(true);
  });
  it('an HTTP error names the status in its hint, not the private-address one (Hari, #126)', () => {
    const hintOf = (status: number) => { try { toApiError(httpStatusError(status)); } catch (e) { return (e as ApiError).hint ?? ''; } return ''; };
    expect(hintOf(404)).toContain('HTTP 404');
    expect(hintOf(404)).toContain('Check the URL');
    expect(hintOf(403)).toContain('HTTP 403');
    expect(hintOf(503)).toContain('try again');
    for (const s of [404, 403, 503, 400]) expect(hintOf(s)).not.toContain('Private and internal');
  });
  it('a source that is down or slow keeps the default retryable: true', async () => {
    const down = await fetchRemoteMedia('https://cdn.example.com/a.png', {
      lookup: publicLookup, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    const mapped = (() => { try { toApiError(down); } catch (e) { return e as ApiError; } })()!;
    expect(mapped).toMatchObject({ code: 'source_unreachable', retryable: true });
  });
});

describe('thumbnailStatus says whether a thumbnail is coming (Sam: upload_asset thumbnailUrl empty, get_asset had one later)', () => {
  const now = new Date('2026-10-16T10:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it('ready with a link; pending while processing or for a few minutes after filing; none for copy or a failed file', () => {
    expect(thumbnailStatusOf({ thumbnailUrl: 'https://x/t.webp', mediaType: 'video', fileStatus: 'ready', createdAt: ago(60) }, now)).toBe('ready');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'image', fileStatus: 'ready', createdAt: ago(0.5) }, now)).toBe('pending');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'video', fileStatus: 'ready', createdAt: ago(1) }, now)).toBe('pending');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'video', fileStatus: 'processing', createdAt: ago(30) }, now)).toBe('pending');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'video', fileStatus: 'failed', createdAt: ago(1) }, now)).toBe('none');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: null, fileStatus: 'ready', createdAt: ago(1) }, now)).toBe('none');
  });
  it('is not pending forever when no thumbnail will be made (Hari, #126): a ready file past the window is none', () => {
    // No ffmpeg, a poster timeout, a failed image job, or an asset from before thumbnails: ready, old, no thumbnail.
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'image', fileStatus: 'ready', createdAt: ago(6) }, now)).toBe('none');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'video', fileStatus: 'ready', createdAt: ago(60 * 24 * 30) }, now)).toBe('none');
    expect(thumbnailStatusOf({ thumbnailUrl: null, mediaType: 'image', fileStatus: 'ready', createdAt: null }, now)).toBe('none');
  });
  it('upload_asset and get_asset declare thumbnailStatus in their output schema', async () => {
    const tools = await getTools();
    const upload = tools.find((t) => t.name === 'upload_asset')!;
    const get = tools.find((t) => t.name === 'get_asset')!;
    expect(Object.keys(upload.outputSchema)).toContain('thumbnailStatus');
    expect(JSON.stringify(Object.keys((get.outputSchema.creative as any).shape))).toContain('thumbnailStatus');
  });
});

describe('Activity can leave out MCP connection steps (Sam: 33 rows, many of them initialize / tools/list)', () => {
  it('includeConnection=false hides MCP rows with no tool; the default keeps them', async () => {
    const send = (body: Record<string, unknown>) => request(app).post('/mcp').set('Authorization', `Bearer ${key.key}`).set('Accept', ACCEPT).send(body);
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fb', version: '1' } } });
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await call(key.key, 'whoami');
    // The audit row is written when the response finishes; give it a moment.
    let all: any[] = [];
    for (let i = 0; i < 20 && all.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      all = (await request(app).get(`/api/v1/api-keys/${key.id}/activity`).set('Authorization', `Bearer ${owner}`)).body.data.items;
    }
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.some((r) => r.transport === 'mcp' && r.tool === null)).toBe(true);
    const tools = (await request(app).get(`/api/v1/api-keys/${key.id}/activity`).query({ includeConnection: 'false' }).set('Authorization', `Bearer ${owner}`)).body.data.items as any[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((r) => r.tool !== null)).toBe(true);
    expect(tools.some((r) => r.tool === 'whoami')).toBe(true);
    const bad = await request(app).get('/api/v1/api-keys/activity').query({ includeConnection: 'maybe' }).set('Authorization', `Bearer ${owner}`);
    expect(bad.status).toBe(400);
  });
});
