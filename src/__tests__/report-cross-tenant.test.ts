import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * OCT-49 — getUnifiedReport row-level cross-tenant filter.
 *
 * The companion test in report.test.ts ("OCT-49 multi-tenant guard") only
 * exercises the zero-businessId guard + the empty-but-correct shape for a
 * tenant with no Stato campaigns. Neither hits the actual row filter,
 * because the test env has no LEADBYTE_TOKEN → leadbyte.getCampaignReport
 * returns [] → the filter never sees a row to drop.
 *
 * Here we mock the LeadByte client at module scope so the report receives
 * three planted rows: owner-mapped, alien-mapped, and truly-orphan. We then
 * seed the DB with two tenants (owner + alien) and matching campaigns, call
 * getUnifiedReport with the owner's businessId, and assert that the alien
 * campaign + supplier rows are excluded from rows / byPlatform / totals while
 * owner + orphan survive.
 */

const ALIEN_BUSINESS_ID = '00000000-0000-0000-0000-0000000a4901';
const ALIEN_CLIENT_ID = '00000000-0000-0000-0000-0000000a4902';
const ALIEN_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a4903';
const ALIEN_CAMPAIGN_NAME = 'OCT-49 ALIEN — leak canary unified';

const OWNER_BUSINESS_ID = '00000000-0000-0000-0000-0000000a4910';
const OWNER_CLIENT_ID = '00000000-0000-0000-0000-0000000a4911';
const OWNER_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a4912';
const OWNER_CAMPAIGN_NAME = 'OCT-49 OWNER — should appear unified';

const ORPHAN_CAMPAIGN_NAME = 'OCT-49 ORPHAN — no junction unified';

vi.mock('../integrations/leadbyte/leadbyte-client.js', () => ({
  getCampaignReport: async () => [
    { campaign: OWNER_CAMPAIGN_NAME, campaignId: 'lb-owner', leads: 50, valid: 50, invalid: 0, pending: 0, rejections: 0, payable: 50, sold: 50, returns: 0, payout: 0, revenue: 500, profit: 500, currency: 'GBP' },
    { campaign: ALIEN_CAMPAIGN_NAME, campaignId: 'lb-alien', leads: 999, valid: 999, invalid: 0, pending: 0, rejections: 0, payable: 999, sold: 999, returns: 0, payout: 0, revenue: 9999, profit: 9999, currency: 'GBP' },
    { campaign: ORPHAN_CAMPAIGN_NAME, campaignId: 'lb-orphan', leads: 5, valid: 5, invalid: 0, pending: 0, rejections: 0, payable: 5, sold: 5, returns: 0, payout: 0, revenue: 50, profit: 50, currency: 'GBP' },
  ],
  getSupplierSpend: async () => [
    // Owner row uses a platform unique to the owner campaign so byPlatform
    // assertions can match precisely on it.
    { supplierId: 'sup-owner',  supplierName: 'Owner Supplier',  platform: 'Facebook Ads', campaignId: 'lb-owner',  campaignName: OWNER_CAMPAIGN_NAME,  window: 'this_month' as const, spend: 100,  leads: 50,  cpl: 2 },
    // Alien row's `Google Ads` platform is the only one of its kind in this
    // fixture — its absence from byPlatform is direct proof the supplier-row
    // filter excluded it.
    { supplierId: 'sup-alien',  supplierName: 'Alien Supplier',  platform: 'Google Ads',   campaignId: 'lb-alien',  campaignName: ALIEN_CAMPAIGN_NAME,  window: 'this_month' as const, spend: 9999, leads: 999, cpl: 10 },
    // Orphan supplier row — needed because getUnifiedReport builds `rows`
    // from supplier rows; a campaign with no supplier row never surfaces. We
    // want to assert that truly-orphan campaigns DO surface (rather than
    // being collateral damage of the cross-tenant filter).
    { supplierId: 'sup-orphan', supplierName: 'Orphan Supplier', platform: 'Taboola',      campaignId: 'lb-orphan', campaignName: ORPHAN_CAMPAIGN_NAME, window: 'this_month' as const, spend: 10,   leads: 5,   cpl: 2 },
  ],
}));

const { getUnifiedReport } = await import('../services/report.service.js');
const { invalidateCache } = await import('../utils/cache.js');
const { db } = await import('../config/database.js');
const { businesses } = await import('../db/schema/businesses.js');
const { clients } = await import('../db/schema/clients.js');
const { campaigns: campaignsTable } = await import('../db/schema/campaigns.js');
const { clientCampaigns } = await import('../db/schema/client-campaigns.js');
const { inArray } = await import('drizzle-orm');
import type { AuthPayload } from '../types/index.js';

describe('getUnifiedReport — OCT-49 cross-tenant row filter', () => {
  beforeAll(async () => {
    await db.insert(businesses).values([
      { id: ALIEN_BUSINESS_ID, name: 'OCT-49 alien biz', slug: 'oct-49-alien', status: 'active' },
      { id: OWNER_BUSINESS_ID, name: 'OCT-49 owner biz', slug: 'oct-49-owner', status: 'active' },
    ]).onConflictDoNothing();

    await db.insert(clients).values([
      { id: ALIEN_CLIENT_ID, businessId: ALIEN_BUSINESS_ID, companyName: 'OCT-49 alien client', contactEmail: 'oct49@alien.test', currency: 'GBP', status: 'active' },
      { id: OWNER_CLIENT_ID, businessId: OWNER_BUSINESS_ID, companyName: 'OCT-49 owner client', contactEmail: 'oct49@owner.test', currency: 'GBP', status: 'active' },
    ]).onConflictDoNothing();

    // Owner + alien campaigns exist in Stato's `campaigns` table. The orphan
    // campaign does NOT — that's what makes it orphan: present in LeadByte,
    // absent from every tenant's Stato metadata, so safe to surface.
    await db.insert(campaignsTable).values([
      { id: ALIEN_CAMPAIGN_ID, name: ALIEN_CAMPAIGN_NAME, vertical: 'Solar Panels', status: 'active' },
      { id: OWNER_CAMPAIGN_ID, name: OWNER_CAMPAIGN_NAME, vertical: 'Hearing Aids', status: 'active' },
    ]).onConflictDoNothing();

    await db.insert(clientCampaigns).values([
      { campaignId: ALIEN_CAMPAIGN_ID, clientId: ALIEN_CLIENT_ID },
      { campaignId: OWNER_CAMPAIGN_ID, clientId: OWNER_CLIENT_ID },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [ALIEN_CAMPAIGN_ID, OWNER_CAMPAIGN_ID]));
    await db.delete(campaignsTable).where(inArray(campaignsTable.id, [ALIEN_CAMPAIGN_ID, OWNER_CAMPAIGN_ID]));
    await db.delete(clients).where(inArray(clients.id, [ALIEN_CLIENT_ID, OWNER_CLIENT_ID]));
    await db.delete(businesses).where(inArray(businesses.id, [ALIEN_BUSINESS_ID, OWNER_BUSINESS_ID]));
  });

  // Real Redis may be running locally — purge any stale cached fixture from
  // earlier runs so the mocked leadbyte client is exercised on each call.
  beforeEach(async () => {
    await invalidateCache(
      'lb:report:this_month:v5',
      'lb:supplier-spend:this_month:v1',
    );
  });

  function ownerAuth(): AuthPayload {
    return {
      userId: 'oct-49-cross-tenant-test',
      role: 'owner',
      email: 'oct-49@owner.test',
      businessId: OWNER_BUSINESS_ID,
    };
  }

  it('excludes the alien tenant\'s campaign from rows when called with the owner\'s businessId', async () => {
    const r = await getUnifiedReport(ownerAuth(), { window: 'this_month' });
    const names = r.rows.map((row) => row.campaignName);
    expect(names).not.toContain(ALIEN_CAMPAIGN_NAME);
    expect(names).toContain(OWNER_CAMPAIGN_NAME);
    // Truly-orphan rows (no Stato mapping in any tenant) remain visible — the
    // filter is "drop if mapped to another tenant", not "drop everything we
    // don't recognise".
    expect(names).toContain(ORPHAN_CAMPAIGN_NAME);
  });

  it('totals reflect only the visible rows — the £9,999 alien revenue is not summed in', async () => {
    const r = await getUnifiedReport(ownerAuth(), { window: 'this_month' });
    // Owner-row revenue (£500) + orphan-row revenue (£50) = £550. If the alien
    // £9,999 leaked, totals.revenue would jump well past this.
    expect(r.totals.revenue).toBeLessThan(1000);
    expect(r.totals.leads).toBeLessThan(100);
  });

  it('byPlatform aggregation excludes the alien supplier row', async () => {
    const r = await getUnifiedReport(ownerAuth(), { window: 'this_month' });
    // The alien row is the only one tagged 'Google Ads' in our fixture, so its
    // absence from byPlatform is a direct proof the supplier-row filter fired.
    const platforms = r.byPlatform.map((p) => p.platform);
    expect(platforms).not.toContain('Google Ads');
  });
});
