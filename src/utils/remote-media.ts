import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

// Fetches an ad's image/video from a URL the caller supplies (POST /creatives
// with `sourceUrl`, and the Meta/Taboola sync). Guards:
//   - http(s) only, and the host must resolve to a PUBLIC address — the
//     server must not be usable to reach internal services (SSRF);
//   - images and videos only, by the response Content-Type;
//   - 50 MB cap, enforced on Content-Length AND on the bytes actually read.
// Same 50 MB ceiling as the presign route (upload.routes.ts).

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export interface FetchedMedia {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  mediaType: 'image' | 'video';
}

export interface RemoteMediaDeps {
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = v.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function mediaTypeOf(contentType: string): 'image' | 'video' | null {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  if (ct.startsWith('image/') && ct !== 'image/svg+xml') return 'image';
  if (ct.startsWith('video/')) return 'video';
  return null;
}

export async function fetchRemoteMedia(sourceUrl: string, deps: RemoteMediaDeps = {}): Promise<FetchedMedia> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true }));

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new AppError(422, 'sourceUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(422, 'sourceUrl must be an http(s) URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new AppError(422, `Could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(422, 'sourceUrl must point to a public address');
  }

  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new AppError(422, `Could not download sourceUrl (HTTP ${res.status})`);
  const contentType = res.headers.get('content-type') ?? '';
  const mediaType = mediaTypeOf(contentType);
  if (!mediaType) throw new AppError(422, `sourceUrl must be an image or video, got "${contentType || 'unknown'}"`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new AppError(413, 'File too large: max 50 MB');

  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_MEDIA_BYTES) throw new AppError(413, 'File too large: max 50 MB');
      chunks.push(Buffer.from(chunk));
    }
  }
  const buffer = Buffer.concat(chunks);
  return {
    buffer,
    contentType: contentType.split(';')[0]!.trim(),
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    mediaType,
  };
}
