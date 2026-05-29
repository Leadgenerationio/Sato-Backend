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
import { resolveR2Location } from './creative.service.js';
import { getSignedDownloadUrl } from '../integrations/r2/r2-client.js';
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
        totalThisMonth: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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
        totalAllTime: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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
        leads: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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
        leads: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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
        leads: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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
        leads: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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

// Sam (jam-video #3, 29-May-2026):
// "you've put in estimated, you put estimated 111 leads, estimated 30
// which is not correct, we need to show the client actual figures, we
// can't just make up figures... these need to be actual figures and
// needs to be actual live ad spends, so that's a non-negotiable."
//
// No more spend-share estimates. The By Source breakdown only renders
// when LeadByte can give us per-supplier truth — i.e. when the date
// range matches a LeadByte preset (today / yesterday / this_week /
// last_week / this_month / last_month / ytd). For custom ranges that
// don't map to a preset, we return an empty array and a `windowReason`
// hint so the FE can prompt the user to pick a preset rather than
// inventing numbers.
//
// LEADS — valid only, sourced from LeadByte's `valid` column on the
//   supplier report. Admin /reports/campaign overview reads the same
//   field, so the numbers reconcile.
// SPEND — exact, from the deduped aggregateClientAdSpendByPlatform
//   path. The 3× authorization_id duplication that gave Sam £5,646
//   instead of £1,888 is already collapsed there.
export interface PortalLeadsBySource {
  platform: string;
  /** Valid lead count from LeadByte's supplier report (matches admin). */
  leads: number;
  spend: number;
  currency: string;
}

/** Returned alongside the breakdown so the FE can explain why the card
 *  is empty when the user has picked a custom range. */
export type PortalLeadsBySourceWindow =
  | { kind: 'preset'; preset: DeliveryWindow }
  | { kind: 'custom-no-preset-match' };

async function aggregateLeadsByCampaign(
  clientId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      campaignId: leadDeliveries.campaignId,
      leads: sql<number>`coalesce(sum(coalesce(${leadDeliveries.validLeadCount}, ${leadDeliveries.leadCount})), 0)::int`,
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

// Sam (jam-video #3, 29-May-2026): no more spend-share estimates. The
// LeadByte supplier report is preset-window only, so we map the
// requester's date range onto the closest preset and only return data
// when that mapping is exact. Custom ranges that don't hit a preset
// return an empty array with kind='custom-no-preset-match' so the FE
// can show a "pick a preset for per-source breakdown" hint.
function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function rangeToLeadByteWindow(from: string, to: string): DeliveryWindow | null {
  const now = new Date();
  const today = isoDate(now);
  const yesterday = isoDate(new Date(Date.now() - 86_400_000));
  if (from === today && to === today) return 'today';
  if (from === yesterday && to === yesterday) return 'yesterday';
  // this_week (Mon → today). LeadByte's week starts Monday.
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mon … 6=Sun
  const thisWeekStart = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow));
  if (from === thisWeekStart && to === today) return 'this_week';
  // last_week (previous Mon → previous Sun)
  const lastWeekStart = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7));
  const lastWeekEnd = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 1));
  if (from === lastWeekStart && to === lastWeekEnd) return 'last_week';
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
  return null;
}

export async function getLeadsBySource(
  requester: AuthPayload,
  range?: GetLeadsRange,
): Promise<{ rows: PortalLeadsBySource[]; window: PortalLeadsBySourceWindow }> {
  const clientId = requireClientId(requester);
  const { from, to } = resolveLeadsRange(range);
  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (linkedCampaignIds.length === 0) {
    const lbWindow = rangeToLeadByteWindow(from, to);
    return {
      rows: [],
      window: lbWindow ? { kind: 'preset', preset: lbWindow } : { kind: 'custom-no-preset-match' },
    };
  }

  const lbWindow = rangeToLeadByteWindow(from, to);
  // Custom range without a preset match → no estimate, no fake numbers.
  // FE shows "Switch to a preset to see per-source breakdown."
  if (!lbWindow) {
    return { rows: [], window: { kind: 'custom-no-preset-match' } };
  }

  // Both LeadByte supplier rows AND Catchr spend in parallel — Catchr is
  // tenant-scoped to the client's campaign set via traffic_sources; LeadByte
  // is tenant-scoped by campaign name (the LB campaign name lives on
  // `campaigns.name`).
  let supplierRows: Awaited<ReturnType<typeof leadbyte.getSupplierSpend>>;
  try {
    supplierRows = await cached(
      `lb:supplier-spend:${lbWindow}:v1`,
      900,
      () => leadbyte.getSupplierSpend(lbWindow),
    );
  } catch (err) {
    // LeadByte unreachable → return empty with the preset window so the
    // FE shows "couldn't fetch report data" rather than estimates.
    logger.warn({ err, lbWindow, clientId }, 'portal getLeadsBySource: LeadByte supplier-spend fetch failed');
    return { rows: [], window: { kind: 'preset', preset: lbWindow } };
  }

  const [ownCampaignNames, campaignSpendRows] = await Promise.all([
    db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(inArray(campaigns.id, linkedCampaignIds))
      .then((rs) => new Set(rs.map((r) => r.name))),
    aggregateClientAdSpendByCampaignAndPlatform(linkedCampaignIds, from, to),
  ]);

  // Sam (jam-video #3): use VALID leads, not total. Admin /reports shows
  // "Google 18 valid leads / Facebook 92 valid leads" — portal must match.
  const lbValidLeadsByPlatform = new Map<string, number>();
  for (const r of supplierRows) {
    if (!ownCampaignNames.has(r.campaignName)) continue;
    const canonicalPlatform = supplierNameToCatchrPlatform(r.supplierName);
    if (!canonicalPlatform) continue;
    lbValidLeadsByPlatform.set(
      canonicalPlatform,
      (lbValidLeadsByPlatform.get(canonicalPlatform) ?? 0) + r.validLeads,
    );
  }

  // Bucket spend per (platform, currency). LeadByte tells us what leads
  // there are; Catchr tells us what was spent. Platforms with spend but no
  // LeadByte supplier row land with leads=0 (Catchr connected, LB supplier
  // not set up — surface the spend honestly).
  interface Bucket { leads: number; spend: number; currency: string; }
  const buckets = new Map<string, Bucket>();
  for (const r of campaignSpendRows) {
    const key = `${r.platform}|${r.currency ?? ''}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.spend += r.spend;
    } else {
      buckets.set(key, {
        leads: 0,
        spend: r.spend,
        currency: normalizeCurrencyCode(r.currency) ?? 'GBP',
      });
    }
  }
  for (const [key, b] of buckets.entries()) {
    const platform = key.split('|')[0];
    b.leads = lbValidLeadsByPlatform.get(platform) ?? 0;
  }
  // Also surface platforms that have LeadByte leads but no recorded
  // Catchr spend (free traffic, or Catchr ingestion missing). Spend = 0,
  // currency defaults to GBP. Sam wants the leads visible regardless.
  for (const [platform, leads] of lbValidLeadsByPlatform.entries()) {
    const key = `${platform}|`;
    const matched = Array.from(buckets.keys()).some((k) => k.startsWith(`${platform}|`));
    if (!matched) {
      buckets.set(key, { leads, spend: 0, currency: 'GBP' });
    }
  }

  const rows = Array.from(buckets.entries())
    .map(([key, b]) => {
      const platform = key.split('|')[0];
      return {
        platform,
        leads: Math.round(b.leads),
        spend: Math.round(b.spend * 100) / 100,
        currency: b.currency,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  return { rows, window: { kind: 'preset', preset: lbWindow } };
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
  // R2 object key (e.g. 'creatives/<uuid>.png'). Surfaced so the portal can
  // ask for a fresh signed download URL on each open — fileUrl was the
  // upload-time presigned URL, which expires (R2 returns the `ExpiredRequest`
  // XML once the X-Amz-Expires window elapses). Nullable for legacy rows
  // uploaded before r2Key was recorded.
  r2Key: string | null;
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
      r2Key: creatives.r2Key,
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
      r2Key: r.r2Key,
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

/**
 * Portal-side per-creative signed URL. Mirrors the staff-side
 * getCreativeSignedUrlForStaff but uses portal authz:
 *
 *   - requester must be a portal client (clientId set)
 *   - creative's campaign must be linked to that client via client_campaigns
 *   - creative must not be a staff-only draft
 *
 * The buyer never needed to know the R2 folder — every legacy creative
 * landed in misc/ via the agency upload UI even though the portal asked for
 * 'creatives/', which is what produced the ExpiredRequest XML (the FE fell
 * back to the stale upload-time fileUrl). The server now resolves the
 * folder from the stored file_url, so misc-folder legacy rows open fine.
 */
export async function getCreativeSignedUrlForPortal(
  id: string,
  requester: AuthPayload,
): Promise<string | null> {
  const clientId = requireClientId(requester);

  const [row] = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.id, id), eq(creatives.isDeleted, false)));
  if (!row) return null;
  // Staff drafts must never be visible to the buyer, even by direct id.
  if (row.status === 'draft') return null;

  const linkedCampaignIds = await campaignIdsForClient(clientId);
  if (!linkedCampaignIds.includes(row.campaignId)) return null;

  const location = resolveR2Location(row.fileUrl, row.r2Key);
  if (!location) return null;
  return getSignedDownloadUrl({ folder: location.folder, key: location.key, expiresInSeconds: 3600 });
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
