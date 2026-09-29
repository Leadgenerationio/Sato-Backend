import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { startFakeStato } from './fake-stato.js';

// Hosted mode: the caller's key (Authorization: Bearer) is passed through to
// Stato as X-API-Key, per request, with no shared state between callers.

let fake: Awaited<ReturnType<typeof startFakeStato>>;
let mcp: http.Server;
let mcpUrl: string;

beforeAll(async () => {
  fake = await startFakeStato(() => ({ body: { status: 'success', data: { items: [] } } }));
  mcp = createHttpServer({ apiUrl: fake.url });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => { await new Promise((r) => mcp.close(r)); await fake.close(); });

async function connectWith(key: string) {
  const c = new Client({ name: 'http-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return c;
}

describe('Streamable HTTP server', () => {
  it('passes each caller\'s own key through to Stato', async () => {
    const a = await connectWith('sk_key_A');
    const b = await connectWith('sk_key_B');
    expect((await a.listTools()).tools).toHaveLength(5);
    await a.callTool({ name: 'list_creatives', arguments: { q: 'a' } });
    await b.callTool({ name: 'list_creatives', arguments: { q: 'b' } });
    const keys = fake.seen.filter((s) => s.path === '/api/v1/creatives').map((s) => [s.query.q, s.headers['x-api-key']]);
    expect(keys).toEqual([['a', 'sk_key_A'], ['b', 'sk_key_B']]);
    await a.close(); await b.close();
  });

  it('refuses a request with no key (401) and never calls Stato', async () => {
    const before = fake.seen.length;
    const res = await fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(fake.seen.length).toBe(before);
  });

  it('answers /health and 404s other paths', async () => {
    const base = mcpUrl.replace(/\/mcp$/, '');
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(mcpUrl, { method: 'GET', headers: { Authorization: 'Bearer k' } })).status).toBe(405);
  });
});
