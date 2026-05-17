import { logger } from '../../utils/logger.js';
import type {
  CatchrListSourcesResponse,
  CatchrRowsResponse,
  CatchrRunRequestArgs,
  McpToolCallRequest,
  McpToolCallResponse,
} from './catchr-types.js';

/**
 * Catchr MCP HTTP client.
 *
 * Talks to `CATCHR_MCP_URL` (an MCP streamable-HTTP endpoint) via JSON-RPC 2.0
 * POST requests. Authentication is a bearer `CATCHR_ACCESS_TOKEN` obtained once
 * via the OAuth flow (scope `mcp:tools:read mcp:tools:execute`) and pasted into
 * .env for Phase 1.
 *
 * For tool calls the server returns `application/json` with a JSON-RPC envelope
 * whose `result.content[0].text` is a JSON string — we parse that into the
 * concrete data type the caller expects.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

// Read straight from process.env — the env.ts module captures values at
// import time, so a runtime delete (in tests) wouldn't reach the cached
// snapshot. Reading process.env every call keeps `delete process.env.X` honest.
function token(): string {
  return process.env.CATCHR_ACCESS_TOKEN || '';
}

function mcpUrl(): string {
  return (process.env.CATCHR_MCP_URL || 'https://api.catchr.io/mcp').replace(/\/$/, '');
}

export function isCatchrConfigured(): boolean {
  return !!token();
}

// ─── Low-level JSON-RPC ─────────────────────────────────────────────────────

let rpcId = 0;
function nextId(): number {
  rpcId += 1;
  return rpcId;
}

// ─── MCP session (Streamable HTTP, spec 2025-06-18) ─────────────────────────
// Catchr enforces stateful sessions: every non-initialize request must carry
// an Mcp-Session-Id header obtained from a prior initialize handshake.

let sessionId: string | null = null;

/** Clear the cached MCP session so the next call performs a fresh handshake. */
export function resetSession(): void {
  sessionId = null;
}

/** Test-only hooks for seeding/clearing session state without doing a real handshake. */
export const __testing = {
  setSessionId(id: string | null): void { sessionId = id; },
  getSessionId(): string | null { return sessionId; },
};

async function postMcp(body: object, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
}

async function doInitialize(): Promise<void> {
  const res = await postMcp({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stato-catchr', version: '1.0.0' },
    },
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, text: text.slice(0, 500) }, 'Catchr MCP initialize failed');
    throw new Error(`Catchr MCP initialize: ${res.status}`);
  }

  const sid = res.headers.get('mcp-session-id');
  if (!sid) {
    throw new Error('Catchr MCP initialize: no Mcp-Session-Id header in response');
  }
  sessionId = sid;
  try { await res.text(); } catch { /* drain */ }

  // Complete the handshake. notifications/initialized has no response body.
  const notified = await postMcp(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'Mcp-Session-Id': sessionId },
  );
  try { await notified.text(); } catch { /* drain */ }

  logger.info({ sessionIdPrefix: sessionId.slice(0, 8) }, 'Catchr MCP session established');
}

async function ensureSession(): Promise<void> {
  if (sessionId) return;
  await doInitialize();
}

/**
 * POST a JSON-RPC `tools/call` to the Catchr MCP endpoint.
 *
 * Establishes an MCP session on first use and attaches the Mcp-Session-Id
 * header to every call. If the server reports the session is gone (404 or a
 * 400 mentioning "session"), re-initializes once and retries.
 *
 * Catchr returns single-response JSON for these tools — if future tools stream
 * we also handle `text/event-stream`.
 */
async function callTool<T>(name: string, args: Record<string, unknown>, retried = false): Promise<T> {
  if (!isCatchrConfigured()) {
    throw new Error('Catchr not configured — set CATCHR_ACCESS_TOKEN');
  }

  await ensureSession();

  const body: McpToolCallRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name, arguments: args },
  };

  const res = await postMcp(body, { 'Mcp-Session-Id': sessionId! });

  if (!res.ok) {
    const text = await res.text();
    if (!retried && (res.status === 404 || res.status === 400) && /session/i.test(text)) {
      logger.warn({ status: res.status, name }, 'Catchr MCP session lost — reinitializing');
      sessionId = null;
      return callTool<T>(name, args, true);
    }
    logger.error({ status: res.status, name, text: text.slice(0, 500) }, 'Catchr MCP call failed');
    throw new Error(`Catchr MCP ${name}: ${res.status}`);
  }

  const ctype = res.headers.get('content-type') || '';
  let envelope: McpToolCallResponse;
  if (ctype.includes('text/event-stream')) {
    // SSE — find the first "data: {...}" line with a JSON-RPC body.
    const raw = await res.text();
    const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith('data: '));
    if (!dataLine) throw new Error(`Catchr MCP ${name}: empty SSE stream`);
    envelope = JSON.parse(dataLine.slice(6)) as McpToolCallResponse;
  } else {
    envelope = (await res.json()) as McpToolCallResponse;
  }

  if (envelope.error) {
    throw new Error(`Catchr MCP ${name}: ${envelope.error.message}`);
  }
  if (!envelope.result) {
    throw new Error(`Catchr MCP ${name}: missing result`);
  }
  if (envelope.result.isError) {
    // Surface whatever the MCP tool actually said in the content text — the
    // bare "tool reported error" message hides the real cause (rate limit,
    // missing field, expired auth, etc.) and makes debugging impossible.
    const detail = envelope.result.content
      .map((c) => (c.type === 'text' ? (c as { type: 'text'; text: string }).text : `[${c.type}]`))
      .join(' | ')
      .slice(0, 500);
    throw new Error(`Catchr MCP ${name}: ${detail || 'tool reported error'}`);
  }

  const first = envelope.result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Catchr MCP ${name}: unexpected content shape`);
  }
  return JSON.parse((first as { type: 'text'; text: string }).text) as T;
}

// ─── Public typed wrappers ──────────────────────────────────────────────────

export async function listPlatforms(connectedOnly = true): Promise<{
  platforms: Array<{ id: string; name: string; connected: boolean }>;
}> {
  return callTool('list_platforms', { connectedOnly });
}

export async function listSources(opts: { platform?: string; includeAvailableAccounts?: boolean } = {}): Promise<CatchrListSourcesResponse> {
  const args: Record<string, unknown> = {
    includeAvailableAccounts: opts.includeAvailableAccounts ?? true,
  };
  if (opts.platform) args.platform = opts.platform;
  return callTool<CatchrListSourcesResponse>('list_sources', args);
}

export async function runApiRequest(args: CatchrRunRequestArgs): Promise<CatchrRowsResponse> {
  return callTool<CatchrRowsResponse>('run_api_request_json', args as unknown as Record<string, unknown>);
}
