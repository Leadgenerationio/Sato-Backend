import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import {
  aggregateCatchrSpend,
  aggregateCatchrSpendByLbId,
  aggregateUnlinkedSpend,
} from '../services/traffic-source-aggregation.service.js';

// T1 (Sam, 2026-05-20) — Manual ad-account → campaign attribution.
//
// Locks in the rule "no ad_spend row counts toward a campaign until the
// (platform, account_id) appears in an active traffic_sources row". The
// suite seeds isolated fixtures (random suffixes so prod data can't bleed
// in) and cleans up after each test.

const tag = `t1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const lbIdOf = (n: number) => `${tag}-lb-${n}`;
const acctOf = (n: number) => `${tag}-acc-${n}`;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const createdCampaignIds: string[] = [];
const createdTrafficSourceIds: string[] = [];

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

async function linkSource(opts: {
  campaignId: string;
  platform: string;
  accountId: string | null;
  accountIds?: string[];
  isActive?: boolean;
  name?: string;
}): Promise<string> {
  const [row] = await db
    .insert(trafficSources)
    .values({
      campaignId: opts.campaignId,
      name: opts.name ?? `${opts.platform} — ${opts.accountId ?? opts.accountIds?.[0] ?? 'multi'}`,
      platform: opts.platform,
      accountId: opts.accountId,
      accountIds: opts.accountIds ?? [],
      isActive: opts.isActive ?? true,
    })
    .returning();
  createdTrafficSourceIds.push(row.id);
  return row.id;
}

async function seedSpend(opts: {
  platform: string;
  accountId: string;
  spend: number;
  campaignId?: string;
}): Promise<void> {
  await db.insert(adSpend).values({
    platform: opts.platform,
    authorizationId: 1,
    accountId: opts.accountId,
    accountName: `Acct ${opts.accountId}`,
    campaignId: opts.campaignId ?? `cat-${opts.accountId}`,
    campaignName: 'Test',
    date: todayIso(),
    spend: opts.spend.toString(),
    currency: 'GBP',
  });
}

async function cleanup(): Promise<void> {
  // ad_spend rows seeded by these tests use the test tag in accountId — safe
  // wildcard delete via inArray on the platforms we used (we only used
  // 'facebook-ads' and 'google-ads' inside this tag).
  if (createdTrafficSourceIds.length > 0) {
    await db.delete(trafficSources).where(inArray(trafficSources.id, createdTrafficSourceIds));
  }
  await db.delete(adSpend).where(inArray(adSpend.accountId, [
    acctOf(1), acctOf(2), acctOf(3), acctOf(4), acctOf(5),
  ]));
  if (createdCampaignIds.length > 0) {
    await db.delete(campaigns).where(inArray(campaigns.id, createdCampaignIds));
  }
  createdTrafficSourceIds.length = 0;
  createdCampaignIds.length = 0;
}

describe('traffic-source-aggregation — campaign attribution', () => {
  afterEach(cleanup);

  it('aggregateCatchrSpend returns 0 when the campaign has no traffic_sources rows', async () => {
    const campaignId = await makeCampaign(`Empty ${tag}`, lbIdOf(0));
    // ad_spend exists but no mapping — must not attribute to this campaign.
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 200 });
    const total = await aggregateCatchrSpend(campaignId);
    expect(total).toBe(0);
  });

  it('aggregateCatchrSpend sums only the mapped (platform, account_id) pair', async () => {
    const campaignId = await makeCampaign(`Installation ${tag}`, lbIdOf(1));
    // Link the campaign to account #1; account #2 is a sibling on the same
    // platform but unrelated. The integration test from the spec.
    await linkSource({ campaignId, platform: 'facebook-ads', accountId: acctOf(1) });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 20 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 679 });

    const total = await aggregateCatchrSpend(campaignId);
    expect(total).toBeCloseTo(20, 5);
  });

  it('aggregateCatchrSpend picks up multi-account rows via account_ids[]', async () => {
    const campaignId = await makeCampaign(`Multi ${tag}`, lbIdOf(2));
    await linkSource({
      campaignId,
      platform: 'facebook-ads',
      accountId: null,
      accountIds: [acctOf(1), acctOf(2)],
    });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 30 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 70 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(3), spend: 9999 });

    const total = await aggregateCatchrSpend(campaignId);
    expect(total).toBeCloseTo(100, 5);
  });

  it('aggregateCatchrSpend ignores inactive mappings', async () => {
    const campaignId = await makeCampaign(`Inactive ${tag}`, lbIdOf(3));
    await linkSource({ campaignId, platform: 'facebook-ads', accountId: acctOf(1), isActive: false });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 50 });
    const total = await aggregateCatchrSpend(campaignId);
    expect(total).toBe(0);
  });

  it('aggregateCatchrSpend returns 0 for non-UUID input', async () => {
    expect(await aggregateCatchrSpend('not-a-uuid')).toBe(0);
    expect(await aggregateCatchrSpend('')).toBe(0);
  });

  it('aggregateCatchrSpendByLbId maps every linked campaign in one round-trip', async () => {
    const a = await makeCampaign(`A ${tag}`, lbIdOf(4));
    const b = await makeCampaign(`B ${tag}`, lbIdOf(5));
    await linkSource({ campaignId: a, platform: 'facebook-ads', accountId: acctOf(1) });
    await linkSource({ campaignId: b, platform: 'google-ads', accountId: acctOf(2) });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 11 });
    await seedSpend({ platform: 'google-ads', accountId: acctOf(2), spend: 22 });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(3), spend: 9999 });

    const m = await aggregateCatchrSpendByLbId(30);
    expect(m.get(lbIdOf(4))).toBeCloseTo(11, 5);
    expect(m.get(lbIdOf(5))).toBeCloseTo(22, 5);
  });

  // Bug 2026-05-22 — repro: in prod, `traffic_sources.platform` was written
  // with the FE-picker values ('google', 'Facebook', 'TikTok'), but
  // `ad_spend.platform` is the canonical Catchr identifier
  // ('google-ads', 'facebook-ads', 'tik-tok'). Raw `=` join silently
  // returned zero rows for every campaign → Solar Panels (UK) had real
  // £8,926 TikTok spend but the /campaigns endpoint reported totalCost: 0
  // and margin: 100% (visibly broken — 13k leads, £132k revenue, "no
  // cost"). Both helpers MUST canonicalize platform on both sides of the
  // join so operator-entered mappings actually attribute spend.
  it('aggregateCatchrSpendByLbId canonicalizes FE-style platform values vs Catchr platform values', async () => {
    const solarUk = await makeCampaign(`Solar Panels (UK) ${tag}`, lbIdOf(8));
    const insulation = await makeCampaign(`Insulation ${tag}`, lbIdOf(9));
    // Operator picks 'TikTok' / 'google' / 'Facebook' in the FE — these are
    // the exact distinct values found in prod traffic_sources.platform.
    await linkSource({ campaignId: solarUk, platform: 'TikTok', accountId: acctOf(1) });
    await linkSource({ campaignId: insulation, platform: 'google', accountId: acctOf(2) });
    // Catchr writes the hyphenated canonical strings.
    await seedSpend({ platform: 'tik-tok', accountId: acctOf(1), spend: 100 });
    await seedSpend({ platform: 'google-ads', accountId: acctOf(2), spend: 250 });
    // Stray unmapped row that must NOT leak into either campaign.
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(3), spend: 9999 });

    const m = await aggregateCatchrSpendByLbId(30);
    expect(m.get(lbIdOf(8))).toBeCloseTo(100, 5);
    expect(m.get(lbIdOf(9))).toBeCloseTo(250, 5);
  });

  it('aggregateCatchrSpend canonicalizes platform — TikTok ↔ tik-tok join must fire', async () => {
    const campaignId = await makeCampaign(`Solar ${tag}`, lbIdOf(10));
    // Mixed-case "TikTok" stays out of the canonical form on its own — the
    // SQL must lower-case-trim it down to 'tik-tok'.
    await linkSource({ campaignId, platform: 'TikTok', accountId: acctOf(1) });
    await seedSpend({ platform: 'tik-tok', accountId: acctOf(1), spend: 50 });
    // Sibling Catchr row on a different account on the same canonical
    // platform — must NOT contribute.
    await seedSpend({ platform: 'tik-tok', accountId: acctOf(2), spend: 999 });

    const total = await aggregateCatchrSpend(campaignId);
    expect(total).toBeCloseTo(50, 5);
  });
});

describe('traffic-source-aggregation — unlinked diagnostic', () => {
  afterEach(cleanup);

  it('aggregateUnlinkedSpend returns rows whose (platform, account_id) is not mapped', async () => {
    const campaignId = await makeCampaign(`U ${tag}`, lbIdOf(6));
    await linkSource({ campaignId, platform: 'facebook-ads', accountId: acctOf(1) });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 50 });   // mapped
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(2), spend: 200 });  // unmapped
    await seedSpend({ platform: 'google-ads',   accountId: acctOf(3), spend: 75 });   // unmapped

    const summary = await aggregateUnlinkedSpend(30);
    const mine = summary.rows.filter((r) => r.accountId === acctOf(2) || r.accountId === acctOf(3));
    expect(mine.length).toBe(2);
    const acct2 = mine.find((r) => r.accountId === acctOf(2))!;
    const acct3 = mine.find((r) => r.accountId === acctOf(3))!;
    expect(acct2.spend).toBeCloseTo(200, 5);
    expect(acct2.platform).toBe('facebook-ads');
    expect(acct3.spend).toBeCloseTo(75, 5);
    expect(acct3.platform).toBe('google-ads');

    // The mapped pair must NOT appear.
    expect(summary.rows.find((r) => r.accountId === acctOf(1))).toBeUndefined();
  });

  it('aggregateUnlinkedSpend treats an inactive mapping as no mapping', async () => {
    const campaignId = await makeCampaign(`Inact U ${tag}`, lbIdOf(7));
    // Inactive mapping — the row IS in traffic_sources but it shouldn't
    // cover the (platform, account_id) any more.
    await linkSource({ campaignId, platform: 'facebook-ads', accountId: acctOf(1), isActive: false });
    await seedSpend({ platform: 'facebook-ads', accountId: acctOf(1), spend: 90 });

    const summary = await aggregateUnlinkedSpend(30);
    const mine = summary.rows.find((r) => r.accountId === acctOf(1));
    expect(mine).toBeDefined();
    expect(mine!.spend).toBeCloseTo(90, 5);
  });
});

// Belt-and-braces: make sure the cleanup helper itself works against
// records the suite created. If this fails the rest of the suite will
// leak fixtures into other test files (vitest runs files sequentially
// per `fileParallelism: false` but tests inside a file share state).
beforeAll(async () => {
  // Pre-clean in case a previous run crashed mid-flight and left rows
  // with this tag. Belt-and-braces — production tags are uuid-shaped, so
  // the `tag` prefix can't collide.
  await db.delete(adSpend).where(inArray(adSpend.accountId, [
    acctOf(1), acctOf(2), acctOf(3), acctOf(4), acctOf(5),
  ]));
});

// Silence the unused-import warning if `eq`/`and` aren't used in a future
// trim — they're imported so test maintainers don't need to re-add them.
void and; void eq;
