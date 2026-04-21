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

export interface AdSpendSyncResult {
  startedAt: string;
  finishedAt: string;
  platformsSynced: number;
  accountsSynced: number;
  rowsWritten: number;
  skippedPlatforms: string[];
  errors: Array<{ platform: string; accountId: string; message: string }>;
  error?: string;
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

        const inserts: AdSpendInsert[] = [];
        for (const row of resp.rows) {
          const d = coerceDate(row[map.date]);
          if (!d) continue;
          const spendValue = coerceNumber(row[map.spend]);
          inserts.push({
            platform: source.platform,
            authorizationId: source.id,
            accountId: acc.id,
            accountName: (row[map.accountName] as string) ?? acc.name,
            campaignId: String(row[map.campaignId] ?? ''),
            campaignName: (row[map.campaignName] as string) ?? null,
            date: d,
            spend: spendValue.toString(),
            currency: (row[map.accountCurrency] as string) ?? 'GBP',
          });
        }

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
        result.errors.push({
          platform: source.platform,
          accountId: acc.id,
          message: (err as Error).message,
        });
        logger.error({ platform: source.platform, accountId: acc.id, err }, 'Catchr: account sync failed');
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

  const rows = await db
    .select({
      platform: adSpend.platform,
      accountName: adSpend.accountName,
      currency: adSpend.currency,
      totalSpend: sql<string>`coalesce(sum(${adSpend.spend}), 0)`,
      campaigns: sql<number>`count(distinct ${adSpend.campaignId})::int`,
    })
    .from(adSpend)
    .where(where)
    .groupBy(adSpend.platform, adSpend.accountName, adSpend.currency)
    .orderBy(desc(sql`coalesce(sum(${adSpend.spend}), 0)`));

  return rows.map((r) => ({
    platform: r.platform,
    accountName: r.accountName,
    currency: r.currency,
    totalSpend: parseFloat(r.totalSpend || '0'),
    campaigns: Number(r.campaigns ?? 0),
  }));
}

export async function totalSpend(filters: AdSpendFilters = {}): Promise<{ total: number; currency: string; rowCount: number }> {
  const where = buildWhere(filters);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${adSpend.spend}), 0)`,
      rowCount: sql<number>`count(*)::int`,
    })
    .from(adSpend)
    .where(where);

  return {
    total: parseFloat(row?.total ?? '0'),
    currency: 'GBP',
    rowCount: Number(row?.rowCount ?? 0),
  };
}
