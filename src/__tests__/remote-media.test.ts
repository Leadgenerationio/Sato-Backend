import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fetchRemoteMedia, MAX_MEDIA_BYTES } from '../utils/remote-media.js';

const publicLookup = async () => [{ address: '93.184.216.34' }];
function fakeFetch(body: Buffer, headers: Record<string, string>, status = 200): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status, headers })) as unknown as typeof fetch;
}

describe('fetchRemoteMedia', () => {
  it('downloads an image and fingerprints it', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const m = await fetchRemoteMedia('https://cdn.example.com/a.png', { lookup: publicLookup, fetchImpl: fakeFetch(png, { 'content-type': 'image/png' }) });
    expect(m.mediaType).toBe('image');
    expect(m.sizeBytes).toBe(png.length);
    expect(m.sha256).toBe(createHash('sha256').update(png).digest('hex'));
  });

  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '::1', '100.64.0.1'])(
    'refuses a host that resolves to a private address (%s)', async (address) => {
      await expect(fetchRemoteMedia('https://internal.example.com/x.png', { lookup: async () => [{ address }], fetchImpl: fakeFetch(Buffer.alloc(1), { 'content-type': 'image/png' }) }))
        .rejects.toMatchObject({ statusCode: 422, message: 'sourceUrl must point to a public address' });
    });

  it('refuses a literal private IP without a DNS lookup', async () => {
    await expect(fetchRemoteMedia('http://127.0.0.1:3001/api', { fetchImpl: fakeFetch(Buffer.alloc(1), { 'content-type': 'image/png' }) }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses non-media content (e.g. an .exe or HTML page)', async () => {
    await expect(fetchRemoteMedia('https://cdn.example.com/a.exe', { lookup: publicLookup, fetchImpl: fakeFetch(Buffer.from('MZ'), { 'content-type': 'application/x-msdownload' }) }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(fetchRemoteMedia('https://cdn.example.com/a.svg', { lookup: publicLookup, fetchImpl: fakeFetch(Buffer.from('<svg/>'), { 'content-type': 'image/svg+xml' }) }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses files over 50 MB by header and by bytes read', async () => {
    await expect(fetchRemoteMedia('https://cdn.example.com/big.mp4', { lookup: publicLookup, fetchImpl: fakeFetch(Buffer.alloc(10), { 'content-type': 'video/mp4', 'content-length': String(MAX_MEDIA_BYTES + 1) }) }))
      .rejects.toMatchObject({ statusCode: 413, message: 'File too large: max 50 MB' });
    await expect(fetchRemoteMedia('https://cdn.example.com/big.mp4', { lookup: publicLookup, fetchImpl: fakeFetch(Buffer.alloc(MAX_MEDIA_BYTES + 1), { 'content-type': 'video/mp4' }) }))
      .rejects.toMatchObject({ statusCode: 413 });
  });

  it('refuses non-http schemes', async () => {
    await expect(fetchRemoteMedia('file:///etc/passwd')).rejects.toMatchObject({ statusCode: 422 });
  });
  it('sends a User-Agent (hosts like Wikimedia refuse requests without one)', async () => {
    let seen: Headers | undefined;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const spyFetch = (async (_u: string, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }); }) as unknown as typeof fetch;
    await fetchRemoteMedia('https://cdn.example.com/a.png', { lookup: publicLookup, fetchImpl: spyFetch });
    expect(seen?.get('user-agent')).toMatch(/Stato/);
  });
});

describe('fetchRemoteMedia image limit (spec: images up to 30 MB)', () => {
  const pngOf = (n: number) => { const b = Buffer.alloc(n, 7); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); return b; };
  const mp4Of = (n: number) => { const b = Buffer.alloc(n, 0); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); return b; };
  const MiB = 1024 * 1024;
  it('refuses a 31 MB image', async () => {
    await expect(fetchRemoteMedia('https://cdn.example.com/a.png', { lookup: publicLookup, fetchImpl: fakeFetch(pngOf(31 * MiB), { 'content-type': 'image/png' }) }))
      .rejects.toMatchObject({ statusCode: 413 });
  });
  it('refuses a big image that is served without a size or as a video type (the real type is read from the bytes)', async () => {
    await expect(fetchRemoteMedia('https://cdn.example.com/a.mp4', { lookup: publicLookup, fetchImpl: fakeFetch(pngOf(40 * MiB), { 'content-type': 'video/mp4' }) }))
      .rejects.toMatchObject({ statusCode: 413, message: expect.stringContaining('30 MB') });
  });
  it('still takes a 29 MB image and a 40 MB video', async () => {
    expect((await fetchRemoteMedia('https://cdn.example.com/a.png', { lookup: publicLookup, fetchImpl: fakeFetch(pngOf(29 * MiB), { 'content-type': 'image/png' }) })).mediaType).toBe('image');
    expect((await fetchRemoteMedia('https://cdn.example.com/a.mp4', { lookup: publicLookup, fetchImpl: fakeFetch(mp4Of(40 * MiB), { 'content-type': 'video/mp4' }) })).mediaType).toBe('video');
  });
});
