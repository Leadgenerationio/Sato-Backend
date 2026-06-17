import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import * as invoiceService from '../services/invoice.service.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import { logger } from '../utils/logger.js';
import { emailQueue } from './queue.js';
import type { AuthPayload } from '../types/index.js';
import type { ResendSendRequest } from '../integrations/resend/resend-types.js';

const SYSTEM_AUTH: AuthPayload = {
  userId: 'system',
  role: 'owner',
  email: 'system@stato.local',
  businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
};

export interface HandlerResult {
  ok: boolean;
  summary: string;
}

/**
 * Real workflow runners. Mapped from `workflows.handler_key` → fn. The
 * worker calls these instead of the generic step loop when a workflow row
 * has `handler_key` set.
 *
 * Adding a new handler: drop a new entry here, then either set the column
 * directly in seed.ts or expose a "Bind to handler" button in the workflow
 * editor. Removing a handler is safe — the worker falls back to the generic
 * step executor.
 */
export const WORKFLOW_HANDLERS: Record<string, () => Promise<HandlerResult>> = {
  /**
   * chase-overdue — fetches every overdue invoice, queues a chase email per
   * billing contact via the existing `email` BullMQ queue. Identical to the
   * cron job at jobs/schedules.ts so the workflow UI and the schedule run
   * the same code path.
   */
  'chase-overdue': async () => {
    const overdue = await invoiceService.getOverdueInvoices(SYSTEM_AUTH);
    if (overdue.length === 0) return { ok: true, summary: 'No overdue invoices.' };

    let enqueued = 0;
    for (const inv of overdue) {
      if (!emailQueue) break;
      await emailQueue.add('send-email', {
        to: `billing+${inv.clientId}@stato.local`,
        subject: `Invoice ${inv.invoiceNumber} overdue`,
        html: `<p>Invoice ${inv.invoiceNumber} for ${inv.clientName} is ${inv.daysOverdue} days overdue (${inv.currency} ${inv.total}).</p>`,
      } satisfies ResendSendRequest);
      enqueued++;
    }
    return { ok: true, summary: `Chased ${overdue.length} overdue invoices (${enqueued} emails queued).` };
  },

  /**
   * auto-invoice — reconciles every active weekly_auto client against Xero.
   *
   * Xero is the billing source of truth (2026-06-16, Sam): this handler used
   * to fabricate a draft invoice from leadCount × leadPrice and push it to
   * Xero, which risked double-billing and amounts that didn't match what Sam
   * actually raised. It now PULLS each eligible client's real invoices from
   * Xero via `invoiceService.syncInvoicesFromXero()` (idempotent — dedupes by
   * xeroInvoiceId, re-syncs status/amounts on existing rows). Clients with no
   * leads in the last 7 days are skipped.
   */
  'auto-invoice': async () => {
    const eligible = await db
      .select()
      .from(clients)
      .where(and(eq(clients.status, 'active'), eq(clients.billingWorkflow, 'weekly_auto')));

    if (eligible.length === 0) return { ok: true, summary: 'No clients on weekly_auto billing.' };

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];

    let clientsReconciled = 0;
    let invoicesSynced = 0;
    let invoicesUpdated = 0;
    let skippedNoLeads = 0;
    let skippedNoInvoice = 0;
    const errors: string[] = [];

    for (const client of eligible) {
      try {
        const requester: AuthPayload = {
          ...SYSTEM_AUTH,
          businessId: client.businessId ?? SYSTEM_AUTH.businessId,
        };

        const [agg] = await db
          .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
          .from(leadDeliveries)
          .where(and(eq(leadDeliveries.clientId, client.id), gte(leadDeliveries.deliveryDate, sevenDaysAgo)));

        const leadCount = agg?.leads ?? 0;
        if (leadCount === 0) {
          skippedNoLeads++;
          continue;
        }

        const result = await invoiceService.syncInvoicesFromXero(client.id, requester);
        if (!result || result.totalRemote === 0) {
          // Nothing to reconcile: Xero not configured, contact not linked, or
          // no invoice raised for this client yet. All expected states — count
          // them for visibility but do NOT treat as an error (which would flip
          // the whole run to failed for any tenant that isn't on Xero).
          skippedNoInvoice++;
          continue;
        }
        clientsReconciled++;
        invoicesSynced += result.synced;
        invoicesUpdated += result.updated ?? 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, clientId: client.id }, 'auto-invoice: per-client Xero sync failure');
        errors.push(`${client.companyName}: ${msg}`);
      }
    }

    const summary = `Auto-invoice (Xero sync): ${clientsReconciled} reconciled, ${invoicesSynced} imported, ${invoicesUpdated} updated, ${skippedNoLeads} no-leads, ${skippedNoInvoice} no-invoice. ${errors.length} errors.`;
    // Only genuine per-client exceptions (caught above) count as failure;
    // not-configured / no-invoice are expected and don't fail the run.
    return { ok: errors.length === 0, summary };
  },

  /**
   * monthly-validated — emails Sam a per-client lead-volume summary for the
   * previous calendar month, plus the eligible clients' contact emails so he
   * can request validation. Once Sam confirms, he triggers auto-invoice.
   */
  'monthly-validated': async () => {
    const eligible = await db
      .select()
      .from(clients)
      .where(and(eq(clients.status, 'active'), eq(clients.billingWorkflow, 'monthly_validated')));

    if (eligible.length === 0) return { ok: true, summary: 'No clients on monthly_validated billing.' };

    // Previous calendar month bounds.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

    const rows: { client: string; leads: number; revenue: number; email: string | null }[] = [];
    for (const c of eligible) {
      const [agg] = await db
        .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
        .from(leadDeliveries)
        .where(
          and(
            eq(leadDeliveries.clientId, c.id),
            gte(leadDeliveries.deliveryDate, monthStart),
          ),
        );
      const leadCount = agg?.leads ?? 0;
      const leadPrice = Number(c.leadPrice ?? 0);
      rows.push({
        client: c.companyName,
        leads: leadCount,
        revenue: Math.round(leadCount * leadPrice * 100) / 100,
        email: c.contactEmail,
      });
    }

    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const html = `
      <p>Monthly validation report for ${monthStart} – ${monthEnd}.</p>
      <p><strong>${rows.length} clients</strong> · <strong>${rows.reduce((s, r) => s + r.leads, 0)} total leads</strong> · <strong>£${totalRevenue.toFixed(2)} revenue</strong></p>
      <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;">
        <tr><th>Client</th><th>Leads</th><th>Revenue</th><th>Contact</th></tr>
        ${rows.map((r) => `<tr><td>${r.client}</td><td align="right">${r.leads}</td><td align="right">£${r.revenue.toFixed(2)}</td><td>${r.email ?? '—'}</td></tr>`).join('')}
      </table>
      <p>Reply to each client requesting sign-off, then run auto-invoice.</p>
    `;

    if (emailQueue) {
      await emailQueue.add('send-email', {
        to: 'owner@stato.app',
        subject: `Monthly validation report — ${rows.length} clients (${monthStart} – ${monthEnd})`,
        html,
      } satisfies ResendSendRequest);
    }
    return {
      ok: true,
      summary: `Validation summary for ${rows.length} clients queued (${rows.reduce((s, r) => s + r.leads, 0)} leads, £${totalRevenue.toFixed(2)} revenue).`,
    };
  },

  /**
   * health-check — trivial handler used by the workflow.test.ts test
   * suite to verify dispatch wiring without touching real integrations.
   */
  'health-check': async () => {
    return { ok: true, summary: 'OK' };
  },
};

void invoices;
void sendEmail;

export function isRegisteredHandler(key: string | null | undefined): key is string {
  return !!key && key in WORKFLOW_HANDLERS;
}
