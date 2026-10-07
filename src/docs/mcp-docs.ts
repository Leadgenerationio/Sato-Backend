import fs from 'node:fs';
import type { StatoTool } from '../mcp/types.js';
import { logger } from '../utils/logger.js';

// docs/mcp-tools.md is generated from the live tool definitions, so the table can never drift from what /mcp serves.
// Regenerate with: npx tsx scripts/generate-mcp-docs.ts   (a test fails when the file is out of date).

const firstSentence = (d: string) => (d.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? d).replace(/\s+/g, ' ').trim();

export interface ToolDoc {
  name: string;
  summary: string;
  scope: string | null;
  kind: 'read only' | 'write' | 'write (hides or removes, never deletes a file)';
  required: string[];
  optional: string[];
  idempotencyKey: boolean;
}

/** One row per tool, sorted by name: the portal's tool table, and the source of mcp-tools.md. */
export function toolDocs(tools: StatoTool[]): ToolDoc[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
    const a = t.annotations ?? {};
    const names = Object.entries(t.inputSchema).map(([k, v]) => ({ k, optional: (v as { isOptional?: () => boolean }).isOptional?.() ?? false }));
    return {
      name: t.name,
      summary: firstSentence(t.description),
      scope: t.scope ?? null,
      kind: a.readOnlyHint ? 'read only' : a.destructiveHint ? 'write (hides or removes, never deletes a file)' : 'write',
      required: names.filter((n) => !n.optional).map((n) => n.k),
      optional: names.filter((n) => n.optional && n.k !== 'idempotencyKey').map((n) => n.k),
      idempotencyKey: names.some((n) => n.k === 'idempotencyKey'),
    };
  });
}

/** The sentence above the table: tool count, IDs, idempotency, error shape. */
export function toolsIntro(tools: StatoTool[]): string {
  const docs = toolDocs(tools);
  const writesWithoutKey = docs.filter((d) => d.kind !== 'read only' && !d.idempotencyKey).map((d) => `\`${d.name}\``);
  const idem = writesWithoutKey.length ? `Write tools take an optional \`idempotencyKey\` (except ${writesWithoutKey.join(', ')}, which are safe to repeat as they are).` : 'Every write tool takes an optional `idempotencyKey`.';
  return `${docs.length} tools. Every ID is a string. ${idem} Errors come back with \`isError: true\` and a body with \`code\`, \`message\`, \`hint\`, \`fields\`, \`retryable\` and \`requestId\`.`;
}

function inputs(d: ToolDoc): string {
  const code = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  const parts = [d.required.length ? code(d.required) : '', d.optional.length ? `optional: ${code(d.optional)}` : ''].filter(Boolean);
  if (!parts.length && !d.idempotencyKey) return 'none';
  return parts.join('; ') + (d.idempotencyKey ? '; takes `idempotencyKey`' : '');
}

export function renderToolsMarkdown(tools: StatoTool[]): string {
  const rows = toolDocs(tools).map((d) => `| \`${d.name}\` | ${d.summary.replace(/\|/g, '\\|')} | ${d.scope ? `\`${d.scope}\`` : 'any key'} | ${d.kind} | ${inputs(d)} |`);
  return [
    '# Stato MCP tools',
    '',
    '<!-- Generated from the tool definitions by scripts/generate-mcp-docs.ts. Do not edit by hand. -->',
    '',
    toolsIntro(tools),
    '',
    '| Tool | What it does | Scope | Kind | Inputs |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

// docs/mcp-setup.md, read once. src/docs and dist/docs are the same depth, so one relative path serves both;
// the Dockerfile copies docs/ into the image for it.
const SETUP_PATH = new URL('../../docs/mcp-setup.md', import.meta.url);
let setupCache: string | null = null;
export function mcpSetupGuide(): string | null {
  if (setupCache === null) {
    try {
      setupCache = fs.readFileSync(SETUP_PATH, 'utf8');
    } catch (err) {
      logger.error({ err, path: SETUP_PATH.pathname }, 'MCP setup guide not found');
      return null;
    }
  }
  return setupCache;
}
