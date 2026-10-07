import type { StatoTool } from '../mcp/types.js';

// docs/mcp-tools.md is generated from the live tool definitions, so the table can never drift from what /mcp serves.
// Regenerate with: npx tsx scripts/generate-mcp-docs.ts   (a test fails when the file is out of date).

const firstSentence = (d: string) => (d.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? d).replace(/\s+/g, ' ').trim();

function inputs(tool: StatoTool): string {
  const names = Object.entries(tool.inputSchema).map(([k, v]) => ({ k, optional: (v as { isOptional?: () => boolean }).isOptional?.() ?? false }));
  if (names.length === 0) return 'none';
  const required = names.filter((n) => !n.optional).map((n) => `\`${n.k}\``);
  const optional = names.filter((n) => n.optional && n.k !== 'idempotencyKey').map((n) => `\`${n.k}\``);
  const parts = [required.length ? required.join(', ') : '', optional.length ? `optional: ${optional.join(', ')}` : ''].filter(Boolean);
  const idem = names.some((n) => n.k === 'idempotencyKey') ? '; takes `idempotencyKey`' : '';
  return parts.join('; ') + idem;
}

export function renderToolsMarkdown(tools: StatoTool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((t) => {
    const a = t.annotations ?? {};
    const kind = a.readOnlyHint ? 'read only' : a.destructiveHint ? 'write (hides or removes, never deletes a file)' : 'write';
    return `| \`${t.name}\` | ${firstSentence(t.description).replace(/\|/g, '\\|')} | ${t.scope ? `\`${t.scope}\`` : 'any key'} | ${kind} | ${inputs(t)} |`;
  });
  const writesWithoutKey = sorted.filter((t) => !t.annotations?.readOnlyHint && !('idempotencyKey' in t.inputSchema)).map((t) => `\`${t.name}\``);
  const idem = writesWithoutKey.length ? `Write tools take an optional \`idempotencyKey\` (except ${writesWithoutKey.join(', ')}, which are safe to repeat as they are).` : 'Every write tool takes an optional `idempotencyKey`.';
  return [
    '# Stato MCP tools',
    '',
    '<!-- Generated from the tool definitions by scripts/generate-mcp-docs.ts. Do not edit by hand. -->',
    '',
    `${sorted.length} tools. Every ID is a string. ${idem} Errors come back with \`isError: true\` and a body with \`code\`, \`message\`, \`hint\`, \`fields\`, \`retryable\` and \`requestId\`.`,
    '',
    '| Tool | What it does | Scope | Kind | Inputs |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
