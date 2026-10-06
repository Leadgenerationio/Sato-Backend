import { createHash } from 'node:crypto';
import { SNIFF_BYTES, sniffMedia } from './sniff-media.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import { AppError, MediaSourceError } from './errors.js';

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

export const MAX_REDIRECTS = 3;

/** A content type that says nothing about the file; the first bytes decide. */
export const isGenericBinary = (contentType: string) => /^(application|binary)\/octet-stream/i.test(contentType.trim());

/**
 * The address check above resolves the name once; a plain fetch resolves it again to connect, so a name that answers
 * public first and private second (DNS rebinding) would get through. This agent checks the address it is about to
 * connect to, at connect time, and refuses a private one.
 */
const guardedAgent = new Agent({
  connect: {
    lookup: (hostname: string, options: any, cb: (err: Error | null, address?: any, family?: number) => void) => {
      dnsLookupCb(hostname, options, (err, address, family) => {
        if (err) return cb(err, address, family);
        const list = Array.isArray(address) ? address : [{ address, family }];
        if (list.some((a: { address: string }) => isPrivateAddress(a.address))) return cb(new Error('PRIVATE_ADDRESS'));
        return cb(null, address, family);
      });
    },
  },
});
const nativeFetch = globalThis.fetch;
/** undici's own fetch with the guarded agent. If the global fetch was replaced (tests), that replacement is used. */
const guardedFetch = ((input: any, init?: any) => (globalThis.fetch !== nativeFetch
  ? globalThis.fetch(input, init)
  : undiciFetch(input, { ...init, dispatcher: guardedAgent }))) as unknown as typeof fetch;
const USER_AGENT = 'StatoCreativeFetcher/1.0 (+https://leadgenerationio.stato.tech)';

/**
 * Open a public URL, following up to 3 redirects and checking EVERY hop: http(s) only, and the host must resolve to a
 * public address (so a redirect to localhost or a cloud metadata address is refused, not followed).
 */
export async function openPublicUrl(sourceUrl: string, deps: RemoteMediaDeps = {}, opts: { timeoutMs?: number } = {}): Promise<{ res: Response; finalUrl: URL }> {
  const fetchImpl = deps.fetchImpl ?? guardedFetch;
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new MediaSourceError(422, 'sourceUrl is not a valid URL', 'source_unreachable');
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new MediaSourceError(422, 'sourceUrl must be an http(s) URL', 'source_unreachable');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host).catch(() => []);
    if (addresses.length === 0) throw new MediaSourceError(422, `Could not resolve ${host}`, 'source_unreachable');
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      throw new MediaSourceError(422, 'sourceUrl must point to a public address', 'source_unreachable');
    }
    // Some image hosts (Wikimedia, several CDNs) answer 400/403 to requests without a User-Agent: send an honest one.
    const res = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,video/*' } }).catch((err: unknown) => {
      if (String((err as { cause?: { message?: string } })?.cause?.message ?? '').includes('PRIVATE_ADDRESS')) {
        throw new MediaSourceError(422, 'sourceUrl must point to a public address', 'source_unreachable');
      }
      throw new MediaSourceError(422, `Could not download sourceUrl (${err instanceof Error ? err.message : 'network error'})`, 'source_unreachable');
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new MediaSourceError(422, `sourceUrl redirects more than ${MAX_REDIRECTS} times`, 'source_unreachable');
      await res.body?.cancel().catch(() => {});
      try { url = new URL(res.headers.get('location')!, url); } catch { throw new MediaSourceError(422, 'sourceUrl redirects to an invalid address', 'source_unreachable'); }
      continue;
    }
    return { res, finalUrl: url };
  }
}

export async function fetchRemoteMedia(sourceUrl: string, deps: RemoteMediaDeps = {}): Promise<FetchedMedia> {
  const { res } = await openPublicUrl(sourceUrl, deps);
  if (!res.ok) throw new MediaSourceError(422, `Could not download sourceUrl (HTTP ${res.status})`, 'source_unreachable');
  const contentType = res.headers.get('content-type') ?? '';
  const mediaType = mediaTypeOf(contentType);
  // Many S3 and CDN links serve media as octet-stream: the first-bytes check below decides the real type.
  if (!mediaType && !isGenericBinary(contentType)) throw new MediaSourceError(422, `sourceUrl must be an image or video, got "${contentType || 'unknown'}"`, 'unsupported_type');
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
  // The real type comes from the first bytes, not the Content-Type header or the name
  // (MCP spec v1.0: an .exe served as video/mp4 must be refused).
  const sniffed = sniffMedia(buffer.subarray(0, SNIFF_BYTES));
  if (!sniffed) throw new MediaSourceError(422, 'sourceUrl must be an image or video: the file content is not a jpg, png, webp, gif, mp4 or mov', 'unsupported_type');
  return {
    buffer,
    contentType: sniffed.mime,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    mediaType: sniffed.mediaType,
  };
}
