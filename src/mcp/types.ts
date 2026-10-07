import type { z } from 'zod';
import type { ApiScope } from '../services/api-key.service.js';

// MCP tools live one per file in src/mcp/tools/<name>.tool.ts. The mount loads
// every such file, so adding a tool never edits a shared list and two people
// never touch the same file.

/** Who is calling, resolved from the API key (never from the tool arguments). */
export interface ToolContext {
  businessId: string;
  /** The user who owns the key, when known. */
  userId: string | null;
  apiKey: { id: string; prefix: string; scopes: string[] };
  /** Bot name from the X-Stato-Agent header, or the MCP client name. */
  agent: string | null;
  requestId: string;
  /** This key's rate-limit window after the current call, when the limiter reported it. */
  rateLimit?: { limit: number; remaining: number; resetsInSeconds: number } | null;
  /** The same caller shaped like a signed-in user, for the existing service functions. */
  auth: { userId: string; email: string; role: 'ops_manager'; businessId: string };
}

export type ZodShape = Record<string, z.ZodType>;

export interface ToolOutput<T = Record<string, unknown>> {
  /** One or two plain sentences for the AI reader. */
  summary: string;
  /** Structured result, validated against outputSchema. */
  data: T;
  /** Optional detail for the audit log (the audit writer redacts and stores it). */
  audit?: { before?: unknown; after?: unknown; recordsTouched?: Array<{ type: string; id: string }> };
}

export interface StatoTool {
  name: string;
  title: string;
  /** Written for an AI reader: when to use it, what to call first, that IDs are strings. */
  description: string;
  inputSchema: ZodShape;
  outputSchema: ZodShape;
  annotations: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  /** The key must hold this scope; otherwise the call returns insufficient_scope. */
  scope?: ApiScope;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

/** Helper that keeps a tool file's types honest. */
export function defineTool<S extends ZodShape, O extends ZodShape>(
  tool: Omit<StatoTool, 'inputSchema' | 'outputSchema' | 'handler'> & {
    inputSchema: S;
    outputSchema: O;
    handler: (args: { [K in keyof S]: z.infer<S[K]> }, ctx: ToolContext) => Promise<ToolOutput<{ [K in keyof O]: z.infer<O[K]> }>>;
  },
): StatoTool {
  return tool as unknown as StatoTool;
}
