import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import app from '../index.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { createStatoMcpServer, type AuditEntry } from '../mcp/server.js';
import { loadTools } from '../mcp/tools/registry.js';
import { defineTool, type ToolContext } from '../mcp/types.js';
import { ApiError } from '../utils/api-error.js';

// Contract test for the in-app MCP mount (spec v1.0 section 3). It guards the
// risk the verdict named: an untested mount. It talks to the real /mcp route.
const tag = `${Date.now() % 1e9}`;
let owner = '';
let readKey = '';
const keyIds: string[] = [];
const ACCEPT = 'application/json, text/event-stream';

async function makeKey(scopes: string[]): Promise<{ key: string; id: string }> {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test mcp ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key, id: res.body.data.apiKey.id };
}
const rpc = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).set(headers).send(body);

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  readKey = (await makeKey(['clients:read'])).key;
});
afterAll(async () => {
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('POST /mcp', () => {
  it('initialises, lists tools with descriptions and annotations, and calls whoami', async () => {
    const init = await rpc(readKey, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('stato');
    expect(init.body.result.instructions).toContain('IDs');

    const list = await rpc(readKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const who = list.body.result.tools.find((t: { name: string }) => t.name === 'whoami');
    expect(who.description.length).toBeGreaterThan(40);
    expect(who.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(who.outputSchema).toBeDefined();

    const call = await rpc(readKey, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { 'X-Stato-Agent': 'Grok Bot' });
    expect(call.status).toBe(200);
    expect(call.body.result.isError).toBeUndefined();
    expect(call.body.result.structuredContent).toMatchObject({ authType: 'api_key', agent: 'Grok Bot', rateLimit: { limit: 120, windowSeconds: 60 } });
    expect(call.body.result.structuredContent.key.scopes).toEqual(['clients:read']);
    expect(call.body.result.content[0].text).toContain('Yash Test mcp');
  });
  it('accepts the key as Authorization: Bearer stk_ and as X-API-Key', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await rpc(readKey, body)).status).toBe(200);
    const viaHeader = await request(app).post('/mcp').set('X-API-Key', readKey).set('Accept', ACCEPT).send(body);
    expect(viaHeader.status).toBe(200);
  });
  it('refuses no key, a bad key, and a signed-in user token', async () => {
    const none = await request(app).post('/mcp').set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.body.error.message).toContain('stk_');
    expect((await rpc('stk_notarealkey', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    const asUser = await request(app).post('/mcp').set('Authorization', `Bearer ${owner}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(asUser.status).toBe(401);
  });
  it('answers GET and DELETE with 405 (stateless, no sessions)', async () => {
    for (const m of ['get', 'delete'] as const) {
      const res = await request(app)[m]('/mcp').set('Authorization', `Bearer ${readKey}`);
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
  it('a revoked key stops working on the next call', async () => {
    const { key, id } = await makeKey(['clients:read']);
    expect((await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    await request(app).delete(`/api/v1/api-keys/${id}`).set('Authorization', `Bearer ${owner}`).expect(200);
    expect((await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(401);
  });
  it('the call is logged against the key like a REST call', async () => {
    const { key, id } = await makeKey(['clients:read']);
    await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await new Promise((r) => setTimeout(r, 250));
    const usage = await request(app).get(`/api/v1/api-keys/${id}/usage`).set('Authorization', `Bearer ${owner}`);
    expect(usage.body.data.usage[0]).toMatchObject({ method: 'POST', path: '/mcp', status: 200 });
  });
});

// The wrapper itself, through the SDK's own client, with fixture tools.
const ctx = (scopes: string[]): ToolContext => ({
  businessId: 'b', userId: 'u', apiKey: { id: 'k', prefix: 'p', scopes }, agent: 'Bot', requestId: 'req-1',
  auth: { userId: 'u', email: 'e', role: 'ops_manager', businessId: 'b' },
});
const fixtureTools = [
  defineTool({
    name: 'echo', title: 'Echo', description: 'Echo a number back, for tests.', inputSchema: { n: z.number() }, outputSchema: { n: z.number() },
    annotations: { readOnlyHint: true }, scope: 'clients:read',
    handler: async ({ n }) => ({ summary: `Got ${n}.`, data: { n }, audit: { recordsTouched: [{ type: 'client', id: 'c1' }] } }),
  }),
  defineTool({
    name: 'fail_coded', title: 'Fail', description: 'Always fails with a coded error.', inputSchema: {}, outputSchema: { ok: z.boolean() }, annotations: {},
    handler: async () => { throw new ApiError('account_not_linked', 'The meta account 9 is not linked to a client.', { hint: 'Use link_ad_account.' }); },
  }),
  defineTool({
    name: 'boom', title: 'Boom', description: 'Throws an unexpected error.', inputSchema: {}, outputSchema: { ok: z.boolean() }, annotations: {},
    handler: async () => { throw new Error('secret internals'); },
  }),
];
async function connect(scopes: string[], audits: AuditEntry[] = []) {
  const server = createStatoMcpServer(ctx(scopes), fixtureTools, (a) => audits.push(a));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

describe('tool wrapper', () => {
  it('returns structured data plus a text summary and reports audit detail', async () => {
    const audits: AuditEntry[] = [];
    const client = await connect(['clients:read'], audits);
    const res = await client.callTool({ name: 'echo', arguments: { n: 7 } });
    expect(res.structuredContent).toEqual({ n: 7 });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('Got 7.');
    expect(audits).toEqual([{ tool: 'echo', args: { n: 7 }, before: undefined, after: undefined, recordsTouched: [{ type: 'client', id: 'c1' }] }]);
  });
  it('refuses a key without the tool scope with insufficient_scope', async () => {
    const audits: AuditEntry[] = [];
    const client = await connect(['creatives:read'], audits);
    const res = await client.callTool({ name: 'echo', arguments: { n: 1 } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'insufficient_scope', requestId: 'req-1', retryable: false });
    expect(audits[0]).toMatchObject({ tool: 'echo', errorCode: 'insufficient_scope' });
  });
  it('maps an ApiError to isError with code, message, hint and requestId', async () => {
    const client = await connect([]);
    const res = await client.callTool({ name: 'fail_coded', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'error', code: 'account_not_linked', hint: 'Use link_ad_account.', requestId: 'req-1' });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('Hint: Use link_ad_account.');
  });
  it('masks an unexpected error', async () => {
    const client = await connect([]);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'internal_error', message: 'Internal server error' });
    expect(JSON.stringify(res)).not.toContain('secret internals');
  });
});

describe('tool loader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stato-tools-'));
  const body = (name: string) => `export default { name: '${name}', title: 't', description: 'd', inputSchema: {}, outputSchema: {}, annotations: {}, handler: async () => ({ summary: 's', data: {} }) };`;
  it('loads every <name>.tool file in the folder, so adding a tool edits no shared list', async () => {
    fs.writeFileSync(path.join(tmp, 'b_tool.tool.mjs'), body('b_tool'));
    fs.writeFileSync(path.join(tmp, 'a_tool.tool.mjs'), body('a_tool'));
    fs.writeFileSync(path.join(tmp, 'ignored.mjs'), body('ignored'));
    expect((await loadTools(tmp)).map((t) => t.name)).toEqual(['a_tool', 'b_tool']);
  });
  it('fails loudly on a duplicate name or a file with no tool', async () => {
    fs.writeFileSync(path.join(tmp, 'c_tool.tool.mjs'), body('a_tool'));
    await expect(loadTools(tmp)).rejects.toThrow(/Duplicate MCP tool name "a_tool"/);
    fs.unlinkSync(path.join(tmp, 'c_tool.tool.mjs'));
    fs.writeFileSync(path.join(tmp, 'd_tool.tool.mjs'), 'export const x = 1;');
    await expect(loadTools(tmp)).rejects.toThrow(/must export a tool/);
  });
  it('the real tools folder loads and includes whoami', async () => {
    expect((await loadTools()).map((t) => t.name)).toContain('whoami');
  });
});
