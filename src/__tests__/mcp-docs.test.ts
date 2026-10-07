import { describe, it, expect } from 'vitest';
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
