import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiKeyOrJwt, apiKeyRateLimit } from '../middleware/api-key.middleware.js';
import { createStatoMcpServer, rejectInvalidToolCall } from '../mcp/server.js';
import { getTools } from '../mcp/tools/registry.js';
import type { ToolContext } from '../mcp/types.js';
import { realUserId } from '../services/ad-account-rules.service.js';

// Remote MCP over Streamable HTTP, one endpoint, stateless (MCP spec v1.0
// section 3). It sits inside the API: same key check, same scopes, same
// per-key rate limit and, through res.locals.audit, the same audit log as the
// REST routes. A key is required; a signed-in user token is not accepted.

export const mcpRoutes: RouterType = Router();

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}) {
  res.status(status).set(headers).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/** The limiter's view of this key after the current call (express-rate-limit puts it on the request). */
function rateLimitOf(req: Request): { limit: number; remaining: number; resetsInSeconds: number } | null {
  const rl = (req as Request & { rateLimit?: { limit: number; remaining: number; resetTime?: Date } }).rateLimit;
  if (!rl) return null;
  return { limit: rl.limit, remaining: Math.max(0, rl.remaining), resetsInSeconds: rl.resetTime ? Math.max(0, Math.ceil((rl.resetTime.getTime() - Date.now()) / 1000)) : 60 };
}

function hasKey(req: Request): boolean {
  return Boolean(req.get('x-api-key')) || /^Bearer\s+stk_/i.test(req.get('authorization') ?? '');
}

mcpRoutes.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'POST') {
    // Stateless: no server-initiated streams or sessions to resume or close.
    return jsonRpcError(res, 405, 'Method not allowed. Send MCP requests with POST.', { Allow: 'POST' });
  }
  if (!hasKey(req)) {
    return jsonRpcError(res, 401, 'Send your Stato API key as "Authorization: Bearer stk_..." (or in X-API-Key).', { 'WWW-Authenticate': 'Bearer' });
  }
  next();
});
mcpRoutes.use(apiKeyOrJwt, apiKeyRateLimit);

mcpRoutes.post('/', async (req: Request, res: Response) => {
  const key = req.apiKey!;
  const ctx: ToolContext = {
    businessId: req.user!.businessId!,
    userId: realUserId(req.user!.userId),
    apiKey: key,
    agent: (req.get('x-stato-agent') ?? '').trim().slice(0, 100) || null,
    requestId: String(res.locals.requestId ?? ''),
    rateLimit: rateLimitOf(req),
    auth: { userId: req.user!.userId, email: req.user!.email, role: 'ops_manager', businessId: req.user!.businessId! },
  };
  // One audit entry per request: res.locals.audit holds a single call, so a
  // JSON-RPC batch (dropped from the newer MCP spec) is refused, not half-audited.
  if (Array.isArray(req.body)) {
    return jsonRpcError(res, 400, 'Batch requests are not supported. Send one JSON-RPC message per POST.');
  }
  const tools = await getTools();
  const invalid = rejectInvalidToolCall(tools, req.body, ctx.requestId || null);
  if (invalid) {
    const { errorCode, args, ...reply } = invalid;
    res.locals.audit = { tool: String((req.body as { params: { name: string } }).params.name), args, errorCode };
    res.json(reply);
    return;
  }
  const server = createStatoMcpServer(ctx, tools, (a) => { res.locals.audit = a; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
