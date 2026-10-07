import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../index.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';

// Cursor and other agents connect with the official SDK client. That client validates structuredContent against the tool's
// outputSchema even when isError is true, so an error body that does not fit the schema made it throw and hide the hint.
const tag = `${Date.now() % 1e9}`;
let server: http.Server; let url = '';
let fullKey = ''; let readKey = '';
const keyIds: string[] = [];

async function connect(k: string) {
  const client = new Client({ name: 'cursor-like-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${k}` } } }));
  await client.listTools(); // the client validates results against the schemas it learned here (as Cursor does)
  return client;
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  const owner = login.body.data.tokens.accessToken;
  for (const [name, scopes] of [['full', ['clients:read', 'uploads:write', 'creatives:read']], ['read', ['clients:read']]] as const) {
    const r = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test sdk ${name} ${tag}`, scopes });
    keyIds.push(r.body.data.apiKey.id);
    if (name === 'full') fullKey = r.body.data.key; else readKey = r.body.data.key;
  }
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
  await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('the official MCP SDK client (what Cursor uses)', () => {
  it('lists the tools and reads a success result', async () => {
    const client = await connect(fullKey);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(22);
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    expect(who.isError).toBeFalsy();
    expect((who.structuredContent as any).key.name).toBe(`Yash Test sdk full ${tag}`);
    await client.close();
  });
  it.each([
    ['bad input', 'get_client', { clientId: 'abc' }, 'validation_failed'],
    ['not found', 'get_client', { clientId: '00000000-0000-4000-8000-000000000000' }, 'not_found'],
    ['not found on complete_upload (its status field is an enum)', 'complete_upload', { uploadId: '00000000-0000-4000-8000-000000000000' }, 'not_found'],
  ])('a tool error (%s) comes back with its code and hint instead of throwing', async (_label, name, args, code) => {
    const client = await connect(fullKey);
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code, retryable: false });
    expect(typeof (res.structuredContent as any).hint).toBe('string');
    expect(typeof (res.structuredContent as any).requestId).toBe('string');
    await client.close();
  });
  it('a missing scope is insufficient_scope with a hint, not a thrown error', async () => {
    const client = await connect(readKey);
    const res = await client.callTool({ name: 'create_upload', arguments: { filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100 } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'insufficient_scope' });
    await client.close();
  });
});
