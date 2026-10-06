import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError } from '../utils/api-error.js';
import { buildErrorBody } from '../utils/error-body.js';
import { logger } from '../utils/logger.js';
import type { StatoTool, ToolContext } from './types.js';

export const SERVER_INFO = { name: 'stato', version: '1.0.0' } as const;

const INSTRUCTIONS =
  'Stato is the record of which file, copy and landing page is running in which ad, for which client and campaign. ' +
  'Stato never writes to Meta, Google or TikTok; your ad-platform tools do that. Matching is always on IDs, never names, and every ID is a string. ' +
  'Call whoami first to check which key you are using. If an ad account is not linked to a client, stop and ask the owner. ' +
  'A tool error carries a code and a hint saying what to do next.';

export interface AuditEntry {
  tool: string;
  args: unknown;
  before?: unknown;
  after?: unknown;
  recordsTouched?: Array<{ type: string; id: string }>;
  errorCode?: string;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** One MCP server per request (stateless), exposing the loaded tools to one caller. */
export function createStatoMcpServer(ctx: ToolContext, tools: StatoTool[], onAudit?: (a: AuditEntry) => void): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations },
      async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          if (t.scope && !ctx.apiKey.scopes.includes(t.scope)) {
            throw new ApiError('insufficient_scope', `This API key does not have the "${t.scope}" scope.`, {
              hint: 'Ask the owner to add that scope to the key in Settings, API keys, or use a key that has it.',
            });
          }
          const out = await t.handler(args, ctx);
          onAudit?.({ tool: t.name, args, before: out.audit?.before, after: out.audit?.after, recordsTouched: out.audit?.recordsTouched });
          return { content: [{ type: 'text', text: `${out.summary}\n\n${JSON.stringify(out.data, null, 2)}` }], structuredContent: out.data };
        } catch (err) {
          const { body } = buildErrorBody(err, ctx.requestId);
          if (body.code === 'internal_error') logger.error({ err, requestId: ctx.requestId }, 'MCP tool failed');
          onAudit?.({ tool: t.name, args, errorCode: String(body.code ?? 'internal_error') });
          const hint = typeof body.hint === 'string' ? `\nHint: ${body.hint}` : '';
          return { isError: true, content: [{ type: 'text', text: `${String(body.message)}${hint}` }], structuredContent: body };
        }
      },
    );
  }
  return server;
}
