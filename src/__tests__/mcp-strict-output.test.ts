import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStatoMcpServer } from '../mcp/server.js';
import type { StatoTool, ToolContext } from '../mcp/types.js';

// The registered output schema is loose (so an error body can travel in structuredContent). A success result is still checked
// against the strict schema, so a tool that stops returning a required field is caught by the tests, not by a bot.
const ctx = { businessId: 'b', userId: null, apiKey: { id: 'k', prefix: 'p', scopes: [] }, agent: null, requestId: 'r', auth: { userId: 'u', email: 'e', role: 'ops_manager', businessId: 'b' } } as ToolContext;
const tool = (data: Record<string, unknown>): StatoTool => ({
  name: 'probe', title: 'Probe', description: 'A tool for this test. IDs are strings.',
  inputSchema: {}, outputSchema: { creativeId: z.string(), count: z.number() },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ summary: 'ok', data }),
});

async function call(t: StatoTool) {
  const server = createStatoMcpServer(ctx, [t]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'strict-test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  const res = await client.callTool({ name: 'probe', arguments: {} });
  await client.close();
  return res;
}

describe('a success result must fit the tool\'s strict output schema', () => {
  it('passes when every required field is there', async () => {
    const res = await call(tool({ creativeId: 'c1', count: 2 }));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ creativeId: 'c1', count: 2 });
  });
  it('outside production, a result that lost a required field is an internal_error, not a quiet success', async () => {
    const res = await call(tool({ count: 2 }));
    expect(res.isError).toBe(true);
    expect((res.structuredContent as any).code).toBe('internal_error');
  });
  it('a wrong type is caught too', async () => {
    const res = await call(tool({ creativeId: 'c1', count: 'two' }));
    expect(res.isError).toBe(true);
  });
});
