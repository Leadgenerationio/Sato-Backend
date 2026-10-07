import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { uploads } from '../db/schema/uploads.js';
import { apiKeys } from '../db/schema/api-keys.js';

// Spec v1.0 section 3: every write tool takes an optional idempotencyKey (24 h replay; the same key with a different request is refused).
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
const ALL = ['clients:read', 'ad_accounts:write', 'ad_links:write', 'creatives:read', 'creatives:write', 'uploads:write'];
let owner = ''; let key = ''; let clientA = ''; let clientB = ''; let creativeId = '';
const keyIds: string[] = [];

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method, params });
  expect(res.status).toBe(200);
  return res.body.result;
}
const call = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }) as Promise<{ isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> }>;

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test idem ${tag}`, scopes: ALL });
  keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
  const mk = async (n: string) => (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test IDEM ${n} ${tag}`, status: 'active' }).returning())[0]!.id;
  clientA = await mk('A'); clientB = await mk('B');
  await request(app).post(`/api/v1/clients/${clientA}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_77${tag}1` }).expect(201);
  const [cr] = await db.insert(creatives).values({ businessId: BIZ, clientId: clientA, name: `Yash Test IDEM asset ${tag}`, type: 'image', platform: 'meta', source: 'mcp' } as any).returning();
  creativeId = cr!.id;
});
afterAll(async () => {
  await db.delete(creativeAdLinks).where(eq(creativeAdLinks.creativeId, creativeId));
  await db.delete(uploads).where(eq(uploads.businessId, BIZ)).catch(() => {});
  await db.delete(creatives).where(eq(creatives.id, creativeId));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [clientA, clientB]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('every write tool takes an idempotencyKey', () => {
  it('tools/list: every tool that is not read-only has an idempotencyKey input', async () => {
    const tools = (await rpc('tools/list')).tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties: Record<string, unknown> } }>;
    const missing = tools.filter((t) => !t.annotations?.readOnlyHint && !('idempotencyKey' in t.inputSchema.properties)).map((t) => t.name);
    expect(missing).toEqual([]);
  });
});

describe('replay', () => {
  const same = (a: any, b: any) => expect(b.structuredContent).toEqual(a.structuredContent);
  it('link_ad_account: the same key and arguments returns the first answer; the same key with other arguments is refused', async () => {
    const args = { clientId: clientB, platform: 'meta', accountId: `act_77${tag}2`, idempotencyKey: `idem-${tag}-la` };
    const first = await call('link_ad_account', args);
    expect(first.structuredContent.result).toBe('created');
    const again = await call('link_ad_account', args);
    same(first, again);
    expect(again.content[0]!.text).toContain('Same request as before');
    const other = await call('link_ad_account', { ...args, accountId: `act_77${tag}3` });
    expect(other.isError).toBe(true);
    expect(other.structuredContent.code).toBe('validation_failed');
  });
  it('link_ad_platform_ids: replayed, and one ad link', async () => {
    const args = { creativeId, platform: 'meta', accountId: `act_77${tag}1`, adId: `idem-ad-${tag}`, idempotencyKey: `idem-${tag}-lp` };
    const first = await call('link_ad_platform_ids', args);
    expect(first.structuredContent.result).toBe('created');
    const again = await call('link_ad_platform_ids', args);
    same(first, again);
    expect(again.content[0]!.text).toContain('Same request as before');
    expect(await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, creativeId))).toHaveLength(1);
  });
  it('unlink_ad_platform_ids: replayed', async () => {
    const [link] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, creativeId));
    const args = { adLinkId: link!.id, reason: 'idem test', idempotencyKey: `idem-${tag}-ul` };
    const first = await call('unlink_ad_platform_ids', args);
    expect(first.structuredContent.result).toBe('removed');
    const again = await call('unlink_ad_platform_ids', args);
    same(first, again);
    expect(again.content[0]!.text).toContain('Same request as before');
  });
  it('complete_upload: an answer that is still processing is not kept, so the same key works until the file is ready', async () => {
    const [row] = await db.insert(uploads).values({ businessId: BIZ, filename: 'idem.mp4', contentType: 'video/mp4', sizeBytes: 100, r2Key: `idem-${tag}`, mode: 'single', status: 'processing', sha256: 'a'.repeat(64) }).returning();
    const args = { uploadId: row!.id, idempotencyKey: `idem-${tag}-cu` };
    expect((await call('complete_upload', args)).structuredContent.status).toBe('processing');
    await db.update(uploads).set({ status: 'ready' }).where(eq(uploads.id, row!.id));
    const ready = await call('complete_upload', args);
    expect(ready.structuredContent.status).toBe('ready'); // not the stale 'processing'
    await db.update(uploads).set({ status: 'processing' }).where(eq(uploads.id, row!.id));
    const replay = await call('complete_upload', args);
    expect(replay.structuredContent.status).toBe('ready'); // the final answer is kept
    expect(replay.content[0]!.text).toContain('Same request as before');
  });
});
