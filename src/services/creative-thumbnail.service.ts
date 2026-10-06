import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { downloadFile, getSignedDownloadUrl, isR2Configured, uploadFile } from '../integrations/r2/r2-client.js';
import { logger } from '../utils/logger.js';
import { resolveR2Location } from './creative.service.js';

// Server-made thumbnails for the creative library (plan phase 2). Images go
// through sharp; videos get a poster frame from ffmpeg when the binary is on
// PATH (add `apk add ffmpeg` to the Dockerfile to enable) — without it the
// video keeps thumbnail_key NULL and the UI shows its player instead.

export const THUMB_WIDTH = 480;

export async function makeImageThumbnail(input: Buffer): Promise<{ thumb: Buffer; width?: number; height?: number }> {
  const sharp = (await import('sharp')).default;
  const img = sharp(input, { failOn: 'none' });
  const meta = await img.metadata();
  const thumb = await img.rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return { thumb, width: meta.width, height: meta.height };
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += String(d); });
    p.on('error', () => resolve({ code: -1, stderr: 'spawn failed' }));
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export async function makeVideoPoster(input: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stato-thumb-'));
  try {
    await writeFile(join(dir, 'in'), input);
    const r = await run('ffmpeg', ['-y', '-ss', '1', '-i', join(dir, 'in'), '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, join(dir, 'out.jpg')]);
    if (r.code !== 0) return null;
    const jpg = await readFile(join(dir, 'out.jpg'));
    return (await makeImageThumbnail(jpg)).thumb;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── Videos: probe and poster from a signed URL, never loading the file ───
// ffprobe and ffmpeg read the object over HTTP (range requests), so a 4 GB video
// uses no more memory than a small one. A video whose index is at the end of the
// file can make that slow, so every call has a hard timeout and falls back to "no
// poster" rather than hanging the worker.

/** Read at call time so it can be changed without a restart (and shortened in tests). */
export const videoToolTimeoutMs = (): number => Number(process.env.VIDEO_TOOL_TIMEOUT_MS ?? 120_000);

interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean; missing: boolean }

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // detached = its own process group, so a timeout kills the tool and anything it started.
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: RunResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      // Return at once; do not wait for the pipes to close (a hung child can hold them open).
      try { if (p.pid) process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
      finish({ code: -1, stdout, stderr, timedOut: true, missing: false });
    }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += String(d); });
    p.stderr.on('data', (d) => { stderr += String(d).slice(-2000); });
    p.on('error', () => finish({ code: -1, stdout, stderr: 'spawn failed', timedOut: false, missing: true }));
    p.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false, missing: false }));
  });
}

export interface VideoProbe { ok: boolean; missingBinary: boolean; timedOut: boolean; width?: number; height?: number; durationS?: number }

export async function probeVideo(url: string): Promise<VideoProbe> {
  const r = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', url], videoToolTimeoutMs());
  if (r.missing) return { ok: false, missingBinary: true, timedOut: false };
  if (r.timedOut) return { ok: false, missingBinary: false, timedOut: true };
  if (r.code !== 0) return { ok: false, missingBinary: false, timedOut: false };
  try {
    const j = JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const st = j.streams?.[0];
    if (!st?.width || !st.height) return { ok: false, missingBinary: false, timedOut: false };
    const d = Number(j.format?.duration);
    return { ok: true, missingBinary: false, timedOut: false, width: st.width, height: st.height, durationS: Number.isFinite(d) ? Math.round(d * 100) / 100 : undefined };
  } catch {
    return { ok: false, missingBinary: false, timedOut: false };
  }
}

export async function posterFromUrl(url: string, durationS?: number): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stato-poster-'));
  try {
    const seek = durationS && durationS < 2 ? 0 : 1;
    const r = await runCapture('ffmpeg', ['-y', '-ss', String(seek), '-i', url, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, join(dir, 'out.jpg')], videoToolTimeoutMs());
    if (r.code !== 0) return null;
    return (await makeImageThumbnail(await readFile(join(dir, 'out.jpg')))).thumb;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Width, height, duration and a poster for a stored video, then fileStatus ready (or failed when the file cannot be read). */
export async function processVideo(row: typeof creatives.$inferSelect, loc: { folder: 'creatives' | 'misc' | string; key: string }): Promise<{ thumbnailKey: string | null; skipped?: string }> {
  const url = await getSignedDownloadUrl({ folder: loc.folder as 'creatives', key: loc.key, expiresInSeconds: 3600 });
  const probe = await probeVideo(url);
  const settle = (fileStatus: 'ready' | 'failed') => (row.fileStatus === 'processing' ? { fileStatus } : {});
  if (probe.missingBinary) {
    logger.info({ creativeId: row.id }, 'No ffmpeg: the video keeps no thumbnail');
    await db.update(creatives).set({ ...settle('ready') }).where(eq(creatives.id, row.id));
    return { thumbnailKey: null, skipped: 'no ffmpeg' };
  }
  if (!probe.ok && !probe.timedOut) {
    logger.warn({ creativeId: row.id }, 'Video could not be read by ffprobe');
    await db.update(creatives).set({ ...settle('failed') }).where(eq(creatives.id, row.id));
    return { thumbnailKey: null, skipped: 'unreadable video' };
  }
  const poster = probe.timedOut ? null : await posterFromUrl(url, probe.durationS);
  let thumbnailKey: string | null = null;
  if (poster) {
    thumbnailKey = `thumbs/${row.id}.webp`;
    await uploadFile({ folder: 'creatives', key: thumbnailKey, body: poster, contentType: 'image/webp', cacheControl: 'private, max-age=86400' });
  }
  await db.update(creatives).set({
    ...(thumbnailKey ? { thumbnailKey } : {}),
    ...(probe.width && !row.width ? { width: probe.width } : {}),
    ...(probe.height && !row.height ? { height: probe.height } : {}),
    ...(probe.durationS != null && row.durationS == null ? { durationS: String(probe.durationS) } : {}),
    ...settle('ready'),
  }).where(eq(creatives.id, row.id));
  return { thumbnailKey, ...(poster ? {} : { skipped: probe.timedOut ? 'poster timed out' : 'no poster' }) };
}

/** BullMQ 'media' → 'thumbnail'. Safe to retry; a missing row is a no-op. */
export async function generateThumbnail(creativeId: string): Promise<{ thumbnailKey: string | null; skipped?: string }> {
  const [row] = await db.select().from(creatives).where(eq(creatives.id, creativeId));
  if (!row) return { thumbnailKey: null, skipped: 'not found' };
  if (!isR2Configured()) return { thumbnailKey: null, skipped: 'storage not configured' };
  const loc = resolveR2Location(row.fileUrl, row.r2Key);
  if (!loc) return { thumbnailKey: null, skipped: 'no stored file' };

  const isVideo = (row.contentType ?? '').startsWith('video/') || row.type === 'video';
  // Videos are read from a signed URL, never downloaded into memory.
  if (isVideo) return processVideo(row, loc);
  const buf = await downloadFile(loc.folder, loc.key);
  let thumb: Buffer | null = null;
  let width: number | undefined;
  let height: number | undefined;
  ({ thumb, width, height } = await makeImageThumbnail(buf));
  const key = `thumbs/${creativeId}.webp`;
  await uploadFile({ folder: 'creatives', key, body: thumb, contentType: 'image/webp', cacheControl: 'private, max-age=86400' });
  await db.update(creatives).set({
    thumbnailKey: key,
    ...(width && !row.width ? { width } : {}),
    ...(height && !row.height ? { height } : {}),
  }).where(eq(creatives.id, creativeId));
  return { thumbnailKey: key };
}
