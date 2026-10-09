import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
import { objectExists } from '../integrations/r2/r2-client.js';
import { runUrlUpload, startUrlUpload, MAX_URL_COPIES } from '../services/mcp-url-uploads.service.js';
import { businesses } from '../db/schema/businesses.js';

// 50 MB to 1 GB by URL (spec v1.0): the API starts a background copy, the worker streams it into storage.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const MiB = 1024 * 1024;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = ''; let clientA = '';
const keyIds: string[] = [];
const files = new Map<string, { body: Buffer; type: string; status?: number; location?: string; length?: string; delayMs?: number }>();
let fetchSpy: ReturnType<typeof vi.spyOn>;
const calls = new Map<string, number>(); // how many times each URL was requested (a delay applies from the 2nd request: the worker's)
const real = globalThis.fetch;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const mp4 = (n: number, seed: string) => { const b = Buffer.alloc(n, 0x00); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); b.write('mp41', 16, 'ascii'); b.write(`${seed}-${tag}`, 32); return b; };
const u = (n: string) => `https://93.184.216.34/${tag}/${n}`;
async function call(k: string, name: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any> };
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test url ${tag}`, scopes: ['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'uploads:write'] });
  keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test URL ${tag}`, status: 'active' }).returning();
  clientA = c!.id;
  await request(app).post(`/api/v1/clients/${clientA}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_44${tag}1` }).expect(201);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const href = String(input instanceof URL ? input.href : input);
    const f = files.get(href);
    if (!f) return real(input, init);
    if (f.delayMs && calls.get(href) !== undefined) await new Promise((r) => setTimeout(r, f.delayMs));
    calls.set(href, (calls.get(href) ?? 0) + 1);
    const headers: Record<string, string> = { 'content-type': f.type, 'content-length': f.length ?? String(f.body.length) };
    if (f.location) headers.location = f.location;
    const redirect = f.status !== undefined && f.status >= 300 && f.status < 400;
    return new Response(redirect ? null : new Uint8Array(f.body), { status: f.status ?? 200, headers });
  });
});
afterAll(async () => {
  fetchSpy.mockRestore();
  const ids = (await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, clientA))).map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(uploads).where(eq(uploads.businessId, BIZ)).catch(() => {});
  await db.delete(creatives).where(eq(creatives.clientId, clientA));
  await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, clientA));
  await db.delete(clients).where(eq(clients.id, clientA));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

const upload = (name: string, extra: Record<string, unknown> = {}) => call(key, 'upload_asset', { sourceUrl: u(name), mediaType: 'video', platform: 'meta', platformAccountId: `act_44${tag}1`, ...extra });

describe('a 60 MB file by URL', () => {
  it('answers upload_incomplete with an uploadId, is copied to storage with its real SHA-256, then is filed with upload_asset', async () => {
    const body = mp4(60 * MiB, 'big');
    files.set(u('big.mp4'), { body, type: 'video/mp4' });
    const first = await upload('big.mp4');
    expect(first.isError).toBe(true);
    expect(first.structuredContent).toMatchObject({ code: 'upload_incomplete', retryable: true });
    const uploadId = first.structuredContent.details.uploadId as string;
    // The worker is not running in tests: run its job here.
    expect(await runUrlUpload(uploadId, u('big.mp4'))).toBe('ready');
    const done = await call(key, 'complete_upload', { uploadId });
    expect(done.structuredContent).toMatchObject({ status: 'ready', sizeBytes: body.length, contentType: 'video/mp4', sha256: sha(body) });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row).toMatchObject({ mode: 'url', multipartUploadId: null });
    expect(await objectExists('creatives', row!.r2Key)).toBe(true);
    const filed = await call(key, 'upload_asset', { uploadId, platform: 'meta', platformAccountId: `act_44${tag}1`, name: `Yash Test URL big ${tag}` });
    expect(filed.structuredContent).toMatchObject({ result: 'created', mediaType: 'video', sizeBytes: body.length });
  }, 120_000);
  it('asking again for the same URL reuses the copy instead of starting another', async () => {
    files.set(u('again.mp4'), { body: mp4(55 * MiB, 'again'), type: 'video/mp4' });
    const a = await upload('again.mp4'); const b = await upload('again.mp4');
    expect(b.structuredContent.details.uploadId).toBe(a.structuredContent.details.uploadId);
    expect(b.structuredContent.details.reused).toBe(true);
  }, 60_000);
});

describe('refusals', () => {
  it('a file declared over 1 GB is file_too_large before anything is copied', async () => {
    files.set(u('huge.mp4'), { body: Buffer.alloc(10), type: 'video/mp4', length: String(2 * 1024 * MiB) });
    const r = await upload('huge.mp4');
    expect(r.structuredContent.code).toBe('file_too_large');
    const rows = await db.select().from(uploads).where(eq(uploads.businessId, BIZ));
    expect(rows.some((x) => x.filename.includes('huge.mp4'))).toBe(false);
  });
  it('an .exe served as video/mp4 fails the copy, and nothing is left in storage', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(60 * MiB, 1)]);
    files.set(u('virus.mp4'), { body: exe, type: 'video/mp4' });
    const first = await upload('virus.mp4');
    const uploadId = first.structuredContent.details.uploadId as string;
    expect(await runUrlUpload(uploadId, u('virus.mp4'))).toBe('failed');
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row).toMatchObject({ status: 'failed', multipartUploadId: null });
    expect(row!.error).toContain('not a jpg, png, webp, gif, mp4 or mov');
    expect(await objectExists('creatives', row!.r2Key)).toBe(false);
    expect((await call(key, 'complete_upload', { uploadId })).structuredContent.code).toBe('upload_incomplete');
  }, 120_000);
  it('a big image is refused: by its header at once, and by its real bytes when it claims to be a video (images are up to 30 MB)', async () => {
    const png = (n: number) => { const b = Buffer.alloc(n, 3); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0); b.write(`big-${tag}`, 32); return b; };
    files.set(u('huge.png'), { body: png(60 * MiB), type: 'image/png' });
    const direct = await call(key, 'upload_asset', { sourceUrl: u('huge.png'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1` });
    expect(direct.structuredContent.code).toBe('file_too_large');
    files.set(u('liar.mp4'), { body: png(60 * MiB), type: 'video/mp4' }); // says video, is a PNG
    const first = await upload('liar.mp4');
    expect(first.structuredContent.code).toBe('upload_incomplete');
    const uploadId = first.structuredContent.details.uploadId as string;
    expect(await runUrlUpload(uploadId, u('liar.mp4'))).toBe('failed');
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row).toMatchObject({ status: 'failed', multipartUploadId: null });
    expect(row!.error).toContain('30 MB');
    expect(await objectExists('creatives', row!.r2Key)).toBe(false);
  }, 120_000);
  it('a page that is not media is unsupported_type', async () => {
    files.set(u('page.html'), { body: Buffer.from('<html></html>'), type: 'text/html' });
    expect((await upload('page.html')).structuredContent.code).toBe('unsupported_type');
  });
});

describe('redirects: up to 3, every hop checked', () => {
  it('follows two redirects to a public file', async () => {
    files.set(u('r1.mp4'), { body: Buffer.alloc(0), type: 'text/plain', status: 302, location: u('r2.mp4') });
    files.set(u('r2.mp4'), { body: Buffer.alloc(0), type: 'text/plain', status: 302, location: u('final.png') });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`redir-${tag}`)]);
    files.set(u('final.png'), { body: png, type: 'image/png' });
    const r = await call(key, 'upload_asset', { sourceUrl: u('r1.mp4'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1`, name: `Yash Test URL redirect ${tag}` });
    expect(r.structuredContent).toMatchObject({ result: 'created', mediaType: 'image' });
  });
  it('a redirect to an internal address is refused, not followed', async () => {
    files.set(u('evil.png'), { body: Buffer.alloc(0), type: 'text/plain', status: 302, location: 'http://169.254.169.254/latest/meta-data/' });
    const r = await call(key, 'upload_asset', { sourceUrl: u('evil.png'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1` });
    expect(r.structuredContent).toMatchObject({ code: 'source_unreachable' });
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).includes('169.254.169.254'))).toBe(false);
  });
  it('more than 3 redirects is refused', async () => {
    for (let i = 0; i < 5; i++) files.set(u(`loop${i}.png`), { body: Buffer.alloc(0), type: 'text/plain', status: 302, location: u(`loop${i + 1}.png`) });
    const r = await call(key, 'upload_asset', { sourceUrl: u('loop0.png'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1` });
    expect(r.structuredContent.code).toBe('source_unreachable');
    expect(r.structuredContent.message).toContain('redirects');
  });
});

describe('octet-stream links: the first bytes decide', () => {
  it('a 60 MB mp4 served as application/octet-stream is copied and checked as a video', async () => {
    const body = mp4(60 * MiB, 'octet');
    files.set(u('octet.bin'), { body, type: 'application/octet-stream' });
    const first = await upload('octet.bin');
    expect(first.structuredContent.code).toBe('upload_incomplete');
    const uploadId = first.structuredContent.details.uploadId as string;
    expect(await runUrlUpload(uploadId, u('octet.bin'))).toBe('ready');
    expect((await call(key, 'complete_upload', { uploadId })).structuredContent).toMatchObject({ status: 'ready', contentType: 'video/mp4', sha256: sha(body) });
  }, 120_000);
  it('a small png served as octet-stream is filed; an .exe served as octet-stream is unsupported_type', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`oct-${tag}`)]);
    files.set(u('o.png'), { body: png, type: 'application/octet-stream' });
    expect((await call(key, 'upload_asset', { sourceUrl: u('o.png'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1`, name: `Yash Test URL octet ${tag}` })).structuredContent).toMatchObject({ result: 'created', mediaType: 'image' });
    files.set(u('o.exe'), { body: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]), type: 'application/octet-stream' });
    expect((await call(key, 'upload_asset', { sourceUrl: u('o.exe'), mediaType: 'image', platform: 'meta', platformAccountId: `act_44${tag}1` })).structuredContent.code).toBe('unsupported_type');
  });
});

describe('the copy: parts, memory and the clock', () => {
  it('a 70 MB file (a 64 MiB part and a 6 MiB part) is hashed and stored exactly', async () => {
    const body = mp4(70 * MiB, 'twopart');
    files.set(u('two.mp4'), { body, type: 'video/mp4' });
    const first = await upload('two.mp4');
    const uploadId = first.structuredContent.details.uploadId as string;
    expect(await runUrlUpload(uploadId, u('two.mp4'))).toBe('ready');
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row).toMatchObject({ status: 'ready', sizeBytes: body.length, sha256: sha(body) });
  }, 120_000);
  it('time spent waiting in the queue does not count: the clock starts when the copy starts', async () => {
    files.set(u('wait.mp4'), { body: mp4(55 * MiB, 'wait'), type: 'video/mp4', delayMs: 600 });
    const first = await upload('wait.mp4');
    const uploadId = first.structuredContent.details.uploadId as string;
    await db.update(uploads).set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(uploads.id, uploadId));
    const run = runUrlUpload(uploadId, u('wait.mp4'));
    await new Promise((r) => setTimeout(r, 250)); // the worker is now waiting on the (slow) URL
    const [during] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(Date.now() - during!.updatedAt.getTime()).toBeLessThan(60_000);
    expect(await run).toBe('ready');
  }, 60_000);
});

describe('a limit on copies running at once', () => {
  it('refuses a 6th copy with rate_limited, even for a different query string on the same file', async () => {
    const [b] = await db.insert(businesses).values({ name: `Yash Test cap ${tag}`, slug: `yash-test-cap-${tag}` }).returning();
    try {
      const caller = { businessId: b!.id, userId: null, keyId: keyIds[0]! };
      await db.insert(uploads).values(Array.from({ length: MAX_URL_COPIES }, (_, i) => ({ businessId: b!.id, filename: `url-cap${i}-x.mp4`, contentType: 'video/mp4', sizeBytes: 100, r2Key: `cap-${tag}-${i}`, mode: 'url' as const, status: 'processing' as const })));
      files.set(u('cap.mp4?n=6'), { body: mp4(55 * MiB, 'cap'), type: 'video/mp4' });
      await expect(startUrlUpload(caller, u('cap.mp4?n=6'))).rejects.toMatchObject({ code: 'rate_limited' });
      await db.update(uploads).set({ status: 'ready' }).where(eq(uploads.businessId, b!.id));
      const ok = await startUrlUpload(caller, u('cap.mp4?n=6'));
      expect(ok.reused).toBe(false);
    } finally {
      await db.delete(uploads).where(eq(uploads.businessId, b!.id));
      await db.delete(businesses).where(eq(businesses.id, b!.id));
    }
  }, 60_000);
});
