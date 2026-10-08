import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import request from 'supertest';
import app from '../index.js';
import fs from 'node:fs';
import path from 'node:path';
import { getTools } from '../mcp/tools/registry.js';
import { renderToolsMarkdown } from '../docs/mcp-docs.js';
import { buildOpenApi } from '../docs/openapi.js';
import { API_ERROR_CODES } from '../utils/api-error.js';
import { API_SCOPES } from '../services/api-key.service.js';

// The MCP docs are part of the deliverable (spec section 5): they must not drift from the code.
const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('MCP docs stay in step with the code', () => {
  it('docs/mcp-tools.md is exactly what the live tool definitions generate (run: npx tsx scripts/generate-mcp-docs.ts)', async () => {
    expect(read('docs/mcp-tools.md')).toBe(renderToolsMarkdown(await getTools()));
  });
  it('the setup guide names every error code and every scope the API has', () => {
    const guide = read('docs/mcp-setup.md');
    for (const c of API_ERROR_CODES) expect(guide, `error code ${c}`).toContain(`\`${c}\``);
    for (const s of API_SCOPES) expect(guide, `scope ${s}`).toContain(`\`${s}\``);
  });
  it('the setup guide has the endpoint, both auth headers, a Cursor config and a Claude Code command', () => {
    const guide = read('docs/mcp-setup.md');
    for (const needle of ['/mcp', 'Authorization: Bearer stk_', 'X-API-Key', '"mcpServers"', 'claude mcp add --transport http', 'whoami', 'complete_upload']) expect(guide).toContain(needle);
  });
  it('the OpenAPI document describes POST /mcp and the Bearer key', () => {
    const doc = buildOpenApi('https://example.test') as any;
    expect(doc.paths['/mcp'].post.summary).toContain('MCP');
    expect(doc.components.securitySchemes.BearerKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.info.description).toContain('docs/mcp-setup.md');
  });
});

describe('GET /api/v1/mcp-docs (the portal MCP page)', () => {
  it('serves the setup guide and one row per live tool, without a login', async () => {
    const res = await request(app).get('/api/v1/mcp-docs');
    expect(res.status).toBe(200);
    const { setup, intro, tools } = res.body.data;
    expect(setup).toBe(read('docs/mcp-setup.md'));
    const live = await getTools();
    expect(tools).toHaveLength(live.length);
    expect(intro).toContain(`${live.length} tools.`);
    expect(tools.find((t: any) => t.name === 'upload_asset')).toMatchObject({ scope: 'creatives:write', kind: 'write', idempotencyKey: true });
    expect(tools.find((t: any) => t.name === 'whoami')).toMatchObject({ scope: null, kind: 'read only', required: [], optional: [] });
    expect(tools.find((t: any) => t.name === 'find_client_by_ad_account').required).toEqual(['platform', 'accountId']);
  });
});

// The guide's two copy-paste examples must actually work: parse them out of the guide, put in a real key, and
// connect to /mcp with exactly the URL path and headers each one tells the client to send.
describe('the setup guide examples connect', () => {
  const guide = read('docs/mcp-setup.md');
  const KEY_PLACEHOLDER = 'stk_your_key_here';
  const keyIds: string[] = [];
  afterAll(async () => {
    if (!keyIds.length) return;
    // the audit row is written just AFTER the response: wait for each one, or the key delete hits the foreign key
    for (let i = 0; i < 40; i++) {
      const seen = await db.select({ k: apiAuditLog.apiKeyId }).from(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
      if (new Set(seen.map((r) => r.k)).size >= keyIds.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  });

  async function realKey() {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`).send({ name: `Hari Test guide examples ${Date.now() % 1e9}`, scopes: ['clients:read'] });
    expect(res.status).toBe(201);
    keyIds.push(res.body.data.apiKey.id);
    return res.body.data.key as string;
  }
  const section = (title: string) => guide.split(`### ${title}`)[1]!.split('\n### ')[0]!;
  const connect = async (urlPath: string, headers: Record<string, string>) => {
    const r = request(app).post(urlPath).set('Accept', 'application/json, text/event-stream');
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  };

  it('the Cursor JSON parses and its url + headers reach /mcp as the key', async () => {
    const json = /```json\n([\s\S]*?)```/.exec(section('Cursor'))![1]!;
    const server = JSON.parse(json).mcpServers.stato as { url: string; headers: Record<string, string> };
    expect(new URL(server.url.replace('<your Stato API host>', 'stato.example')).pathname).toBe('/mcp');
    const key = await realKey();
    const headers = Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, v.replace(KEY_PLACEHOLDER, key)]));
    const res = await connect('/mcp', headers);
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.structuredContent.keyName).toBeTruthy();
    expect(res.body.result.structuredContent.agent).toBe('Cursor'); // X-Stato-Agent really reached the server
  });

  it('the Claude Code command carries the same url and headers, and they reach /mcp as the key', async () => {
    const cmd = /```bash\n(claude mcp add[\s\S]*?)```/.exec(section('Claude Code'))![1]!.replace(/\\\n/g, ' ');
    expect(cmd).toContain('--transport http');
    const url = /(https:\/\/<your Stato API host>\/mcp)/.exec(cmd)![1]!;
    expect(new URL(url.replace('<your Stato API host>', 'stato.example')).pathname).toBe('/mcp');
    const headers = Object.fromEntries([...cmd.matchAll(/--header "([^:"]+): ([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(headers)).toEqual(['Authorization', 'X-Stato-Agent']);
    const key = await realKey();
    const res = await connect('/mcp', Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(KEY_PLACEHOLDER, key)])));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.structuredContent.agent).toBe('Claude Code');
  });
});
