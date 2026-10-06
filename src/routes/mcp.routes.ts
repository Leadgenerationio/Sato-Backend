import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiKeyOrJwt, apiKeyRateLimit } from '../middleware/api-key.middleware.js';
import { createStatoMcpServer } from '../mcp/server.js';
import { getTools } from '../mcp/tools/registry.js';
import type { ToolContext } from '../mcp/types.js';

// Remote MCP over Streamable HTTP, one endpoint, stateless (MCP spec v1.0
// section 3). It sits inside the API: same key check, same scopes, same
// per-key rate limit and, through res.locals.audit, the same audit log as the
// REST routes. A key is required; a signed-in user token is not accepted.

export const mcpRoutes: RouterType = Router();

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}) {
  res.status(status).set(headers).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
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
    userId: req.user!.userId,
    apiKey: key,
    agent: (req.get('x-stato-agent') ?? '').trim().slice(0, 100) || null,
    requestId: String(res.locals.requestId ?? ''),
    auth: { userId: req.user!.userId, email: req.user!.email, role: 'ops_manager', businessId: req.user!.businessId! },
  };
  const tools = await getTools();
  const server = createStatoMcpServer(ctx, tools, (a) => { res.locals.audit = a; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
