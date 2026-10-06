import { describe, it, expect } from 'vitest';
import { sniffMedia, ALLOWED_MIME } from '../utils/sniff-media.js';

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const ftyp = (brand: string, compat: string[] = []) => {
  const size = 16 + compat.length * 4;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0); b.write('ftyp', 4, 'ascii'); b.write(brand, 8, 'ascii'); b.writeUInt32BE(0, 12);
  compat.forEach((c, i) => b.write(c, 16 + i * 4, 'ascii'));
  return Uint8Array.from(b);
};

describe('sniffMedia', () => {
  it('recognises jpg, png, gif and webp from the first bytes', () => {
    expect(sniffMedia(bytes('ffd8ffe000104a464946'))).toEqual({ mime: 'image/jpeg', mediaType: 'image' });
    expect(sniffMedia(bytes('89504e470d0a1a0a0000000d49484452'))).toEqual({ mime: 'image/png', mediaType: 'image' });
    expect(sniffMedia(Uint8Array.from(Buffer.from('GIF89a......')))).toEqual({ mime: 'image/gif', mediaType: 'image' });
    expect(sniffMedia(Uint8Array.from(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])))).toEqual({ mime: 'image/webp', mediaType: 'image' });
  });
  it('recognises mp4 and mov by the ftyp brand, including a compatible-brand list', () => {
    expect(sniffMedia(ftyp('isom'))).toEqual({ mime: 'video/mp4', mediaType: 'video' });
    expect(sniffMedia(ftyp('mp42'))).toEqual({ mime: 'video/mp4', mediaType: 'video' });
    expect(sniffMedia(ftyp('qt  '))).toEqual({ mime: 'video/quicktime', mediaType: 'video' });
    expect(sniffMedia(ftyp('XXXX', ['mp41']))).toEqual({ mime: 'video/mp4', mediaType: 'video' });
  });
  it('refuses an executable, a script, an html page and audio-only mp4, whatever they are called', () => {
    expect(sniffMedia(Uint8Array.from(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary')))).toBeNull(); // .exe renamed .mp4
    expect(sniffMedia(Uint8Array.from(Buffer.from('#!/bin/sh\necho hi')))).toBeNull();
    expect(sniffMedia(Uint8Array.from(Buffer.from('<html><body>hi</body></html>')))).toBeNull();
    expect(sniffMedia(ftyp('M4A '))).toBeNull();
    expect(sniffMedia(new Uint8Array(0))).toBeNull();
    expect(sniffMedia(Uint8Array.from([0xff, 0xd8]))).toBeNull(); // too short to be a jpeg
  });
  it('lists exactly the six allowed types', () => {
    expect([...ALLOWED_MIME].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);
  });
});
