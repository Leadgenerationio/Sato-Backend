import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { method: string; path: string; query: Record<string, string>; headers: http.IncomingHttpHeaders; body: unknown }

/** A stand-in for the Stato REST API that records every request. */
export async function startFakeStato(handler: (r: Seen) => { status?: number; body: unknown } = () => ({ body: { status: 'success', data: { ok: true } } })) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const r: Seen = {
        method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers: req.headers, body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(r);
      const out = handler(r);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}
