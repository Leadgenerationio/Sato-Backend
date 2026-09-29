import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import type { LeadByteSupplier } from '../integrations/leadbyte/leadbyte-types.js';

// Sam S11 (2026-09-29): the Ad Account Links card showed revenue £0.00
// against £13,440 for the campaign. Revenue was campaigns.lead_price ×
// leads, and lead_price is empty since per-buyer prices moved to
// client_campaigns. Leads/revenue now come from LeadByte's supplier report
// for the row's ad platform. LeadByte is mocked at the service boundary.
const suppliersMock = vi.fn<(lbId: string) => Promise<LeadByteSupplier[]>>();
vi.mock('../services/campaign-suppliers.js', () => ({
  getCampaignSuppliers: (lbId: string) => suppliersMock(lbId),
}));

const { listSourcesForCampaign } = await import('../services/traffic-source.service.js');

const tag = `s11-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const acct = (n: number) => `${tag}-acc-${n}`;
const requester = { userId: 'u', email: 'owner@stato.app', role: 'owner', businessId: null } as never;
const created = { campaigns: [] as string[], sources: [] as string[] };

function supplier(name: string, leads: number, revenue: number): LeadByteSupplier {
  return { id: name, name, platform: name, accountId: name, campaignId: `${tag}-lb`, totalSpend: 0, totalLeads: leads, revenue };
}

async function makeCampaign(): Promise<string> {
  const [row] = await db.insert(campaigns).values({
    name: `S11 ${tag}`, vertical: 'Test', status: 'active', leadbyteCampaignId: `${tag}-lb`, clientId: null,
  }).returning();
  created.campaigns.push(row.id);
  return row.id;
}

async function link(campaignId: string, platform: string, accountId: string, name = platform): Promise<void> {
  const [row] = await db.insert(trafficSources).values({ campaignId, name, platform, accountId, accountIds: [] }).returning();
  created.sources.push(row.id);
}

async function spend(platform: string, accountId: string, amount: number, authorizationId = 1): Promise<void> {
  await db.insert(adSpend).values({
    platform, authorizationId, accountId, accountName: accountId, campaignId: `cat-${accountId}`,
    campaignName: 'Test', date: new Date().toISOString().slice(0, 10), spend: String(amount), currency: 'GBP',
  });
}

beforeEach(() => { suppliersMock.mockReset(); });
afterEach(async () => {
  if (created.sources.length) await db.delete(trafficSources).where(inArray(trafficSources.id, created.sources));
  await db.delete(adSpend).where(inArray(adSpend.accountId, [acct(1), acct(2), acct(3)]));
  if (created.campaigns.length) await db.delete(campaigns).where(inArray(campaigns.id, created.campaigns));
  created.sources.length = 0;
  created.campaigns.length = 0;
});

describe('listSourcesForCampaign — Sam S11 attribution', () => {
  it('matches a "Facebook" row to Catchr facebook-ads spend and takes leads + revenue from LeadByte', async () => {
    const id = await makeCampaign();
    await link(id, 'Facebook', acct(1), 'Facebook - CH Hearing');
    // Catchr ingests the same day under 3 authorization ids — counted once.
    for (const a of [1, 2, 3]) await spend('facebook-ads', acct(1), 14527.53, a);
    suppliersMock.mockResolvedValue([supplier('facebook', 120, 8400), supplier('Facebook Ads', 70, 5040)]);

    const [row] = await listSourcesForCampaign(id, requester);
    expect(suppliersMock).toHaveBeenCalledWith(`${tag}-lb`);
    expect(row).toMatchObject({
      attribution: 'platform',
      totalSpend: 14527.53,
      totalLeads: 190,
      revenue: 13440,
      cpl: 76.46,
      netProfit: -1087.53,
    });
  });

  it('marks two rows on the same platform as shared instead of copying the platform figures onto both', async () => {
    const id = await makeCampaign();
    await link(id, 'google', acct(1));
    await link(id, 'Google Ads', acct(2));
    await spend('google-ads', acct(1), 100);
    await spend('google-ads', acct(2), 50);
    suppliersMock.mockResolvedValue([supplier('google', 30, 900)]);

    const rows = await listSourcesForCampaign(id, requester);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ attribution: 'shared', totalLeads: 0, revenue: 0 });
    expect(rows.map((r) => r.totalSpend).sort((a, b) => a - b)).toEqual([50, 100]);
  });

  it('says "unavailable" (not £0 revenue as fact) when LeadByte fails, and still shows spend', async () => {
    const id = await makeCampaign();
    await link(id, 'taboola', acct(3));
    await spend('taboola', acct(3), 42);
    suppliersMock.mockImplementation(async () => { throw new Error('LeadByte GET /reports/supplier: 500'); });

    const [row] = await listSourcesForCampaign(id, requester);
    expect(row).toMatchObject({ attribution: 'unavailable', totalSpend: 42, totalLeads: 0, revenue: 0 });
  });
});
