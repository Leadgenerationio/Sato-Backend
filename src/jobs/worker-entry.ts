import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { workflows, workflowExecutions } from '../db/schema/workflows.js';
import { syncAll } from '../integrations/leadbyte/leadbyte-client.js';
import { recordLeadByteSync } from '../controllers/integration.controller.js';
import { syncAll as catchrSyncAll } from '../services/ad-spend.service.js';
import { recordCatchrSync } from '../controllers/ad-spend.controller.js';
import { syncAllBusinessesFromXero, recordBankFeedSync } from '../services/bank-feed.service.js';
import { syncInvoicesAllBusinesses, recordInvoiceSync } from '../services/invoice.service.js';
import { prewarmLeadByteCache } from '../services/cache-prewarm.service.js';
import { processRecurringTasks } from './recurring-tasks.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import type { ResendSendRequest } from '../integrations/resend/resend-types.js';
import { emailQueue } from './queue.js';
import * as invoiceService from '../services/invoice.service.js';
import { runAutoInvoiceAllBusinesses } from '../services/auto-invoice.service.js';
import { refreshWorkflowAggregates } from '../services/workflow.service.js';
import { WORKFLOW_HANDLERS, isRegisteredHandler } from './workflow-handlers.js';
import type { AuthPayload } from '../types/index.js';

const connection = redis ?? undefined;

let workersStarted = false;

/**
 * Spin up all BullMQ workers (email, invoice, workflow, sync).
 *
 * Idempotent — guards against being called twice if both `pnpm worker`
 * and an in-process import try to start workers in the same Node
 * process. Returns a boolean for visibility but never throws so the
 * API server can call this without try/catch.
 */
export function startWorkers(): boolean {
  if (workersStarted) {
    logger.warn('Workers already started — ignoring duplicate startWorkers() call');
    return true;
  }
  if (!connection) {
    logger.warn('Redis not configured — workers will not start');
    return false;
  }
  registerWorkers();
  workersStarted = true;
  logger.info('Workers started');
  return true;
}

const SYSTEM_AUTH: AuthPayload = {
  userId: 'system',
  role: 'owner',
  email: 'system@stato.local',
  businessId: 'system',
};

function registerWorkers(): void {
  // startWorkers() already null-checked, but re-narrow for TS inside this fn.
  if (!connection) return;
// Email worker — dispatches on job.name
new Worker('email', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing email job');

  switch (job.name) {
    case 'send-email': {
      const req = job.data as ResendSendRequest;
      return sendEmail(req);
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown email job — ignoring');
      return { skipped: true };
  }
}, { connection });

// Invoice worker — dispatches on job.name
new Worker('invoice', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing invoice job');

  switch (job.name) {
    case 'chase-overdue-invoices': {
      const overdue = await invoiceService.getOverdueInvoices(SYSTEM_AUTH);
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
      logger.info({ overdue: overdue.length, enqueued }, 'chase-overdue-invoices complete');
      return { overdue: overdue.length, enqueued };
    }
    case 'auto-invoice-weekly': {
      // Sam Loom #14 — Mondays 09:00 UTC. Iterates every business; per-tenant
      // errors are caught + logged in auto_invoice_runs without aborting the
      // whole sweep.
      const result = await runAutoInvoiceAllBusinesses();
      logger.info(result, 'auto-invoice-weekly complete');
      return result;
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown invoice job — ignoring');
      return { skipped: true };
  }
}, { connection });

// Workflow worker — runs each workflow's steps sequentially, updating
// the execution row as it progresses. Each step type has its own handler;
// unknown step types are skipped (recorded in step_results).
interface WorkflowStep {
  id: string;
  order: number;
  name: string;
  type: string;
  config: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
}
interface WorkflowRunPayload {
  executionId: string;
  workflowId: string;
}

async function runWorkflowStep(step: WorkflowStep): Promise<{ ok: boolean; output: string }> {
  // Step handlers are intentionally minimal in slice 1 — they record what
  // would happen rather than triggering side-effects. Real integration calls
  // are added per step type as the workflows surface real flows.
  switch (step.type) {
    case 'data_fetch':
    case 'api_call':
    case 'query':
    case 'database':
      return { ok: true, output: `${step.type}: ${step.config}` };
    case 'computation':
      return { ok: true, output: `computed: ${step.config}` };
    case 'notification':
      return { ok: true, output: `notification queued: ${step.config}` };
    case 'wait':
    case 'approval':
      return { ok: true, output: `${step.type} satisfied (auto in stub)` };
    case 'action':
      return { ok: true, output: `action: ${step.config}` };
    default:
      return { ok: true, output: `unknown step type "${step.type}" — skipped` };
  }
}

new Worker('workflow', async (job) => {
  const { executionId, workflowId } = job.data as WorkflowRunPayload;
  logger.info({ jobId: job.id, executionId, workflowId }, 'Processing workflow run');

  if (job.name !== 'workflow.run') {
    logger.warn({ jobId: job.id, name: job.name }, 'Unknown workflow job — ignoring');
    return { skipped: true };
  }

  const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  if (!wf) {
    await db
      .update(workflowExecutions)
      .set({ status: 'failed', completedAt: new Date(), error: 'Workflow not found' })
      .where(eq(workflowExecutions.id, executionId));
    return { error: 'workflow_missing' };
  }

  // Bound handler? Run it instead of the generic step loop.
  if (isRegisteredHandler(wf.handlerKey)) {
    try {
      const result = await WORKFLOW_HANDLERS[wf.handlerKey]();
      await db
        .update(workflowExecutions)
        .set({
          status: result.ok ? 'completed' : 'failed',
          completedAt: new Date(),
          stepsCompleted: result.ok ? 1 : 0,
          stepsTotal: 1,
          result: result.summary,
        })
        .where(eq(workflowExecutions.id, executionId));
      await refreshWorkflowAggregates(workflowId, wf.lastRunAt ?? new Date());
      logger.info({ executionId, handler: wf.handlerKey, summary: result.summary }, 'Workflow handler finished');
      return { status: result.ok ? 'completed' : 'failed', summary: result.summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(workflowExecutions)
        .set({ status: 'failed', completedAt: new Date(), error: msg, result: `Handler threw: ${msg}` })
        .where(eq(workflowExecutions.id, executionId));
      await refreshWorkflowAggregates(workflowId, wf.lastRunAt ?? new Date());
      return { error: msg };
    }
  }

  const steps = ((wf.steps as WorkflowStep[] | null) ?? []);
  const stepResults: Array<{ id: string; status: string; output: string }> = [];

  let completed = 0;
  let failed = false;
  for (const step of steps) {
    completed += 1;
    await db
      .update(workflowExecutions)
      .set({ currentStep: completed, stepsCompleted: completed - 1 })
      .where(eq(workflowExecutions.id, executionId));

    try {
      const result = await runWorkflowStep(step);
      stepResults.push({ id: step.id, status: result.ok ? 'completed' : 'failed', output: result.output });
      if (!result.ok) {
        failed = true;
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stepResults.push({ id: step.id, status: 'failed', output: msg });
      failed = true;
      break;
    }
  }

  const status = failed ? 'failed' : 'completed';
  const summary = failed
    ? `Failed at step ${completed}/${steps.length}`
    : `Completed ${steps.length} steps`;

  await db
    .update(workflowExecutions)
    .set({
      status,
      completedAt: new Date(),
      stepsCompleted: failed ? completed - 1 : steps.length,
      stepResults,
      result: summary,
    })
    .where(eq(workflowExecutions.id, executionId));

  await refreshWorkflowAggregates(workflowId, wf.lastRunAt ?? new Date());

  logger.info({ executionId, status, summary }, 'Workflow run finished');
  return { status, summary };
}, { connection });

// Sync worker — dispatches on job.name
new Worker('sync', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing sync job');

  switch (job.name) {
    case 'leadbyte-hourly-sync': {
      const result = await syncAll({ db, campaigns });
      recordLeadByteSync(result.finishedAt);
      return result;
    }
    case 'catchr-hourly-sync': {
      const result = await catchrSyncAll({ db });
      recordCatchrSync(result.finishedAt, {
        platformsSynced: result.platformsSynced,
        accountsSynced: result.accountsSynced,
        rowsWritten: result.rowsWritten,
        skippedPlatforms: result.skippedPlatforms,
        errorAccounts: result.errors.length,
      });
      return result;
    }
    case 'bank-feed-hourly-sync': {
      const result = await syncAllBusinessesFromXero();
      const ts = new Date().toISOString();
      recordBankFeedSync(ts);
      return { ...result, finishedAt: ts };
    }
    case 'invoice-hourly-sync': {
      // Sam audit #2 — pull every business's Xero invoices on a cron so the
      // dashboard widget reads non-empty data without per-client manual sync.
      const result = await syncInvoicesAllBusinesses();
      const ts = new Date().toISOString();
      recordInvoiceSync(ts);
      const totalSynced = result.results.reduce((sum, r) => sum + r.invoicesSynced, 0);
      logger.info({ businesses: result.total, totalSynced, finishedAt: ts }, 'invoice-hourly-sync complete');
      return { ...result, finishedAt: ts, totalSynced };
    }
    case 'leadbyte-cache-prewarm': {
      // Runs every 45s — keeps the LeadByte Redis cache always-fresh so
      // users never see a cold-miss 1.5-2s wait. See cache-prewarm.service.ts
      // for the full strategy explanation.
      return prewarmLeadByteCache();
    }
    case 'recurring-tasks-tick': {
      // Slice 5 Day 4 — clone any tasks whose recurrence has come due.
      return processRecurringTasks();
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown sync job — ignoring');
      return { skipped: true };
  }
}, { connection });
} // end registerWorkers

// Auto-start when this file is the entry point (e.g. `pnpm worker`).
// When imported by index.ts (in-process), index.ts calls startWorkers() itself.
const isMainModule = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMainModule) {
  startWorkers();
}
