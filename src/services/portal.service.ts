import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import bcryptjs from 'bcryptjs';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { users } from '../db/schema/users.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { invoices } from '../db/schema/invoices.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { agreements } from '../db/schema/agreements.js';
import { getApprovalStatesForCreatives } from './creative-approval.service.js';
import { computeDaysOverdue, deriveDisplayStatus } from './invoice.service.js';
import { supplierNameToCatchrPlatform } from './report.service.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';
import { cached } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { normalizeCurrencyCode } from '../utils/currency.js';
import { canonicalPlatformSql } from '../utils/catchr-platform.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Resolve a clientId to the list of campaign UUIDs they're linked to via the
 * client_campaigns join table (Slice 2 concept inversion, Sam Loom #40).
 *
 * Replaces the older `campaigns.client_id = $1` direct lookup, which silently
 * returned zero rows for campaigns Piece 1 auto-inserted (clientId is NULL on
 * those — the buyer set lives in client_campaigns). Without this helper, real
 * buyers like UK Energy Saving Network see empty Dashboard / Campaigns /
 * Compliance pages despite having thousands of lead_deliveries rows.
 */
async function campaignIdsForClient(clientId: string): Promise<string[]> {
  const rows = await db
    .select({ campaignId: clientCampaigns.campaignId })
    .from(clientCampaigns)
    .where(eq(clientCampaigns.clientId, clientId));
  return rows.map((r) => r.campaignId);
}

/**
 * Per-platform ad spend attributed to a client's campaigns since `fromDateIso`.
 *
 * Attribution goes through `traffic_sources`, NOT `ad_spend.client_id` —
 * `client_id` is never populated by the Catchr ingest (it's NULL on every
 * row), so scoping by it returns nothing. The whole app attributes Catchr
 * spend by joining ad_spend → traffic_sources on (canonical platform,
 * account_id) → campaign (see aggregateCatchrSpend). Both platform sides go
 * through canonicalPlatformSql() because Catchr writes 'facebook-ads' while
 * traffic_sources hold 'facebook' — a raw `=` join silently yields zero rows.
 * `account_ids` (jsonb) is unioned in for sources that roll up multiple
 * Catchr accounts under one row.
 *
 * Grouped per (platform, currency) so we never sum across currencies.
 * Self-maintaining: a campaign's spend appears the moment its Catchr account
 * is linked via traffic_sources — no backfill, no client_id needed.
 */
async function aggregateClientAdSpendByPlatform(
  campaignIds: string[],
  fromDateIso: string,
  toDateIso?: string,
): Promise<Array<{ platform: string; currency: string | null; spend: number }>> {
  if (campaignIds.length === 0) return [];
  const tsPlatform = sql.raw(canonicalPlatformSql('ts.platform'));
  const idList = sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `);
  // Sam (jam-video #2, 27-May-2026): portal showed £5,646 for Benson when
  // the real spend was £1,888. Root cause: each (platform, account_id,
  // campaign_id, date) tuple has 3 rows in ad_spend because the unique
  // index includes authorization_id and Catchr re-auths create a new id
  // per reconnect. We pick MAX(spend) per natural key in a subquery so
  // duplicates collapse to one row before summing. Hari's ingestion fix
  // will eventually de-dup at write time; this defends the portal number
  // until then.
  const dateUpper = toDateIso ?? '2099-12-31';
  const rows = (await db.execute(sql`
    with source_accounts as (
      select ${tsPlatform} as platform, ts.account_id as acc_id
      from traffic_sources ts
      where ts.campaign_id in (${idList})
        and ts.is_active = true
        and ts.account_id is not null
        and ts.platform is not null
      union
      select ${tsPlatform} as platform, jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.campaign_id in (${idList})
        and ts.is_active = true
        and ts.platform is not null
    ),
    -- Dedupe step (Sam jam-video #2 — £5,646 vs £1,888): collapse the 3x
    -- duplicate rows that share (platform, account_id, campaign_id, date)
    -- but differ on authorization_id. Spend values are identical across
    -- the duplicates so MAX() picks one row's value, not a sum.
    deduped as (
      select a.platform, a.account_id, a.campaign_id, a.date,
             a.currency,
             max(a.spend::numeric) as spend
      from ad_spend a
      where a.date >= ${fromDateIso}
        and a.date <= ${dateUpper}
      group by a.platform, a.account_id, a.campaign_id, a.date, a.currency
    )
    select d.platform as platform,
           d.currency as currency,
           coalesce(sum(d.spend), 0)::text as spend
    from deduped d
    join source_accounts sa
      on ${sql.raw(canonicalPlatformSql('d.platform'))} = sa.platform
     and d.account_id = sa.acc_id
    group by d.platform, d.currency
    order by sum(d.spend) desc
  `)) as unknown as Array<{ platform: string; currency: string | null; spend: string }>;
  return rows.map((r) => ({
    platform: r.platform,
    currency: r.currency,
    spend: Math.round(Number(r.spend) * 100) / 100,
  }));
}

export interface PortalAdSpendPlatform {
  platform: string;
  spend: number;
  currency: string;
}

// Read-path guard for the currency a managed client sees. ad_spend rows
// ingested before the write-time fix may still hold a malformed code, so we
// normalise on the way out too (defence in depth) — see normalizeCurrencyCode.

export interface PortalDashboard {
  companyName: string;
  clientType: 'managed' | 'ppl';
  activeCampaigns: number;
  totalLeadsThisMonth: number;
  totalLeadsAllTime: number;
  pendingInvoices: number;
  overdueInvoices: number;
  totalOutstanding: number;
  agreementSigned: boolean;
  recentLeads: { date: string; leads: number }[];
  // Per-platform ad spend for the current month (MTD), surfaced ONLY for
  // managed clients. PPL clients always get an empty array — they don't see
  // ad spend in the portal (no regression). Scoped to the client's own
  // ad_spend rows (client_id) so the figure matches the agency-side
  // getPnlSummary source of truth. Empty array also when a managed client
  // simply has no attributed spend this month.
  adSpendByPlatform: PortalAdSpendPlatform[];
}

export interface PortalCampaign {
  id: string;
  name: string;
  vertical: string;
  status: string;
  leadsThisWeek: number;
  leadsThisMonth: number;
  totalLeads: number;
  startDate: string;
}

export interface PortalLeadDay {
  date: string;
  campaignId: string;
  campaignName: string;
  leadCount: number;
  validLeads: number;
  invalidLeads: number;
}

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  dueDate: string;
  paidDate: string | null;
  daysOverdue: number;
}

export interface PortalCompliance {
  campaignName: string;
  creatives: {
    id: string;
    name: string;
    type: string;
    uploadedAt: string;
    fileUrl: string;
    approval: {
      status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
      decidedAt: string | null;
      decidedByName: string | null;
      feedback: string | null;
    };
  }[];
  landingPages: { id: string; url: string; screenshotUrl: string | null; lastChecked: string }[];
}

export interface PortalAgreement {
  id: string;
  status: 'pending' | 'sent' | 'signed';
  signedAt: string | null;
  documentUrl: string | null;
  clientName: string;
  terms: string;
}

class PortalAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalAccessError';
  }
}

// Statuses that represent internal pre-issue / post-cancel states. The
// client portal must NEVER see invoices in these states — drafts are
// pre-authorisation work in progress; voided/deleted are post-cancel
// records that exist for auditing only. Used by both getDashboard
// (counts/sums) and getInvoices (table rows).
const PORTAL_INVOICE_HIDDEN_STATUSES = new Set(['draft', 'voided', 'deleted']);

// Campaigns in these states are admin-only — drafts pre-launch, archived
// after teardown, deleted soft-deletes. Active/paused/ended/churned all
// remain visible so the buyer has historical context for past leads.
const PORTAL_CAMPAIGN_HIDDEN_STATUSES = new Set(['draft', 'archived', 'deleted']);

// Agreements in these states are admin-only workflow rows (drafts being
// edited, cancelled before send, voided after) — the portal should never
// surface them as "your agreement".
const PORTAL_AGREEMENT_HIDDEN_STATUSES = new Set(['draft', 'cancelled', 'voided', 'deleted']);

function requireClientId(requester: AuthPayload): string {
  if (!requester.clientId) {
    throw new PortalAccessError('Portal access requires an authenticated client user');
  }
  return requester.clientId;
}

async function loadClientOrThrow(clientId: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!row) throw new PortalAccessError('Client not found');
  return row;
}

export async function getDashboard(requester: AuthPayload): Promise<PortalDashboard> {
  const clientId = requireClientId(requester);
  const client = await loadClientOrThrow(clientId);

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
  const fourteenDaysAgoDate = fourteenDaysAgo.toISOString().split('T')[0];

  // Resolve the buyer's campaign set via client_campaigns first — the old
  // campaigns.client_id filter misses every campaign Piece 1 auto-inserted.
  const linkedCampaignIds = await campaignIdsForClient(clientId);

  const [
    [{ activeCampaigns }],
    [{ totalThisMonth }],
    [{ totalAllTime }],
    invoiceRows,
    recentDeliveries,
  ] = await Promise.all([
    linkedCampaignIds.length === 0
      ? Promise.resolve([{ activeCampaigns: 0 }])
      : db
          .select({ activeCampaigns: sql<number>`count(*)::int` })
          .from(campaigns)
          .where(and(inArray(campaigns.id, linkedCampaignIds), eq(campaigns.status, 'active'))),
    db
      .select({
        totalThisMonth: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(
        and(
          eq(leadDeliveries.clientId, clientId),
          gte(leadDeliveries.deliveryDate, monthStart.toISOString().split('T')[0]),
        ),
      ),
    db
      .select({
        totalAllTime: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(eq(leadDeliveries.clientId, clientId)),
    db
      .select()
      .from(invoices)
      .where(eq(invoices.clientId, clientId)),
    db
      .select({
        date: leadDeliveries.deliveryDate,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(
        and(
          eq(leadDeliveries.clientId, clientId),
          gte(leadDeliveries.deliveryDate, fourteenDaysAgoDate),
        ),
      )
      .groupBy(leadDeliveries.deliveryDate)
      .orderBy(leadDeliveries.deliveryDate),
  ]);

  // Pending = anything unpaid that the client should be aware of. Includes
  // Xero's 'authorised' state (invoice finalised + sent to customer,
  // awaiting payment). Explicitly EXCLUDES 'draft' and 'voided' — those
  // are internal Stato/Xero workflow states that must never count toward
  // numbers the client sees (otherwise they'd be chased for something we
  // haven't actually issued yet).
  //
  // T5 (Sam, 2026-05-20): also exclude rows without a xero_invoice_id.
  // An auto-invoice run can write status='sent' on a row that never
  // actually got pushed to Xero (the £44k incident); the structural
  // guard keeps that out of every client-facing tile regardless.
  const clientVisibleInvoices = invoiceRows.filter(
    (i) =>
      !PORTAL_INVOICE_HIDDEN_STATUSES.has((i.status ?? '').toLowerCase()) &&
      i.xeroInvoiceId !== null && i.xeroInvoiceId !== undefined,
  );
  const pendingInvoices = clientVisibleInvoices.filter(
    (i) => i.status === 'sent' || i.status === 'authorised' || i.status === 'submitted',
  ).length;
  const overdueInvoices = clientVisibleInvoices.filter((i) => i.status === 'overdue').length;
  const totalOutstanding = clientVisibleInvoices
    .filter((i) => i.status !== 'paid')
    .reduce((sum, i) => sum + Number(i.total ?? 0), 0);

  const recentLeads: { date: string; leads: number }[] = [];
  const deliveryMap = new Map(recentDeliveries.map((d) => [d.date, d.leads]));
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    recentLeads.push({ date: dateStr, leads: deliveryMap.get(dateStr) ?? 0 });
  }

  // Managed clients (bundled retainer) now see their ad spend in the portal;
  // PPL clients never do, so we short-circuit to an empty array. Attribution
  // runs through traffic_sources (see aggregateClientAdSpendByPlatform) —
  // ad_spend.client_id is never populated, so the previous direct-column
  // scope returned nothing for every client. This is the same join the agency
  // side uses, and is self-maintaining: spend appears the moment a campaign's
  // Catchr account is linked. Window is MTD to match the portal's framing;
  // grouped per (platform, currency) so mixed currencies are never summed.
  const adSpendByPlatform: PortalAdSpendPlatform[] =
    (client.clientType ?? 'ppl') === 'managed'
      ? (await aggregateClientAdSpendByPlatform(linkedCampaignIds, monthStart.toISOString().split('T')[0]))
          .map((r) => ({
            platform: r.platform,
            spend: r.spend,
            currency: normalizeCurrencyCode(r.currency, client.currency ?? 'GBP'),
          }))
      : [];

  return {
    companyName: client.companyName,
    clientType: client.clientType ?? 'ppl',
    activeCampaigns: activeCampaigns ?? 0,
    totalLeadsThisMonth: totalThisMonth ?? 0,
    totalLeadsAllTime: totalAllTime ?? 0,
    pendingInvoices,
    overdueInvoices,
    totalOutstanding: Math.round(totalOutstanding * 100) / 100,
    agreementSigned: client.agreementSigned ?? false,
    recentLeads,
    adSpendByPlatform,
  };
}

export async function getCampaigns(requester: AuthPayload): Promise<PortalCampaign[]> {
  const clientId = requireClientId(requester);

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const weekStart = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];

  // Slice 2 fix: a buyer's campaigns live in client_campaigns, not the legacy
  // campaigns.client_id column (which is NULL for every Piece 1 auto-inserted
  // row). Without this, multi-linked buyers like UK Energy Saving Network see
  // zero campaigns in the portal despite the join table having links.
  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (linkedCampaignIds.length === 0) return [];

  const rawRows = await db
    .select()
    .from(campaigns)
    .where(inArray(campaigns.id, linkedCampaignIds));

  // Hide admin-only workflow rows (draft/archived/deleted). The dashboard
  // already filters its "Active Campaigns" count to status='active' only;
  // here we keep paused/ended/churned visible so historical leads in the
  // Leads tab don't appear to come from a campaign that doesn't exist.
  const rows = rawRows.filter(
    (r) => !PORTAL_CAMPAIGN_HIDDEN_STATUSES.has((r.status ?? 'active').toLowerCase()),
  );

  if (rows.length === 0) return [];

  const campaignIds = rows.map((r) => r.id);
  const [weekly, monthly, allTime] = await Promise.all([
    db
      .select({
        campaignId: leadDeliveries.campaignId,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(
        and(
          eq(leadDeliveries.clientId, clientId),
          gte(leadDeliveries.deliveryDate, weekStart),
        ),
      )
      .groupBy(leadDeliveries.campaignId),
    db
      .select({
        campaignId: leadDeliveries.campaignId,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(
        and(
          eq(leadDeliveries.clientId, clientId),
          gte(leadDeliveries.deliveryDate, monthStart),
        ),
      )
      .groupBy(leadDeliveries.campaignId),
    db
      .select({
        campaignId: leadDeliveries.campaignId,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(eq(leadDeliveries.clientId, clientId))
      .groupBy(leadDeliveries.campaignId),
  ]);

  void campaignIds;
  const weekMap = new Map(weekly.map((w) => [w.campaignId, w.leads]));
  const monthMap = new Map(monthly.map((m) => [m.campaignId, m.leads]));
  const allMap = new Map(allTime.map((a) => [a.campaignId, a.leads]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    vertical: r.vertical ?? '',
    status: r.status ?? 'active',
    leadsThisWeek: weekMap.get(r.id) ?? 0,
    leadsThisMonth: monthMap.get(r.id) ?? 0,
    totalLeads: allMap.get(r.id) ?? 0,
    startDate: r.startDate ? r.startDate.toISOString() : '',
  }));
}

export interface GetLeadsRange {
  /** ISO date `YYYY-MM-DD`. Defaults to 30 days ago. */
  from?: string;
  /** ISO date `YYYY-MM-DD`. Defaults to today. */
  to?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

function thirtyDaysAgoIso(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];
}

/**
 * Resolve the `from`/`to` window. Invalid or missing inputs fall back to the
 * default 30-day window so a client typo can never blank out the dashboard.
 * `to` is end-inclusive (we use `lte`).
 */
export function resolveLeadsRange(input?: GetLeadsRange): { from: string; to: string } {
  const from = input?.from && ISO_DATE_RE.test(input.from) ? input.from : thirtyDaysAgoIso();
  const to = input?.to && ISO_DATE_RE.test(input.to) ? input.to : todayIso();
  // Guard against from > to (swap rather than 500).
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function getLeads(requester: AuthPayload, range?: GetLeadsRange): Promise<PortalLeadDay[]> {
  const clientId = requireClientId(requester);
  const { from, to } = resolveLeadsRange(range);

  const rows = await db
    .select({
      date: leadDeliveries.deliveryDate,
      leadCount: leadDeliveries.leadCount,
      validLeads: leadDeliveries.validLeadCount,
      invalidLeads: leadDeliveries.invalidLeadCount,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
    })
    .from(leadDeliveries)
    .innerJoin(campaigns, eq(campaigns.id, leadDeliveries.campaignId))
    .where(
      and(
        eq(leadDeliveries.clientId, clientId),
        gte(leadDeliveries.deliveryDate, from),
        lte(leadDeliveries.deliveryDate, to),
      ),
    )
    .orderBy(desc(leadDeliveries.deliveryDate));

  return rows.map((r) => ({
    date: r.date,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    leadCount: r.leadCount,
    validLeads: r.validLeads ?? r.leadCount,
    invalidLeads: r.invalidLeads ?? 0,
  }));
}

// Sam (jam-video #2, 27-May-2026):
// "you have it in the back end to have the ad spend where you can see
// google, facebook, and you can see the amount of leads that google or
// facebook has generated, and the ad spend next to it... we can change
// the time period to see the ad spend over different time periods."
//
// Per-source leads + spend for the same date range the Leads tab is
// showing. Numbers:
//
//   SPEND — exact. Comes from the deduped aggregateClientAdSpendByPlatform,
//     so the 3× authorization_id duplication that gave Sam £5,646 instead
//     of £1,888 is already collapsed.
//
//   LEADS — attributed per (campaign × platform) by **spend share within
//     that campaign**. A campaign that ran only on Facebook gets 100% of
//     its leads on Facebook. A campaign that split £600 Facebook / £400
//     Google over the window has its leads pro-rated 60/40. This matches
//     the admin-side per-source view closely enough for the portal; the
//     LeadByte supplier-row path is more precise and will replace this
//     heuristic once it's wired in. Campaigns with zero recorded spend
//     in the window keep their leads in an "Unattributed" bucket so we
//     never inflate a platform.
export interface PortalLeadsBySource {
  platform: string;
  leads: number;
  spend: number;
  currency: string;
  /** Spend-share allocation is approximate for multi-source campaigns. */
  leadsAreEstimated: boolean;
}

async function aggregateLeadsByCampaign(
  clientId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      campaignId: leadDeliveries.campaignId,
      leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
    })
    .from(leadDeliveries)
    .where(and(
      eq(leadDeliveries.clientId, clientId),
      gte(leadDeliveries.deliveryDate, from),
      lte(leadDeliveries.deliveryDate, to),
    ))
    .groupBy(leadDeliveries.campaignId);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.campaignId, r.leads);
  return map;
}

async function aggregateClientAdSpendByCampaignAndPlatform(
  campaignIds: string[],
  fromDateIso: string,
  toDateIso: string,
): Promise<Array<{ campaignId: string; platform: string; currency: string | null; spend: number }>> {
  if (campaignIds.length === 0) return [];
  const tsPlatform = sql.raw(canonicalPlatformSql('ts.platform'));
  const adPlatform = sql.raw(canonicalPlatformSql('d.platform'));
  const idList = sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `);
  // Same dedupe pattern as aggregateClientAdSpendByPlatform — collapse the
  // 3× authorization_id rows per (platform, account_id, campaign_id, date)
  // before we attach the campaign label.
  const rows = (await db.execute(sql`
    with source_accounts as (
      select ts.campaign_id as campaign_id,
             ${tsPlatform} as platform,
             ts.account_id as acc_id
      from traffic_sources ts
      where ts.campaign_id in (${idList})
        and ts.is_active = true
        and ts.account_id is not null
        and ts.platform is not null
      union
      select ts.campaign_id as campaign_id,
             ${tsPlatform} as platform,
             jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.campaign_id in (${idList})
        and ts.is_active = true
        and ts.platform is not null
    ),
    deduped as (
      select a.platform, a.account_id, a.campaign_id, a.date,
             a.currency,
             max(a.spend::numeric) as spend
      from ad_spend a
      where a.date >= ${fromDateIso}
        and a.date <= ${toDateIso}
      group by a.platform, a.account_id, a.campaign_id, a.date, a.currency
    )
    select sa.campaign_id::text as campaign_id,
           d.platform as platform,
           d.currency as currency,
           coalesce(sum(d.spend), 0)::text as spend
    from deduped d
    join source_accounts sa
      on ${adPlatform} = sa.platform
     and d.account_id = sa.acc_id
    group by sa.campaign_id, d.platform, d.currency
  `)) as unknown as Array<{ campaign_id: string; platform: string; currency: string | null; spend: string }>;
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    platform: r.platform,
    currency: r.currency,
    spend: Math.round(Number(r.spend) * 100) / 100,
  }));
}

// Sam (jam-video #2, 27-May-2026) ask 4b: drop the spend-share leads
// estimate when we can use LeadByte's per-supplier truth instead. LeadByte
// only exposes preset windows (`today`, `this_month`, `last_month`, etc.),
// not arbitrary date ranges. When the portal's picker lands on one of
// those presets we hit LeadByte; otherwise we fall back to the spend-share
// estimate for that range. `last_year` from the FE preset list is not
// supported by LeadByte's preset enum so it goes the estimate route.
function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function rangeToLeadByteWindow(from: string, to: string): DeliveryWindow | null {
  const now = new Date();
  const today = isoDate(now);
  const yesterday = isoDate(new Date(Date.now() - 86_400_000));
  if (from === today && to === today) return 'today';
  if (from === yesterday && to === yesterday) return 'yesterday';
  // this_month → 1st of current month → today
  const monthStart = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  if (from === monthStart && to === today) return 'this_month';
  // last_month → 1st of last month → last day of last month
  const lastMonthStart = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = isoDate(new Date(now.getFullYear(), now.getMonth(), 0));
  if (from === lastMonthStart && to === lastMonthEnd) return 'last_month';
  // ytd → Jan 1 → today
  const ytdStart = `${now.getFullYear()}-01-01`;
  if (from === ytdStart && to === today) return 'ytd';
  // this_week (Mon → today) and last_week aren't surfaced by the portal's
  // preset buttons so we don't probe for them — keeps the mapper tight.
  return null;
}

export async function getLeadsBySource(
  requester: AuthPayload,
  range?: GetLeadsRange,
): Promise<PortalLeadsBySource[]> {
  const clientId = requireClientId(requester);
  const { from, to } = resolveLeadsRange(range);
  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (linkedCampaignIds.length === 0) return [];

  const [campaignSpendRows, campaignLeadsMap] = await Promise.all([
    aggregateClientAdSpendByCampaignAndPlatform(linkedCampaignIds, from, to),
    aggregateLeadsByCampaign(clientId, from, to),
  ]);

  // Bucket spend per campaign so we know the share each platform claims.
  const spendByCampaign = new Map<string, number>();
  for (const r of campaignSpendRows) {
    spendByCampaign.set(r.campaignId, (spendByCampaign.get(r.campaignId) ?? 0) + r.spend);
  }

  // Step 1 — spend-share allocation (the fallback): walk each
  // (campaign, platform, spend) row, allocate that campaign's leads
  // proportionally to its share of the campaign's total spend. Single-
  // source campaigns get 100%; multi-source split by spend share.
  interface Bucket { leads: number; spend: number; currency: string; estimated: boolean; }
  const buckets = new Map<string, Bucket>();
  const platformsPerCampaign = new Map<string, Set<string>>();
  for (const r of campaignSpendRows) {
    const set = platformsPerCampaign.get(r.campaignId) ?? new Set<string>();
    set.add(r.platform);
    platformsPerCampaign.set(r.campaignId, set);
  }

  for (const r of campaignSpendRows) {
    const campaignTotalSpend = spendByCampaign.get(r.campaignId) ?? 0;
    const platformCount = platformsPerCampaign.get(r.campaignId)?.size ?? 1;
    const campaignLeads = campaignLeadsMap.get(r.campaignId) ?? 0;
    const share = campaignTotalSpend > 0 ? r.spend / campaignTotalSpend : 1 / platformCount;
    const allocatedLeads = campaignLeads * share;
    const key = `${r.platform}|${r.currency ?? ''}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.leads += allocatedLeads;
      existing.spend += r.spend;
      existing.estimated = existing.estimated || platformCount > 1;
    } else {
      buckets.set(key, {
        leads: allocatedLeads,
        spend: r.spend,
        currency: normalizeCurrencyCode(r.currency) ?? 'GBP',
        estimated: platformCount > 1,
      });
    }
  }

  // Step 2 — if the date range exactly matches a LeadByte preset, OVERRIDE
  // the lead count per platform with LeadByte's supplier-row truth. Goes
  // through the same `cached('lb:supplier-spend:${window}:v1', …)` key
  // that getUnifiedReport uses so we never make a duplicate LeadByte call
  // when an operator is on the admin side at the same time. Spend numbers
  // stay sourced from Catchr ad_spend (still deduped) — LeadByte's
  // `payout` field is empty for ad-network suppliers, so we'd lose the
  // numbers if we sourced both from there.
  const lbWindow = rangeToLeadByteWindow(from, to);
  if (lbWindow) {
    try {
      const supplierRows = await cached(
        `lb:supplier-spend:${lbWindow}:v1`,
        900,
        () => leadbyte.getSupplierSpend(lbWindow),
      );
      // Tenant-scope by campaign name. The client's Stato campaigns carry
      // the canonical LeadByte campaign name on `campaigns.name`, which
      // matches the `campaignName` LeadByte returns. Look those names up
      // for the requester's campaign set so we never read a row that
      // belongs to another tenant's campaign.
      const ownCampaignNames = new Set(
        (await db
          .select({ name: campaigns.name })
          .from(campaigns)
          .where(inArray(campaigns.id, linkedCampaignIds))
        ).map((r) => r.name),
      );

      const lbLeadsByPlatform = new Map<string, number>();
      for (const r of supplierRows) {
        if (!ownCampaignNames.has(r.campaignName)) continue;
        const canonicalPlatform = supplierNameToCatchrPlatform(r.supplierName);
        if (!canonicalPlatform) continue;
        lbLeadsByPlatform.set(
          canonicalPlatform,
          (lbLeadsByPlatform.get(canonicalPlatform) ?? 0) + r.leads,
        );
      }

      // Overwrite per-platform leads in the existing buckets with the
      // LeadByte truth. Drop the `estimated` flag — these are actuals now.
      // Buckets that didn't get a LeadByte row keep the spend-share
      // estimate (could happen for a platform with no LeadByte supplier
      // configured, e.g. when only the Catchr side is connected).
      for (const [key, b] of buckets.entries()) {
        const platform = key.split('|')[0];
        const lbLeads = lbLeadsByPlatform.get(platform);
        if (lbLeads !== undefined) {
          b.leads = lbLeads;
          b.estimated = false;
        }
      }
    } catch (err) {
      // LeadByte hiccup → fall back to the spend-share estimate already
      // computed in Step 1. Log once so we know when the override path
      // misses (Sam will see "est." on the row).
      logger.warn(
        { err, lbWindow, clientId },
        'portal getLeadsBySource: LeadByte supplier-spend fetch failed — keeping spend-share estimate',
      );
    }
  }

  return Array.from(buckets.entries())
    .map(([key, b]) => {
      const platform = key.split('|')[0];
      return {
        platform,
        leads: Math.round(b.leads),
        spend: Math.round(b.spend * 100) / 100,
        currency: b.currency,
        leadsAreEstimated: b.estimated,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export async function getInvoices(requester: AuthPayload): Promise<PortalInvoice[]> {
  const clientId = requireClientId(requester);
  // Sam wants what the client owes surfaced first — outstanding rows
  // (overdue / sent / authorised) before everything else. Inside the
  // outstanding bucket we sort by due_date ASC so the most-overdue row
  // is at the top; non-outstanding rows fall back to created_at DESC.
  // LOWER() guards against Xero's UPPER_CASE statuses. Order is applied
  // at the DB level so future LIMIT/OFFSET pagination stays correct.
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.clientId, clientId))
    .orderBy(
      sql`CASE WHEN LOWER(${invoices.status}) IN ('overdue', 'sent', 'authorised') THEN 0 ELSE 1 END`,
      sql`CASE WHEN LOWER(${invoices.status}) IN ('overdue', 'sent', 'authorised') THEN ${invoices.dueDate} END ASC NULLS LAST`,
      sql`CASE WHEN LOWER(${invoices.status}) IN ('overdue', 'sent', 'authorised') THEN NULL ELSE ${invoices.createdAt} END DESC NULLS LAST`,
    );

  // T5 (Sam, 2026-05-20): mirror the structural guard from
  // invoice.service.isOutstandingInvoice — an unpushed row (xero_invoice_id
  // is null) is never customer-visible regardless of its status. Same
  // PORTAL_INVOICE_HIDDEN_STATUSES gate stays so the client doesn't see
  // drafts/voided either.
  //
  // Status is derived, not raw: a Xero `authorised` invoice that's 31 days
  // past due was still showing "Authorised" on the portal because the
  // stored `status` column only flips to 'overdue' on the next external
  // sync. Re-derive daysOverdue + displayStatus per row so the buyer's
  // badge matches reality the moment the page loads.
  return rows
    .filter((r) =>
      !PORTAL_INVOICE_HIDDEN_STATUSES.has((r.status ?? 'draft').toLowerCase()) &&
      r.xeroInvoiceId !== null && r.xeroInvoiceId !== undefined,
    )
    .map((r) => {
      const daysOverdue = computeDaysOverdue(r.dueDate, r.paidDate, r.status);
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber ?? '',
        status: deriveDisplayStatus(r.status, daysOverdue),
        total: Number(r.total ?? 0),
        currency: r.currency ?? 'GBP',
        dueDate: (r.dueDate ?? new Date()).toISOString(),
        paidDate: r.paidDate ? r.paidDate.toISOString() : null,
        daysOverdue,
      };
    });
}

export async function getCompliance(requester: AuthPayload): Promise<PortalCompliance[]> {
  const clientId = requireClientId(requester);

  // Same Slice 2 fix as getCampaigns / getDashboard.
  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (linkedCampaignIds.length === 0) return [];

  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(inArray(campaigns.id, linkedCampaignIds));
  if (campaignRows.length === 0) return [];

  const campaignIds = campaignRows.map((c) => c.id);
  const [creativeRows, landingRows] = await Promise.all([
    db
      .select()
      .from(creatives)
      .where(and(
        sql`${creatives.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        eq(creatives.isDeleted, false),
        // T2 (Sam, 2026-05-20): staff drafts are never visible on the
        // portal — buyer only sees what's been explicitly submitted.
        sql`${creatives.status} <> 'draft'`,
      )),
    db
      .select()
      .from(landingPages)
      .where(sql`${landingPages.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)})`),
  ]);

  // Fetch latest approval status for every visible creative in one query.
  const approvalStates = await getApprovalStatesForCreatives(creativeRows.map((cr) => cr.id));

  return campaignRows.map((c) => ({
    campaignName: c.name,
    creatives: creativeRows
      .filter((cr) => cr.campaignId === c.id)
      .map((cr) => {
        const state = approvalStates.get(cr.id);
        return {
          id: cr.id,
          name: cr.name,
          type: cr.type ?? 'unknown',
          uploadedAt: (cr.createdAt ?? new Date()).toISOString(),
          fileUrl: cr.fileUrl,
          approval: {
            status: state?.status ?? 'pending',
            decidedAt: state?.decidedAt ?? null,
            decidedByName: state?.decidedByName ?? null,
            feedback: state?.feedback ?? null,
          },
        };
      }),
    landingPages: landingRows
      .filter((lp) => lp.campaignId === c.id)
      .map((lp) => ({
        id: lp.id,
        url: lp.url,
        screenshotUrl: lp.screenshotUrl,
        lastChecked: (lp.updatedAt ?? lp.createdAt ?? new Date()).toISOString(),
      })),
  }));
}

// ─── Creative review v2 (Sam #9/#11) — buyer-facing split list ─────────────

export interface PortalCreative {
  id: string;
  campaignId: string;
  campaignName: string;
  name: string;
  type: string;
  fileUrl: string;
  uploadedAt: string;
  section: 'media' | 'copy_lp';
  approval: {
    status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
    decidedAt: string | null;
    decidedByName: string | null;
    feedback: string | null;
  };
}

export interface PortalCreativesBySection {
  media: PortalCreative[];
  copyLp: PortalCreative[];
}

/**
 * List every creative across every campaign the buyer is linked to, split
 * by section. The portal review tab renders Media + Copy/LP as separate
 * cards and the buyer signs off each independently.
 */
export async function getCreativesBySection(requester: AuthPayload): Promise<PortalCreativesBySection> {
  const clientId = requireClientId(requester);

  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (linkedCampaignIds.length === 0) return { media: [], copyLp: [] };

  const rows = await db
    .select({
      id: creatives.id,
      campaignId: creatives.campaignId,
      campaignName: campaigns.name,
      name: creatives.name,
      type: creatives.type,
      fileUrl: creatives.fileUrl,
      section: creatives.section,
      createdAt: creatives.createdAt,
    })
    .from(creatives)
    .innerJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .where(and(
      inArray(creatives.campaignId, linkedCampaignIds),
      eq(creatives.isDeleted, false),
      // T2 (Sam, 2026-05-20): staff drafts are never visible on the
      // portal — buyer only sees what's been explicitly submitted.
      sql`${creatives.status} <> 'draft'`,
    ))
    .orderBy(desc(creatives.createdAt));

  if (rows.length === 0) return { media: [], copyLp: [] };

  const approvalStates = await getApprovalStatesForCreatives(rows.map((r) => r.id));

  const items: PortalCreative[] = rows.map((r) => {
    const state = approvalStates.get(r.id);
    return {
      id: r.id,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      name: r.name,
      type: r.type ?? 'unknown',
      fileUrl: r.fileUrl,
      uploadedAt: (r.createdAt ?? new Date()).toISOString(),
      section: (r.section as 'media' | 'copy_lp') ?? 'media',
      approval: {
        status: state?.status ?? 'pending',
        decidedAt: state?.decidedAt ?? null,
        decidedByName: state?.decidedByName ?? null,
        feedback: state?.feedback ?? null,
      },
    };
  });

  return {
    media: items.filter((i) => i.section === 'media'),
    copyLp: items.filter((i) => i.section === 'copy_lp'),
  };
}

export async function getAgreement(requester: AuthPayload): Promise<PortalAgreement | null> {
  const clientId = requireClientId(requester);
  const client = await loadClientOrThrow(clientId);

  const rawRows = await db
    .select()
    .from(agreements)
    .where(eq(agreements.clientId, clientId))
    .orderBy(desc(agreements.createdAt));

  // Hide internal workflow rows (draft/cancelled/voided/deleted) — the
  // client should never see "draft" presented as their agreement. Among
  // what remains we prefer most-progressed (signed → sent → pending) so a
  // newer draft can never shadow a previously-sent or previously-signed
  // agreement once the draft filter is in place.
  const visibleRows = rawRows.filter(
    (r) => !PORTAL_AGREEMENT_HIDDEN_STATUSES.has((r.status ?? 'pending').toLowerCase()),
  );
  if (visibleRows.length === 0) return null;

  const progressRank = (r: typeof visibleRows[number]): number =>
    r.signedAt ? 2 : r.sentAt ? 1 : 0;
  visibleRows.sort((a, b) => {
    const rankDiff = progressRank(b) - progressRank(a);
    if (rankDiff !== 0) return rankDiff;
    const aCreated = a.createdAt?.getTime() ?? 0;
    const bCreated = b.createdAt?.getTime() ?? 0;
    return bCreated - aCreated;
  });
  const row = visibleRows[0];

  const status: PortalAgreement['status'] =
    row.signedAt ? 'signed' : row.sentAt ? 'sent' : 'pending';

  return {
    id: row.id,
    status,
    signedAt: row.signedAt ? row.signedAt.toISOString() : null,
    documentUrl: row.documentUrl,
    clientName: client.companyName,
    terms: `Lead Generation Service Agreement between leadgeneration.io and ${client.companyName}. Lead price: £${client.leadPrice ?? '0.00'} per valid lead. Payment terms: ${client.paymentTermsDays ?? 30} days.`,
  };
}

// ─── Sam (2026-05-27 jam-video #2) ───────────────────────────────────
// The client-side self-service surface (listPortalUsersForClient /
// createPortalUserForClient / deletePortalUserForClient /
// updatePortalUserPermissions / uploadExternalAgreement) has been removed.
// Sam manages portal users and agreement uploads on the admin side; the
// portal user account is display-only.
//
// PortalTabSlug + the allowedTabs column on users remain because admin-side
// per-portal-user tab visibility (set by Sam) is read by the FE nav at
// render time. portal-layout.tsx is the only consumer of that field.
// ─────────────────────────────────────────────────────────────────────

export const PORTAL_TAB_SLUGS = ['leads', 'invoices', 'compliance', 'creatives', 'agreement'] as const;
export type PortalTabSlug = (typeof PORTAL_TAB_SLUGS)[number];

// PortalUserDto / CreatePortalUserInput / ExternalAgreementInput +
// listPortalUsersForClient / createPortalUserForClient /
// deletePortalUserForClient / updatePortalUserPermissions /
// uploadExternalAgreement removed per Sam jam-video #2 (27-May-2026).
// Admin-side equivalents (clients/detail Portal Users card + "Mark as
// signed (external)" override) remain.
