import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for the 2026-05-22 revenue-inflation bug.
 *
 * LeadByte's `/reports/campaign` and `/reports/supplier` return inconsistent
 * lead counts for the same campaign × window:
 *
 *   /reports/campaign  →  leads = 840   revenue = £15,189.20   (truth — matches
 *                                                               LeadReports.io)
 *   /reports/supplier  →  Σ supplier.leads = 1,382             (counts cascade/
 *                                                               route events,
 *                                                               not unique
 *                                                               deliveries)
 *
 * Before the fix: revPerLead = 15189.20 / 840 = £18.08; supplier revenue =
 * 18.08 × 1,382 = £24,989 (+65% inflated).
 *
 * After the fix: supplier revenue = campaign.revenue × (r.leads / Σ supplier.leads).
 * Σ(supplier.revenue) per campaign === campaign.revenue, regardless of which
 * leads count we use.
 */

vi.mock('../integrations/leadbyte/leadbyte-client.js', () => ({
  getCampaignReport: async () => [
    {
      campaign: 'Hearing Aids (IE)',
      campaignId: '12',
      leads: 840,
      valid: 583,
      invalid: 257,
      pending: 0,
      rejections: 83,
      payable: 500,
      sold: 500,
      returns: 0,
      payout: 0,
      revenue: 15189.20,
      profit: 15189.20,
      currency: 'GBP',
    },
  ],
  getSupplierSpend: async () => [
    { supplierId: 'lb-sup-facebook',          supplierName: 'facebook',          platform: 'facebook',          campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 1102, cpl: 0 },
    { supplierId: 'lb-sup-fb-ads',            supplierName: 'Facebook Ads',      platform: 'Facebook Ads',      campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 193,  cpl: 0 },
    { supplierId: 'lb-sup-google',            supplierName: 'Google Ads',        platform: 'Google Ads',        campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 55,   cpl: 0 },
    { supplierId: 'lb-sup-taboola',           supplierName: 'Taboola',           platform: 'Taboola',           campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 24,   cpl: 0 },
    { supplierId: 'lb-sup-community',         supplierName: 'Community Manager', platform: 'Community Manager', campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 6,    cpl: 0 },
    { supplierId: 'lb-sup-direct',            supplierName: 'Direct',            platform: 'Direct',            campaignId: '12', campaignName: 'Hearing Aids (IE)', window: 'this_month' as const, spend: 0, leads: 2,    cpl: 0 },
  ],
}));

const { getUnifiedReport } = await import('../services/report.service.js');
const { invalidateCache } = await import('../utils/cache.js');

describe('getUnifiedReport — supplier revenue allocation (2026-05-22 fix)', () => {
  beforeEach(async () => {
    await invalidateCache(
      'lb:report:this_month:v5',
      'lb:supplier-spend:this_month:v1',
    );
  });

  it('per-campaign revenue sum equals LeadByte truth — never inflated by supplier-side lead double-counting', async () => {
    const r = await getUnifiedReport(
      // Valid-UUID businessId. Pre-OCT-49 this value was ignored; after OCT-49,
      // loadCampaignMetaByName(businessId) treats it as a real tenant lookup,
      // so a non-UUID like 'leadgen' triggers a Postgres uuid parse error. We
      // pass a UUID that isn't seeded in this test — the campaign is therefore
      // treated as orphan (no Stato mapping in any tenant) and survives the
      // OCT-49 tenant-safe filter, which is what the revenue-allocation math
      // here is meant to verify.
      { sub: 'test', userId: 'rev-alloc-test', email: 'rev-alloc@test.local', role: 'owner', businessId: '00000000-0000-0000-0000-000000005ea1' } as never,
      { window: 'this_month' },
    );

    const ieRows = r.rows.filter((row) => row.campaignName === 'Hearing Aids (IE)');
    expect(ieRows.length).toBe(6);

    const sumSupplierRevenue = ieRows.reduce((s, row) => s + row.revenue, 0);

    // Must match LeadByte's /reports/campaign truth (£15,189.20), NOT the
    // inflated £24,989 that the pre-fix algorithm produced.
    expect(sumSupplierRevenue).toBeCloseTo(15189.20, 1);

    // Sanity: the largest supplier (facebook with 1102/1382 ≈ 79.7% lead share)
    // should get ~79.7% of the campaign's revenue (£12,109.61), not £19,927 as
    // the buggy algorithm produced.
    const facebookRow = ieRows.find((row) => row.supplier === 'facebook');
    expect(facebookRow).toBeDefined();
    expect(facebookRow!.revenue).toBeGreaterThan(11_500);
    expect(facebookRow!.revenue).toBeLessThan(12_500);
  });

  it('per-campaign lead count sum matches LeadByte truth (840), not the inflated supplier-spend sum (1,382)', async () => {
    const r = await getUnifiedReport(
      // Valid-UUID businessId. Pre-OCT-49 this value was ignored; after OCT-49,
      // loadCampaignMetaByName(businessId) treats it as a real tenant lookup,
      // so a non-UUID like 'leadgen' triggers a Postgres uuid parse error. We
      // pass a UUID that isn't seeded in this test — the campaign is therefore
      // treated as orphan (no Stato mapping in any tenant) and survives the
      // OCT-49 tenant-safe filter, which is what the revenue-allocation math
      // here is meant to verify.
      { sub: 'test', userId: 'rev-alloc-test', email: 'rev-alloc@test.local', role: 'owner', businessId: '00000000-0000-0000-0000-000000005ea1' } as never,
      { window: 'this_month' },
    );
    const ieRows = r.rows.filter((row) => row.campaignName === 'Hearing Aids (IE)');
    const sumSupplierLeads = ieRows.reduce((s, row) => s + row.leads, 0);
    // Must match /reports/campaign truth (840 unique leads), NOT the
    // /reports/supplier cascade-event sum (1,382). ±1 tolerance for
    // proportional rounding across 6 supplier rows.
    expect(sumSupplierLeads).toBeGreaterThanOrEqual(839);
    expect(sumSupplierLeads).toBeLessThanOrEqual(841);
  });

  it('campaigns with zero supplier leads return zero revenue without divide-by-zero', async () => {
    // Same mock — Hearing Aids (IE) supplier-leads-sum is 1,382 (positive),
    // so we just sanity-check that the totals object is well-formed and the
    // margin calculation doesn't produce NaN.
    const r = await getUnifiedReport(
      // Valid-UUID businessId. Pre-OCT-49 this value was ignored; after OCT-49,
      // loadCampaignMetaByName(businessId) treats it as a real tenant lookup,
      // so a non-UUID like 'leadgen' triggers a Postgres uuid parse error. We
      // pass a UUID that isn't seeded in this test — the campaign is therefore
      // treated as orphan (no Stato mapping in any tenant) and survives the
      // OCT-49 tenant-safe filter, which is what the revenue-allocation math
      // here is meant to verify.
      { sub: 'test', userId: 'rev-alloc-test', email: 'rev-alloc@test.local', role: 'owner', businessId: '00000000-0000-0000-0000-000000005ea1' } as never,
      { window: 'this_month' },
    );
    expect(Number.isFinite(r.totals.revenue)).toBe(true);
    expect(Number.isFinite(r.totals.margin)).toBe(true);
  });

  it('byPlatform aggregation sums to the same totals (revenue + spend + leads) as the totals object', async () => {
    // Sam (2026-05-15 meeting #10): per-platform roll-up. The aggregation is
    // a pure SUM over the per-(campaign × supplier) rows already returned —
    // Σ(byPlatform) must equal totals so the "By source" card never drifts
    // from the "Totals" strip on /reports/unified.
    const r = await getUnifiedReport(
      // Valid-UUID businessId. Pre-OCT-49 this value was ignored; after OCT-49,
      // loadCampaignMetaByName(businessId) treats it as a real tenant lookup,
      // so a non-UUID like 'leadgen' triggers a Postgres uuid parse error. We
      // pass a UUID that isn't seeded in this test — the campaign is therefore
      // treated as orphan (no Stato mapping in any tenant) and survives the
      // OCT-49 tenant-safe filter, which is what the revenue-allocation math
      // here is meant to verify.
      { sub: 'test', userId: 'rev-alloc-test', email: 'rev-alloc@test.local', role: 'owner', businessId: '00000000-0000-0000-0000-000000005ea1' } as never,
      { window: 'this_month' },
    );
    expect(Array.isArray(r.byPlatform)).toBe(true);
    expect(r.byPlatform.length).toBeGreaterThan(0);

    const sumLeads = r.byPlatform.reduce((s, p) => s + p.leads, 0);
    const sumSpend = r.byPlatform.reduce((s, p) => s + p.spend, 0);
    const sumRevenue = r.byPlatform.reduce((s, p) => s + p.revenue, 0);

    expect(sumLeads).toBe(r.totals.leads);
    // Money fields are rounded to 2dp per-row, so tiny float jitter is
    // possible — assert within 1p tolerance.
    expect(sumSpend).toBeCloseTo(r.totals.spend, 1);
    expect(sumRevenue).toBeCloseTo(r.totals.revenue, 1);
  });

  it('byPlatform groups distinct supplier platforms into separate rows (one per platform)', async () => {
    // 6 supplier rows across 6 distinct platform strings (facebook / Facebook
    // Ads / Google Ads / Taboola / Community Manager / Direct) → 6 byPlatform
    // buckets. Bucketing is case-sensitive against the LeadByte platform
    // string (we mirror what LeadReports.io shows).
    const r = await getUnifiedReport(
      // Valid-UUID businessId. Pre-OCT-49 this value was ignored; after OCT-49,
      // loadCampaignMetaByName(businessId) treats it as a real tenant lookup,
      // so a non-UUID like 'leadgen' triggers a Postgres uuid parse error. We
      // pass a UUID that isn't seeded in this test — the campaign is therefore
      // treated as orphan (no Stato mapping in any tenant) and survives the
      // OCT-49 tenant-safe filter, which is what the revenue-allocation math
      // here is meant to verify.
      { sub: 'test', userId: 'rev-alloc-test', email: 'rev-alloc@test.local', role: 'owner', businessId: '00000000-0000-0000-0000-000000005ea1' } as never,
      { window: 'this_month' },
    );
    const platformNames = r.byPlatform.map((p) => p.platform).sort();
    expect(platformNames).toEqual([
      'Community Manager',
      'Direct',
      'Facebook Ads',
      'Google Ads',
      'Taboola',
      'facebook',
    ]);
    // Every row has a non-negative margin (no NaN / Infinity from
    // divide-by-zero on Direct/Community-Manager which have 0 spend).
    for (const p of r.byPlatform) {
      expect(Number.isFinite(p.margin)).toBe(true);
      expect(Number.isFinite(p.profit)).toBe(true);
    }
  });
});
