import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Catchr integration BEFORE importing the service so the service
// picks up our stubs instead of hitting the real MCP endpoint.
vi.mock('../integrations/catchr/index.js', async () => {
  const actual = await vi.importActual<typeof import('../integrations/catchr/index.js')>(
    '../integrations/catchr/index.js',
  );
  return {
    ...actual,
    isCatchrConfigured: () => true,
    listSources: vi.fn(),
    runApiRequest: vi.fn(),
  };
});

import { logger } from '../utils/logger.js';
import * as catchr from '../integrations/catchr/index.js';
import { syncAll, __resetDeadAccountCacheForTests } from '../services/ad-spend.service.js';

/**
 * A fake Drizzle-style query builder that just records the inserts so the
 * test can assert behaviour without touching Postgres. The shape we need is
 * `db.insert(table).values(rows).onConflictDoUpdate({...})` — return `this`
 * from each method and resolve at the terminal step.
 */
function makeFakeDb() {
  const inserts: Array<Record<string, unknown>[]> = [];
  const builder = {
    insert(_table: unknown) { return this; },
    values(rows: Record<string, unknown>[]) {
      inserts.push(rows);
      return this;
    },
    onConflictDoUpdate(_cfg: unknown) { return Promise.resolve(undefined); },
  };
  return { db: builder as unknown as Parameters<typeof syncAll>[0] extends { db?: infer T } | undefined ? T : never, inserts };
}

describe('ad-spend syncAll — empty campaign_id diagnostic logging', () => {
  beforeEach(() => {
    __resetDeadAccountCacheForTests();
    vi.mocked(catchr.listSources).mockReset();
    vi.mocked(catchr.runApiRequest).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs platform + raw row keys + configuredCampaignField when rows arrive with empty campaign_id', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    vi.mocked(catchr.listSources).mockResolvedValue({
      count: 1,
      sources: [{
        id: 42,
        name: 'TikTok auth',
        platform: 'tik-tok',
        platform_name: 'TikTok',
        type: 'ads',
        state: 'SUCCESS',
        last_sync: null,
        total_available_data_source: 1,
        total_activated_data_source: 1,
        available_accounts: [{
          id: 'acct-xyz',
          name: 'TikTok Acct XYZ',
          is_parent_account: false,
          authorization_id: 42,
          authorization_name: 'TikTok auth',
          options: null,
        }],
      }],
    } as never);

    // Return one row that LOOKS valid (has a date + spend) but is MISSING
    // the configured campaignId field (`campaign/campaign_id`). It carries
    // a differently-named campaign key so the operator can spot the
    // mismatch in the log output.
    vi.mocked(catchr.runApiRequest).mockResolvedValue({
      count: 1,
      rows: [{
        _NORMALIZED_DATE_FIELD_YEAR_MONTH_DAY: '20260513',
        'advertiser/name': 'Some Advertiser',
        'advertiser/currency': 'GBP',
        // Wrong key — not campaign/campaign_id — so the row is dropped.
        campaign_id_wrong_name: '99999',
        'campaign/campaign_name': 'Spring Promo',
        spend: '12.34',
      }],
    });

    const fake = makeFakeDb();
    await syncAll({ db: fake.db });

    const warnCalls = warnSpy.mock.calls;
    const skipCall = warnCalls.find((args) => {
      const last = args[args.length - 1];
      return typeof last === 'string' && last.includes('empty campaign_id');
    });
    expect(skipCall).toBeDefined();
    const ctx = skipCall![0] as Record<string, unknown>;
    expect(ctx.platform).toBe('tik-tok');
    expect(ctx.accountId).toBe('acct-xyz');
    expect(ctx.skippedEmptyCampaign).toBe(1);
    expect(ctx.configuredCampaignField).toBe('campaign/campaign_id');
    expect(Array.isArray(ctx.sampleRowKeys)).toBe(true);
    // Crucial diagnostic: the operator MUST see the actual key the row uses
    // so they can fix the mapping without attaching a debugger to prod.
    expect(ctx.sampleRowKeys).toContain('campaign_id_wrong_name');
    expect(ctx.sampleRowKeys).toContain('_NORMALIZED_DATE_FIELD_YEAR_MONTH_DAY');

    // And no row was written because the only row was dropped.
    expect(fake.inserts).toEqual([]);
  });

  it('does NOT emit the empty-campaign warning when rows are well-formed', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    vi.mocked(catchr.listSources).mockResolvedValue({
      count: 1,
      sources: [{
        id: 43,
        name: 'Google auth',
        platform: 'google-ads',
        platform_name: 'Google Ads',
        type: 'ads',
        state: 'SUCCESS',
        last_sync: null,
        total_available_data_source: 1,
        total_activated_data_source: 1,
        available_accounts: [{
          id: 'gads-acct',
          name: 'GAds Acct',
          is_parent_account: false,
          authorization_id: 43,
          authorization_name: 'Google auth',
          options: null,
        }],
      }],
    } as never);

    vi.mocked(catchr.runApiRequest).mockResolvedValue({
      count: 1,
      rows: [{
        Date: '2026-05-13',
        AccountDescriptiveName: 'GAds Acct',
        AccountCurrencyCode: 'GBP',
        CampaignId: 'camp-123',
        CampaignName: 'Brand UK',
        Cost: '45.67',
      }],
    });

    const fake = makeFakeDb();
    const result = await syncAll({ db: fake.db });

    const skipCall = warnSpy.mock.calls.find((args) => {
      const last = args[args.length - 1];
      return typeof last === 'string' && last.includes('empty campaign_id');
    });
    expect(skipCall).toBeUndefined();
    expect(result.rowsWritten).toBe(1);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0][0]).toMatchObject({
      platform: 'google-ads',
      campaignId: 'camp-123',
      campaignName: 'Brand UK',
      spend: '45.67',
    });
  });
});
