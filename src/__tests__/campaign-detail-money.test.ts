import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import type { LeadByteCampaignReportRow } from '../integrations/leadbyte/leadbyte-types.js';

// Sam S11 (2026-09-29), end to end through getCampaign(): a direct-traffic
// campaign (LeadByte payout 0, real cost in Catchr) must show a non-zero CPL
// bar, one "Facebook" source, and a window Cost that includes ad spend.
// LeadByte is mocked at the module boundary; the cache is a passthrough so
// shared report keys can't serve another run's rows.

const tag = `s11d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LB_ID = `${tag}-lb`;
const NAME = `Hearing Aids (CH) ${tag}`;
const ACCT = `${tag}-acc`;
const today = new Date().toISOString().slice(0, 10);

vi.mock('../utils/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/cache.js')>();
  return { ...actual, cached: <T>(_k: string, _ttl: number, fn: () => Promise<T>) => fn() };
});

vi.mock('../integrations/leadbyte/leadbyte-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/leadbyte/leadbyte-client.js')>();
  const row = (leads: number, revenue: number): LeadByteCampaignReportRow => ({
    campaign: NAME, campaignId: LB_ID, leads, valid: leads, invalid: 0, pending: 0, rejections: 0,
    payable: leads, sold: leads, returns: 0, payout: 0, revenue, profit: revenue, currency: 'GBP',
  } as LeadByteCampaignReportRow);
  return {
    ...actual,
    getCampaigns: async () => [{
      id: LB_ID, name: NAME, clientId: '', clientName: '', vertical: 'Hearing Aids',
      status: 'active', leadPrice: 0, currency: 'GBP', startDate: '2026-01-01',
    }],
    getCampaignReport: async (w: string) => (['this_month', 'this_week', 'today', 'ytd'].includes(w) ? [row(10, 700)] : []),
    getDeliveryReports: async (_id: string, w: string) => (w === 'this_month'
      ? [{ campaignId: LB_ID, date: today, leadCount: 10, validLeads: 10, invalidLeads: 0, revenue: 0, cost: 0, reportId: 'r' }]
      : []),
    getSuppliers: async () => [
      { id: 'a', name: 'facebook', platform: 'facebook', accountId: 'facebook', campaignId: LB_ID, totalSpend: 0, totalLeads: 6, revenue: 420 },
      { id: 'b', name: 'Facebook Ads', platform: 'Facebook Ads', accountId: 'Facebook Ads', campaignId: LB_ID, totalSpend: 0, totalLeads: 4, revenue: 280 },
    ],
  };
});

const { getCampaign } = await import('../services/campaign.service.js');
let campaignId: string;

beforeAll(async () => {
  const [c] = await db.insert(campaigns).values({ name: NAME, vertical: 'Hearing Aids', status: 'active', leadbyteCampaignId: LB_ID, clientId: null }).returning();
  campaignId = c.id;
  await db.insert(trafficSources).values({ campaignId, name: 'Facebook - CH Hearing', platform: 'Facebook', accountId: ACCT, accountIds: [] });
  // Same day ingested under 3 Catchr authorization ids → £150 once.
  for (const authorizationId of [1, 2, 3]) {
    await db.insert(adSpend).values({
      platform: 'facebook-ads', authorizationId, accountId: ACCT, accountName: 'CH Hearing',
      campaignId: 'fb-1', date: today, spend: '150', currency: 'GBP',
    });
  }
});

afterAll(async () => {
  await db.delete(adSpend).where(inArray(adSpend.accountId, [ACCT]));
  await db.delete(trafficSources).where(inArray(trafficSources.campaignId, [campaignId]));
  await db.delete(campaigns).where(inArray(campaigns.id, [campaignId]));
});

describe('getCampaign — Sam S11 figures agree', () => {
  it('builds CPL, windowed cost, daily cost and headline cost from the same ad spend', async () => {
    const detail = await getCampaign(LB_ID, { userId: 'u', email: 'o', role: 'owner' } as never);
    expect(detail).not.toBeNull();
    const d = detail!;

    // One source, not "facebook" + "Facebook Ads"; CPL from ad spend.
    expect(d.suppliers).toEqual([
      expect.objectContaining({ name: 'Facebook', totalLeads: 10, revenue: 700, adSpend: 150, leadbyteCost: 0, totalSpend: 150, cpl: 15 }),
    ]);
    // "Cost" for This Month includes ad spend, so revenue − cost = profit.
    expect(d.windowReports.this_month).toMatchObject({ leads: 10, revenue: 700, leadbyteCost: 0, adSpend: 150, cost: 150 });
    expect(d.windowReports.today.cost).toBe(150);
    expect(d.windowReports.last_month).toMatchObject({ cost: 0, adSpend: 0 });
    // Revenue vs Cost chart: the day's cost carries the day's ad spend.
    expect(d.leadDeliveries).toEqual([expect.objectContaining({ date: today, adSpend: 150, cost: 150 })]);
    // Headline cost uses the same (year-to-date) ad spend.
    expect(d.totalCost).toBe(150);
  });
});
