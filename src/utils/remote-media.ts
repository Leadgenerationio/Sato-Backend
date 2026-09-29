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

// Expand an IPv6 literal into 8 16-bit groups (null when it is not valid IPv6).
function ipv6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0]!;
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const quad = v.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const o = [quad[2], quad[3], quad[4], quad[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    v = `${quad[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateIPv4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Anything that is not clearly a public unicast address counts as private.
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isPrivateIPv4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  const g = ipv6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => isPrivateIPv4(hi >> 8, hi & 255, lo >> 8);
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7]! <= 1 ? true : embedded(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  return false;
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

  // Some image hosts (Wikimedia, several CDNs) answer 400/403 to requests
  // without a User-Agent — send an honest one.
  const res = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'StatoCreativeFetcher/1.0 (+https://leadgenerationio.stato.tech)', Accept: 'image/*,video/*' },
  });
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
