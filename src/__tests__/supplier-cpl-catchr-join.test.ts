import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { adSpend } from '../db/schema/ad-spend.js';

// Regression test: the supplier-performance report MUST join Catchr ad_spend
// for ad-platform suppliers (Facebook, Google Ads, Taboola, etc.) so the
// supplier CPL chart no longer shows £0 spend across the board. Before this
// fix, the endpoint used LeadByte's `payout` field which is genuinely £0 for
// every ad-platform supplier (LeadByte doesn't know what we spent in FB).

const isoOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

// Mock leadbyte.getSupplierSpend to return a controlled fixture so the test
// isn't dependent on what LeadByte returns at runtime (rate-limit risk).
vi.mock('../integrations/leadbyte/leadbyte-client.js', () => ({
  getSupplierSpend: async () => [
    {
      supplierId: 'lb-sup-facebook',
      supplierName: 'facebook',
      platform: 'facebook',
      campaignId: 'camp-1',
      campaignName: 'Solar UK',
      window: 'this_month',
      spend: 0,
      leads: 1000,
      cpl: 0,
    },
    {
      supplierId: 'lb-sup-Facebook Ads',
      supplierName: 'Facebook Ads',
      platform: 'Facebook Ads',
      campaignId: 'camp-2',
      campaignName: 'Insulation UK',
      window: 'this_month',
      spend: 0,
      leads: 200,
      cpl: 0,
    },
    {
      supplierId: 'lb-sup-Google Ads',
      supplierName: 'Google Ads',
      platform: 'Google Ads',
      campaignId: 'camp-3',
      campaignName: 'Hearing Aids',
      window: 'this_month',
      spend: 0,
      leads: 500,
      cpl: 0,
    },
    {
      supplierId: 'lb-sup-direct-1',
      supplierName: 'Direct',
      platform: 'Direct',
      campaignId: 'camp-4',
      campaignName: 'Will Writing',
      window: 'this_month',
      spend: 0,
      leads: 50,
      cpl: 0,
    },
  ],
}));

// Lazy-import the service AFTER the mock is registered so it picks up the
// mocked leadbyte client.
const { getSupplierPerformance } = await import('../services/report.service.js');

describe('Supplier performance — Catchr ad_spend join', () => {
  beforeAll(async () => {
    // Seed ad_spend rows for the same window the supplier query covers
    // (this_month). Facebook £2,400 should split across "facebook" + "Facebook
    // Ads" suppliers proportionally to their 1000 vs 200 lead share (5:1).
    await db
      .insert(adSpend)
      .values([
        {
          platform: 'facebook',
          authorizationId: 999201,
          accountId: 'cpl-test-acc-fb',
          date: isoOffset(2),
          spend: '2400.00',
          currency: 'GBP',
        },
        {
          platform: 'google-ads',
          authorizationId: 999201,
          accountId: 'cpl-test-acc-g',
          date: isoOffset(3),
          spend: '1500.00',
          currency: 'GBP',
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(adSpend).where(inArray(adSpend.accountId, ['cpl-test-acc-fb', 'cpl-test-acc-g']));
  });

  it('Facebook + Google Ads suppliers get totalSpend from Catchr, not LeadByte', async () => {
    const rows = await getSupplierPerformance(
      { sub: 'test', role: 'owner', businessId: 'leadgen' } as never,
      'this_month',
    );

    const fb = rows.find((r) => r.supplierName === 'facebook');
    const fbAds = rows.find((r) => r.supplierName === 'Facebook Ads');
    const gAds = rows.find((r) => r.supplierName === 'Google Ads');

    expect(fb).toBeDefined();
    expect(fbAds).toBeDefined();
    expect(gAds).toBeDefined();

    // The key assertion: ad-platform suppliers now have NON-ZERO totalSpend
    // (vs the £0 they had before, because the LeadByte payout field is
    // genuinely empty for ad networks). Exact figures depend on whatever
    // ad_spend rows are in the DB at test time — what matters is the
    // Catchr join is firing.
    expect(fb!.totalSpend).toBeGreaterThan(0);
    expect(fbAds!.totalSpend).toBeGreaterThan(0);
    expect(gAds!.totalSpend).toBeGreaterThan(0);

    // CPL is also non-zero now that totalSpend is populated.
    expect(fb!.cpl).toBeGreaterThan(0);
    expect(gAds!.cpl).toBeGreaterThan(0);
  });

  it('"Direct" supplier (no Catchr platform mapping) stays at £0 spend', async () => {
    const rows = await getSupplierPerformance(
      { sub: 'test', role: 'owner', businessId: 'leadgen' } as never,
      'this_month',
    );
    const direct = rows.find((r) => r.supplierName === 'Direct');
    expect(direct).toBeDefined();
    expect(direct!.totalSpend).toBe(0);
    expect(direct!.cpl).toBe(0);
  });
});
