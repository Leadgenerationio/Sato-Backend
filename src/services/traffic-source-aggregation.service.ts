import { sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { isUuid } from '../utils/zod-helpers.js';

/**
 * T1 — Manual ad-account → campaign attribution.
 *
 * Two helpers used by every Catchr-cost rollup that should respect the
 * `traffic_sources` mapping:
 *
 *   1. `aggregateCatchrSpend(campaignId, windowDays)` — total spend for ONE
 *      Stato campaign, summed only across `(platform, account_id)` pairs
 *      that appear in that campaign's `traffic_sources` rows. Returns 0 when
 *      the campaign has no mappings — matches Sam's "Installation alone
 *      should only be ~£20k, not the global £699k" expectation.
 *
 *   2. `aggregateCatchrSpendByLbId(windowDays)` — batched version that
 *      returns a `Map<lbCampaignId, totalSpend>` for every campaign with at
 *      least one mapping. Used by `campaign.service.ts:listCampaigns()` so
 *      the index page costs one round-trip instead of N.
 *
 *   3. `aggregateUnlinkedSpend(windowDays)` — every `ad_spend` row whose
 *      `(platform, account_id)` is NOT covered by any active traffic_sources
 *      row, rolled up per `(platform, account_id)`. Powers the "Unlinked
 *      Spend" diagnostic on /campaigns so spend the system can't attribute
 *      is visible rather than silently mis-attributed.
 *
 * All helpers filter `traffic_sources.is_active = true` so soft-deleted
 * mappings stop counting immediately. All SQL uses Postgres parameter
 * binding via Drizzle's `sql` template; no string concatenation of user
 * input. Window defaults to 30 days to match what Catchr's sync window
 * actually fills.
 */

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Result row for the unlinked-spend diagnostic. One row per
 * `(platform, account_id)` pair that has spend in the window but no
 * matching active traffic_sources mapping.
 */
export interface UnlinkedSpendRow {
  platform: string;
  accountId: string;
  accountName: string | null;
  spend: number;
  /** Distinct days in window with non-zero spend — helps decide if the
   *  pair is actively running or just dormant historical noise. */
  daysActive: number;
}

export interface UnlinkedSpendSummary {
  windowDays: number;
  total: number;
  rows: UnlinkedSpendRow[];
}

/**
 * Sum 30-day Catchr ad-spend for one Stato campaign, joining strictly via
 * the `traffic_sources` mapping. Returns 0 when:
 *   - `campaignId` is not a valid UUID
 *   - the campaign has zero active traffic_sources rows
 *   - ad_spend has no rows in the window for the mapped `(platform, account_id)` pairs
 *
 * The CTE flattens both the legacy `traffic_sources.account_id` scalar and
 * the new `account_ids` jsonb array, de-duplicates, and only considers
 * active mappings. Inactive rows continue to live in the DB for audit
 * history but stop contributing to cost the moment they're flipped off.
 */
export async function aggregateCatchrSpend(
  campaignId: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const rows = (await db.execute(sql`
    with source_accounts as (
      select ts.platform, ts.account_id as acc_id
      from traffic_sources ts
      where ts.campaign_id = ${campaignId}::uuid
        and ts.is_active = true
        and ts.account_id is not null
        and ts.platform is not null
      union
      select ts.platform, jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.campaign_id = ${campaignId}::uuid
        and ts.is_active = true
        and ts.platform is not null
    )
    select coalesce(sum(a.spend::numeric), 0)::float as total
    from ad_spend a
    join source_accounts sa on a.platform = sa.platform and a.account_id = sa.acc_id
    where a.date >= current_date - make_interval(days => ${windowDays})
  `)) as unknown as Array<{ total: number }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Batched version of {@link aggregateCatchrSpend} — one query returns the
 * total per campaign for every campaign that has at least one active
 * mapping. Keyed by `leadbyte_campaign_id` so the listCampaigns map step
 * (which already has the LB id in hand) can look up directly.
 *
 * Campaigns with no mappings simply do not appear in the map; the caller
 * defaults to `0` for those — i.e. the "no spend until you link an
 * account" rule from T1 AC#1.
 */
export async function aggregateCatchrSpendByLbId(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    with source_accounts as (
      select ts.campaign_id, ts.platform, ts.account_id as acc_id
      from traffic_sources ts
      where ts.is_active = true
        and ts.account_id is not null
        and ts.platform is not null
      union
      select ts.campaign_id, ts.platform, jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.is_active = true
        and ts.platform is not null
    )
    select c.leadbyte_campaign_id as lb_id,
           coalesce(sum(a.spend::numeric), 0)::float as total
    from source_accounts sa
    join campaigns c on c.id = sa.campaign_id
    join ad_spend a on a.platform = sa.platform and a.account_id = sa.acc_id
    where a.date >= current_date - make_interval(days => ${windowDays})
      and c.leadbyte_campaign_id is not null
    group by c.leadbyte_campaign_id
  `)) as unknown as Array<{ lb_id: string; total: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.lb_id, Number(r.total ?? 0));
  return out;
}

/**
 * Roll up every `ad_spend` row in the window whose `(platform, account_id)`
 * is NOT covered by an active traffic_sources mapping. Drives the
 * "Unlinked Spend" diagnostic card on /campaigns — surfaces spend the
 * system can't attribute so Sam (or any operator) can decide whether to
 * link it, ignore it, or chase it down in Catchr.
 *
 * Important: the rows returned here are **never** added to any campaign
 * total. By design the only place this number appears is the diagnostic
 * card. Adding it to a campaign would be exactly the bug T1 fixes.
 */
export async function aggregateUnlinkedSpend(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<UnlinkedSpendSummary> {
  const rows = (await db.execute(sql`
    with mapped as (
      select distinct ts.platform, ts.account_id as acc_id
      from traffic_sources ts
      where ts.is_active = true
        and ts.account_id is not null
        and ts.platform is not null
      union
      select distinct ts.platform, jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.is_active = true
        and ts.platform is not null
    )
    select a.platform,
           a.account_id as account_id,
           max(a.account_name) as account_name,
           coalesce(sum(a.spend::numeric), 0)::float as spend,
           count(distinct a.date)::int as days_active
    from ad_spend a
    left join mapped m
      on m.platform = a.platform and m.acc_id = a.account_id
    where a.date >= current_date - make_interval(days => ${windowDays})
      and m.platform is null
    group by a.platform, a.account_id
    having coalesce(sum(a.spend::numeric), 0) > 0
    order by spend desc
  `)) as unknown as Array<{
    platform: string;
    account_id: string;
    account_name: string | null;
    spend: number;
    days_active: number;
  }>;

  const result: UnlinkedSpendRow[] = rows.map((r) => ({
    platform: r.platform,
    accountId: r.account_id,
    accountName: r.account_name,
    spend: Math.round(Number(r.spend ?? 0) * 100) / 100,
    daysActive: Number(r.days_active ?? 0),
  }));
  const total = result.reduce((s, r) => s + r.spend, 0);
  return {
    windowDays,
    total: Math.round(total * 100) / 100,
    rows: result,
  };
}
