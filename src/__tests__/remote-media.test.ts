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
});
