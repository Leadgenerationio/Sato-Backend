import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createStatoMcpServer } from './server.js';
import { StatoApi } from './stato-client.js';

// Hosted MCP over Streamable HTTP, deployed next to the backend. Stateless:
// every POST /mcp builds a fresh server bound to the caller's API key, so one
// deployment serves many keys and nothing is shared between callers.
//
// The key comes from `Authorization: Bearer <stato api key>` (or `X-API-Key`)
// and is passed through to the Stato API as X-API-Key. STATO_API_KEY is only
// a fallback for a single-tenant deployment; leave it unset when hosting.

const MAX_BODY = 1024 * 1024;

export interface HttpServerOptions {
  apiUrl: string;
  fallbackApiKey?: string;
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
}

function keyFrom(req: http.IncomingMessage, fallback?: string): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || undefined;
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return fallback || undefined;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export function createHttpServer(opts: HttpServerOptions): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (path !== '/mcp') return jsonRpcError(res, 404, 'Not found. The MCP endpoint is /mcp.');
    if (opts.allowedHosts?.length && !opts.allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
      return jsonRpcError(res, 403, 'Host not allowed');
    }
    if (req.method !== 'POST') {
      // Stateless server: no server-initiated streams or sessions to resume/close.
      return jsonRpcError(res, 405, 'Method not allowed', { Allow: 'POST' });
    }
    const apiKey = keyFrom(req, opts.fallbackApiKey);
    if (!apiKey) {
      return jsonRpcError(res, 401, 'Send your Stato API key as "Authorization: Bearer <key>".', { 'WWW-Authenticate': 'Bearer' });
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      return jsonRpcError(res, (err as { status?: number }).status ?? 400, (err as Error).message);
    }
    const server = createStatoMcpServer(new StatoApi({ baseUrl: opts.apiUrl, apiKey, fetchImpl: opts.fetchImpl }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) jsonRpcError(res, 500, `MCP server error: ${(err as Error).message}`);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const apiUrl = process.env.STATO_API_URL?.trim();
  if (!apiUrl) throw new Error('STATO_API_URL is not set');
  const port = Number(process.env.PORT ?? 3010);
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  createHttpServer({ apiUrl, fallbackApiKey: process.env.STATO_API_KEY, allowedHosts }).listen(port, () => {
    console.log(`Stato MCP listening on :${port}/mcp → ${apiUrl}`);
  });
}
