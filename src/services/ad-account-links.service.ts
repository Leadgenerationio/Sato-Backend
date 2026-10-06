import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { canonicalizePlatform, canonicalPlatformSql, normaliseAccountId, sourceLabel } from '../utils/catchr-platform.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Sam S13 (feedback round 1, 2026-09-29): one screen to say which client
 * (and optionally which campaign) owns every ad account, instead of one
 * campaign page at a time. Accounts are matched on (platform, account_id)
 * only — never on the account name.
 *
 * "Known" accounts are the union of:
 *   - every (platform, account_id) with Catchr spend in ad_spend,
 *   - every account referenced by a traffic_sources row (Ad Account Links on
 *     a campaign page), even with no spend yet,
 *   - every account already in client_ad_accounts.
 *
 * ad_spend and traffic_sources carry no business id (single-tenant today);
 * client_ad_accounts, clients and the lookup are scoped to the caller's
 * business.
 */

export interface AdAccountLink {
  clientId: string;
  clientName: string;
  campaignId: string | null;
  campaignName: string | null;
  updatedAt: string | null;
}

export interface AdAccountRow {
  /** canonicalizePlatform() value, or the lower-cased raw platform. */
  platform: string;
  platformLabel: string;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  /** Deduped Catchr spend in the window. */
  spend: number;
  lastSpendDate: string | null;
  link: AdAccountLink | null;
  /** Campaigns whose Ad Account Links (traffic_sources) include this account. */
  campaigns: Array<{ campaignId: string; campaignName: string }>;
}

export interface AdAccountList {
  windowDays: number;
  accounts: AdAccountRow[];
  /** Picker options for the bulk screen: every client in the business and
   *  every Sato campaign (by UUID — the campaigns list API is keyed by
   *  LeadByte id), so the screen needs one round-trip. */
  options: {
    clients: Array<{ id: string; companyName: string; status: string | null; currency: string | null }>;
    campaigns: Array<{ id: string; name: string; status: string | null }>;
  };
  summary: {
    total: number;
    linked: number;
    unlinked: number;
    /** Sums across currencies — prefer the ByCurrency fields for display. */
    totalSpend: number;
    unlinkedSpend: number;
    /** Unlinked spend per account currency ('GBP' when Catchr sent none),
     *  so £ and € are never added together (Sam M3). */
    unlinkedSpendByCurrency: Record<string, number>;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Canonical platform for storage/matching; unknown platforms keep their
 *  lower-cased spelling so they still get exactly one row. */
export function normalisePlatform(input: string): string {
  return canonicalizePlatform(input) ?? input.toLowerCase().trim();
}

const keyOf = (platform: string, accountId: string) => `${platform}|${accountId}`;

function requireBusiness(requester: AuthPayload): string {
  if (!requester.businessId) throw new ValidationError('Your account is not linked to a business');
  return requester.businessId;
}

export interface AdAccountFilters {
  platform?: string;
  clientId?: string;
  campaignId?: string;
  linked?: boolean;
  /** Matches the account ID or the account name, case-insensitive. */
  q?: string;
}

export async function listAdAccounts(requester: AuthPayload, windowDays = 30, filters: AdAccountFilters = {}): Promise<AdAccountList> {
  const businessId = requireBusiness(requester);
  const days = Math.max(1, Math.min(365, Math.floor(windowDays)));
  const adPlatform = sql.raw(`coalesce(${canonicalPlatformSql('d.platform')}, lower(trim(d.platform)))`);
  const tsPlatform = sql.raw(`coalesce(${canonicalPlatformSql('ts.platform')}, lower(trim(ts.platform)))`);

  const [spendRows, sourceRows, linkRows, clientOptions, campaignOptions] = await Promise.all([
    // Deduped per natural key (Catchr ingests a day once per authorization
    // id), same rule as every other spend figure.
    db.execute(sql`
      with deduped as (
        select platform, account_id, campaign_id, date,
               max(spend::numeric) as spend, max(account_name) as account_name, max(currency) as currency
        from ad_spend
        where date >= current_date - make_interval(days => ${days})
        group by platform, account_id, campaign_id, date
      )
      select ${adPlatform} as platform,
             d.account_id as account_id,
             max(d.account_name) as account_name,
             max(d.currency) as currency,
             coalesce(sum(d.spend), 0)::float as spend,
             to_char(max(d.date), 'YYYY-MM-DD') as last_date
      from deduped d
      group by 1, 2
    `) as unknown as Promise<Array<{
      platform: string; account_id: string; account_name: string | null;
      currency: string | null; spend: number; last_date: string | null;
    }>>,
    db.execute(sql`
      with accs as (
        select ts.campaign_id, ${tsPlatform} as platform, ts.account_id as acc_id
        from traffic_sources ts
        where ts.is_active = true and ts.platform is not null and ts.account_id is not null and ts.account_id <> ''
        union
        select ts.campaign_id, ${tsPlatform} as platform, jsonb_array_elements_text(ts.account_ids) as acc_id
        from traffic_sources ts
        where ts.is_active = true and ts.platform is not null
      )
      select distinct a.platform, a.acc_id as account_id, c.id as campaign_id, c.name as campaign_name
      from accs a
      join campaigns c on c.id = a.campaign_id
      where a.acc_id is not null and a.acc_id <> ''
    `) as unknown as Promise<Array<{ platform: string; account_id: string; campaign_id: string; campaign_name: string }>>,
    db
      .select({
        platform: clientAdAccounts.platform,
        accountId: clientAdAccounts.accountId,
        accountName: clientAdAccounts.accountName,
        currency: clientAdAccounts.currency,
        clientId: clientAdAccounts.clientId,
        clientName: clients.companyName,
        campaignId: clientAdAccounts.campaignId,
        campaignName: campaigns.name,
        updatedAt: clientAdAccounts.updatedAt,
      })
      .from(clientAdAccounts)
      .innerJoin(clients, eq(clients.id, clientAdAccounts.clientId))
      .leftJoin(campaigns, eq(campaigns.id, clientAdAccounts.campaignId))
      .where(eq(clientAdAccounts.businessId, businessId)),
    db
      .select({ id: clients.id, companyName: clients.companyName, status: clients.status, currency: clients.currency })
      .from(clients)
      .where(eq(clients.businessId, businessId))
      .orderBy(clients.companyName),
    db
      .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
      .from(campaigns)
      .orderBy(campaigns.name),
  ]);

  const byKey = new Map<string, AdAccountRow>();
  const ensure = (platform: string, accountId: string): AdAccountRow => {
    const k = keyOf(platform, accountId);
    let row = byKey.get(k);
    if (!row) {
      row = {
        platform,
        platformLabel: sourceLabel(platform, platform),
        accountId,
        accountName: null,
        currency: null,
        spend: 0,
        lastSpendDate: null,
        link: null,
        campaigns: [],
      };
      byKey.set(k, row);
    }
    return row;
  };

  for (const s of spendRows) {
    const row = ensure(s.platform, s.account_id);
    row.spend = round2(row.spend + Number(s.spend ?? 0));
    row.accountName = row.accountName ?? s.account_name;
    row.currency = row.currency ?? s.currency;
    if (s.last_date && (!row.lastSpendDate || s.last_date > row.lastSpendDate)) row.lastSpendDate = s.last_date;
  }
  for (const t of sourceRows) {
    const row = ensure(t.platform, t.account_id);
    if (!row.campaigns.some((c) => c.campaignId === t.campaign_id)) {
      row.campaigns.push({ campaignId: t.campaign_id, campaignName: t.campaign_name });
    }
  }
  for (const l of linkRows) {
    const row = ensure(l.platform, l.accountId);
    row.accountName = row.accountName ?? l.accountName;
    row.currency = row.currency ?? l.currency;
    row.link = {
      clientId: l.clientId,
      clientName: l.clientName,
      campaignId: l.campaignId,
      campaignName: l.campaignName ?? null,
      updatedAt: l.updatedAt ? l.updatedAt.toISOString() : null,
    };
  }

  // Unlinked spend first (largest first) — that's the work to do — then the
  // linked accounts, also by spend.
  const wantPlatform = filters.platform ? normalisePlatform(filters.platform) : null;
  const wantQ = filters.q ? filters.q.toLowerCase() : null;
  const wantQId = filters.q ? filters.q.replace(/^act_/i, '').replace(/-/g, '').toLowerCase() : null;
  const filtered = [...byKey.values()].filter((a) => {
    if (wantPlatform && a.platform !== wantPlatform) return false;
    if (filters.linked !== undefined && Boolean(a.link) !== filters.linked) return false;
    if (filters.clientId && a.link?.clientId !== filters.clientId) return false;
    if (filters.campaignId && a.link?.campaignId !== filters.campaignId && !a.campaigns.some((c) => c.campaignId === filters.campaignId)) return false;
    if (wantQ) {
      const id = a.accountId.toLowerCase();
      const name = (a.accountName ?? '').toLowerCase();
      if (!id.includes(wantQ) && !id.includes(wantQId!) && !name.includes(wantQ)) return false;
    }
    return true;
  });
  const accounts = filtered.sort((a, b) => {
    const au = a.link ? 1 : 0;
    const bu = b.link ? 1 : 0;
    return au - bu || b.spend - a.spend || a.platform.localeCompare(b.platform) || a.accountId.localeCompare(b.accountId);
  });
  const unlinked = accounts.filter((a) => !a.link);
  return {
    windowDays: days,
    accounts,
    options: {
      clients: clientOptions.map((c) => ({ ...c, status: c.status ?? null, currency: c.currency ?? null })),
      campaigns: campaignOptions.map((c) => ({ ...c, status: c.status ?? null })),
    },
    summary: {
      total: accounts.length,
      linked: accounts.length - unlinked.length,
      unlinked: unlinked.length,
      totalSpend: round2(accounts.reduce((s, a) => s + a.spend, 0)),
      unlinkedSpend: round2(unlinked.reduce((s, a) => s + a.spend, 0)),
      unlinkedSpendByCurrency: unlinked.reduce<Record<string, number>>((acc, a) => {
        if (a.spend > 0) {
          const cur = a.currency ?? 'GBP';
          acc[cur] = round2((acc[cur] ?? 0) + a.spend);
        }
        return acc;
      }, {}),
    },
  };
}

export interface LinkInput {
  platform: string;
  accountId: string;
  /** null removes the link. */
  clientId: string | null;
  campaignId?: string | null;
  accountName?: string | null;
  currency?: string | null;
}

export type LinkAction = 'created' | 'updated' | 'removed' | 'unchanged';

export interface BulkLinkResult {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  results: Array<{ platform: string; accountId: string; action: LinkAction; clientName: string | null; campaignName: string | null }>;
}

/**
 * Create, change or remove many links in one transaction. Every client and
 * campaign id is checked first (client must belong to the caller's
 * business), so a bad id rejects the whole batch with nothing written.
 */
export async function bulkUpsertLinks(requester: AuthPayload, links: LinkInput[]): Promise<BulkLinkResult> {
  const businessId = requireBusiness(requester);
  const normalised = links.map((l) => ({
    ...l,
    platform: normalisePlatform(l.platform),
    accountId: normaliseAccountId(l.platform, l.accountId),
    campaignId: l.campaignId ?? null,
  }));

  const seen = new Set<string>();
  for (const l of normalised) {
    if (!l.accountId) throw new ValidationError('Every row needs an ad account id');
    const k = keyOf(l.platform, l.accountId);
    if (seen.has(k)) throw new ValidationError(`Ad account ${l.accountId} (${l.platform}) appears twice in this save`);
    seen.add(k);
    if (!l.clientId && l.campaignId) throw new ValidationError(`Pick a client for ad account ${l.accountId} before choosing a campaign`);
  }

  const clientIds = [...new Set(normalised.map((l) => l.clientId).filter((x): x is string => !!x))];
  const campaignIds = [...new Set(normalised.map((l) => l.campaignId).filter((x): x is string => !!x))];
  const [clientRows, campaignRows] = await Promise.all([
    clientIds.length
      ? db.select({ id: clients.id, name: clients.companyName }).from(clients)
          .where(and(eq(clients.businessId, businessId), inArray(clients.id, clientIds)))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    campaignIds.length
      ? db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(campaigns.id, campaignIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const clientName = new Map(clientRows.map((c) => [c.id, c.name]));
  const campaignName = new Map(campaignRows.map((c) => [c.id, c.name]));
  const missingClient = clientIds.find((id) => !clientName.has(id));
  if (missingClient) throw new ValidationError('One of the chosen clients no longer exists. Refresh the page and try again — nothing was saved.');
  const missingCampaign = campaignIds.find((id) => !campaignName.has(id));
  if (missingCampaign) throw new ValidationError('One of the chosen campaigns no longer exists. Refresh the page and try again — nothing was saved.');

  const result: BulkLinkResult = { created: 0, updated: 0, removed: 0, unchanged: 0, results: [] };
  await db.transaction(async (tx) => {
    for (const l of normalised) {
      const [existing] = await tx
        .select()
        .from(clientAdAccounts)
        .where(and(eq(clientAdAccounts.platform, l.platform), eq(clientAdAccounts.accountId, l.accountId)));
      if (existing && existing.businessId !== businessId) {
        throw new ValidationError(`Ad account ${l.accountId} is linked by another business — nothing was saved.`);
      }
      let action: LinkAction;
      if (!l.clientId) {
        if (existing) {
          await tx.delete(clientAdAccounts).where(eq(clientAdAccounts.id, existing.id));
          action = 'removed';
        } else {
          action = 'unchanged';
        }
      } else if (!existing) {
        await tx.insert(clientAdAccounts).values({
          businessId,
          platform: l.platform,
          accountId: l.accountId,
          accountName: l.accountName ?? null,
          clientId: l.clientId,
          campaignId: l.campaignId,
          currency: l.currency ?? null,
          linkedBy: requester.userId,
        });
        action = 'created';
      } else if (existing.clientId === l.clientId && (existing.campaignId ?? null) === l.campaignId) {
        action = 'unchanged';
      } else {
        await tx.update(clientAdAccounts)
          .set({ clientId: l.clientId, campaignId: l.campaignId, linkedBy: requester.userId, updatedAt: new Date() })
          .where(eq(clientAdAccounts.id, existing.id));
        action = 'updated';
      }
      result[action] += 1;
      result.results.push({
        platform: l.platform,
        accountId: l.accountId,
        action,
        clientName: l.clientId ? clientName.get(l.clientId) ?? null : null,
        campaignName: l.campaignId ? campaignName.get(l.campaignId) ?? null : null,
      });
    }
  });
  return result;
}

export interface ClientLookupResult {
  platform: string;
  accountId: string;
  client: { id: string; companyName: string; currency: string | null };
  campaign: { id: string; name: string } | null;
}

/** GET /clients/lookup?platform=&accountId= — which client owns this ad account. */
export async function lookupClientByAdAccount(
  requester: AuthPayload,
  platform: string,
  accountId: string,
): Promise<ClientLookupResult> {
  const businessId = requireBusiness(requester);
  const p = normalisePlatform(platform);
  const [row] = await db
    .select({
      clientId: clients.id,
      companyName: clients.companyName,
      currency: clients.currency,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
    })
    .from(clientAdAccounts)
    .innerJoin(clients, eq(clients.id, clientAdAccounts.clientId))
    .leftJoin(campaigns, eq(campaigns.id, clientAdAccounts.campaignId))
    .where(and(
      eq(clientAdAccounts.businessId, businessId),
      eq(clientAdAccounts.platform, p),
      eq(clientAdAccounts.accountId, normaliseAccountId(platform, accountId)),
    ));
  if (!row) throw new NotFoundError('Linked client for this ad account');
  return {
    platform: p,
    accountId: normaliseAccountId(platform, accountId),
    client: { id: row.clientId, companyName: row.companyName, currency: row.currency ?? null },
    campaign: row.campaignId ? { id: row.campaignId, name: row.campaignName ?? '' } : null,
  };
}
