import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { downloadFile, isR2Configured, uploadFile } from '../integrations/r2/r2-client.js';
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

/** BullMQ 'media' → 'thumbnail'. Safe to retry; a missing row is a no-op. */
export async function generateThumbnail(creativeId: string): Promise<{ thumbnailKey: string | null; skipped?: string }> {
  const [row] = await db.select().from(creatives).where(eq(creatives.id, creativeId));
  if (!row) return { thumbnailKey: null, skipped: 'not found' };
  if (!isR2Configured()) return { thumbnailKey: null, skipped: 'storage not configured' };
  const loc = resolveR2Location(row.fileUrl, row.r2Key);
  if (!loc) return { thumbnailKey: null, skipped: 'no stored file' };

  const buf = await downloadFile(loc.folder, loc.key);
  const isVideo = (row.contentType ?? '').startsWith('video/') || row.type === 'video';
  let thumb: Buffer | null = null;
  let width: number | undefined;
  let height: number | undefined;
  if (isVideo) {
    thumb = await makeVideoPoster(buf);
    if (!thumb) {
      logger.info({ creativeId }, 'No video poster (ffmpeg unavailable or failed) — leaving thumbnail empty');
      return { thumbnailKey: null, skipped: 'no ffmpeg' };
    }
  } else {
    ({ thumb, width, height } = await makeImageThumbnail(buf));
  }
  const key = `thumbs/${creativeId}.webp`;
  await uploadFile({ folder: 'creatives', key, body: thumb, contentType: 'image/webp', cacheControl: 'private, max-age=86400' });
  await db.update(creatives).set({
    thumbnailKey: key,
    ...(width && !row.width ? { width } : {}),
    ...(height && !row.height ? { height } : {}),
  }).where(eq(creatives.id, creativeId));
  return { thumbnailKey: key };
}
