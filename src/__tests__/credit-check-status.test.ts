import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';

// Mock the database module BEFORE importing the controller so the controller
// picks up our chainable stub instead of the real (null) drizzle handle. Each
// test below replaces `lastCount` / `last30dCount` to simulate different
// credit_checks row counts without needing a live Postgres.
let allTimeCount = 0;
let last30dCount = 0;
let queryCallCount = 0;

vi.mock('../config/database.js', () => {
  // db.select().from(table) → all-time count
  // db.select().from(table).where(...) → last-30-days count
  return {
    db: {
      select: () => ({
        from: () => {
          queryCallCount++;
          // Return a thenable that also exposes `.where(...)` for the 30d query.
          // The all-time query awaits the from() result directly; the 30d query
          // chains .where(...) before awaiting.
          const allRows = [{ count: allTimeCount }];
          const last30Rows = [{ count: last30dCount }];
          const promise = Promise.resolve(allRows);
          // Attach .where so the chain `.from(t).where(...)` works and returns
          // the 30d-window result.
          (promise as unknown as { where: (..._a: unknown[]) => Promise<unknown> }).where =
            () => Promise.resolve(last30Rows);
          return promise;
        },
      }),
    },
  };
});

// Stub out the credit-check provider router so getActiveProvider doesn't need
// any real env wiring — we're not testing provider selection here.
vi.mock('../integrations/credit-check/index.js', () => ({
  getActiveProvider: () => 'endole',
}));

import { creditCheckStatus } from '../controllers/integration.controller.js';

function mockResponse(): Response & { _json?: unknown; _status?: number } {
  const res: Partial<Response> & { _json?: unknown; _status?: number } = {};
  res.json = ((body: unknown) => { res._json = body; return res as Response; }) as Response['json'];
  res.status = ((code: number) => { res._status = code; return res as Response; }) as Response['status'];
  return res as Response & { _json?: unknown; _status?: number };
}

describe('GET /integrations/credit-check/status — checksRun wiring', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    allTimeCount = 0;
    last30dCount = 0;
    queryCallCount = 0;
    delete process.env.ENDOLE_SANDBOX;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the all-time count from credit_checks', async () => {
    allTimeCount = 3;
    last30dCount = 2;

    const req = {} as Request;
    const res = mockResponse();
    await creditCheckStatus(req, res);

    expect(queryCallCount).toBeGreaterThanOrEqual(2);
    const body = res._json as { status: string; data: { checksRun: number; checksRunLast30d: number } };
    expect(body.status).toBe('success');
    expect(body.data.checksRun).toBe(3);
    expect(body.data.checksRunLast30d).toBe(2);
  });

  it('returns 0 when there are no credit_checks rows', async () => {
    allTimeCount = 0;
    last30dCount = 0;

    const req = {} as Request;
    const res = mockResponse();
    await creditCheckStatus(req, res);

    const body = res._json as { data: { checksRun: number; checksRunLast30d: number } };
    expect(body.data.checksRun).toBe(0);
    expect(body.data.checksRunLast30d).toBe(0);
  });

  it('still returns provider + configured + sandbox alongside the count', async () => {
    allTimeCount = 42;
    last30dCount = 5;
    process.env.ENDOLE_SANDBOX = 'true';

    const req = {} as Request;
    const res = mockResponse();
    await creditCheckStatus(req, res);

    const body = res._json as { data: { provider: string; configured: boolean; sandbox: boolean; checksRun: number } };
    expect(body.data.provider).toBe('endole');
    expect(body.data.configured).toBe(true);
    expect(body.data.sandbox).toBe(true);
    expect(body.data.checksRun).toBe(42);
  });
});
