import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { invoices } from '../db/schema/invoices.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { agreements } from '../db/schema/agreements.js';
import { getApprovalStatesForCreatives } from './creative-approval.service.js';
import { computeDaysOverdue, deriveDisplayStatus } from './invoice.service.js';
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

export interface PortalAdSpendPlatform {
  platform: string;
  spend: number;
  currency: string;
}

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

  // Managed clients (bundled retainer) now see their ad spend in the portal.
  // PPL clients never do — we short-circuit to an empty array without running
  // the query, so there's zero behaviour change for them. Scope by the
  // client's own ad_spend rows (client_id) + this-month window so the figure
  // lines up with the agency-side getPnlSummary's per-client spend total and
  // the portal's existing "Leads This Month" window.
  // Group by (platform, currency) — NOT platform alone — so we never sum
  // across currencies. A client running ads in more than one currency (rare,
  // but ad_spend.currency is per-row and not constrained to GBP) gets one row
  // per (platform, currency) pair; the FE renders each with its own symbol
  // and totals per-currency. Summing mixed currencies into a single figure
  // would be silently wrong.
  const adSpendByPlatform: PortalAdSpendPlatform[] =
    (client.clientType ?? 'ppl') === 'managed'
      ? (
          await db
            .select({
              platform: adSpend.platform,
              currency: adSpend.currency,
              spend: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text`,
            })
            .from(adSpend)
            .where(
              and(
                eq(adSpend.clientId, clientId),
                gte(adSpend.date, monthStart.toISOString().split('T')[0]),
              ),
            )
            .groupBy(adSpend.platform, adSpend.currency)
            .orderBy(desc(sql`sum(${adSpend.spend}::numeric)`))
        ).map((r) => ({
          platform: r.platform,
          spend: Math.round(Number(r.spend) * 100) / 100,
          currency: r.currency ?? client.currency ?? 'GBP',
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
