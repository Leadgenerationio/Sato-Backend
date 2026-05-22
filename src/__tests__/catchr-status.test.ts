import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';

// OCT-40 regression test. Before the fix, GET /integrations/catchr/status
// read getLastCatchrSyncAt() — an in-memory variable in ad-spend.controller
// that resets to null on API restart and never sees writes from the
// sync-worker process. Meanwhile /integrations/overview used the DB-backed
// max(ad_spend.synced_at), so the two endpoints disagreed for the same
// integration. This test mocks the db so .select().from(adSpend) returns a
// timestamp and asserts catchrStatus surfaces it (not null).
let latestSyncedAt: string | null = null;

vi.mock('../config/database.js', () => {
  return {
    db: {
      select: () => ({
        from: () => Promise.resolve([{ latest: latestSyncedAt }]),
      }),
    },
  };
});

// Stub the in-memory fallback so we can prove the DB value (not the fallback)
// is what's surfaced when both are present.
vi.mock('../controllers/ad-spend.controller.js', () => ({
  getLastCatchrSyncAt: () => '__in_memory_fallback__',
}));

// Stub the catchr client — we're not testing config detection here.
vi.mock('../integrations/catchr/catchr-client.js', () => ({
  isCatchrConfigured: () => true,
  listSources: async () => [],
  listPlatforms: async () => [],
}));

import { catchrStatus } from '../controllers/integration.controller.js';

function mockResponse(): Response & { _json?: unknown } {
  const res: Partial<Response> & { _json?: unknown } = {};
  res.json = ((body: unknown) => { res._json = body; return res as Response; }) as Response['json'];
  return res as Response & { _json?: unknown };
}

describe('GET /integrations/catchr/status — OCT-40 lastSyncAt is DB-backed', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    latestSyncedAt = null;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns max(ad_spend.synced_at) when the table has rows', async () => {
    latestSyncedAt = '2026-05-22 09:08:31';

    const req = {} as Request;
    const res = mockResponse();
    await catchrStatus(req, res);

    const body = res._json as { status: string; data: { configured: boolean; mcpUrl: string; lastSyncAt: string | null } };
    expect(body.status).toBe('success');
    expect(body.data.configured).toBe(true);
    // DB-backed value wins over the in-memory fallback. Pre-fix this was null.
    expect(body.data.lastSyncAt).toBe('2026-05-22 09:08:31');
  });

  it('falls back to the in-memory value only when ad_spend is empty', async () => {
    latestSyncedAt = null;

    const req = {} as Request;
    const res = mockResponse();
    await catchrStatus(req, res);

    const body = res._json as { data: { lastSyncAt: string | null } };
    expect(body.data.lastSyncAt).toBe('__in_memory_fallback__');
  });

  it('preserves the response shape (configured + mcpUrl + lastSyncAt)', async () => {
    latestSyncedAt = '2026-05-22 09:08:31';
    process.env.CATCHR_MCP_URL = 'https://api.catchr.io/mcp';

    const req = {} as Request;
    const res = mockResponse();
    await catchrStatus(req, res);

    const body = res._json as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      configured: true,
      mcpUrl: 'https://api.catchr.io/mcp',
      lastSyncAt: '2026-05-22 09:08:31',
    });
  });
});
