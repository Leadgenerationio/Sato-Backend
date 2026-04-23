import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';
import { eq, and } from 'drizzle-orm';
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
   * auto-invoice — creates a draft Xero invoice for every active
   * weekly_auto client based on the last 7 days of LeadByte deliveries.
   *
   * Slice 1 stub: discovers eligible clients but doesn't push yet — needs
   * the LeadByte→client→delivery aggregation that the LeadByte sync job
   * builds in `lead_deliveries`. Returns a count so the UI shows progress.
   */
  'auto-invoice': async () => {
    const eligible = await db
      .select()
      .from(clients)
      .where(and(eq(clients.status, 'active'), eq(clients.billingWorkflow, 'weekly_auto')));

    if (eligible.length === 0) return { ok: true, summary: 'No clients on weekly_auto billing.' };

    logger.info({ count: eligible.length }, 'auto-invoice handler — eligible clients');
    return {
      ok: true,
      summary: `Identified ${eligible.length} weekly_auto clients. Real Xero push pending — wire to invoice.service.pushInvoiceToXero per client once lead_deliveries is populated.`,
    };
  },

  /**
   * monthly-validated — sends per-client validation reports for clients on
   * the monthly_validated billing workflow.
   *
   * Slice 1: emails Sam a summary instead of building per-client PDFs.
   */
  'monthly-validated': async () => {
    const eligible = await db
      .select()
      .from(clients)
      .where(and(eq(clients.status, 'active'), eq(clients.billingWorkflow, 'monthly_validated')));

    if (eligible.length === 0) return { ok: true, summary: 'No clients on monthly_validated billing.' };

    if (emailQueue) {
      await emailQueue.add('send-email', {
        to: 'owner@stato.app',
        subject: `Monthly validation report — ${eligible.length} clients`,
        html: `<p>${eligible.length} clients on monthly_validated billing need lead-data sign-off.</p><ul>${eligible.map((c) => `<li>${c.companyName}</li>`).join('')}</ul>`,
      } satisfies ResendSendRequest);
    }
    return { ok: true, summary: `Validation summary queued for ${eligible.length} clients.` };
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
