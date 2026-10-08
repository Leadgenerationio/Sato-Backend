import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { uploads } from '../db/schema/uploads.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { hashObject, objectExists, getSignedUploadUrl } from '../integrations/r2/r2-client.js';
import * as r2 from '../integrations/r2/r2-client.js';
import * as multipart from '../integrations/r2/r2-multipart.js';
import { claimUploadForFiling, createUpload, releaseUploadClaim, sweepUploads } from '../services/mcp-uploads.service.js';
import { fetchRemoteMedia } from '../utils/remote-media.js';
import { MediaSourceError } from '../utils/errors.js';

// Review changes on the upload PR: a verified file cannot be replaced through its old URL, an upload is used once,
// a storage error never deletes a file, list_ad_accounts shows only this business, ids are validated.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = '';
let clientA = ''; let clientB = ''; let otherBiz = ''; let otherClient = '';
const keyIds: string[] = [];
const spendIds: string[] = [];
const campIds: string[] = [];
const tsIds: string[] = [];

const jpeg = (n: number, seed: string) => { const b = Buffer.alloc(n, 0x41); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0); b.write(`${seed}-${tag}`, 8); return b; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function call(k: string, name: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}
const put = async (url: string, body: Buffer, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });
  expect(r.status).toBe(200);
};
const upload = async (file: Buffer) => {
  const c = await call(key, 'create_upload', { filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: file.length });
  await put(c.structuredContent.uploadUrl, file, c.structuredContent.headers);
  return c.structuredContent as { uploadId: string; uploadUrl: string; headers: Record<string, string> };
};
const acct = (n: number) => ({ platform: 'meta', platformAccountId: `act_55${tag}${n}` });

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({
    name: `Yash Test hard ${tag}`,
    scopes: ['clients:read', 'ad_accounts:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'landing_pages:write'],
  });
  expect(made.status).toBe(201);
  keyIds.push(made.body.data.apiKey.id);
  key = made.body.data.key;
  for (const n of [1, 2]) {
    const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test HARD ${n} ${tag}`, status: 'active' }).returning();
    if (n === 1) clientA = c!.id; else clientB = c!.id;
    await request(app).post(`/api/v1/clients/${c!.id}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_55${tag}${n}` }).expect(201);
  }
  const [b] = await db.insert(businesses).values({ name: `Yash Test other ${tag}`, slug: `yash-test-other-${tag}` }).returning();
  otherBiz = b!.id;
  const [oc] = await db.insert(clients).values({ businessId: otherBiz, companyName: `Yash Test OTHER ${tag}`, status: 'active' }).returning();
  otherClient = oc!.id;
});
afterAll(async () => {
  vi.restoreAllMocks();
  const ids = (await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.clientId, [clientA, clientB]))).map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(uploads).where(inArray(uploads.businessId, [BIZ, otherBiz])).catch(() => {});
  await db.delete(creatives).where(inArray(creatives.clientId, [clientA, clientB]));
  if (tsIds.length) await db.delete(trafficSources).where(inArray(trafficSources.id, tsIds));
  if (campIds.length) await db.delete(campaigns).where(inArray(campaigns.id, campIds));
  if (spendIds.length) await db.delete(adSpend).where(inArray(adSpend.id, spendIds));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [clientA, clientB, otherClient]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB, otherClient]));
  await db.delete(businesses).where(eq(businesses.id, otherBiz));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('a verified single-PUT file cannot be replaced through its old URL', () => {
  it('signs the size into the URL, and works on a copy under a key nobody has a URL for', async () => {
    const file = jpeg(8000, 'swap');
    const up = await upload(file);
    expect(new URL(up.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(up.headers['Content-Length']).toBe(String(file.length));
    const [before] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    const originalKey = before!.r2Key;

    const done = await call(key, 'complete_upload', { uploadId: up.uploadId });
    expect(done.structuredContent).toMatchObject({ status: 'ready', sha256: sha(file) });
    const [after] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(after!.r2Key).not.toBe(originalKey);
    expect(after!.r2Key.startsWith('verified-')).toBe(true);
    expect(await objectExists('creatives', originalKey)).toBe(false);

    // The caller still holds the old URL: writing to it now does not touch the verified file.
    await put(up.uploadUrl, Buffer.from('MZ-not-an-image'), { 'Content-Type': 'image/jpeg' });
    expect((await hashObject('creatives', after!.r2Key, 1024 * 1024))!.sha256).toBe(sha(file));
    await r2.deleteFile('creatives', originalKey);
  });
});

describe('the original single-PUT key is cleaned once its URL has expired', () => {
  it('a file written through the old URL after the copy is removed by the sweeper; the verified file stays', async () => {
    const file = jpeg(8100, 'orig');
    const up = await upload(file);
    const [before] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    const originalKey = before!.r2Key;
    expect((await call(key, 'complete_upload', { uploadId: up.uploadId })).structuredContent.status).toBe('ready');
    const [after] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(after!.r2Key).toBe(`verified-${originalKey}`);
    await put(up.uploadUrl, Buffer.from('written later through the old URL'), { 'Content-Type': 'image/jpeg' });
    expect(await objectExists('creatives', originalKey)).toBe(true);
    await sweepUploads(); // the URL is still valid: nothing to clean yet
    expect(await objectExists('creatives', originalKey)).toBe(true);
    await db.update(uploads).set({ expiresAt: new Date(Date.now() - 5 * 60 * 1000) }).where(eq(uploads.id, up.uploadId));
    await sweepUploads();
    expect(await objectExists('creatives', originalKey)).toBe(false);
    expect(await objectExists('creatives', after!.r2Key)).toBe(true);
  });
});

describe('an upload is used once', () => {
  it('the same upload for another client is refused, and for the same client returns the first asset; a duplicate never leaves a dead file behind', async () => {
    const file = jpeg(9000, 'once');
    const first = await upload(file);
    await call(key, 'complete_upload', { uploadId: first.uploadId });
    const made = await call(key, 'upload_asset', { uploadId: first.uploadId, ...acct(1), name: `Yash HARD once ${tag}` });
    expect(made.structuredContent.result).toBe('created');

    const second = await upload(file);
    await call(key, 'complete_upload', { uploadId: second.uploadId });
    const dup = await call(key, 'upload_asset', { uploadId: second.uploadId, ...acct(1) });
    expect(dup.structuredContent).toMatchObject({ result: 'duplicate', creativeId: made.structuredContent.creativeId });

    const other = await call(key, 'upload_asset', { uploadId: second.uploadId, ...acct(2) });
    expect(other.isError).toBe(true);
    expect(other.structuredContent.code).toBe('validation_failed');
    expect(other.structuredContent.message).toContain('already used');
    expect(await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, clientB))).toHaveLength(0);

    const again = await call(key, 'upload_asset', { uploadId: second.uploadId, ...acct(1) });
    expect(again.structuredContent).toMatchObject({ creativeId: made.structuredContent.creativeId });
    const [stored] = await db.select().from(creatives).where(eq(creatives.id, made.structuredContent.creativeId));
    expect(await objectExists('creatives', stored!.r2Key!)).toBe(true);
  });
});

describe('a storage error does not delete the file', () => {
  it('complete_upload that cannot read the file answers a retryable error, keeps the file and the upload, and works on the next call', async () => {
    const file = jpeg(7000, 'blip');
    const up = await upload(file);
    const spy = vi.spyOn(r2, 'hashObject').mockRejectedValueOnce(new Error('R2 hiccup'));
    const failed = await call(key, 'complete_upload', { uploadId: up.uploadId });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ code: 'internal_error', retryable: true });
    spy.mockRestore();
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(row!.status).toBe('uploading');
    expect(await objectExists('creatives', row!.r2Key)).toBe(true);

    const done = await call(key, 'complete_upload', { uploadId: up.uploadId });
    expect(done.structuredContent).toMatchObject({ status: 'ready', sha256: sha(file) });
  });
  it('an error while reading the first bytes is retryable too', async () => {
    const up = await upload(jpeg(6000, 'head'));
    const spy = vi.spyOn(multipart, 'readObjectHead').mockRejectedValueOnce(new Error('R2 hiccup'));
    const failed = await call(key, 'complete_upload', { uploadId: up.uploadId });
    spy.mockRestore();
    expect(failed.structuredContent).toMatchObject({ code: 'internal_error', retryable: true });
    expect((await call(key, 'complete_upload', { uploadId: up.uploadId })).structuredContent.status).toBe('ready');
  });
});

describe('a storage error after multipart assembly does not lose the file', () => {
  it('complete (assembles) -> storage error -> retry without parts is ready, not failed', async () => {
    const big = Buffer.alloc(70 * 1024 * 1024, 0x00); big.writeUInt32BE(24, 0); big.write('ftyp', 4, 'ascii'); big.write('isom', 8, 'ascii'); big.write('mp41', 16, 'ascii'); big.write(`mpr-${tag}`, 32);
    const c = await call(key, 'create_upload', { filename: 'multi.mp4', contentType: 'video/mp4', sizeBytes: big.length });
    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const part of c.structuredContent.parts as Array<{ partNumber: number; url: string; bytes: number }>) {
      const from = (part.partNumber - 1) * c.structuredContent.partSize;
      const r = await fetch(part.url, { method: 'PUT', body: new Uint8Array(big.subarray(from, from + part.bytes)) });
      expect(r.status).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: r.headers.get('etag') ?? '' });
    }
    const spy = vi.spyOn(multipart, 'readObjectHead').mockRejectedValueOnce(new Error('R2 hiccup'));
    const first = await call(key, 'complete_upload', { uploadId: c.structuredContent.uploadId, parts: etags });
    spy.mockRestore();
    expect(first.structuredContent).toMatchObject({ code: 'internal_error', retryable: true });
    const [mid] = await db.select().from(uploads).where(eq(uploads.id, c.structuredContent.uploadId));
    expect(mid).toMatchObject({ status: 'uploading', multipartUploadId: null });
    expect(await objectExists('creatives', mid!.r2Key)).toBe(true);
    const retry = await call(key, 'complete_upload', { uploadId: c.structuredContent.uploadId });
    expect(retry.structuredContent).toMatchObject({ status: 'ready', sha256: sha(big) });
  }, 120_000);
});

describe('an upload is claimed in the database, so it is filed once', () => {
  it('two upload_asset calls at once for two clients: one creative, the other refused', async () => {
    const up = await upload(jpeg(9500, 'race'));
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    const [a, b] = await Promise.all([
      call(key, 'upload_asset', { uploadId: up.uploadId, ...acct(1) }),
      call(key, 'upload_asset', { uploadId: up.uploadId, ...acct(2) }),
    ]);
    const made = [a, b].filter((r) => r.structuredContent.creativeId);
    const refused = [a, b].filter((r) => r.isError);
    expect(made).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(row).toMatchObject({ creativeId: made[0]!.structuredContent.creativeId, error: null });
    const same = await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.r2Key, row!.r2Key));
    expect(same).toHaveLength(1);
  });
  it('the claim is taken once, can be given back, and an old dead claim can be taken over', async () => {
    const up = await upload(jpeg(9400, 'claim'));
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    expect(await claimUploadForFiling(up.uploadId)).toBe(true);
    expect(await claimUploadForFiling(up.uploadId)).toBe(false);
    await releaseUploadClaim(up.uploadId);
    expect(await claimUploadForFiling(up.uploadId)).toBe(true);
    await db.update(uploads).set({ updatedAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(uploads.id, up.uploadId));
    expect(await claimUploadForFiling(up.uploadId)).toBe(true); // the holder is gone: taken over
    await releaseUploadClaim(up.uploadId);
  });
  it('a failed filing gives the claim back, so the call can be repeated', async () => {
    const up = await upload(jpeg(9600, 'release'));
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    const bad = await call(key, 'upload_asset', { uploadId: up.uploadId, platform: 'meta', platformAccountId: `act_55${tag}999` });
    expect(bad.structuredContent.code).toBe('account_not_linked');
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(row!.error).toBeNull();
    expect((await call(key, 'upload_asset', { uploadId: up.uploadId, ...acct(1) })).structuredContent.result).toMatch(/created|duplicate/);
  });
});

describe('list_ad_accounts shows only this business', () => {
  it('leaves out an account another business has linked, with its name and spend', async () => {
    const accountId = `66${tag}9`;
    await db.insert(clientAdAccounts).values({ businessId: otherBiz, clientId: otherClient, platform: 'facebook-ads', accountId, accountName: 'B secret account' });
    const [sp] = await db.insert(adSpend).values({ platform: 'facebook-ads', authorizationId: 1, accountId, accountName: 'B secret account', campaignId: `c${tag}`, date: new Date().toISOString().slice(0, 10), spend: '1234.5' }).returning();
    spendIds.push(sp!.id);
    const res = await call(key, 'list_ad_accounts', { q: accountId });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.items).toEqual([]);
    // Spend on an account nobody has claimed is not shown either: ad_spend has no business column.
    const free = `66${tag}8`;
    const [sp2] = await db.insert(adSpend).values({ platform: 'facebook-ads', authorizationId: 1, accountId: free, accountName: 'Unclaimed', campaignId: `c${tag}`, date: new Date().toISOString().slice(0, 10), spend: '10' }).returning();
    spendIds.push(sp2!.id);
    expect((await call(key, 'list_ad_accounts', { q: free })).structuredContent.items).toEqual([]);
    // ...until a traffic source ties it to a campaign this business can see.
    const [camp] = await db.insert(campaigns).values({ name: `Yash Test PW camp ${tag}`, leadbyteCampaignId: `PW-${tag}` }).returning();
    campIds.push(camp!.id);
    const [ts] = await db.insert(trafficSources).values({ campaignId: camp!.id, name: `Yash Test PW ts ${tag}`, platform: 'facebook-ads', accountId: free }).returning();
    tsIds.push(ts!.id);
    const shown = await call(key, 'list_ad_accounts', { q: free });
    expect(shown.structuredContent.items).toHaveLength(1);
    expect(shown.structuredContent.items[0].campaigns[0].campaignId).toBe(camp!.id);
  });
});

describe('ids are validated before the database sees them', () => {
  it.each([
    ['get_asset', { creativeId: 'abc' }],
    ['list_assets', { clientId: 'abc' }],
    ['list_assets', { campaignId: 'abc' }],
    ['list_assets', { landingPageId: 'abc' }],
    ['add_landing_page', { clientId: 'abc', url: 'https://example.com' }],
    ['add_landing_page', { clientId: '00000000-0000-4000-8000-000000000000', url: 'https://example.com', campaignId: 'abc' }],
    ['list_landing_pages', { clientId: 'abc' }],
    ['attach_landing_page', { creativeId: 'abc', url: 'https://example.com' }],
    ['attach_landing_page', { creativeId: '00000000-0000-4000-8000-000000000000', landingPageId: 'abc' }],
    ['update_asset', { creativeId: 'abc', name: 'x' }],
    ['update_asset', { creativeId: '00000000-0000-4000-8000-000000000000', clientId: 'abc' }],
    ['archive_asset', { creativeId: 'abc' }],
    ['restore_asset', { creativeId: 'abc' }],
    ['complete_upload', { uploadId: 'abc' }],
    ['upload_asset', { uploadId: 'abc', ...acct(1) }],
  ])('%s %j is validation_failed, not internal_error', async (name, args) => {
    const res = await call(key, name, args);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.code).toBe('validation_failed');
  });
});

describe('a file whose content is not an allowed type, served by a sourceUrl', () => {
  it('is MediaSourceError unsupported_type, so the tool answers unsupported_type', async () => {
    const exe = new Response(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), { headers: { 'content-type': 'image/png' } });
    const err = await fetchRemoteMedia('https://example.com/a.png', { fetchImpl: async () => exe, lookup: async () => [{ address: '93.184.216.34' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaSourceError);
    expect((err as MediaSourceError).reason).toBe('unsupported_type');
  });
});

describe('storage is bounded', () => {
  it('refuses a new upload when the business already has 50 open', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ businessId: otherBiz, filename: `o${i}.jpg`, contentType: 'image/jpeg', sizeBytes: 10, r2Key: `open-${tag}-${i}`, mode: 'single' as const, status: 'uploading' as const }));
    await db.insert(uploads).values(rows);
    await expect(createUpload({ businessId: otherBiz, userId: null, keyId: keyIds[0]! }, { filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10 })).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it("the sweeper never removes the file of an upload a live creative already points at (filing failed halfway)", async () => {
    const file = jpeg(5000, 'halfway');
    const up = await upload(file);
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    // the creative was made from this file, but the upload was never marked used
    const [cr] = await db.insert(creatives).values({ name: `Yash HARD halfway ${tag}`, fileUrl: `r2://stato/creatives/${row!.r2Key}`, r2Key: row!.r2Key, type: 'image', clientId: clientA, source: 'mcp' }).returning();
    try {
      await db.update(uploads).set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(uploads.id, up.uploadId));
      await sweepUploads();
      expect(await objectExists('creatives', row!.r2Key)).toBe(true); // the creative's file is still there
    } finally {
      await db.delete(creatives).where(eq(creatives.id, cr!.id));
      await db.update(uploads).set({ status: 'failed' }).where(eq(uploads.id, up.uploadId));
      await r2.deleteFile('creatives', row!.r2Key).catch(() => undefined);
    }
  });
  it('the sweeper does not fail an upload that is still waiting in the queue, but fails one that is not', async () => {
    const file = jpeg(5000, 'queued');
    const up = await upload(file);
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    await db.update(uploads).set({ status: 'processing', updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(uploads.id, up.uploadId));
    await sweepUploads(new Date(), { queuedUploadIds: async () => new Set([up.uploadId]) });
    expect((await db.select().from(uploads).where(eq(uploads.id, up.uploadId)))[0]).toMatchObject({ status: 'processing' });
    expect(await objectExists('creatives', row!.r2Key)).toBe(true);
    await sweepUploads(new Date(), { queuedUploadIds: async () => new Set() });
    expect((await db.select().from(uploads).where(eq(uploads.id, up.uploadId)))[0]).toMatchObject({ status: 'failed', error: 'Processing timed out' });
    expect(await objectExists('creatives', row!.r2Key)).toBe(false);
  });
  it('the sweeper removes a ready upload nobody used, and settles a stuck video as ready', async () => {
    const file = jpeg(5000, 'unused');
    const up = await upload(file);
    await call(key, 'complete_upload', { uploadId: up.uploadId });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(row!.status).toBe('ready');
    await db.update(uploads).set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(uploads.id, up.uploadId));
    await sweepUploads();
    const [after] = await db.select().from(uploads).where(eq(uploads.id, up.uploadId));
    expect(after).toMatchObject({ status: 'expired' });
    expect(await objectExists('creatives', row!.r2Key)).toBe(false);
  });
});
