import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openPublicUrl } from '../utils/remote-media.js';
import { MediaSourceError } from '../utils/errors.js';

// DNS rebinding: the host passes the first lookup (public) but really resolves to a private address when fetch connects.
// The pre-check is faked as public here; the real connect-time lookup of "localhost" is 127.0.0.1.
let server: http.Server; let port = 0; let hits = 0;
beforeAll(async () => {
  server = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('openPublicUrl connects only to the address it checked', () => {
  it('refuses a name that passes the first lookup but connects to a private address, and never reaches the server', async () => {
    const err = await openPublicUrl(`http://localhost:${port}/a.png`, { lookup: async () => [{ address: '93.184.216.34' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaSourceError);
    expect((err as Error).message).toContain('public address');
    expect(hits).toBe(0);
  });
});
