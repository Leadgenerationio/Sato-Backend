// The real file type, read from the first bytes, never from the name or the
// Content-Type header (MCP spec v1.0 section 3, Files). Images: jpg, png, webp,
// gif. Videos: mp4 and mov. Anything else is refused.

export interface SniffedMedia {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/quicktime';
  mediaType: 'image' | 'video';
}

/** How many leading bytes are enough to recognise every supported type. */
export const SNIFF_BYTES = 4096;

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));

// Brands of an ISO base media file that are video (mp4 family). Audio-only
// brands (M4A, M4B) are refused.
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42', 'mmp4', 'M4V ', 'M4VH', 'M4VP', 'dash', 'f4v ', 'hvc1', 'hev1', 'av01']);

export function sniffMedia(head: Uint8Array): SniffedMedia | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', mediaType: 'image' };
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 3) === 'PNG' && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return { mime: 'image/png', mediaType: 'image' };
  if (head.length >= 6 && (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a')) return { mime: 'image/gif', mediaType: 'image' };
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { mime: 'image/webp', mediaType: 'image' };
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'qt  ') return { mime: 'video/quicktime', mediaType: 'video' };
    if (MP4_BRANDS.has(brand)) return { mime: 'video/mp4', mediaType: 'video' };
    // Compatible brands list: a file may declare mp4 there and use another major brand.
    const boxSize = Math.min(head.length, (head[0]! << 24 | head[1]! << 16 | head[2]! << 8 | head[3]!) >>> 0);
    for (let i = 16; i + 4 <= boxSize; i += 4) {
      const b = ascii(head, i, 4);
      if (b === 'qt  ') return { mime: 'video/quicktime', mediaType: 'video' };
      if (MP4_BRANDS.has(b)) return { mime: 'video/mp4', mediaType: 'video' };
    }
  }
  return null;
}

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'] as const;
export const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
