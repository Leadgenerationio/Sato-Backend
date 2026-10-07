import { describe, it, expect } from 'vitest';
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
