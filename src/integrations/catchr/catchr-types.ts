/**
 * Types for the Catchr MCP HTTP integration.
 *
 * Catchr exposes its data via an MCP server at `CATCHR_MCP_URL` (default
 * https://api.catchr.io/mcp). Authentication is OAuth bearer. For Phase 1
 * the access token is pasted manually into `CATCHR_ACCESS_TOKEN` — refresh
 * flow is Phase-2 work once Sam gives us the client-credentials grant.
 */

export type CatchrPlatform =
  | 'google-ads'
  | 'facebook-ads'
  | 'bing-ads'
  | 'tik-tok'
  | 'taboola';

export interface CatchrAvailableAccount {
  id: string;
  name: string;
  is_parent_account: boolean;
  authorization_id: number;
  authorization_name: string;
  options: unknown;
}

export interface CatchrSource {
  id: number;
  name: string;
  platform: CatchrPlatform | string;
  platform_name: string;
  type: string;
  state: 'SUCCESS' | string;
  last_sync: string | null;
  total_available_data_source: number;
  total_activated_data_source: number | null;
  available_accounts?: CatchrAvailableAccount[];
}

export interface CatchrListSourcesResponse {
  count: number;
  sources: CatchrSource[];
}

export interface CatchrRunRequestAccount {
  id: string;
  authorization_id: number | string;
  global?: boolean;
}

export type CatchrDatePreset =
  | 'TODAY'
  | 'YESTERDAY'
  | 'LAST_7_DAYS'
  | 'LAST_14_DAYS'
  | 'LAST_28_DAYS'
  | 'LAST_90_DAYS'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'CUSTOM';

export interface CatchrRunRequestArgs {
  platform: string;
  accounts: CatchrRunRequestAccount[];
  dimensions?: string[];
  metrics?: string[];
  date?: CatchrDatePreset;
  start_date?: string; // YYYY-MM-DD (required if date=CUSTOM)
  end_date?: string;   // YYYY-MM-DD (required if date=CUSTOM)
  filters?: Array<Record<string, unknown>>;
  options?: Record<string, unknown>;
}

export interface CatchrRowsResponse {
  count: number;
  rows: Array<Record<string, string | number | null>>;
}

/** JSON-RPC 2.0 request body for MCP `tools/call`. */
export interface McpToolCallRequest {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** JSON-RPC 2.0 successful tool-call envelope. */
export interface McpToolCallResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    content: Array<{ type: 'text'; text: string } | { type: string; [k: string]: unknown }>;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
