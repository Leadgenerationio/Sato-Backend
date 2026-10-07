import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError } from '../utils/api-error.js';
import { buildErrorBody } from '../utils/error-body.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import type { StatoTool, ToolContext } from './types.js';
import { callWithinClientScope } from './client-scope.js';

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
    // The registered schema is loose (see below), so a success result is also checked here against the strict one.
    const strictOutput = z.object(t.outputSchema);
    server.registerTool(
      t.name,
      // Every output field is optional (and extras are allowed) because a tool error comes back in the same structuredContent,
      // as the shared error body. The official SDK client validates structuredContent against outputSchema even when isError is
      // true, so a strict schema made it throw "does not match the tool's output schema" and hide the code and hint.
      { title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: z.object(t.outputSchema).partial().loose(), annotations: t.annotations },
      async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          if (t.scope && !ctx.apiKey.scopes.includes(t.scope)) {
            throw new ApiError('insufficient_scope', `This API key does not have the "${t.scope}" scope.`, {
              hint: 'Ask the owner to add that scope to the key in Settings, API keys, or use a key that has it.',
            });
          }
          const out = await callWithinClientScope(t, args, ctx);
          const strict = strictOutput.safeParse(out.data);
          if (!strict.success) {
            logger.error({ tool: t.name, issues: strict.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }, 'MCP tool result does not match its output schema');
            // Outside production this is a bug in the tool: fail loudly so the tests catch it. In production the caller still gets the result.
            if (env.NODE_ENV !== 'production') throw new Error(`${t.name} returned a result that does not match its output schema`);
          }
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

/**
 * Bad tool input must come back in the shared error shape (code, fields,
 * requestId), not as the SDK's own "MCP error -32602" text. The route calls
 * this before the SDK sees a tools/call; it answers with a JSON-RPC result
 * (isError: true, structuredContent) when the arguments do not match the
 * tool's input schema, and returns null when the call may go on.
 */
export function rejectInvalidToolCall(tools: StatoTool[], message: unknown, requestId: string | null) {
  const m = message as { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string; arguments?: unknown } } | null;
  if (!m || m.method !== 'tools/call' || typeof m.params?.name !== 'string') return null;
  const tool = tools.find((t) => t.name === m.params!.name);
  if (!tool) return null; // unknown tool: the SDK's own error is right
  const parsed = z.object(tool.inputSchema).safeParse(m.params.arguments ?? {});
  if (parsed.success) return null;
  const fields = parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(input)', message: i.message }));
  const err = new ApiError('validation_failed', `Invalid input for ${tool.name}`, {
    fields,
    hint: `${fields[0]!.field}: ${fields[0]!.message}`,
  });
  const { body } = buildErrorBody(err, requestId ?? undefined);
  const hint = typeof body.hint === 'string' ? `\nHint: ${body.hint}` : '';
  return {
    jsonrpc: '2.0' as const,
    id: m.id ?? null,
    result: { isError: true, content: [{ type: 'text', text: `${String(body.message)}${hint}` }], structuredContent: body },
    errorCode: 'validation_failed',
    args: m.params.arguments,
  };
}
