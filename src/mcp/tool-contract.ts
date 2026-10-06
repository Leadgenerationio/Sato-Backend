import type { z, ZodRawShape } from 'zod';
import type { AuthPayload } from '../types/index.js';
import type { ApiScope } from '../services/api-key.service.js';

// The contract between the /mcp mount (Track Y builds the loader) and the tool
// files (both tracks add them). Each src/mcp/tools/<name>.tool.ts exports one
// `tool` of this type; the loader registers every file it finds, so adding a
// tool never edits a shared list.
//
// PROPOSED (Hari, 6 Oct) — to agree with Yash before D3, then change only by
// agreement (plan rule 3).
//
// The loader is expected to:
//   - check `scope` against the key before calling the handler
//     (insufficient_scope otherwise), so tools carry no scope checks;
//   - turn a thrown error into mcpErrorResult(err, ctx.requestId)
//     (src/utils/api-error.ts);
//   - turn a returned ToolOutput into { content: [{ type: 'text', text:
//     summary }], structuredContent: data };
//   - write ctx.audit into res.locals.audit for the audit writer (plan
//     contract "Audit").

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolAuditEntry {
  tool: string;
  args?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  recordsTouched?: Array<{ type: string; id: string }>;
  errorCode?: string | null;
}

export interface ToolContext {
  /** The caller, as apiKeyOrJwt sets req.user (a key acts in its own business). */
  user: AuthPayload;
  businessId: string;
  apiKey: { id: string; scopes: string[]; allowedClientIds?: string[] | null } | null;
  requestId: string | null;
  /** Filled by the tool; the loader copies it to res.locals.audit. */
  audit: Partial<ToolAuditEntry>;
}

export interface ToolOutput<T extends Record<string, unknown> = Record<string, unknown>> {
  /** One or two plain sentences for the model. */
  summary: string;
  data: T;
}

export interface McpToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  /** Written for an AI reader: when to use it, what to call first, that IDs are strings. */
  description: string;
  /** null = any valid key (whoami). */
  scope: ApiScope | null;
  annotations: ToolAnnotations;
  inputSchema: S;
  outputSchema?: ZodRawShape;
  /** Called with input already validated against inputSchema. */
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>;
}

/** Identity helper so a tool file gets its handler args typed from its own schema. */
export function defineTool<S extends ZodRawShape>(def: McpToolDefinition<S>): McpToolDefinition<S> {
  return def;
}
