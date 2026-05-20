import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import {
  createSource,
  updateSource,
  deleteSource,
} from '../services/traffic-source.service.js';
import type { AuthPayload } from '../types/index.js';

// T1.3 (Sam, 2026-05-20) — backfill `ad_spend.stato_campaign_id` whenever
// a traffic_sources row is created / updated / deleted. Locks in the rule
// "the canonical attribution pointer in ad_spend mirrors the current state
// of traffic_sources, automatically, for rows in the last 90 days".

const tag = `t1bf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const lbIdOf = (n: number) => `${tag}-lb-${n}`;
const acctOf = (n: number) => `${tag}-acc-${n}`;

const REQUESTER: AuthPayload = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'owner@stato.app',
  role: 'owner',
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const createdCampaignIds: string[] = [];

async function makeCampaign(name: string, leadbyteCampaignId: string): Promise<string> {
  const [row] = await db
    .insert(campaigns)
    .values({
      name,
      vertical: 'Test',
      status: 'active',
      leadbyteCampaignId,
      clientId: null,
    })
    .returning();
  createdCampaignIds.push(row.id);
  return row.id;
}

async function seedSpend(opts: {
  platform: string;
  accountId: string;
  spend: number;
}): Promise<void> {
  await db.insert(adSpend).values({
    platform: opts.platform,
    authorizationId: 1,
    accountId: opts.accountId,
    accountName: `Acct ${opts.accountId}`,
    campaignId: `cat-${opts.accountId}`,
    campaignName: 'Test',
    date: todayIso(),
    spend: opts.spend.toString(),
    currency: 'GBP',
  });
}

async function statoCampaignIdFor(opts: { platform: string; accountId: string }): Promise<string | null> {
  const [row] = await db
    .select({ statoCampaignId: adSpend.statoCampaignId })
    .from(adSpend)
    .where(eq(adSpend.accountId, opts.accountId));
  return row?.statoCampaignId ?? null;
}

async function cleanup(): Promise<void> {
  await db.delete(adSpend).where(inArray(adSpend.accountId, [
    acctOf(1), acctOf(2), acctOf(3), acctOf(4),
  ]));
  if (createdCampaignIds.length > 0) {
    await db.delete(trafficSources).where(inArray(trafficSources.campaignId, createdCampaignIds));
    await db.delete(campaigns).where(inArray(campaigns.id, createdCampaignIds));
  }
  createdCampaignIds.length = 0;
}

describe('traffic-source-backfill — ad_spend.stato_campaign_id stays in sync', () => {
  beforeAll(async () => {
    await db.delete(adSpend).where(inArray(adSpend.accountId, [
      acctOf(1), acctOf(2), acctOf(3), acctOf(4),
    ]));
  });
  afterEach(cleanup);

  it('createSource backfills stato_campaign_id for historical ad_spend rows', async () => {
    const campaignId = await makeCampaign(`Backfill ${tag}`, lbIdOf(1));
    // ad_spend exists BEFORE the mapping — exactly the case T1 AC#3 wants
    // covered. Today's row should pick up the new campaign id.
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 42 });
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBeNull();

    await createSource(campaignId, { name: 'FB', platform: 'facebook-ads', accountId: acctOf(1) }, REQUESTER);

    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);
  });

  it('createSource backfills multi-account rows via account_ids[]', async () => {
    const campaignId = await makeCampaign(`Multi ${tag}`, lbIdOf(2));
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 10 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 20 });

    await createSource(
      campaignId,
      { name: 'FB-multi', platform: 'facebook-ads', accountIds: [acctOf(1), acctOf(2)] },
      REQUESTER,
    );

    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(2) })).toBe(campaignId);
  });

  it('createSource does NOT touch unrelated (platform, account_id) pairs', async () => {
    const campaignId = await makeCampaign(`Scope ${tag}`, lbIdOf(3));
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 10 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 20 });

    await createSource(campaignId, { name: 'FB-only-1', platform: 'facebook-ads', accountId: acctOf(1) }, REQUESTER);

    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);
    // The sibling account stays unattributed — no mapping covers it.
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(2) })).toBeNull();
  });

  it('deleteSource clears stato_campaign_id when no other mapping covers the pair', async () => {
    const campaignId = await makeCampaign(`Del ${tag}`, lbIdOf(4));
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 50 });
    const source = await createSource(
      campaignId,
      { name: 'X', platform: 'facebook-ads', accountId: acctOf(1) },
      REQUESTER,
    );
    expect(source).toBeTruthy();
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);

    await deleteSource(campaignId, source!.id, REQUESTER);
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBeNull();
  });

  it('updateSource re-attributes when a platform/accountId changes', async () => {
    const campaignId = await makeCampaign(`Edit ${tag}`, lbIdOf(5));
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 10 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 20 });

    const source = await createSource(
      campaignId,
      { name: 'X', platform: 'facebook-ads', accountId: acctOf(1) },
      REQUESTER,
    );
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);

    await updateSource(
      campaignId,
      source!.id,
      { accountId: acctOf(2) },
      REQUESTER,
    );
    // Old pair (acc 1) no longer covered → cleared.
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBeNull();
    // New pair (acc 2) now covered → attributed.
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(2) })).toBe(campaignId);
  });

  it('updateSource isActive=false clears stato_campaign_id', async () => {
    const campaignId = await makeCampaign(`Inact ${tag}`, lbIdOf(6));
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 10 });
    const source = await createSource(
      campaignId,
      { name: 'X', platform: 'facebook-ads', accountId: acctOf(1) },
      REQUESTER,
    );
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBe(campaignId);

    await updateSource(campaignId, source!.id, { isActive: false }, REQUESTER);
    expect(await statoCampaignIdFor({ platform: 'facebook-ads', accountId: acctOf(1) })).toBeNull();
  });
});
