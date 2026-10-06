import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { sweepUploads } from '../services/mcp-uploads.service.js';
import { processVideo } from '../services/creative-thumbnail.service.js';

// MCP spec v1.0 create_upload / complete_upload / upload_asset(uploadId):
// tests 3 (the flow, with a file over the old 50 MB limit), 8 (duplicate) and 11 (refusals).
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const MiB = 1024 * 1024;
const ACCEPT = 'application/json, text/event-stream';
let owner = ''; let key = ''; let noUploadKey = '';
let clientA = '';
const keyIds: string[] = [];

const jpeg = (n: number, seed: string) => { const b = Buffer.alloc(n, 0x41); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0); b.write(`${seed}-${tag}`, 8); return b; };
const mp4 = (n: number, seed: string) => {
  const b = Buffer.alloc(n, 0x00);
  b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); b.write('mp41', 16, 'ascii'); b.write(`${seed}-${tag}`, 32);
  return b;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test upl ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return res.body.data.key as string;
}
async function call(k: string, name: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${k}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
}
const put = async (url: string, body: Buffer, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });
  expect(r.status).toBe(200);
  return r.headers.get('etag') ?? '';
};
const account = (n: number) => ({ platform: 'meta', platformAccountId: `act_33${tag}${n}` });

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  key = await makeKey(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'uploads:write']);
  noUploadKey = await makeKey(['creatives:write']);
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test UPL ${tag}`, status: 'active' }).returning();
  clientA = c!.id;
  await request(app).post(`/api/v1/clients/${clientA}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_33${tag}1` }).expect(201);
});
afterAll(async () => {
  const rows = await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, clientA));
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
  await db.delete(uploads).where(eq(uploads.businessId, BIZ)).catch(() => {});
  await db.delete(creatives).where(eq(creatives.clientId, clientA));
  await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, clientA));
  await db.delete(clients).where(eq(clients.id, clientA));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('direct upload of a small file (single PUT)', () => {
  it('create_upload, PUT, complete_upload, then upload_asset files it (and the same file again is a duplicate)', async () => {
    const file = jpeg(20_000, 'single');
    const created = await call(key, 'create_upload', { filename: 'ad one.jpg', contentType: 'image/jpeg', sizeBytes: file.length });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ mode: 'single', partSize: null, parts: null, headers: { 'Content-Type': 'image/jpeg' } });
    await put(created.structuredContent.uploadUrl, file, created.structuredContent.headers);

    const done = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId });
    expect(done.structuredContent).toMatchObject({ status: 'ready', sizeBytes: file.length, contentType: 'image/jpeg', sha256: sha(file) });
    expect((await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId })).structuredContent.status).toBe('ready'); // idempotent

    const asset = await call(key, 'upload_asset', { uploadId: created.structuredContent.uploadId, ...account(1), name: `Yash UPL one ${tag}` });
    expect(asset.isError).toBeUndefined();
    expect(asset.structuredContent).toMatchObject({ result: 'created', mediaType: 'image', fileStatus: 'ready', sizeBytes: file.length });
    const [row] = await db.select().from(creatives).where(eq(creatives.id, asset.structuredContent.creativeId));
    expect(row).toMatchObject({ clientId: clientA, sha256: sha(file), source: 'mcp' });
    const [up] = await db.select().from(uploads).where(eq(uploads.id, created.structuredContent.uploadId));
    expect(up).toMatchObject({ status: 'ready', creativeId: row!.id });

    // The same bytes through a second upload: one creative, result duplicate, the duplicate object removed.
    const again = await call(key, 'create_upload', { filename: 'copy.jpg', contentType: 'image/jpeg', sizeBytes: file.length });
    await put(again.structuredContent.uploadUrl, file, again.structuredContent.headers);
    await call(key, 'complete_upload', { uploadId: again.structuredContent.uploadId });
    const dup = await call(key, 'upload_asset', { uploadId: again.structuredContent.uploadId, ...account(1) });
    expect(dup.structuredContent).toMatchObject({ result: 'duplicate', creativeId: asset.structuredContent.creativeId });
  });
});

describe('direct upload of a big file (multipart), over the old 50 MB limit', () => {
  it('uploads 70 MB in two parts, verifies size, type and SHA-256, and files it as a video still processing (test 3)', async () => {
    const file = mp4(70 * MiB, 'big');
    const created = await call(key, 'create_upload', { filename: 'big.mp4', contentType: 'video/mp4', sizeBytes: file.length });
    expect(created.structuredContent).toMatchObject({ mode: 'multipart', partSize: 64 * MiB, uploadUrl: null });
    expect(created.structuredContent.parts.map((p: { bytes: number }) => p.bytes)).toEqual([64 * MiB, 6 * MiB]);

    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const p of created.structuredContent.parts as Array<{ partNumber: number; url: string; bytes: number }>) {
      const from = (p.partNumber - 1) * 64 * MiB;
      etags.push({ partNumber: p.partNumber, etag: await put(p.url, file.subarray(from, from + p.bytes)) });
    }
    const done = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId, parts: etags });
    expect(done.structuredContent).toMatchObject({ status: 'ready', sizeBytes: file.length, contentType: 'video/mp4', sha256: sha(file) });

    const asset = await call(key, 'upload_asset', { uploadId: created.structuredContent.uploadId, ...account(1), name: `Yash UPL big ${tag}` });
    expect(asset.structuredContent).toMatchObject({ result: 'created', mediaType: 'video', fileStatus: 'processing', sizeBytes: file.length });
  }, 120_000);

  it('only the first part uploaded: the size does not match, the file is removed', async () => {
    const file = mp4(70 * MiB, 'short');
    const created = await call(key, 'create_upload', { filename: 'short.mp4', contentType: 'video/mp4', sizeBytes: file.length });
    const p1 = created.structuredContent.parts[0];
    const etag = await put(p1.url, file.subarray(0, p1.bytes));
    const r = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId, parts: [{ partNumber: 1, etag }] });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('validation_failed');
    expect(r.structuredContent.fields[0].field).toBe('sizeBytes');
    const [up] = await db.select().from(uploads).where(eq(uploads.id, created.structuredContent.uploadId));
    expect(up!.status).toBe('failed');
    expect(await objectExists('creatives', up!.r2Key)).toBe(false);
  }, 120_000);

  it('a multipart complete without parts is refused', async () => {
    const created = await call(key, 'create_upload', { filename: 'p.mp4', contentType: 'video/mp4', sizeBytes: 70 * MiB });
    const r = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId });
    expect(r.structuredContent.code).toBe('validation_failed');
    expect(r.structuredContent.fields[0].field).toBe('parts');
  });
});

describe('refusals before and after upload (test 11)', () => {
  it('a 5 GB video is file_too_large before anything is created; so is a 31 MB image; a wrong type is unsupported_type', async () => {
    const before = (await db.select().from(uploads).where(eq(uploads.businessId, BIZ))).length;
    const big = await call(key, 'create_upload', { filename: 'huge.mp4', contentType: 'video/mp4', sizeBytes: 5 * 1024 * MiB });
    expect(big.structuredContent.code).toBe('file_too_large');
    expect(big.structuredContent.hint).toContain('4 GB');
    expect((await call(key, 'create_upload', { filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 31 * MiB })).structuredContent.code).toBe('file_too_large');
    expect((await call(key, 'create_upload', { filename: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 100 })).structuredContent.code).toBe('unsupported_type');
    expect((await db.select().from(uploads).where(eq(uploads.businessId, BIZ))).length).toBe(before);
    // exactly 4 GB is accepted
    expect((await call(key, 'create_upload', { filename: 'four.mp4', contentType: 'video/mp4', sizeBytes: 4 * 1024 * MiB })).structuredContent.mode).toBe('multipart');
  });
  it('an .exe renamed .mp4 is unsupported_type after upload, removed from storage, and cannot be completed again', async () => {
    const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary'), Buffer.alloc(2000, 0x20)]);
    const created = await call(key, 'create_upload', { filename: 'invoice.mp4', contentType: 'video/mp4', sizeBytes: exe.length });
    await put(created.structuredContent.uploadUrl, exe, created.structuredContent.headers);
    const r = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId });
    expect(r.structuredContent.code).toBe('unsupported_type');
    const [up] = await db.select().from(uploads).where(eq(uploads.id, created.structuredContent.uploadId));
    expect(up!.status).toBe('failed');
    expect(await objectExists('creatives', up!.r2Key)).toBe(false);
    expect((await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId })).structuredContent.code).toBe('upload_incomplete');
    expect((await call(key, 'upload_asset', { uploadId: created.structuredContent.uploadId, ...account(1) })).structuredContent.code).toBe('upload_incomplete');
  });
  it('a file whose type does not match what was declared (a png sent as a video) is refused', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(500, 1)]);
    const created = await call(key, 'create_upload', { filename: 'fake.mp4', contentType: 'video/mp4', sizeBytes: png.length });
    await put(created.structuredContent.uploadUrl, png, created.structuredContent.headers);
    expect((await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId })).structuredContent.code).toBe('unsupported_type');
  });
  it('a wrong size is refused and removed; a declared sha256 that does not match is refused and removed', async () => {
    const file = jpeg(3000, 'size');
    const wrong = await call(key, 'create_upload', { filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 5000 });
    // Sent without the Content-Length the URL is signed for (as a caller that ignores the headers would): complete_upload still checks the real size.
    await put(wrong.structuredContent.uploadUrl, file, { 'Content-Type': 'image/jpeg' });
    expect((await call(key, 'complete_upload', { uploadId: wrong.structuredContent.uploadId })).structuredContent.code).toBe('validation_failed');

    const shaWrong = await call(key, 'create_upload', { filename: 'b.jpg', contentType: 'image/jpeg', sizeBytes: file.length, sha256: 'a'.repeat(64) });
    await put(shaWrong.structuredContent.uploadUrl, file, shaWrong.structuredContent.headers);
    const r = await call(key, 'complete_upload', { uploadId: shaWrong.structuredContent.uploadId });
    expect(r.structuredContent.code).toBe('validation_failed');
    expect(r.structuredContent.message).toContain('sha256');
    const [up] = await db.select().from(uploads).where(eq(uploads.id, shaWrong.structuredContent.uploadId));
    expect(await objectExists('creatives', up!.r2Key)).toBe(false);
  });
  it('completing before the file is uploaded is upload_incomplete and can be retried', async () => {
    const file = jpeg(2000, 'late');
    const created = await call(key, 'create_upload', { filename: 'late.jpg', contentType: 'image/jpeg', sizeBytes: file.length });
    const r = await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId });
    expect(r.structuredContent.code).toBe('upload_incomplete');
    await put(created.structuredContent.uploadUrl, file, created.structuredContent.headers);
    expect((await call(key, 'complete_upload', { uploadId: created.structuredContent.uploadId })).structuredContent.status).toBe('ready');
  });
  it('upload_asset before complete_upload is upload_incomplete; both ways of sending the file or neither are refused; an unknown upload is not_found', async () => {
    const created = await call(key, 'create_upload', { filename: 'early.jpg', contentType: 'image/jpeg', sizeBytes: 2000 });
    expect((await call(key, 'upload_asset', { uploadId: created.structuredContent.uploadId, ...account(1) })).structuredContent.code).toBe('upload_incomplete');
    expect((await call(key, 'upload_asset', { ...account(1) })).structuredContent.code).toBe('validation_failed');
    expect((await call(key, 'upload_asset', { uploadId: created.structuredContent.uploadId, sourceUrl: 'https://93.184.216.34/a.jpg', ...account(1) })).structuredContent.code).toBe('validation_failed');
    expect((await call(key, 'upload_asset', { uploadId: '11111111-1111-4111-8111-111111111111', ...account(1) })).structuredContent.code).toBe('not_found');
  });
  it('needs the uploads:write scope', async () => {
    expect((await call(noUploadKey, 'create_upload', { filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100 })).structuredContent.code).toBe('insufficient_scope');
  });
});

describe('the sweeper', () => {
  it('expires an abandoned upload and removes its parts; fails one stuck on processing', async () => {
    const open = await call(key, 'create_upload', { filename: 'abandoned.mp4', contentType: 'video/mp4', sizeBytes: 70 * MiB });
    const part = open.structuredContent.parts[0];
    await put(part.url, mp4(64 * MiB, 'abandoned'));
    await db.update(uploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploads.id, open.structuredContent.uploadId));

    const stuck = await call(key, 'create_upload', { filename: 'stuck.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    await db.update(uploads).set({ status: 'processing', updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(uploads.id, stuck.structuredContent.uploadId));

    const swept = await sweepUploads();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(swept.failed).toBeGreaterThanOrEqual(1);
    const [a] = await db.select().from(uploads).where(eq(uploads.id, open.structuredContent.uploadId));
    const [b] = await db.select().from(uploads).where(eq(uploads.id, stuck.structuredContent.uploadId));
    expect(a!.status).toBe('expired');
    expect(b).toMatchObject({ status: 'failed', error: 'Processing timed out' });
    expect((await call(key, 'complete_upload', { uploadId: open.structuredContent.uploadId })).structuredContent.code).toBe('upload_incomplete');
  }, 120_000);
});

describe('video processing: width, height, duration, poster, and a status that always settles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stato-bin-'));
  const origPath = process.env.PATH;
  const script = (name: string, body: string) => { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  let rowId = '';
  const newVideoRow = async () => {
    const [r] = await db.insert(creatives).values({ name: `Yash UPL video ${tag}`, fileUrl: 'r2://stato/creatives/x.mp4', r2Key: 'x.mp4', type: 'video', clientId: clientA, fileStatus: 'processing' }).returning();
    rowId = r!.id;
    return r!;
  };
  beforeAll(async () => {
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc0000' } }).jpeg().toBuffer();
    fs.writeFileSync(path.join(dir, 'poster.jpg'), jpg);
  });
  afterAll(() => { process.env.PATH = origPath; delete process.env.VIDEO_TOOL_TIMEOUT_MS; });

  it('reads the dimensions and duration, makes a poster, and marks the video ready', async () => {
    script('ffprobe', `echo '{"streams":[{"width":1920,"height":1080}],"format":{"duration":"12.5"}}'`);
    script('ffmpeg', `for last; do :; done\ncp ${path.join(dir, 'poster.jpg')} "$last"`);
    process.env.PATH = `${dir}:${origPath}`;
    const row = await newVideoRow();
    const out = await processVideo(row, { folder: 'creatives', key: 'x.mp4' });
    expect(out.thumbnailKey).toBe(`thumbs/${row.id}.webp`);
    const [after] = await db.select().from(creatives).where(eq(creatives.id, row.id));
    expect(after).toMatchObject({ fileStatus: 'ready', width: 1920, height: 1080, thumbnailKey: `thumbs/${row.id}.webp` });
    expect(Number(after!.durationS)).toBe(12.5);
  });
  it('a video that cannot be read is failed, never left processing', async () => {
    script('ffprobe', 'echo "moov atom not found" 1>&2; exit 1');
    process.env.PATH = `${dir}:${origPath}`;
    const row = await newVideoRow();
    const out = await processVideo(row, { folder: 'creatives', key: 'x.mp4' });
    expect(out.skipped).toBe('unreadable video');
    expect((await db.select().from(creatives).where(eq(creatives.id, row.id)))[0]!.fileStatus).toBe('failed');
  });
  it('a hanging probe is killed after the timeout and the video still settles (ready, no poster)', async () => {
    script('ffprobe', 'sleep 30');
    process.env.PATH = `${dir}:${origPath}`;
    process.env.VIDEO_TOOL_TIMEOUT_MS = '800';
    const row = await newVideoRow();
    const started = Date.now();
    const out = await processVideo(row, { folder: 'creatives', key: 'x.mp4' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toMatchObject({ thumbnailKey: null, skipped: 'poster timed out' });
    expect((await db.select().from(creatives).where(eq(creatives.id, row.id)))[0]!.fileStatus).toBe('ready');
    delete process.env.VIDEO_TOOL_TIMEOUT_MS;
  });
  it('without ffmpeg installed the video is ready with no poster', async () => {
    process.env.PATH = '/nonexistent-path';
    const row = await newVideoRow();
    const out = await processVideo(row, { folder: 'creatives', key: 'x.mp4' });
    process.env.PATH = origPath;
    expect(out.skipped).toBe('no ffmpeg');
    expect((await db.select().from(creatives).where(eq(creatives.id, row.id)))[0]!.fileStatus).toBe('ready');
  });
});
