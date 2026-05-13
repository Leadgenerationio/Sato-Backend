import { and, desc, eq, gte, lte, sql, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { clients } from '../db/schema/clients.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { businesses } from '../db/schema/businesses.js';
import {
  autoInvoiceRuns,
  type AutoInvoiceClientDetail,
} from '../db/schema/auto-invoice-runs.js';
import * as invoiceService from './invoice.service.js';
import { emailQueue } from '../jobs/queue.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';
import type { ResendSendRequest } from '../integrations/resend/resend-types.js';

/**
 * Sam Loom #14 — auto-invoice cron.
 *
 * Replaces Sam's Make.com automation. Once a week (Monday morning), for each
 * client with deliveries in the previous Mon-Sun, generate a Stato invoice
 * priced from the deliveries' stored `revenue` (or, if absent, the
 * client_campaigns per-client `lead_price` × validLeadCount). The chase
 * cron + Xero push happen via the existing infrastructure.
 *
 * Idempotency: each run records its (businessId, periodFrom, periodTo).
 * If a successful run already exists for the same window, the next tick
 * is a no-op (status='skipped'). This guards against:
 *   - cron firing twice on the same day after a Redis restart
 *   - someone clicking "Run now" right after the scheduled one fired
 *
 * Per-client errors are caught + logged on the run's `details` jsonb so a
 * single client failing doesn't blank the entire run.
 */

/** Return the Mon-Sun week immediately before `referenceDate` (defaults today). */
export function previousBillingWeek(referenceDate: Date = new Date()): { fromDate: string; toDate: string } {
  const d = new Date(referenceDate);
  d.setUTCHours(0, 0, 0, 0);
  // JS getUTCDay(): 0=Sun .. 6=Sat. We want the most-recently-completed Mon→Sun
  // (so Monday's run bills the week ending the previous day).
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days back to last Sunday (inclusive end of week):
  //   Sun (0)  → 7 (the Sunday a week ago, not today)
  //   Mon (1)  → 1 (yesterday)
  //   Tue (2)  → 2 ... Sat (6) → 6
  const daysBackToSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const toDate = new Date(d.getTime() - daysBackToSunday * 86_400_000);
  const fromDate = new Date(toDate.getTime() - 6 * 86_400_000);
  return {
    fromDate: fromDate.toISOString().slice(0, 10),
    toDate: toDate.toISOString().slice(0, 10),
  };
}

interface RunContext {
  businessId: string;
  periodFrom: string;
  periodTo: string;
  triggeredBy: 'scheduled' | 'manual';
  triggeredByUserId?: string;
}

interface ClientRollup {
  clientId: string;
  clientName: string;
  contactEmail: string | null;
  currency: string;
  validLeadCount: number;
  revenue: number; // sum from lead_deliveries.revenue
}

async function loadDeliveriesByClient(ctx: RunContext): Promise<ClientRollup[]> {
  const rows = await db
    .select({
      clientId: leadDeliveries.clientId,
      clientName: clients.companyName,
      contactEmail: clients.contactEmail,
      currency: clients.currency,
      validLeadCount: sql<number>`coalesce(sum(${leadDeliveries.validLeadCount}), 0)::int`,
      revenue: sql<string>`coalesce(sum(${leadDeliveries.revenue}::numeric), 0)::text`,
    })
    .from(leadDeliveries)
    .innerJoin(clients, eq(clients.id, leadDeliveries.clientId))
    .where(
      and(
        eq(clients.businessId, ctx.businessId),
        gte(leadDeliveries.deliveryDate, ctx.periodFrom),
        lte(leadDeliveries.deliveryDate, ctx.periodTo),
      ),
    )
    .groupBy(leadDeliveries.clientId, clients.companyName, clients.contactEmail, clients.currency);

  return rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    contactEmail: r.contactEmail,
    currency: r.currency ?? 'GBP',
    validLeadCount: r.validLeadCount,
    revenue: parseFloat(r.revenue) || 0,
  }));
}

async function loadClientLeadPrice(clientId: string): Promise<number | null> {
  // Per-client price comes from the client_campaigns join (Sam's "different
  // buyers on the same vertical pay different rates"). Falls back to the
  // client's default lead_price if no campaign-specific row.
  const [campaignPrice] = await db
    .select({ price: clientCampaigns.leadPrice })
    .from(clientCampaigns)
    .where(and(eq(clientCampaigns.clientId, clientId), isNull(clientCampaigns.endedAt)))
    .limit(1);
  if (campaignPrice?.price) return parseFloat(campaignPrice.price);

  const [client] = await db
    .select({ price: clients.leadPrice })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (client?.price) return parseFloat(client.price);
  return null;
}

/**
 * Has an auto-invoice run already completed successfully for this window?
 * Prevents duplicate billing if the cron fires twice or someone hits
 * "Run now" right after the scheduled tick.
 */
async function hasCompletedRun(ctx: RunContext): Promise<boolean> {
  const [existing] = await db
    .select({ id: autoInvoiceRuns.id })
    .from(autoInvoiceRuns)
    .where(
      and(
        eq(autoInvoiceRuns.businessId, ctx.businessId),
        eq(autoInvoiceRuns.periodFrom, ctx.periodFrom),
        eq(autoInvoiceRuns.periodTo, ctx.periodTo),
        eq(autoInvoiceRuns.status, 'completed'),
      ),
    )
    .limit(1);
  return !!existing;
}

async function buildClientDetail(
  ctx: RunContext,
  rollup: ClientRollup,
  systemAuth: AuthPayload,
): Promise<AutoInvoiceClientDetail> {
  // Prefer the deliveries' stored revenue when present (handles per-day
  // price changes); fall back to validLeadCount × lead_price.
  let amount = rollup.revenue;
  if (amount === 0 && rollup.validLeadCount > 0) {
    const leadPrice = await loadClientLeadPrice(rollup.clientId);
    if (leadPrice == null) {
      return {
        clientId: rollup.clientId,
        clientName: rollup.clientName,
        leads: rollup.validLeadCount,
        amount: '0',
        currency: rollup.currency,
        status: 'no_lead_price',
        reason: 'Client has deliveries but no lead_price configured on client_campaigns or clients',
      };
    }
    amount = Math.round(rollup.validLeadCount * leadPrice * 100) / 100;
  }

  if (amount <= 0 || rollup.validLeadCount === 0) {
    return {
      clientId: rollup.clientId,
      clientName: rollup.clientName,
      leads: rollup.validLeadCount,
      amount: '0',
      currency: rollup.currency,
      status: 'no_deliveries',
    };
  }

  try {
    const lineItem = {
      description: `Lead deliveries ${ctx.periodFrom} → ${ctx.periodTo} (${rollup.validLeadCount} leads)`,
      quantity: rollup.validLeadCount,
      unitPrice: Math.round((amount / rollup.validLeadCount) * 100) / 100,
      amount,
    };

    const invoice = await invoiceService.createInvoice(
      {
        clientId: rollup.clientId,
        currency: rollup.currency,
        lineItems: [lineItem],
        addVat: true,
      },
      systemAuth,
    );

    // Best-effort email — failure here doesn't fail the run; the invoice is
    // created and the client can still be billed via the standard chase flow.
    if (emailQueue && rollup.contactEmail) {
      try {
        await emailQueue.add('send-email', {
          to: rollup.contactEmail,
          subject: `Invoice ${invoice.invoiceNumber} — week of ${ctx.periodFrom}`,
          html: `<p>Hi ${rollup.clientName},</p><p>Your weekly invoice is ready: <strong>${invoice.invoiceNumber}</strong> for ${rollup.validLeadCount} leads delivered ${ctx.periodFrom}–${ctx.periodTo}. Total: ${rollup.currency} ${amount.toFixed(2)}.</p>`,
        } satisfies ResendSendRequest);
      } catch (err) {
        logger.warn({ err, invoiceId: invoice.id }, 'Auto-invoice email enqueue failed (invoice still created)');
      }
    }

    return {
      clientId: rollup.clientId,
      clientName: rollup.clientName,
      leads: rollup.validLeadCount,
      amount: amount.toFixed(2),
      currency: rollup.currency,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: 'invoiced',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invoice creation failed';
    logger.error({ err, clientId: rollup.clientId }, 'Auto-invoice client failed');
    return {
      clientId: rollup.clientId,
      clientName: rollup.clientName,
      leads: rollup.validLeadCount,
      amount: amount.toFixed(2),
      currency: rollup.currency,
      status: 'failed',
      reason,
    };
  }
}

export interface AutoInvoiceRunResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  periodFrom: string;
  periodTo: string;
  clientsBilled: number;
  clientsSkipped: number;
  clientsFailed: number;
  totalAmount: string;
  details: AutoInvoiceClientDetail[];
  error?: string;
}

/**
 * Run the auto-invoice job for one business. Called from:
 *   - the BullMQ Monday cron (per-business loop in worker-entry.ts)
 *   - the manual "Run now" admin endpoint
 *
 * Returns a structured result for both contexts.
 */
export async function runAutoInvoiceForBusiness(
  ctx: RunContext,
  systemAuth: AuthPayload,
): Promise<AutoInvoiceRunResult> {
  if (await hasCompletedRun(ctx)) {
    logger.info({ ctx }, 'Auto-invoice skipped — run already completed for this window');
    const [runRow] = await db
      .insert(autoInvoiceRuns)
      .values({
        businessId: ctx.businessId,
        periodFrom: ctx.periodFrom,
        periodTo: ctx.periodTo,
        triggeredBy: ctx.triggeredBy,
        triggeredByUserId: ctx.triggeredByUserId ?? null,
        status: 'skipped',
        finishedAt: new Date(),
      })
      .returning();
    return {
      runId: runRow.id,
      status: 'skipped',
      periodFrom: ctx.periodFrom,
      periodTo: ctx.periodTo,
      clientsBilled: 0,
      clientsSkipped: 0,
      clientsFailed: 0,
      totalAmount: '0',
      details: [],
    };
  }

  // Create the "running" row up-front so admins watching the audit page see
  // the run in flight, and so per-client details land on a stable id.
  const [runRow] = await db
    .insert(autoInvoiceRuns)
    .values({
      businessId: ctx.businessId,
      periodFrom: ctx.periodFrom,
      periodTo: ctx.periodTo,
      triggeredBy: ctx.triggeredBy,
      triggeredByUserId: ctx.triggeredByUserId ?? null,
      status: 'running',
    })
    .returning();

  try {
    const rollups = await loadDeliveriesByClient(ctx);
    const details: AutoInvoiceClientDetail[] = [];
    let billed = 0;
    let skipped = 0;
    let failed = 0;
    let total = 0;
    let currency = 'GBP';

    for (const r of rollups) {
      const detail = await buildClientDetail(ctx, r, systemAuth);
      details.push(detail);
      if (detail.status === 'invoiced') {
        billed += 1;
        total += parseFloat(detail.amount);
        currency = detail.currency;
      } else if (detail.status === 'failed') failed += 1;
      else skipped += 1;
    }

    await db
      .update(autoInvoiceRuns)
      .set({
        status: failed > 0 && billed === 0 ? 'failed' : 'completed',
        clientsBilled: billed,
        clientsSkipped: skipped,
        clientsFailed: failed,
        invoicesCreated: billed,
        totalAmount: total.toFixed(2),
        currency,
        details,
        finishedAt: new Date(),
      })
      .where(eq(autoInvoiceRuns.id, runRow.id));

    logger.info({ runId: runRow.id, billed, skipped, failed, total }, 'Auto-invoice run complete');
    return {
      runId: runRow.id,
      status: failed > 0 && billed === 0 ? 'failed' : 'completed',
      periodFrom: ctx.periodFrom,
      periodTo: ctx.periodTo,
      clientsBilled: billed,
      clientsSkipped: skipped,
      clientsFailed: failed,
      totalAmount: total.toFixed(2),
      details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'auto-invoice run failed';
    logger.error({ err, runId: runRow.id }, 'Auto-invoice run failed');
    await db
      .update(autoInvoiceRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(autoInvoiceRuns.id, runRow.id));
    return {
      runId: runRow.id,
      status: 'failed',
      periodFrom: ctx.periodFrom,
      periodTo: ctx.periodTo,
      clientsBilled: 0,
      clientsSkipped: 0,
      clientsFailed: 0,
      totalAmount: '0',
      details: [],
      error: message,
    };
  }
}

/**
 * Iterate every business and run the auto-invoice job. Used by the Monday
 * cron in worker-entry.ts. Errors per-business are caught so one tenant's
 * failure doesn't kill the entire run.
 */
export async function runAutoInvoiceAllBusinesses(): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  runs: AutoInvoiceRunResult[];
}> {
  const week = previousBillingWeek();
  const all = await db.select({ id: businesses.id }).from(businesses);
  const runs: AutoInvoiceRunResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const b of all) {
    try {
      const result = await runAutoInvoiceForBusiness(
        {
          businessId: b.id,
          periodFrom: week.fromDate,
          periodTo: week.toDate,
          triggeredBy: 'scheduled',
        },
        // System auth — invoice creation needs a businessId-aware requester.
        { userId: 'system', role: 'owner', email: 'system@stato.local', businessId: b.id },
      );
      runs.push(result);
      if (result.status === 'completed') succeeded += 1;
      else if (result.status === 'skipped') skipped += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, businessId: b.id }, 'Auto-invoice failed for business');
    }
  }

  return { total: all.length, succeeded, failed, skipped, runs };
}

// ─── List + manual-trigger helpers (admin API) ──────────────────────────────

export interface AutoInvoiceRunRow {
  id: string;
  periodFrom: string;
  periodTo: string;
  triggeredBy: string;
  status: string;
  clientsBilled: number;
  clientsSkipped: number;
  clientsFailed: number;
  invoicesCreated: number;
  totalAmount: string;
  currency: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export async function listAutoInvoiceRuns(
  requester: AuthPayload,
  limit = 20,
): Promise<AutoInvoiceRunRow[]> {
  if (!requester.businessId) return [];
  const rows = await db
    .select()
    .from(autoInvoiceRuns)
    .where(eq(autoInvoiceRuns.businessId, requester.businessId))
    .orderBy(desc(autoInvoiceRuns.startedAt))
    .limit(Math.min(100, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    triggeredBy: r.triggeredBy,
    status: r.status,
    clientsBilled: r.clientsBilled,
    clientsSkipped: r.clientsSkipped,
    clientsFailed: r.clientsFailed,
    invoicesCreated: r.invoicesCreated,
    totalAmount: String(r.totalAmount),
    currency: r.currency,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error,
  }));
}

export async function getAutoInvoiceRun(
  id: string,
  requester: AuthPayload,
): Promise<(AutoInvoiceRunRow & { details: AutoInvoiceClientDetail[] }) | null> {
  if (!requester.businessId) return null;
  const [row] = await db
    .select()
    .from(autoInvoiceRuns)
    .where(and(eq(autoInvoiceRuns.id, id), eq(autoInvoiceRuns.businessId, requester.businessId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    triggeredBy: row.triggeredBy,
    status: row.status,
    clientsBilled: row.clientsBilled,
    clientsSkipped: row.clientsSkipped,
    clientsFailed: row.clientsFailed,
    invoicesCreated: row.invoicesCreated,
    totalAmount: String(row.totalAmount),
    currency: row.currency,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    error: row.error,
    details: (row.details as AutoInvoiceClientDetail[]) ?? [],
  };
}

/**
 * Admin "Run now" — runs the job ad-hoc for the requester's own business
 * over the previous billing week. Same idempotency check as the cron, so a
 * second click on the same Monday is a no-op.
 */
export async function runAutoInvoiceManual(requester: AuthPayload): Promise<AutoInvoiceRunResult> {
  if (!requester.businessId) {
    throw new Error('No business context on this user');
  }
  const week = previousBillingWeek();
  return runAutoInvoiceForBusiness(
    {
      businessId: requester.businessId,
      periodFrom: week.fromDate,
      periodTo: week.toDate,
      triggeredBy: 'manual',
      triggeredByUserId: requester.userId,
    },
    requester,
  );
}

