import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as catchr from '../integrations/catchr/catchr-client.js';
import { FIELD_MAP, fieldMapFor } from '../integrations/catchr/field-map.js';

const ORIGINAL_FETCH = global.fetch;

function mockMcpJsonResponse(payload: unknown): Response {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockSseResponse(payload: unknown): Response {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  };
  const sse = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    json: async () => { throw new Error('cannot json() an SSE response'); },
    text: async () => sse,
  } as unknown as Response;
}

function mockErrorEnvelope(message: string): Response {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message },
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Catchr client — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.CATCHR_ACCESS_TOKEN;
    delete process.env.CATCHR_MCP_URL;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  it('reports not configured without a token', () => {
    expect(catchr.isCatchrConfigured()).toBe(false);
  });

  it('reports configured when token is present', () => {
    process.env.CATCHR_ACCESS_TOKEN = 'abc';
    expect(catchr.isCatchrConfigured()).toBe(true);
  });

  it('throws a clear error when a call is made without configuration', async () => {
    await expect(catchr.listPlatforms()).rejects.toThrow(/not configured/);
  });
});

describe('Catchr client — JSON-RPC request shape', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.CATCHR_ACCESS_TOKEN = 'test-token';
    process.env.CATCHR_MCP_URL = 'https://api.catchr.io/mcp';
    // Skip MCP handshake for these tests — they focus on tools/call shape.
    catchr.__testing.setSessionId('seeded-session-id');
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    catchr.__testing.setSessionId(null);
  });

  it('sends a JSON-RPC 2.0 tools/call POST with the bearer token', async () => {
    const fetchSpy = vi.fn(async () => mockMcpJsonResponse({ platforms: [] }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await catchr.listPlatforms(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://api.catchr.io/mcp');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toContain('application/json');
    expect(headers['Mcp-Session-Id']).toBe('seeded-session-id');

    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('list_platforms');
    expect(body.params.arguments).toEqual({ connectedOnly: true });
  });

  it('parses the nested text-content JSON payload and returns typed data', async () => {
    global.fetch = vi.fn(async () =>
      mockMcpJsonResponse({ platforms: [{ id: 'google-ads', name: 'Google Ads', connected: true }] }),
    ) as unknown as typeof fetch;

    const result = await catchr.listPlatforms();

    expect(result.platforms).toHaveLength(1);
    expect(result.platforms[0].id).toBe('google-ads');
  });

  it('runApiRequest forwards platform/accounts/dimensions/metrics unchanged', async () => {
    const fetchSpy = vi.fn(async () => mockMcpJsonResponse({ count: 0, rows: [] }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await catchr.runApiRequest({
      platform: 'google-ads',
      accounts: [{ id: '123', authorization_id: 9 }],
      date: 'LAST_7_DAYS',
      dimensions: ['CampaignName'],
      metrics: ['Cost'],
    });

    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.params.name).toBe('run_api_request_json');
    expect(body.params.arguments.platform).toBe('google-ads');
    expect(body.params.arguments.metrics).toEqual(['Cost']);
    expect(body.params.arguments.accounts).toEqual([{ id: '123', authorization_id: 9 }]);
  });

  it('surfaces server-side JSON-RPC errors as rejections', async () => {
    global.fetch = vi.fn(async () => mockErrorEnvelope('rate limited')) as unknown as typeof fetch;
    await expect(catchr.listPlatforms()).rejects.toThrow(/rate limited/);
  });

  it('parses an SSE response when Catchr streams the tool result', async () => {
    global.fetch = vi.fn(async () =>
      mockSseResponse({ platforms: [{ id: 'facebook-ads', name: 'Facebook Ads', connected: true }] }),
    ) as unknown as typeof fetch;

    const result = await catchr.listPlatforms();
    expect(result.platforms[0].id).toBe('facebook-ads');
  });

  it('throws on a non-2xx HTTP response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    await expect(catchr.listPlatforms()).rejects.toThrow(/401/);
  });
});

describe('Catchr client — MCP session handshake', () => {
  const originalEnv = { ...process.env };

  function mockInitResp(sessionId: string): Response {
    const body = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'catchr', version: '1' } } };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': sessionId }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function mockEmptyOk(): Response {
    return {
      ok: true,
      status: 202,
      headers: new Headers({}),
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response;
  }

  function mockSessionGoneResp(): Response {
    const body = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A valid session id is REQUIRED for non-initialize requests.' } };
    return {
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    process.env.CATCHR_ACCESS_TOKEN = 'test-token';
    process.env.CATCHR_MCP_URL = 'https://api.catchr.io/mcp';
    catchr.resetSession();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    catchr.resetSession();
  });

  it('does initialize + notifications/initialized before the first tool call', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const responses: Response[] = [
      mockInitResp('sess-xyz'),
      mockEmptyOk(),
      mockMcpJsonResponse({ platforms: [] }),
    ];
    global.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const r = responses.shift();
      if (!r) throw new Error('unexpected extra fetch');
      return r;
    }) as unknown as typeof fetch;

    await catchr.listPlatforms();

    expect(calls).toHaveLength(3);

    // 1st call: initialize, no session header
    const initBody = JSON.parse(calls[0][1].body as string);
    expect(initBody.method).toBe('initialize');
    expect(initBody.params.protocolVersion).toBe('2025-06-18');
    expect((calls[0][1].headers as Record<string, string>)['Mcp-Session-Id']).toBeUndefined();

    // 2nd call: notifications/initialized, WITH session header
    const notifBody = JSON.parse(calls[1][1].body as string);
    expect(notifBody.method).toBe('notifications/initialized');
    expect((calls[1][1].headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-xyz');

    // 3rd call: the actual tool call, WITH session header
    const toolBody = JSON.parse(calls[2][1].body as string);
    expect(toolBody.method).toBe('tools/call');
    expect((calls[2][1].headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-xyz');

    // Session cached for next call
    expect(catchr.__testing.getSessionId()).toBe('sess-xyz');
  });

  it('reuses the cached session on subsequent tool calls (no re-handshake)', async () => {
    const responses: Response[] = [
      mockInitResp('sess-1'),
      mockEmptyOk(),
      mockMcpJsonResponse({ platforms: [] }),
      mockMcpJsonResponse({ count: 0, sources: [] }),
    ];
    const fetchSpy = vi.fn(async () => responses.shift() ?? (() => { throw new Error('exhausted'); })());
    global.fetch = fetchSpy as unknown as typeof fetch;

    await catchr.listPlatforms();
    await catchr.listSources();

    expect(fetchSpy).toHaveBeenCalledTimes(4); // init + notified + 2 tool calls
  });

  it('re-initializes once on a session-expired error and retries the tool call', async () => {
    const responses: Response[] = [
      mockInitResp('sess-old'),
      mockEmptyOk(),
      mockSessionGoneResp(),          // first tool call rejected — session expired
      mockInitResp('sess-new'),
      mockEmptyOk(),
      mockMcpJsonResponse({ platforms: [{ id: 'google-ads', name: 'Google', connected: true }] }),
    ];
    const calls: RequestInit[] = [];
    global.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      const r = responses.shift();
      if (!r) throw new Error('unexpected fetch');
      return r;
    }) as unknown as typeof fetch;

    const result = await catchr.listPlatforms();
    expect(result.platforms[0].id).toBe('google-ads');
    // 6 calls total: init, notified, tool(fail), init, notified, tool(retry)
    expect(calls).toHaveLength(6);
    expect(catchr.__testing.getSessionId()).toBe('sess-new');
  });

  it('throws if initialize returns no Mcp-Session-Id header', async () => {
    const badInit = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }), // no mcp-session-id
      json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      text: async () => '{}',
    } as unknown as Response;
    global.fetch = (async () => badInit) as unknown as typeof fetch;

    await expect(catchr.listPlatforms()).rejects.toThrow(/Mcp-Session-Id/);
  });
});

describe('Catchr field map', () => {
  it('exposes confirmed field IDs for Google Ads', () => {
    const map = fieldMapFor('google-ads');
    expect(map).not.toBeNull();
    expect(map!.spend).toBe('Cost');
    expect(map!.campaignName).toBe('CampaignName');
    expect(map!.date).toBe('Date');
  });

  it('exposes confirmed field IDs for Facebook Ads', () => {
    const map = fieldMapFor('facebook-ads');
    expect(map).not.toBeNull();
    expect(map!.spend).toBe('spend');
    expect(map!.date).toBe('date_start');
  });

  it('returns null for unknown platforms rather than guessing', () => {
    expect(fieldMapFor('linkedin-ads')).toBeNull();
  });

  it('covers all 5 connected platforms', () => {
    expect(Object.keys(FIELD_MAP)).toEqual(
      expect.arrayContaining(['google-ads', 'facebook-ads', 'bing-ads', 'tik-tok', 'taboola']),
    );
  });

  it('uses Daily (not TimePeriod) for Bing date — TimePeriod fails Summary aggregation', () => {
    const map = fieldMapFor('bing-ads');
    expect(map).not.toBeNull();
    expect(map!.date).not.toBe('TimePeriod');
    expect(map!.date).toBe('Daily');
  });

  it('has a non-null field map for TikTok with valid platform-native field IDs', () => {
    const map = fieldMapFor('tik-tok');
    expect(map).not.toBeNull();
    expect(map!.spend).toBe('spend');
    expect(map!.campaignId).toBe('campaign/campaign_id');
    expect(map!.campaignName).toBe('campaign/campaign_name');
    expect(map!.accountName).toBe('advertiser/name');
    expect(map!.accountCurrency).toBe('advertiser/currency');
    expect(map!.date).toBe('_NORMALIZED_DATE_FIELD_YEAR_MONTH_DAY');
  });
});
