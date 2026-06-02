import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as endole from '../integrations/endole/endole-client.js';
import * as notificationService from '../services/notification.service.js';
import { db } from '../config/database.js';
import { notifications } from '../db/schema/notifications.js';

const ORIGINAL_FETCH = global.fetch;

function mockEndoleOk(payload: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function mockEndoleErr(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Endole client — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.ENDOLE_APP_ID;
    delete process.env.ENDOLE_APP_KEY;
    delete process.env.ENDOLE_API_KEY;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is not configured when neither APP_ID nor APP_KEY is set', () => {
    expect(endole.isEndoleConfigured()).toBe(false);
  });

  it('is not configured when only ENDOLE_APP_ID is set', () => {
    process.env.ENDOLE_APP_ID = '23013';
    expect(endole.isEndoleConfigured()).toBe(false);
  });

  it('is not configured when only ENDOLE_APP_KEY is set', () => {
    process.env.ENDOLE_APP_KEY = 'some-key';
    expect(endole.isEndoleConfigured()).toBe(false);
  });

  it('is configured when both ENDOLE_APP_ID and ENDOLE_APP_KEY are set', () => {
    process.env.ENDOLE_APP_ID = '23013';
    process.env.ENDOLE_APP_KEY = 'some-key';
    expect(endole.isEndoleConfigured()).toBe(true);
  });
});

describe('Endole client — live API', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.ENDOLE_APP_ID = '23013';
    process.env.ENDOLE_APP_KEY = 'test-secret';
    delete process.env.ENDOLE_SANDBOX;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  it('calls GET /company/{number}/credit_checks with Basic Auth', async () => {
    const fetchSpy = vi.fn(async () =>
      mockEndoleOk({
        credit_scores: { current_year_score: 72, current_year_band: 'Low Risk' },
        ccj_cases: [],
        date_of_creation: '2018-03-15',
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    await endole.runCreditCheck('00445790', 'Test Ltd');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain('https://api.endole.co.uk/company/00445790/credit_checks');
    expect(init.method ?? 'GET').toBe('GET');
    const headers = init.headers as Record<string, string>;
    const expected = 'Basic ' + Buffer.from('23013:test-secret').toString('base64');
    expect(headers['Authorization']).toBe(expected);
  });

  it('parses credit score, registration date, and company identity', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleOk({
        credit_scores: { current_year_score: 85, current_year_band: 'Very Low Risk' },
        ccj_cases: [],
        date_of_creation: '2010-06-01',
      }),
    ) as unknown as typeof fetch;

    const r = await endole.runCreditCheck('12345678', 'Acme Ltd');

    expect(r.creditScore).toBe(85);
    expect(r.riskRating).toBe('very_low');
    expect(r.registrationDate).toBe('2010-06-01');
    expect(r.companyNumber).toBe('12345678');
    expect(r.companyName).toBe('Acme Ltd');
  });

  it('counts CCJ cases and sums their amount', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleOk({
        credit_scores: { current_year_score: 40, current_year_band: 'High Risk' },
        ccj_cases: [{ amount: 2500 }, { amount: 1500 }, { amount: 3000 }],
        date_of_creation: '2015-01-01',
      }),
    ) as unknown as typeof fetch;

    const r = await endole.runCreditCheck('00000001', 'Risky Ltd');
    expect(r.ccjCount).toBe(3);
    expect(r.ccjTotal).toBe(7000);
  });

  it('maps Endole band text to our 5-band risk rating', async () => {
    const cases: Array<[string, string]> = [
      ['Very Low Risk', 'very_low'],
      ['Low Risk', 'low'],
      ['Caution', 'moderate'],
      ['High Risk', 'high'],
      ['Very High Risk', 'very_high'],
    ];
    for (const [band, expected] of cases) {
      global.fetch = vi.fn(async () =>
        mockEndoleOk({
          credit_scores: { current_year_score: 60, current_year_band: band },
          ccj_cases: [],
          date_of_creation: '2010-01-01',
        }),
      ) as unknown as typeof fetch;
      const r = await endole.runCreditCheck('1', 'Co');
      expect(r.riskRating).toBe(expected);
    }
  });

  it('appends ?sandbox=true when ENDOLE_SANDBOX=true', async () => {
    process.env.ENDOLE_SANDBOX = 'true';
    const fetchSpy = vi.fn(async () =>
      mockEndoleOk({
        credit_scores: { current_year_score: 50, current_year_band: 'Caution' },
        ccj_cases: [],
        date_of_creation: '2020-01-01',
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    await endole.runCreditCheck('111', 'Sandbox Co');

    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('sandbox=true');
  });

  // Audit 2026-05-03: when configured, real upstream errors must surface to
  // the caller (which writes a `system_error` notification) rather than being
  // masked as a fabricated mock score. The previous "fall back to mock on
  // error" behaviour was the bug — see endole-client.ts.
  it('throws on HTTP 404 (company not found) when configured', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(404, { error: { code: '301', message: 'company-not-found' } }),
    ) as unknown as typeof fetch;

    await expect(endole.runCreditCheck('99999999', 'Missing Ltd')).rejects.toThrow(/404/);
  });

  it('throws on HTTP 429 (rate limit) when configured', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(429, { error: { code: '204', message: 'throttling-too-many' } }),
    ) as unknown as typeof fetch;

    await expect(endole.runCreditCheck('12345678', 'Busy Ltd')).rejects.toThrow(/429/);
  });

  it('throws on IP-not-whitelisted error (code 104) when configured', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(403, { error: { code: '104', message: 'whitelist-not-listed' } }),
    ) as unknown as typeof fetch;

    await expect(endole.runCreditCheck('12345678', 'Blocked Ltd')).rejects.toThrow(/403/);
  });

  // Sam Loom 13 May 500 — the manual /credit-check endpoint returned a generic
  // 500 because endole-client threw a plain Error. The real upstream response
  // was {"error_code":"102","error_type":"insufficient-credit"} (Endole balance
  // empty). We now translate that into a typed AppError so the FE can render
  // a meaningful message ("Endole balance exhausted") instead of "Internal
  // server error", and so the upstream details are preserved on the error.
  it('throws CreditProviderError with code "credit_provider_balance_exhausted" on Endole error_code 102', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(403, {
        error: 'You do not have enough credit in your balance.',
        error_code: '102',
        error_type: 'insufficient-credit',
      }),
    ) as unknown as typeof fetch;

    const err = await endole.runCreditCheck('12201105', 'Real Co').catch((e: unknown) => e);
    const e = err as Error & { statusCode?: number; code?: string; upstreamStatus?: number; upstreamCode?: string };
    expect(e).toBeInstanceOf(Error);
    expect(e.statusCode).toBe(502);
    expect(e.code).toBe('credit_provider_balance_exhausted');
    expect(e.upstreamStatus).toBe(403);
    expect(e.upstreamCode).toBe('102');
    // Existing test contract: status code is still present in the message.
    expect(e.message).toMatch(/403/);
  });

  it('throws CreditProviderError with code "credit_provider_failed" on other upstream HTTP errors', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(429, { error: { code: '204', message: 'throttling-too-many' } }),
    ) as unknown as typeof fetch;

    const err = await endole.runCreditCheck('12345678', 'Busy Ltd').catch((e: unknown) => e);
    const e = err as Error & { statusCode?: number; code?: string; upstreamStatus?: number; upstreamCode?: string };
    expect(e.statusCode).toBe(502);
    expect(e.code).toBe('credit_provider_failed');
    expect(e.upstreamStatus).toBe(429);
    expect(e.upstreamCode).toBe('204');
  });
});

describe('Endole client — unconfigured fallback', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.ENDOLE_APP_ID;
    delete process.env.ENDOLE_APP_KEY;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  // "No fabricated data" policy (audit 2026-05-03): when unconfigured the
  // client must THROW rather than return a made-up mock score. Previously
  // this asserted a mock report was returned — that was the old behaviour the
  // policy removed, so the assertion was stale. It now verifies the throw, and
  // that we never hit the network without credentials.
  it('throws "not configured" and never calls fetch when unconfigured (no fabricated scores)', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(endole.runCreditCheck('12345678', 'Acme Ltd')).rejects.toThrow(/not configured/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── Endole 102 balance-exhausted alerts ───
//
// When the upstream returns error_code "102" (Sam's Endole balance is empty),
// the client must (a) still throw the typed CreditProviderError so the UI
// renders a meaningful message, AND (b) write a notification row so the
// morning checklist + SMS alerter surface it. Without (b), credit checks fail
// silently for hours until someone notices the integrations card.
describe('Endole client — 102 balance-exhausted alert', () => {
  const originalEnv = { ...process.env };

  // Wipe any pre-existing rows with the dedupe title so each test starts
  // with a clean slate — otherwise an earlier test (or stale dev-DB row)
  // will be picked up by the in-client dedupe lookup and suppress the
  // emit we're asserting on.
  async function clearBalanceAlertRows(): Promise<void> {
    if (!db) return;
    await db
      .delete(notifications)
      .where(eq(notifications.title, endole.ENDOLE_BALANCE_EXHAUSTED_TITLE));
  }

  beforeEach(async () => {
    process.env.ENDOLE_APP_ID = '23013';
    process.env.ENDOLE_APP_KEY = 'test-secret';
    delete process.env.ENDOLE_SANDBOX;
    // Force createNotification to use the in-memory store so we're spying on
    // a plain call (not chasing inserts in Postgres). The dedupe lookup
    // inside endole-client still uses the real `db` — we wipe rows above.
    process.env.USE_DB_NOTIFICATIONS = 'false';
    await clearBalanceAlertRows();
  });
  afterEach(async () => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    await clearBalanceAlertRows();
  });

  it('inserts a system_error notification when Endole returns error_code 102', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(403, {
        error: 'You do not have enough credit in your balance.',
        error_code: '102',
        error_type: 'insufficient-credit',
      }),
    ) as unknown as typeof fetch;

    const createSpy = vi.spyOn(notificationService, 'createNotification');

    await endole.runCreditCheck('12201105', 'Real Co').catch(() => undefined);

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0];
    expect(arg.type).toBe('system_error');
    expect(arg.severity).toBe('error');
    expect(arg.title).toBe(endole.ENDOLE_BALANCE_EXHAUSTED_TITLE);
    expect(arg.title).toMatch(/balance exhausted/i);
    expect(arg.message).toMatch(/endole\.co\.uk/i);
    expect(arg.metadata).toMatchObject({ provider: 'endole', upstreamCode: '102' });
  });

  it('still throws CreditProviderError after emitting the alert', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(403, {
        error: 'You do not have enough credit in your balance.',
        error_code: '102',
        error_type: 'insufficient-credit',
      }),
    ) as unknown as typeof fetch;
    vi.spyOn(notificationService, 'createNotification').mockResolvedValue({
      id: 'ntf-test', type: 'system_error', title: 't', message: 'm',
      severity: 'error', read: false, createdAt: new Date().toISOString(),
    });

    const err = await endole.runCreditCheck('12201105', 'Real Co').catch((e: unknown) => e);
    const e = err as Error & { code?: string };
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('credit_provider_balance_exhausted');
  });

  it('does NOT emit a notification on non-102 upstream errors', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(429, { error: { code: '204', message: 'throttling-too-many' } }),
    ) as unknown as typeof fetch;

    const createSpy = vi.spyOn(notificationService, 'createNotification');

    await endole.runCreditCheck('12345678', 'Busy Ltd').catch(() => undefined);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('still throws CreditProviderError when the notification emit itself fails', async () => {
    global.fetch = vi.fn(async () =>
      mockEndoleErr(403, {
        error: 'You do not have enough credit in your balance.',
        error_code: '102',
        error_type: 'insufficient-credit',
      }),
    ) as unknown as typeof fetch;
    vi.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('DB down'));

    const err = await endole.runCreditCheck('12201105', 'Real Co').catch((e: unknown) => e);
    const e = err as Error & { code?: string };
    expect(e.code).toBe('credit_provider_balance_exhausted');
  });
});
