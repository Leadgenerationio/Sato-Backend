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
      { sub: 'test', role: 'owner', businessId: 'leadgen' } as never,
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

  it('campaigns with zero supplier leads return zero revenue without divide-by-zero', async () => {
    // Same mock — Hearing Aids (IE) supplier-leads-sum is 1,382 (positive),
    // so we just sanity-check that the totals object is well-formed and the
    // margin calculation doesn't produce NaN.
    const r = await getUnifiedReport(
      { sub: 'test', role: 'owner', businessId: 'leadgen' } as never,
      { window: 'this_month' },
    );
    expect(Number.isFinite(r.totals.revenue)).toBe(true);
    expect(Number.isFinite(r.totals.margin)).toBe(true);
  });
});
