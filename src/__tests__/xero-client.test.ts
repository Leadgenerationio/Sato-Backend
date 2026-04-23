import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as xero from '../integrations/xero/xero-client.js';

const ORIGINAL_FETCH = global.fetch;

function mockOk(payload: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function mockErr(status: number, body: unknown = {}): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Xero Custom Connection — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    xero.__testing.resetCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    xero.__testing.resetCache();
  });

  it('is not configured when both env vars are missing', () => {
    expect(xero.isXeroConfigured()).toBe(false);
  });

  it('is not configured when only CLIENT_ID is set', () => {
    process.env.XERO_CLIENT_ID = 'id';
    expect(xero.isXeroConfigured()).toBe(false);
  });

  it('is configured when CLIENT_ID + CLIENT_SECRET are set', () => {
    process.env.XERO_CLIENT_ID = 'id';
    process.env.XERO_CLIENT_SECRET = 'secret';
    expect(xero.isXeroConfigured()).toBe(true);
  });
});

describe('Xero Custom Connection — token exchange (client_credentials)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.XERO_CLIENT_ID = 'B6713733601B4A00A9751F1751FB9EDE';
    process.env.XERO_CLIENT_SECRET = 'a_BnKKxas-RdTIU9QChmc2JqvUYxdY5yEIW545CZY3PUKIjc';
    xero.__testing.resetCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    xero.__testing.resetCache();
  });

  it('POSTs to identity.xero.com/connect/token with Basic auth + client_credentials grant', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/connect/token')) {
        return mockOk({ access_token: 'tok-1', expires_in: 1800, token_type: 'Bearer', scope: 'accounting.transactions' });
      }
      // /connections
      return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantType: 'ORGANISATION', tenantName: 'Clinical Marketing Solutions Ltd' }]);
    }) as unknown as typeof fetch;

    await xero.getValidToken();

    const tokenCall = calls.find((c) => c.url.includes('/connect/token'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.url).toBe('https://identity.xero.com/connect/token');
    expect(tokenCall!.init.method).toBe('POST');
    const headers = tokenCall!.init.headers as Record<string, string>;
    const expected = 'Basic ' + Buffer.from('B6713733601B4A00A9751F1751FB9EDE:a_BnKKxas-RdTIU9QChmc2JqvUYxdY5yEIW545CZY3PUKIjc').toString('base64');
    expect(headers['Authorization']).toBe(expected);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(tokenCall!.init.body)).toContain('grant_type=client_credentials');
  });

  it('fetches and returns the bound tenant ID from /connections on first auth', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/connect/token')) {
        return mockOk({ access_token: 'tok-1', expires_in: 1800, token_type: 'Bearer' });
      }
      return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantType: 'ORGANISATION', tenantName: 'Clinical Marketing Solutions Ltd' }]);
    }) as unknown as typeof fetch;

    const { accessToken, tenantId } = await xero.getValidToken();
    expect(accessToken).toBe('tok-1');
    expect(tenantId).toBe('tenant-abc');
  });

  it('caches the token and does not re-authenticate while still valid', async () => {
    let tokenCalls = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/connect/token')) {
        tokenCalls++;
        return mockOk({ access_token: 'tok-cached', expires_in: 1800, token_type: 'Bearer' });
      }
      return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantName: 'x' }]);
    }) as unknown as typeof fetch;

    await xero.getValidToken();
    await xero.getValidToken();
    await xero.getValidToken();

    expect(tokenCalls).toBe(1);
  });

  it('throws a clear error when Xero rejects credentials', async () => {
    global.fetch = vi.fn(async () =>
      mockErr(400, { error: 'invalid_client' }),
    ) as unknown as typeof fetch;

    await expect(xero.getValidToken()).rejects.toThrow(/xero auth failed/i);
  });
});

describe('Xero Custom Connection — getStatus', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    xero.__testing.resetCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    xero.__testing.resetCache();
  });

  it('returns connected=false when not configured', async () => {
    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    const status = await xero.getStatus();
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(false);
  });

  it('returns connected=true with tenant info after a successful auth', async () => {
    process.env.XERO_CLIENT_ID = 'id';
    process.env.XERO_CLIENT_SECRET = 'secret';

    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/connect/token')) {
        return mockOk({ access_token: 'tok', expires_in: 1800, token_type: 'Bearer' });
      }
      return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantName: 'Clinical Marketing Solutions Ltd' }]);
    }) as unknown as typeof fetch;

    // Warm the cache
    await xero.getValidToken();

    const status = await xero.getStatus();
    expect(status.connected).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.tenantId).toBe('tenant-abc');
    expect(status.tenantName).toBe('Clinical Marketing Solutions Ltd');
  });
});

describe('Xero Custom Connection — disconnect', () => {
  afterEach(() => {
    xero.__testing.resetCache();
    global.fetch = ORIGINAL_FETCH;
  });

  it('clears the in-memory token cache', async () => {
    process.env.XERO_CLIENT_ID = 'id';
    process.env.XERO_CLIENT_SECRET = 'secret';

    let tokenCalls = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/connect/token')) {
        tokenCalls++;
        return mockOk({ access_token: 'tok', expires_in: 1800, token_type: 'Bearer' });
      }
      return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantName: 'x' }]);
    }) as unknown as typeof fetch;

    await xero.getValidToken();
    expect(tokenCalls).toBe(1);

    xero.disconnect();
    await xero.getValidToken();
    expect(tokenCalls).toBe(2); // re-auth after disconnect
  });
});
