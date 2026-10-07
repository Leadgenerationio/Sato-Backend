/**
 * Writes docs/mcp-tools.md from the live MCP tool definitions.
 *   npx tsx scripts/generate-mcp-docs.ts
 */
import { writeFileSync } from 'node:fs';
import { getTools } from '../src/mcp/tools/registry.js';
import { renderToolsMarkdown } from '../src/docs/mcp-docs.js';

const tools = await getTools();
writeFileSync(new URL('../docs/mcp-tools.md', import.meta.url), renderToolsMarkdown(tools));
console.log(`docs/mcp-tools.md written for ${tools.length} tools`);
process.exit(0);
