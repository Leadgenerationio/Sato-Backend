import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { workflows, workflowExecutions } from '../db/schema/workflows.js';
import { workflowQueue } from '../jobs/queue.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  type: 'scheduled' | 'trigger' | 'manual';
  schedule: string | null;
  status: 'active' | 'paused' | 'draft';
  handlerKey: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  successRate: number;
}

export interface WorkflowStep {
  id: string;
  order: number;
  name: string;
  type: string;
  config: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
}

export interface WorkflowExecution {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'paused';
  stepsCompleted: number;
  stepsTotal: number;
  result: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  steps: WorkflowStep[];
  recentExecutions: WorkflowExecution[];
}

export interface ScheduleConfig {
  frequency: 'daily' | 'weekly' | 'monthly';
  day?: string;
  time: string;
}

const STEP_TYPES = [
  'data_fetch', 'calculation', 'approval', 'action', 'notification',
  'wait', 'api_call', 'query', 'computation', 'database',
];

type WorkflowRow = typeof workflows.$inferSelect;
type ExecutionRow = typeof workflowExecutions.$inferSelect;

function buildScheduleString(config: ScheduleConfig): string {
  const [hours, minutes] = config.time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  const timeStr = `${h12}:${String(minutes).padStart(2, '0')} ${period}`;

  if (config.frequency === 'daily') return `Daily ${timeStr}`;
  if (config.frequency === 'weekly') return `Every ${config.day || 'Monday'} ${timeStr}`;
  if (config.frequency === 'monthly') {
    const d = config.day || '1';
    const suffix = d === '1' ? 'st' : d === '2' ? 'nd' : d === '3' ? 'rd' : 'th';
    return `${d}${suffix} of month ${timeStr}`;
  }
  return config.time;
}

function summaryFromRow(row: WorkflowRow): WorkflowSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    type: row.type as WorkflowSummary['type'],
    schedule: row.schedule,
    status: row.status as WorkflowSummary['status'],
    handlerKey: row.handlerKey,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    totalRuns: row.totalRuns,
    successRate: Number(row.successRate ?? 0),
  };
}

function executionFromRow(row: ExecutionRow): WorkflowExecution {
  return {
    id: row.id,
    startedAt: (row.startedAt ?? new Date()).toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    status: row.status as WorkflowExecution['status'],
    stepsCompleted: row.stepsCompleted,
    stepsTotal: row.stepsTotal,
    result: row.result,
  };
}

function detailFromRow(row: WorkflowRow, executions: WorkflowExecution[]): WorkflowDetail {
  return {
    ...summaryFromRow(row),
    steps: ((row.steps as WorkflowStep[] | null) ?? []),
    recentExecutions: executions,
  };
}

async function loadRecentExecutions(workflowId: string, limit = 5): Promise<WorkflowExecution[]> {
  const rows = await db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(limit);
  return rows.map(executionFromRow);
}

export async function listWorkflows(requester: AuthPayload): Promise<WorkflowSummary[]> {
  const where = requester.businessId ? eq(workflows.businessId, requester.businessId) : undefined;
  const rows = await db.select().from(workflows).where(where).orderBy(workflows.name);
  return rows.map(summaryFromRow);
}

export async function getWorkflow(id: string, requester: AuthPayload): Promise<WorkflowDetail | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(
      requester.businessId
        ? and(eq(workflows.id, id), eq(workflows.businessId, requester.businessId))
        : eq(workflows.id, id),
    );
  if (!row) return null;
  const executions = await loadRecentExecutions(id);
  return detailFromRow(row, executions);
}

export async function createWorkflow(
  data: {
    name: string;
    description: string;
    type: WorkflowSummary['type'];
    schedule?: string | null;
    scheduleConfig?: ScheduleConfig;
    steps: { name: string; type: string; config: string }[];
    handlerKey?: string | null;
  },
  requester: AuthPayload,
): Promise<WorkflowDetail> {
  const schedule = data.scheduleConfig
    ? buildScheduleString(data.scheduleConfig)
    : data.schedule ?? null;

  const stepsWithIds: WorkflowStep[] = data.steps.map((s, i) => ({
    id: `ws-${Date.now()}-${i}`,
    order: i + 1,
    name: s.name,
    type: s.type,
    config: s.config,
    status: 'pending',
  }));

  const [row] = await db
    .insert(workflows)
    .values({
      businessId: requester.businessId ?? null,
      name: data.name,
      description: data.description,
      type: data.type,
      schedule,
      steps: stepsWithIds,
      status: 'draft',
      handlerKey: data.handlerKey ?? null,
    })
    .returning();

  return detailFromRow(row, []);
}

export async function updateWorkflow(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    schedule: string | null;
    scheduleConfig: ScheduleConfig;
    steps: { name: string; type: string; config: string }[];
  }>,
  requester: AuthPayload,
): Promise<WorkflowDetail | null> {
  const [existing] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!existing) return null;
  if (requester.businessId && existing.businessId !== requester.businessId) return null;

  const patch: Partial<WorkflowRow> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.scheduleConfig) patch.schedule = buildScheduleString(data.scheduleConfig);
  else if (data.schedule !== undefined) patch.schedule = data.schedule;
  if (data.steps) {
    patch.steps = data.steps.map((s, i) => ({
      id: `ws-${Date.now()}-${i}`,
      order: i + 1,
      name: s.name,
      type: s.type,
      config: s.config,
      status: 'pending' as const,
    }));
  }

  const [row] = await db.update(workflows).set(patch).where(eq(workflows.id, id)).returning();
  if (!row) return null;
  const executions = await loadRecentExecutions(id);
  return detailFromRow(row, executions);
}

export async function toggleWorkflowStatus(id: string, requester: AuthPayload): Promise<WorkflowDetail | null> {
  const [existing] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!existing) return null;
  if (requester.businessId && existing.businessId !== requester.businessId) return null;
  const next = existing.status === 'active' ? 'paused' : 'active';
  const [row] = await db.update(workflows).set({ status: next, updatedAt: new Date() }).where(eq(workflows.id, id)).returning();
  if (!row) return null;
  const executions = await loadRecentExecutions(id);
  return detailFromRow(row, executions);
}

/**
 * T4 (Sam, 2026-05-20) — explicit pause / resume so the FE button is
 * idempotent. Calling pause on an already-paused workflow returns the
 * current row with no state change (HTTP 200), same for resume on
 * already-active. Returns null when the workflow doesn't exist or
 * isn't reachable by the requester's business scope.
 *
 * The previous toggleWorkflowStatus() flipped between active/paused,
 * which races badly when the FE optimistically updates and a second
 * tab clicks the button: each toggle ends up in the WRONG state. The
 * explicit endpoints are immune to that.
 */
export async function setWorkflowStatus(
  id: string,
  next: 'active' | 'paused',
  requester: AuthPayload,
): Promise<WorkflowDetail | null> {
  const [existing] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!existing) return null;
  if (requester.businessId && existing.businessId !== requester.businessId) return null;
  // Idempotent: a no-op write is fine because we always return the current
  // row, but skip the UPDATE to avoid bumping updated_at unnecessarily.
  if (existing.status === next) {
    const executions = await loadRecentExecutions(id);
    return detailFromRow(existing, executions);
  }
  const [row] = await db
    .update(workflows)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(workflows.id, id))
    .returning();
  if (!row) return null;
  const executions = await loadRecentExecutions(id);
  return detailFromRow(row, executions);
}

/**
 * Returns true when ANY workflow row with this handler_key is paused.
 * Used by the cron workers to short-circuit before invoking an
 * automation handler when an admin has paused it from the UI.
 *
 * Multi-tenant note: the seed migration (PR #7) creates one workflow
 * row per business with the same handler_key. The previous
 * implementation used `LIMIT 1` with no ORDER BY, so the row Postgres
 * returned was nondeterministic — if Sam paused his tenant's row but
 * Postgres happened to return a different tenant's `active` row, the
 * cron would still fire. We now filter on `status='paused'` directly
 * and treat "any paused row" as "automation is paused globally" — the
 * pessimistic stance, matching Sam's "pause until hardened" directive.
 *
 * Returns false when:
 *   - no workflow row carries this handler_key (legacy / unbound jobs)
 *   - all workflow rows with this handler_key are active / draft
 *   - the DB lookup itself fails (fail-open: better a cron fires than
 *     silently stops because of a transient DB blip)
 */
export async function isAutomationPaused(handlerKey: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(
        eq(workflows.handlerKey, handlerKey),
        eq(workflows.status, 'paused'),
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Kick off a workflow run.
 *
 * If Redis is configured we enqueue a BullMQ `workflow.run` job (the worker
 * advances the execution row through each step asynchronously). The execution
 * row is created here in `running` state and returned immediately so the caller
 * gets back an ID it can poll.
 *
 * If Redis is *not* configured (e.g. local dev without docker), we fall back
 * to recording a synchronous `completed` execution so the UI still advances.
 */
export async function executeWorkflow(id: string, requester: AuthPayload): Promise<WorkflowExecution | null> {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!wf) return null;
  if (requester.businessId && wf.businessId !== requester.businessId) return null;

  const stepCount = ((wf.steps as WorkflowStep[] | null) ?? []).length;
  const startedAt = new Date();

  if (workflowQueue) {
    const [exec] = await db
      .insert(workflowExecutions)
      .values({
        workflowId: id,
        status: 'running',
        currentStep: 0,
        stepsCompleted: 0,
        stepsTotal: stepCount,
        startedAt,
        result: 'Enqueued',
      })
      .returning();

    await workflowQueue.add('workflow.run', {
      executionId: exec.id,
      workflowId: id,
    });

    await db
      .update(workflows)
      .set({ lastRunAt: startedAt, updatedAt: new Date() })
      .where(eq(workflows.id, id));

    logger.info({ workflowId: id, executionId: exec.id }, 'Workflow enqueued');
    return executionFromRow(exec);
  }

  // Fallback path — Redis not configured. Record a stub completed run so the
  // UI shows an outcome rather than spinning forever.
  logger.warn({ workflowId: id }, 'Redis not configured — recording stub execution');
  const completedAt = new Date(startedAt.getTime() + 100);
  const [exec] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: id,
      status: 'completed',
      currentStep: stepCount,
      stepsCompleted: stepCount,
      stepsTotal: stepCount,
      startedAt,
      completedAt,
      result: `Stub execution — Redis not configured (set REDIS_URL to run for real).`,
    })
    .returning();

  await refreshWorkflowAggregates(id, startedAt);
  return executionFromRow(exec);
}

async function refreshWorkflowAggregates(workflowId: string, lastRunAt: Date): Promise<void> {
  const [{ total, success }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${workflowExecutions.status} = 'completed')::int`,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId));
  const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0;

  await db
    .update(workflows)
    .set({
      lastRunAt,
      totalRuns: total,
      successRate: String(successRate),
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflowId));
}

export { refreshWorkflowAggregates };

export function getStepTypes(): string[] {
  return STEP_TYPES;
}
