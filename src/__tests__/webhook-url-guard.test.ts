import { describe, it, expect } from 'vitest';
import { assertWebhookUrl, guardedLookup, isBlockedAddress } from '../services/webhook-url-guard.js';
import { postSigned } from '../services/webhook.service.js';

// Plan phase 4 SSRF guard: webhooks are POSTed from inside our network, so a
// URL must never reach loopback, private, link-local (cloud metadata) etc.

const PROD = { production: true };
const DEV = { production: false };

describe('isBlockedAddress', () => {
  it.each([
    '10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.0.1', '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s everywhere', (ip) => {
    expect(isBlockedAddress(ip, PROD)).toBe(true);
    expect(isBlockedAddress(ip, DEV)).toBe(true);
  });

  it.each(['127.0.0.1', '127.10.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1'])('blocks loopback %s in production only', (ip) => {
    expect(isBlockedAddress(ip, PROD)).toBe(true);
    expect(isBlockedAddress(ip, DEV)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip, PROD)).toBe(false);
  });
});

describe('assertWebhookUrl', () => {
  it('requires https in production', async () => {
    await expect(assertWebhookUrl('http://93.184.216.34/hook', PROD)).rejects.toThrow(/https/);
    await expect(assertWebhookUrl('https://93.184.216.34/hook', PROD)).resolves.toBeInstanceOf(URL);
  });

  it('refuses credentials in the URL and non-URLs', async () => {
    await expect(assertWebhookUrl('https://user:pw@93.184.216.34/', PROD)).rejects.toThrow(/username or password/);
    await expect(assertWebhookUrl('example.com/hook', PROD)).rejects.toThrow(/full web address/);
  });

  it('refuses internal targets, including via DNS and IPv6-mapped forms', async () => {
    for (const u of ['https://169.254.169.254/latest/meta-data', 'https://10.1.2.3/x', 'https://[::ffff:127.0.0.1]/x', 'https://localhost/x']) {
      await expect(assertWebhookUrl(u, PROD)).rejects.toThrow(/private or internal/);
    }
  });

  it('allows http://localhost outside production (local receivers)', async () => {
    await expect(assertWebhookUrl('http://localhost:9999/hook', DEV)).resolves.toBeInstanceOf(URL);
  });
});

describe('connect-time guard', () => {
  it('guardedLookup refuses a hostname that resolves to loopback in production', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup(PROD)('localhost', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EWEBHOOKBLOCKED');
  });

  it('postSigned never connects to a blocked IP literal (Node skips lookup for literals)', async () => {
    const r = await postSigned('https://169.254.169.254/latest/meta-data', '{}', {}, PROD);
    expect(r.status).toBeUndefined();
    expect(r.error).toMatch(/Blocked webhook destination 169\.254\.169\.254/);
  });

  it('postSigned refuses plain http in production', async () => {
    const r = await postSigned('http://93.184.216.34/', '{}', {}, PROD);
    expect(r.error).toMatch(/https/);
  });
});

// One slow endpoint must not hold a delivery slot: the deadline is TOTAL, and bytes that keep trickling in do not extend it.
describe('postSigned deadline', () => {
  const DEVP = { production: false };
  it('gives up on an endpoint that trickles its answer headers, within the deadline', async () => {
    const { createServer } = await import('node:net');
    const server = createServer((sock) => {
      sock.on('data', () => undefined);
      sock.write('HTTP/1.1 200 OK\r\n'); // a status line, then headers that never end
      const t = setInterval(() => sock.write('X-Pad: a\r\n'), 50); // never finishes the headers; each byte resets an idle timer
      sock.on('close', () => clearInterval(t));
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const t0 = Date.now();
    const r = await postSigned(`http://127.0.0.1:${port}/hook`, '{}', {}, DEVP, 500);
    const took = Date.now() - t0;
    server.close();
    expect(r.error).toMatch(/No response within/);
    expect(took).toBeLessThan(2000);
  });
  it('a 2xx status line is the answer: a slow body is not waited for', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const t0 = Date.now();
    const r = await postSigned(`http://127.0.0.1:${port}/hook`, '{}', {}, DEVP, 5000);
    const took = Date.now() - t0;
    server.close();
    expect(r).toEqual({ status: 200 });
    expect(took).toBeLessThan(1500);
  });
});
