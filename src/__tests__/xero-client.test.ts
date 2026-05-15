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

describe('Xero — getBankBalances (statement balance via Finance API)', () => {
  beforeEach(() => {
    process.env.XERO_CLIENT_ID = 'id';
    process.env.XERO_CLIENT_SECRET = 'secret';
    xero.__testing.resetCache();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    xero.__testing.resetCache();
  });

  it('returns the statement balance from /CashValidation, not the GL closing balance', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/connect/token')) {
        return mockOk({ access_token: 'tok', expires_in: 1800, token_type: 'Bearer' });
      }
      if (u.endsWith('/connections')) {
        return mockOk([{ id: 'c-1', tenantId: 'tenant-abc', tenantName: 'CMS' }]);
      }
      if (u.includes('/api.xro/2.0/Accounts')) {
        return mockOk({
          Accounts: [
            { AccountID: 'acc-main', Name: 'Main', Code: '090', CurrencyCode: 'GBP', Type: 'BANK', Status: 'ACTIVE' },
            { AccountID: 'acc-savings', Name: 'Savings', Code: '091', CurrencyCode: 'GBP', Type: 'BANK', Status: 'ACTIVE' },
          ],
        });
      }
      if (u.includes('/finance.xro/1.0/CashValidation')) {
        return mockOk([
          {
            accountId: 'acc-main',
            statementBalance: { value: 52446.21, type: 'DEBIT' },
            statementBalanceDate: '2026-05-07',
            bankStatement: { statementLines: { unreconciledLines: 14 } },
          },
          {
            accountId: 'acc-savings',
            statementBalance: { value: 10000, type: 'DEBIT' },
            statementBalanceDate: '2026-05-07',
            bankStatement: { statementLines: { unreconciledLines: 0 } },
          },
        ]);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const accounts = await xero.getBankBalances();

    expect(calls.some((u) => u.includes('/finance.xro/1.0/CashValidation'))).toBe(true);
    expect(calls.some((u) => u.includes('/Reports/BankSummary'))).toBe(false);

    const main = accounts.find((a) => a.accountId === 'acc-main')!;
    expect(main.balance).toBe('52446.21');
    expect(main.balanceDate).toBe('2026-05-07');
    expect(main.unreconciledLines).toBe(14);
    expect(main.currency).toBe('GBP');
  });

  it('negates the value when CashValidation reports an overdrawn (CREDIT) balance', async () => {
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/connect/token')) return mockOk({ access_token: 'tok', expires_in: 1800 });
      if (u.endsWith('/connections')) return mockOk([{ id: 'c-1', tenantId: 't', tenantName: 'x' }]);
      if (u.includes('/api.xro/2.0/Accounts')) {
        return mockOk({ Accounts: [{ AccountID: 'acc-od', Name: 'Overdraft', CurrencyCode: 'GBP', Type: 'BANK', Status: 'ACTIVE' }] });
      }
      if (u.includes('/CashValidation')) {
        return mockOk([{ accountId: 'acc-od', statementBalance: { value: 350.5, type: 'CREDIT' }, statementBalanceDate: '2026-05-07' }]);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const [acc] = await xero.getBankBalances();
    expect(acc.balance).toBe('-350.50');
  });

  it('falls back to zero balances (not a throw) when Finance API is not enabled (403)', async () => {
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/connect/token')) return mockOk({ access_token: 'tok', expires_in: 1800 });
      if (u.endsWith('/connections')) return mockOk([{ id: 'c-1', tenantId: 't', tenantName: 'x' }]);
      if (u.includes('/api.xro/2.0/Accounts')) {
        return mockOk({ Accounts: [{ AccountID: 'acc-1', Name: 'A', CurrencyCode: 'GBP', Type: 'BANK', Status: 'ACTIVE' }] });
      }
      if (u.includes('/CashValidation')) {
        return mockErr(403, { Type: 'NoPermission', Detail: 'Finance API scope missing' });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const accounts = await xero.getBankBalances();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe('0');
    expect(accounts[0].balanceDate).toBeNull();
    expect(accounts[0].unreconciledLines).toBeNull();
  });

  it('requests only the accounting scopes the Custom Connection is entitled to', async () => {
    // finance.statements.read is intentionally NOT requested here — see the
    // SCOPES comment in xero-client.ts. Requesting an unentitled scope fails
    // the entire token exchange with invalid_scope; the bank-balance feature
    // falls back to /Accounts.Balance when CashValidation isn't available.
    let bodyOnTokenCall = '';
    global.fetch = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.includes('/connect/token')) {
        bodyOnTokenCall = String(init.body ?? '');
        return mockOk({ access_token: 'tok', expires_in: 1800 });
      }
      return mockOk([{ id: 'c-1', tenantId: 't', tenantName: 'x' }]);
    }) as unknown as typeof fetch;

    await xero.getValidToken();
    expect(bodyOnTokenCall).toContain('accounting.transactions');
    expect(bodyOnTokenCall).toContain('accounting.contacts');
    expect(bodyOnTokenCall).toContain('accounting.reports.read');
    expect(bodyOnTokenCall).toContain('accounting.settings.read');
    expect(bodyOnTokenCall).not.toContain('finance.statements.read');
  });
});
