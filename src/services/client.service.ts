import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creditChecks } from '../db/schema/credit-checks.js';
import { invoices } from '../db/schema/invoices.js';
import * as creditCheck from '../integrations/credit-check/index.js';
import { scoreToRiskRating } from '../integrations/credit-check/types.js';
import { createNotification } from './notification.service.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface ClientSummary {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  status: string;
  currency: string;
  creditScore: number | null;
  activeCampaigns: number;
  totalRevenue: number;
  createdAt: string;
}

export interface ClientDetail extends ClientSummary {
  companyNumber: string;
  contactPhone: string;
  address: string;
  paymentTermsDays: number;
  vatRegistered: boolean;
  addVatToInvoices: boolean;
  leadPrice: number;
  billingWorkflow: string;
  onboardingStatus: string;
  agreementSigned: boolean;
  creditLastChecked: string | null;
  creditRiskRating: string | null;
  leadbyteClientId?: string | null;
  endoleCompanyId?: string | null;
  xeroContactId?: string | null;
  notes: string;
}

export interface CreditCheckEntry {
  id: string;
  creditScore: number;
  riskRating: string;
  ccjCount: number;
  ccjTotal: number;
  checkedAt: string;
  scoreChange: number | null;
}

type ClientRow = typeof clients.$inferSelect;

function toSummary(row: ClientRow, activeCampaigns: number, totalRevenue: number): ClientSummary {
  return {
    id: row.id,
    companyName: row.companyName,
    contactName: row.contactName ?? '',
    contactEmail: row.contactEmail ?? '',
    status: row.status ?? 'prospect',
    currency: row.currency ?? 'GBP',
    creditScore: row.creditScore,
    activeCampaigns,
    totalRevenue,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

function toDetail(row: ClientRow, activeCampaigns: number, totalRevenue: number): ClientDetail {
  return {
    ...toSummary(row, activeCampaigns, totalRevenue),
    companyNumber: row.companyNumber ?? '',
    contactPhone: row.contactPhone ?? '',
    address: row.address ?? '',
    paymentTermsDays: row.paymentTermsDays ?? 30,
    vatRegistered: row.vatRegistered ?? false,
    addVatToInvoices: row.addVatToInvoices ?? false,
    leadPrice: Number(row.leadPrice ?? 0),
    billingWorkflow: row.billingWorkflow ?? 'weekly_auto',
    onboardingStatus: row.onboardingStatus ?? 'pending',
    agreementSigned: row.agreementSigned ?? false,
    creditLastChecked: row.creditLastChecked ? row.creditLastChecked.toISOString() : null,
    creditRiskRating: row.creditScore != null ? scoreToRiskRating(row.creditScore) : null,
    leadbyteClientId: row.leadbyteClientId,
    endoleCompanyId: row.endoleCompanyId,
    xeroContactId: row.xeroContactId,
    notes: row.notes ?? '',
  };
}

/**
 * Count active campaigns per client in a single query — keyed by clientId.
 * Runs once per listClients call, not once per client, to avoid N+1.
 */
async function loadActiveCampaignCounts(businessId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      clientId: campaigns.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(campaigns)
    .innerJoin(clients, eq(clients.id, campaigns.clientId))
    .where(and(eq(clients.businessId, businessId), eq(campaigns.status, 'active')))
    .groupBy(campaigns.clientId);

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.clientId, r.count);
  return map;
}

async function loadRevenueByClient(businessId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      clientId: invoices.clientId,
      total: sql<string>`coalesce(sum(${invoices.total}), 0)`,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(eq(clients.businessId, businessId), eq(invoices.status, 'paid')))
    .groupBy(invoices.clientId);

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.clientId, Number(r.total ?? 0));
  return map;
}

async function getRevenueForClient(clientId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${invoices.total}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), eq(invoices.status, 'paid')));
  return Number(row?.total ?? 0);
}

// ─── Service ───

export interface ListClientsParams {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ListClientsResult {
  items: ClientSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Paginated, filter-aware list of clients for the requester's business.
 *
 * Filters and pagination are pushed into Postgres so the cost stays bounded
 * regardless of table size (the previous implementation fetched the whole
 * table and sliced in JS — at 10k+ clients that's a network/CPU hit per
 * request even when the response is just 10 rows).
 */
export async function listClients(
  requester: AuthPayload,
  params: ListClientsParams = {},
): Promise<ListClientsResult> {
  const businessId = requester.businessId;
  if (!businessId) return { items: [], total: 0, page: 1, pageSize: 10 };

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.limit ?? 10));
  const offset = (page - 1) * pageSize;

  const filters = [eq(clients.businessId, businessId)];
  if (params.status && params.status !== 'all') {
    // status is a PG enum — cast through sql to satisfy Drizzle's strict
    // enum-literal type when the value comes from a query string.
    filters.push(sql`${clients.status} = ${params.status}`);
  }
  if (params.search) {
    const q = `%${params.search.toLowerCase()}%`;
    filters.push(sql`(
      lower(${clients.companyName}) like ${q}
      or lower(coalesce(${clients.contactName}, '')) like ${q}
      or lower(coalesce(${clients.contactEmail}, '')) like ${q}
    )`);
  }
  const whereClause = and(...filters);

  // 4 queries in parallel: page rows, total count, active-campaign map,
  // revenue map. The aggregate maps are scoped to the same business but not
  // to this page — at typical sizes the full per-client maps stay in
  // single-digit kB and feed cheap Map.get() lookups for the slice we
  // return.
  const [rows, countResult, countMap, revenueMap] = await Promise.all([
    db
      .select()
      .from(clients)
      .where(whereClause)
      .orderBy(desc(clients.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(whereClause),
    loadActiveCampaignCounts(businessId),
    loadRevenueByClient(businessId),
  ]);

  return {
    items: rows.map((r) => toSummary(r, countMap.get(r.id) ?? 0, revenueMap.get(r.id) ?? 0)),
    total: countResult[0]?.n ?? 0,
    page,
    pageSize,
  };
}

export async function getClient(id: string, requester: AuthPayload): Promise<ClientDetail | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.businessId, businessId)));
  if (!row) return null;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(and(eq(campaigns.clientId, id), eq(campaigns.status, 'active')));

  const revenue = await getRevenueForClient(id);
  return toDetail(row, count ?? 0, revenue);
}

export async function createClient(data: Partial<ClientDetail>, requester: AuthPayload): Promise<ClientDetail> {
  const businessId = requester.businessId;
  if (!businessId) throw new Error('No business associated with requester');

  const [row] = await db
    .insert(clients)
    .values({
      businessId,
      companyName: data.companyName || '',
      companyNumber: data.companyNumber,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      address: data.address,
      currency: data.currency || 'GBP',
      paymentTermsDays: data.paymentTermsDays ?? 30,
      vatRegistered: data.vatRegistered ?? false,
      addVatToInvoices: data.addVatToInvoices ?? false,
      leadPrice: data.leadPrice != null ? String(data.leadPrice) : null,
      billingWorkflow: (data.billingWorkflow as ClientRow['billingWorkflow']) ?? 'weekly_auto',
      status: 'prospect',
      onboardingStatus: 'pending',
      notes: data.notes,
      leadbyteClientId: data.leadbyteClientId,
      endoleCompanyId: data.endoleCompanyId,
      xeroContactId: data.xeroContactId,
    })
    .returning();

  // Fire-and-forget credit check. Sam wants this auto-triggered on buyer
  // creation so staff don't forget to run it manually. We don't await — the
  // create response should not be blocked on the Endole/Creditsafe call,
  // which can take 2-5s. The detail page will show the score on next refresh.
  if (row.companyNumber) {
    runCreditCheck(row.id, requester)
      .then((result) => {
        if (result) {
          logger.info({ clientId: row.id, score: result.creditScore }, 'Auto credit check completed');
        }
      })
      .catch((err) => {
        logger.error({ err, clientId: row.id }, 'Auto credit check failed on client create');
        // Surface to staff — without this the failure was silent and they'd assume
        // a fresh client had no score for legitimate reasons (e.g. brand new ltd
        // with no history) when in fact Endole/Creditsafe just errored.
        void createNotification({
          type: 'system_error',
          severity: 'warning',
          title: `Credit check failed — ${row.companyName}`,
          message:
            (err instanceof Error ? err.message : 'Endole/Creditsafe lookup failed') +
            '. Click Run Credit Check on the client page to retry.',
          actionUrl: `/clients/${row.id}`,
          metadata: { clientId: row.id, companyNumber: row.companyNumber },
        }).catch((notifyErr) => {
          logger.error({ notifyErr }, 'Failed to write credit-check failure notification');
        });
      });
  }

  return toDetail(row, 0, 0);
}

export async function updateClient(id: string, data: Partial<ClientDetail>, requester: AuthPayload): Promise<ClientDetail | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const patch: Partial<ClientRow> = { updatedAt: new Date() };
  if (data.companyName !== undefined) patch.companyName = data.companyName;
  if (data.companyNumber !== undefined) patch.companyNumber = data.companyNumber;
  if (data.contactName !== undefined) patch.contactName = data.contactName;
  if (data.contactEmail !== undefined) patch.contactEmail = data.contactEmail;
  if (data.contactPhone !== undefined) patch.contactPhone = data.contactPhone;
  if (data.address !== undefined) patch.address = data.address;
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.paymentTermsDays !== undefined) patch.paymentTermsDays = data.paymentTermsDays;
  if (data.vatRegistered !== undefined) patch.vatRegistered = data.vatRegistered;
  if (data.addVatToInvoices !== undefined) patch.addVatToInvoices = data.addVatToInvoices;
  if (data.leadPrice !== undefined) patch.leadPrice = String(data.leadPrice);
  if (data.billingWorkflow !== undefined) patch.billingWorkflow = data.billingWorkflow as ClientRow['billingWorkflow'];
  if (data.onboardingStatus !== undefined) patch.onboardingStatus = data.onboardingStatus as ClientRow['onboardingStatus'];
  if (data.status !== undefined) patch.status = data.status as ClientRow['status'];
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.leadbyteClientId !== undefined) patch.leadbyteClientId = data.leadbyteClientId;
  if (data.endoleCompanyId !== undefined) patch.endoleCompanyId = data.endoleCompanyId;
  if (data.xeroContactId !== undefined) patch.xeroContactId = data.xeroContactId;

  const [row] = await db
    .update(clients)
    .set(patch)
    .where(and(eq(clients.id, id), eq(clients.businessId, businessId)))
    .returning();
  if (!row) return null;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(and(eq(campaigns.clientId, id), eq(campaigns.status, 'active')));

  const revenue = await getRevenueForClient(id);
  return toDetail(row, count ?? 0, revenue);
}

export async function getCreditHistory(clientId: string, _requester: AuthPayload): Promise<CreditCheckEntry[]> {
  const rows = await db
    .select()
    .from(creditChecks)
    .where(eq(creditChecks.clientId, clientId))
    .orderBy(desc(creditChecks.checkedAt));

  return rows.map((r) => ({
    id: r.id,
    creditScore: r.creditScore ?? 0,
    riskRating: r.riskRating ?? 'moderate',
    ccjCount: 0, // not stored in credit_checks table
    ccjTotal: 0, // not stored in credit_checks table
    checkedAt: (r.checkedAt ?? new Date()).toISOString(),
    scoreChange: r.scoreChange,
  }));
}

export async function runCreditCheck(clientId: string, requester: AuthPayload): Promise<CreditCheckEntry | null> {
  const client = await getClient(clientId, requester);
  if (!client || !client.companyNumber) return null;

  const report = await creditCheck.runCreditCheck(client.companyNumber, client.companyName);
  const prevScore = client.creditScore;
  const scoreChange = prevScore != null ? report.creditScore - prevScore : null;

  const [inserted] = await db
    .insert(creditChecks)
    .values({
      clientId,
      creditScore: report.creditScore,
      riskRating: report.riskRating,
      previousScore: prevScore,
      scoreChange,
      alertTriggered: scoreChange != null && scoreChange <= -10,
    })
    .returning();

  await db
    .update(clients)
    .set({
      creditScore: report.creditScore,
      creditLastChecked: new Date(report.checkedAt),
      // Persist Endole company link only on first successful check — Endole
      // identifies a company by its Companies House number, which is the
      // same value we just verified against. The External System IDs card
      // surfaces this so admins can see which Endole record is bound.
      endoleCompanyId: client.endoleCompanyId ?? client.companyNumber,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));

  return {
    id: inserted.id,
    creditScore: report.creditScore,
    riskRating: report.riskRating,
    ccjCount: report.ccjCount,
    ccjTotal: report.ccjTotal,
    checkedAt: report.checkedAt,
    scoreChange,
  };
}

export async function getCreditAlerts(requester: AuthPayload): Promise<{ clientId: string; clientName: string; scoreChange: number; currentScore: number }[]> {
  const businessId = requester.businessId;
  if (!businessId) return [];

  // Latest credit check per client, filtered to "concerning" scores. For now
  // we consider any score below 55 an alert; a more sophisticated rule
  // (e.g. recent drop > 10) can be layered on later.
  //
  // Single query (was N+1): joins clients to the latest credit_check per
  // client via DISTINCT ON. At 1k clients the previous loop fired 1k+1
  // round-trips; this is one. Postgres uses the
  // (clientId, checkedAt DESC) ordering to pick the latest row per client.
  const rows = await db.execute(sql`
    SELECT
      c.id            AS "clientId",
      c.company_name  AS "clientName",
      c.credit_score  AS "currentScore",
      cc.score_change AS "scoreChange"
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT score_change
      FROM credit_checks
      WHERE client_id = c.id
      ORDER BY checked_at DESC
      LIMIT 1
    ) cc ON true
    WHERE c.business_id = ${businessId}
      AND c.credit_score IS NOT NULL
      AND c.credit_score < 55
  `);
  type AlertRow = { clientId: string; clientName: string; currentScore: number | null; scoreChange: number | null };
  const list = (rows as unknown as { rows?: AlertRow[] }).rows ?? (rows as unknown as AlertRow[]);
  return list.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    scoreChange: r.scoreChange ?? 0,
    currentScore: r.currentScore ?? 0,
  }));
}
