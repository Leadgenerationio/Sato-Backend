import { and, between, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { adSpend, type AdSpendInsert } from '../db/schema/ad-spend.js';
import {
  listSources,
  runApiRequest,
  fieldMapFor,
  isCatchrConfigured,
  type CatchrSource,
} from '../integrations/catchr/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { normalizeCurrencyCode } from '../utils/currency.js';

export interface AdSpendSyncResult {
  startedAt: string;
  finishedAt: string;
  platformsSynced: number;
  accountsSynced: number;
  rowsWritten: number;
  skippedPlatforms: string[];
  skippedDeadAccounts: number;
  errors: Array<{ platform: string; accountId: string; message: string }>;
  error?: string;
}

/**
 * In-process cache of accounts that returned permanent-failure errors
 * (CUSTOMER_NOT_ENABLED, INVALID_CUSTOMER_ID, etc.) on a prior account-sync
 * attempt this process. We skip them for the rest of the worker lifetime
 * so 69 disabled GAds customers don't keep wasting ~140s/sync and flooding
 * the log. The cache resets on every Railway deploy, so newly-re-enabled
 * accounts re-attempt within a few hours.
 */
const KNOWN_DEAD_ACCOUNTS = new Set<string>();

/**
 * Catchr surfaces underlying provider errors verbatim in the `err.message`.
 * These patterns are permanent on a per-account basis — retrying just wastes
 * a round-trip. Detect them so we can demote the log + memoize the account.
 */
const DEAD_ACCOUNT_PATTERNS: ReadonlyArray<RegExp> = [
  /CUSTOMER_NOT_ENABLED/,
  /INVALID_CUSTOMER_ID/,
  /USER_PERMISSION_DENIED/,
  /AUTHENTICATION_ERROR/,
  /AUTHORIZATION_ERROR/,
];

function isDeadAccountError(message: string): boolean {
  return DEAD_ACCOUNT_PATTERNS.some((re) => re.test(message));
}

function deadAccountKey(platform: string, accountId: string): string {
  return `${platform}|${accountId}`;
}

/** Test-only hook — clears the in-process dead-account cache between tests. */
export function __resetDeadAccountCacheForTests(): void {
  KNOWN_DEAD_ACCOUNTS.clear();
}

/**
 * Defensive deduped sum of `ad_spend.spend` over a date range.
 *
 * Sam jam-video #2 (27-May-2026): Catchr's OAuth model rotates
 * `authorization_id` on every reconnect, and the `ad_spend` unique index
 * includes it — so each natural row (platform, account_id, campaign_id,
 * date) ends up with N copies, one per reconnect. The portal showed
 * Google £5,646 instead of £1,888 for Benson because of this. The admin
 * dashboard + unified report were summing the same triple-counted rows.
 *
 * This helper builds a Drizzle SQL fragment that collapses the duplicates
 * by taking MAX(spend) per natural key BEFORE summing. The spend value is
 * identical across duplicates so MAX picks one row's value, never a sum.
 *
 * Use as a scalar subquery in a select, or as the right-hand side of a
 * column. Permanent ingestion fix (drop authorization_id from the unique
 * index + backfill DELETE) is Hari's piece; this defends the read-path
 * until then.
 */
export function dedupedSpendSumSql(
  dateFromIso: string,
  dateToIso: string,
): ReturnType<typeof sql<string>> {
  return sql<string>`coalesce((
    select sum(d.spend)::text from (
      select max(spend::numeric) as spend
      from ad_spend
      where date >= ${dateFromIso} and date <= ${dateToIso}
      group by platform, account_id, campaign_id, date
    ) d
  ), '0')`;
}

export interface AdSpendFilters {
  from?: string;          // YYYY-MM-DD inclusive
  to?: string;            // YYYY-MM-DD inclusive
  platform?: string;
  accountId?: string;
  clientId?: string;
  campaignSearch?: string;
  limit?: number;
  offset?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function coerceNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceDate(v: string | number | null | undefined): string | null {
  if (!v) return null;
  const s = String(v);
  // Accept YYYY-MM-DD, YYYYMMDD, or ISO strings — normalise to YYYY-MM-DD.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : ymd(dt);
}

/**
 * Sync ad-spend for the last `CATCHR_SYNC_BACKFILL_DAYS` (default 30) across all
 * connected platforms + accounts. Idempotent — upserts on the composite unique
 * key (platform, authorization_id, account_id, campaign_id, date).
 *
 * Invoked by the `sync` BullMQ worker when job.name === 'catchr-hourly-sync'.
 */
export async function syncAll(deps?: { db?: typeof db }): Promise<AdSpendSyncResult> {
  const database = deps?.db ?? db;
  const startedAt = new Date().toISOString();
  const result: AdSpendSyncResult = {
    startedAt,
    finishedAt: startedAt,
    platformsSynced: 0,
    accountsSynced: 0,
    rowsWritten: 0,
    skippedPlatforms: [],
    skippedDeadAccounts: 0,
    errors: [],
  };

  if (!isCatchrConfigured()) {
    result.error = 'Catchr not configured — skipping sync';
    result.finishedAt = new Date().toISOString();
    logger.warn(result.error);
    return result;
  }

  if (!database) {
    result.error = 'Database not configured — skipping sync';
    result.finishedAt = new Date().toISOString();
    logger.warn(result.error);
    return result;
  }

  let sources: CatchrSource[];
  try {
    const sourcesResp = await listSources({ includeAvailableAccounts: true });
    sources = sourcesResp.sources;
  } catch (err) {
    result.error = `Failed to list Catchr sources: ${(err as Error).message}`;
    result.finishedAt = new Date().toISOString();
    logger.error({ err }, result.error);
    return result;
  }

  const backfillDays = env.CATCHR_SYNC_BACKFILL_DAYS;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - backfillDays * 24 * 3600 * 1000);

  const platformsSeen = new Set<string>();

  for (const source of sources) {
    const map = fieldMapFor(source.platform);
    if (!map) {
      if (!result.skippedPlatforms.includes(source.platform)) {
        result.skippedPlatforms.push(source.platform);
      }
      logger.warn({ platform: source.platform }, 'Catchr: no field map — skipping platform');
      continue;
    }
    platformsSeen.add(source.platform);

    const accounts = source.available_accounts ?? [];
    for (const acc of accounts) {
      // Skip accounts we already know are dead-on-arrival (CUSTOMER_NOT_ENABLED
      // etc) this process. Saves ~2s per skipped account and de-noises logs.
      if (KNOWN_DEAD_ACCOUNTS.has(deadAccountKey(source.platform, acc.id))) {
        result.skippedDeadAccounts++;
        continue;
      }
      try {
        const resp = await runApiRequest({
          platform: source.platform,
          accounts: [{ id: acc.id, authorization_id: source.id }],
          date: 'CUSTOM',
          start_date: ymd(startDate),
          end_date: ymd(endDate),
          dimensions: [map.date, map.accountName, map.accountCurrency, map.campaignId, map.campaignName],
          metrics: [map.spend],
        });
        result.accountsSynced++;

        const rowsByKey = new Map<string, AdSpendInsert>();
        let skippedEmptyCampaign = 0;
        // Keep the keys of the FIRST empty-campaign row we see for this
        // account-sync so the warn-log below can show the operator which
        // dimensions the platform actually returned. This is the "fail
        // loudly" path: if a platform's field map is wrong, the log line
        // tells you exactly which keys the row has so you can spot the
        // mismatch against FIELD_MAP[platform].campaignId without having
        // to attach a debugger to prod.
        let sampleEmptyRowKeys: string[] | null = null;
        let sampleConfiguredCampaignField: string | null = null;
        for (const row of resp.rows) {
          const d = coerceDate(row[map.date]);
          if (!d) continue;
          const campaignId = String(row[map.campaignId] ?? '');
          if (!campaignId) {
            skippedEmptyCampaign++;
            if (sampleEmptyRowKeys === null) {
              sampleEmptyRowKeys = Object.keys(row);
              sampleConfiguredCampaignField = map.campaignId;
            }
            continue;
          }
          const spendValue = coerceNumber(row[map.spend]);
          const insertRow: AdSpendInsert = {
            platform: source.platform,
            authorizationId: source.id,
            accountId: acc.id,
            accountName: (row[map.accountName] as string) ?? acc.name,
            campaignId,
            campaignName: (row[map.campaignName] as string) ?? null,
            date: d,
            spend: spendValue.toString(),
            // Normalise at write time — Catchr can emit an empty/malformed
            // currency, and the old `?? 'GBP'` only caught null/undefined.
            // Storing a bad code here is what crashed the portal dashboard
            // (Intl.NumberFormat RangeError). Reject it at the boundary so no
            // ad_spend consumer inherits the landmine.
            currency: normalizeCurrencyCode(row[map.accountCurrency] as string | null | undefined),
          };
          // Deduplicate within-batch on the same key the unique index uses.
          // If two response rows collapse to the same (platform, auth, account,
          // campaign, date) — last-wins. Postgres rejects an INSERT containing
          // multiple rows that would collide on the ON CONFLICT target with
          // "command cannot affect row a second time", so we must dedupe in
          // app code before the batch insert.
          const key = `${source.platform}|${source.id}|${acc.id}|${campaignId}|${d}`;
          rowsByKey.set(key, insertRow);
        }
        if (skippedEmptyCampaign > 0) {
          logger.warn(
            {
              platform: source.platform,
              accountId: acc.id,
              skippedEmptyCampaign,
              configuredCampaignField: sampleConfiguredCampaignField,
              sampleRowKeys: sampleEmptyRowKeys,
            },
            'Catchr: dropped rows with empty campaign_id — field map likely needs adjusting',
          );
        }
        const inserts = Array.from(rowsByKey.values());

        if (inserts.length > 0) {
          await database
            .insert(adSpend)
            .values(inserts)
            .onConflictDoUpdate({
              target: [adSpend.platform, adSpend.authorizationId, adSpend.accountId, adSpend.campaignId, adSpend.date],
              set: {
                accountName: sql`excluded.account_name`,
                campaignName: sql`excluded.campaign_name`,
                spend: sql`excluded.spend`,
                currency: sql`excluded.currency`,
                syncedAt: new Date(),
                updatedAt: new Date(),
              },
            });
          result.rowsWritten += inserts.length;
        }
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        result.errors.push({
          platform: source.platform,
          accountId: acc.id,
          message,
        });
        if (isDeadAccountError(message)) {
          // Memoize so we don't waste another ~2s/sync hitting this account
          // until the worker restarts. Demote to a single info-level log per
          // account per process so the error stream stays usable.
          KNOWN_DEAD_ACCOUNTS.add(deadAccountKey(source.platform, acc.id));
          logger.info(
            { platform: source.platform, accountId: acc.id, accountName: acc.name },
            'Catchr: account permanently disabled (CUSTOMER_NOT_ENABLED / auth error) — adding to in-process skip list',
          );
        } else {
          logger.error({ platform: source.platform, accountId: acc.id, err }, 'Catchr: account sync failed');
        }
      }
    }
  }

  result.platformsSynced = platformsSeen.size;
  result.finishedAt = new Date().toISOString();
  logger.info(result, 'Catchr sync complete');
  return result;
}

// ─── Query helpers for the report page ──────────────────────────────────────

function buildWhere(filters: AdSpendFilters) {
  const conds = [] as Array<ReturnType<typeof eq>>;
  if (filters.from && filters.to) conds.push(between(adSpend.date, filters.from, filters.to));
  else if (filters.from) conds.push(gte(adSpend.date, filters.from));
  else if (filters.to) conds.push(lte(adSpend.date, filters.to));
  if (filters.platform) conds.push(eq(adSpend.platform, filters.platform));
  if (filters.accountId) conds.push(eq(adSpend.accountId, filters.accountId));
  if (filters.clientId) conds.push(eq(adSpend.clientId, filters.clientId));
  return conds.length > 0 ? and(...conds) : undefined;
}

export async function listAdSpend(filters: AdSpendFilters = {}) {
  const where = buildWhere(filters);
  const limit = Math.min(filters.limit ?? 500, 2000);
  const offset = filters.offset ?? 0;

  const rows = await db
    .select({
      id: adSpend.id,
      date: adSpend.date,
      platform: adSpend.platform,
      accountId: adSpend.accountId,
      accountName: adSpend.accountName,
      campaignId: adSpend.campaignId,
      campaignName: adSpend.campaignName,
      spend: adSpend.spend,
      currency: adSpend.currency,
      clientId: adSpend.clientId,
    })
    .from(adSpend)
    .where(where)
    .orderBy(desc(adSpend.date), desc(adSpend.spend))
    .limit(limit)
    .offset(offset);

  return rows;
}

export interface AdSpendSummaryRow {
  platform: string;
  accountName: string | null;
  totalSpend: number;
  currency: string;
  campaigns: number;
}

export async function summarizeAdSpend(filters: AdSpendFilters = {}): Promise<AdSpendSummaryRow[]> {
  const where = buildWhere(filters);

  // Sam jam-video #2: dedupe on natural key BEFORE grouping by
  // (platform, accountName, currency) so the per-account totals on
  // the agency Ad Spend page stop showing 3× the real number. We pull
  // the filtered rows through a CTE that collapses dupes on the natural
  // key first, then aggregate.
  const rowsRaw = (await db.execute(sql`
    with deduped as (
      select a.platform, a.account_id, a.campaign_id, a.date, a.account_name, a.currency,
             max(a.spend::numeric) as spend
      from ${adSpend} a
      where ${where}
      group by a.platform, a.account_id, a.campaign_id, a.date, a.account_name, a.currency
    )
    select platform, account_name as "accountName", currency,
           coalesce(sum(spend), 0)::text as "totalSpend",
           count(distinct campaign_id)::int as campaigns
    from deduped
    group by platform, account_name, currency
    order by sum(spend) desc nulls last
  `)) as unknown as Array<{
    platform: string;
    accountName: string | null;
    currency: string;
    totalSpend: string;
    campaigns: number;
  }>;

  return rowsRaw.map((r) => ({
    platform: r.platform,
    accountName: r.accountName,
    currency: r.currency,
    totalSpend: parseFloat(r.totalSpend || '0'),
    campaigns: Number(r.campaigns ?? 0),
  }));
}

export async function totalSpend(filters: AdSpendFilters = {}): Promise<{ total: number; currency: string; rowCount: number }> {
  const where = buildWhere(filters);
  // Sam jam-video #2 (27-May-2026): dedupe before summing — the 3×
  // authorization_id rows per natural key inflate the total ~3x.
  // rowCount stays as the raw count for diagnostics (so dashboards can
  // still see how many rows are stored); the displayed total is the
  // deduped one. Permanent ingestion fix is Hari's.
  const rowsRaw = (await db.execute(sql`
    with filtered as (
      select * from ${adSpend} where ${where}
    ),
    deduped as (
      select platform, account_id, campaign_id, date, max(spend::numeric) as spend
      from filtered
      group by platform, account_id, campaign_id, date
    )
    select coalesce(sum(spend), 0)::text as total,
           (select count(*)::int from filtered) as row_count
    from deduped
  `)) as unknown as Array<{ total: string; row_count: number }>;
  const row = rowsRaw[0];

  return {
    total: parseFloat(row?.total ?? '0'),
    currency: 'GBP',
    rowCount: Number(row?.row_count ?? 0),
  };
}
