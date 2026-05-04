import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as endole from '../integrations/endole/endole-client.js';

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

  it('does not call fetch and returns a mock report when unconfigured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const r = await endole.runCreditCheck('12345678', 'Acme Ltd');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.companyNumber).toBe('12345678');
    expect(r.companyName).toBe('Acme Ltd');
    expect(r.creditScore).toBeGreaterThanOrEqual(40);
    expect(r.creditScore).toBeLessThanOrEqual(100);
  });
});
