import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tasks, taskComments, taskTemplates } from '../db/schema/tasks.js';
import { logActivity, listActivityForTask, type TaskActivityEvent } from './task-activity.service.js';
import { loadSubtasksForTask, type TaskSubtask } from './task-subtasks.service.js';
import { loadAttachmentsForTask, type TaskAttachment } from './task-attachments.service.js';
import { cronNextFire, isValidCron } from '../utils/cron-next.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface AuditEntry {
  action: string;
  user: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'todo' | 'in_progress' | 'completed' | 'on_hold';
  dueDate: string;
  category: string;
  createdBy: string;
  createdAt: string;
  comments: TaskComment[];
  auditLog: AuditEntry[];
  // Slice 5 — optional fields populated by getTask; listTasks omits the
  // expensive ones (subtasks/attachments/activity) to keep the list page
  // cheap.
  timeBlockMinutes?: number | null;
  linkedSopId?: string | null;
  parentTaskId?: string | null;
  // Sam-Loom #2 follow-up — parent task's title surfaced on every child so
  // the FE can render the "↪ Parent: X" hint even when the parent lives on
  // a different page of the result set (otherwise pagination silently breaks
  // the parent/child grouping). Null when the task is top-level OR when the
  // parent has been deleted (parent_task_id is `set null` on parent delete).
  parentTitle?: string | null;
  recurrenceCron?: string | null;
  recurrenceNextRun?: string | null;
  subtasks?: TaskSubtask[];
  attachments?: TaskAttachment[];
  activity?: TaskActivityEvent[];
}

export interface TaskStats {
  total: number;
  completed: number;
  in_progress: number;
  overdue: number;
  by_priority: { low: number; medium: number; high: number; urgent: number };
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  defaultPriority: 'low' | 'medium' | 'high' | 'urgent';
  defaultCategory: string;
  steps: string[];
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  assignee?: string;
  search?: string;
  // Sam-Loom #7 — 'today' (default): hide completed tasks completed before
  // today; 'all': everything; 'archive': only completed tasks completed
  // before today. Lets the FE render the default un-cluttered view while
  // still exposing the archived rows for performance review later.
  archive?: 'today' | 'all' | 'archive';
}

type TaskRow = typeof tasks.$inferSelect;
type CommentRow = typeof taskComments.$inferSelect;
type TemplateRow = typeof taskTemplates.$inferSelect;

function commentToDto(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    author: row.author,
    text: row.text,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

function taskToDto(
  row: TaskRow,
  comments: TaskComment[],
  extras?: { subtasks?: TaskSubtask[]; attachments?: TaskAttachment[]; activity?: TaskActivityEvent[]; parentTitle?: string | null },
): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    assignee: row.assignee ?? '',
    priority: (row.priority as Task['priority']) ?? 'medium',
    status: (row.status as Task['status']) ?? 'todo',
    dueDate: (row.dueDate ?? new Date()).toISOString(),
    category: row.category ?? 'general',
    createdBy: row.createdBy,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    comments,
    auditLog: ((row.auditLog as AuditEntry[] | null) ?? []),
    timeBlockMinutes: row.timeBlockMinutes ?? null,
    linkedSopId: row.linkedSopId ?? null,
    parentTaskId: row.parentTaskId ?? null,
    parentTitle: extras?.parentTitle ?? null,
    recurrenceCron: row.recurrenceCron ?? null,
    recurrenceNextRun: row.recurrenceNextRun ? row.recurrenceNextRun.toISOString() : null,
    subtasks: extras?.subtasks,
    attachments: extras?.attachments,
    activity: extras?.activity,
  };
}

function templateToDto(row: TemplateRow): TaskTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    defaultPriority: row.defaultPriority as TaskTemplate['defaultPriority'],
    defaultCategory: row.defaultCategory ?? 'general',
    steps: (row.steps as string[]) ?? [],
  };
}

async function loadCommentsForTasks(taskIds: string[]): Promise<Map<string, TaskComment[]>> {
  const map = new Map<string, TaskComment[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select()
    .from(taskComments)
    .where(sql`${taskComments.taskId} IN (${sql.join(taskIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
    .orderBy(taskComments.createdAt);
  for (const r of rows) {
    const list = map.get(r.taskId) ?? [];
    list.push(commentToDto(r));
    map.set(r.taskId, list);
  }
  return map;
}

export async function listTasks(requester: AuthPayload, filters?: TaskFilters): Promise<Task[]> {
  const conditions = [];
  if (requester.businessId) conditions.push(eq(tasks.businessId, requester.businessId));
  if (filters?.status && filters.status !== 'all') conditions.push(eq(tasks.status, filters.status));
  if (filters?.priority && filters.priority !== 'all') conditions.push(eq(tasks.priority, filters.priority));
  if (filters?.assignee) conditions.push(ilike(tasks.assignee, `%${filters.assignee}%`));
  if (filters?.search) {
    const q = `%${filters.search}%`;
    conditions.push(or(ilike(tasks.title, q), ilike(tasks.description, q))!);
  }

  // Sam-Loom #7 — archive split. Default ('today' or missing): hide
  // completed tasks completed before today so the active board stays
  // legible. 'archive' inverts: only completed-before-today rows. 'all'
  // disables the filter entirely (used by stats + reports).
  const archive = filters?.archive ?? 'today';
  if (archive === 'today') {
    conditions.push(
      sql`(${tasks.status} != 'completed' OR ${tasks.completedAt} IS NULL OR ${tasks.completedAt} >= CURRENT_DATE)`,
    );
  } else if (archive === 'archive') {
    conditions.push(eq(tasks.status, 'completed'));
    conditions.push(sql`${tasks.completedAt} < CURRENT_DATE`);
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tasks.createdAt));

  // Sam-Loom #2 follow-up — fetch parent titles for every child in the page,
  // even when the parent lives on a different page. Without this, paginating
  // at >50 tasks would orphan children visually (child appears top-level
  // because its parent wasn't loaded). Single batched query keyed on the
  // distinct parent_task_ids — bounded by page size.
  const parentTitleById = await loadParentTitles(rows);

  const commentsMap = await loadCommentsForTasks(rows.map((r) => r.id));
  return rows.map((r) => taskToDto(r, commentsMap.get(r.id) ?? [], {
    parentTitle: r.parentTaskId ? (parentTitleById.get(r.parentTaskId) ?? null) : null,
  }));
}

async function loadParentTitles(rows: TaskRow[]): Promise<Map<string, string>> {
  const parentIds = Array.from(
    new Set(rows.map((r) => r.parentTaskId).filter((id): id is string => !!id)),
  );
  if (parentIds.length === 0) return new Map();
  const parents = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(inArray(tasks.id, parentIds));
  return new Map(parents.map((p) => [p.id, p.title]));
}

export async function getTask(id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) return null;
  // Slice 5: pull comments + subtasks + attachments + activity feed in
  // parallel so the detail endpoint stays one round-trip. Sam-Loom #2
  // follow-up — also resolve the parent title so the detail page can
  // render the back-link to the parent.
  const [commentsMap, subtasks, attachments, activity, parentTitleById] = await Promise.all([
    loadCommentsForTasks([id]),
    loadSubtasksForTask(id),
    loadAttachmentsForTask(id),
    listActivityForTask(id),
    loadParentTitles([row]),
  ]);
  return taskToDto(row, commentsMap.get(id) ?? [], {
    subtasks,
    attachments,
    activity,
    parentTitle: row.parentTaskId ? (parentTitleById.get(row.parentTaskId) ?? null) : null,
  });
}

export async function createTask(data: Partial<Task>, requester: AuthPayload): Promise<Task> {
  const now = new Date();
  // Slice 5 Day 7 — auto-compute recurrenceNextRun when the caller sets a
  // valid cron but doesn't tell us when the next fire is. Without this,
  // the recurring-tasks worker can never pick up newly-created rows.
  // Invalid crons short-circuit to null (the FE picker validates first,
  // but the API stays lenient — bad crons just don't recur).
  const cron = data.recurrenceCron ?? null;
  let nextRun: Date | null = data.recurrenceNextRun ? new Date(data.recurrenceNextRun) : null;
  if (cron && !nextRun && isValidCron(cron)) {
    nextRun = cronNextFire(cron, now);
  }

  const [row] = await db
    .insert(tasks)
    .values({
      businessId: requester.businessId ?? null,
      title: data.title || '',
      description: data.description || '',
      assignee: data.assignee || '',
      priority: data.priority || 'medium',
      status: data.status || 'todo',
      dueDate: data.dueDate ? new Date(data.dueDate) : new Date(Date.now() + 7 * 86400000),
      category: data.category || 'general',
      createdBy: requester.email,
      // Slice 5 fields — all optional on create.
      timeBlockMinutes: data.timeBlockMinutes ?? null,
      linkedSopId: data.linkedSopId ?? null,
      parentTaskId: data.parentTaskId ?? null,
      recurrenceCron: cron,
      recurrenceNextRun: nextRun,
      auditLog: [{ action: 'Task created', user: requester.email, timestamp: now.toISOString() }],
    })
    .returning();
  await logActivity(row.id, requester.userId, 'task_created', { title: row.title });
  if (row.recurrenceCron) {
    await logActivity(row.id, requester.userId, 'recurrence_set', { cron: row.recurrenceCron });
  }
  return taskToDto(row, []);
}

export async function updateTask(id: string, data: Partial<Task>, requester?: AuthPayload): Promise<Task | null> {
  const patch: Partial<TaskRow> = { updatedAt: new Date() };
  const changed: Record<string, unknown> = {};
  if (data.title !== undefined) { patch.title = data.title; changed.title = data.title; }
  if (data.description !== undefined) { patch.description = data.description; changed.description = data.description; }
  if (data.assignee !== undefined) { patch.assignee = data.assignee; changed.assignee = data.assignee; }
  if (data.priority !== undefined) { patch.priority = data.priority; changed.priority = data.priority; }
  if (data.status !== undefined) { patch.status = data.status; changed.status = data.status; }
  if (data.dueDate !== undefined) { patch.dueDate = new Date(data.dueDate); changed.dueDate = data.dueDate; }
  if (data.category !== undefined) { patch.category = data.category; changed.category = data.category; }
  // Slice 5 fields
  if (data.timeBlockMinutes !== undefined) { patch.timeBlockMinutes = data.timeBlockMinutes; changed.timeBlockMinutes = data.timeBlockMinutes; }
  if (data.linkedSopId !== undefined) { patch.linkedSopId = data.linkedSopId; changed.linkedSopId = data.linkedSopId; }
  if (data.parentTaskId !== undefined) { patch.parentTaskId = data.parentTaskId; changed.parentTaskId = data.parentTaskId; }
  // Slice 5 Day 7 — recurrence:
  //   - cron set to null → also clear next_run so the worker stops watching
  //   - cron set to a valid expression with no explicit next_run → compute it
  //   - cron explicitly paired with next_run → respect both (caller decided)
  //   - cron unchanged but next_run sent → respect it (e.g. snooze)
  if (data.recurrenceCron !== undefined) {
    patch.recurrenceCron = data.recurrenceCron;
    changed.recurrenceCron = data.recurrenceCron;
    if (data.recurrenceCron === null) {
      // Clearing cron clears next_run unless caller explicitly sent one
      // (which would be weird — but we don't fight them).
      if (data.recurrenceNextRun === undefined) {
        patch.recurrenceNextRun = null;
        changed.recurrenceNextRun = null;
      }
    } else if (data.recurrenceNextRun === undefined && isValidCron(data.recurrenceCron)) {
      const next = cronNextFire(data.recurrenceCron, new Date());
      patch.recurrenceNextRun = next;
      changed.recurrenceNextRun = next.toISOString();
    }
  }
  if (data.recurrenceNextRun !== undefined) {
    patch.recurrenceNextRun = data.recurrenceNextRun ? new Date(data.recurrenceNextRun) : null;
    changed.recurrenceNextRun = data.recurrenceNextRun;
  }

  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  if (!row) return null;
  // One activity event per `updateTask` call rather than one per field —
  // the feed stays readable; the payload carries the diff for anyone who
  // wants to drill in.
  if (Object.keys(changed).length > 0) {
    await logActivity(id, requester?.userId ?? null, 'task_updated', changed);
  }
  const commentsMap = await loadCommentsForTasks([id]);
  return taskToDto(row, commentsMap.get(id) ?? []);
}

export async function updateTaskStatus(
  id: string,
  status: Task['status'],
  requester?: AuthPayload,
): Promise<Task | null> {
  const [existing] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!existing) return null;
  const statusLabels: Record<string, string> = {
    todo: 'To Do', in_progress: 'In Progress', completed: 'Completed', on_hold: 'On Hold',
  };
  const auditLog = ((existing.auditLog as AuditEntry[] | null) ?? []).concat({
    action: `Status changed to ${statusLabels[status] || status}`,
    user: existing.assignee ?? '',
    timestamp: new Date().toISOString(),
  });

  // Sam-Loom #7 — track when a task was completed so the archive filter
  // can hide it after today rolls over. Clear the stamp when transitioning
  // away from 'completed' (reopen) so the row reappears in the active set.
  const completedAt =
    status === 'completed' && existing.status !== 'completed'
      ? new Date()
      : status !== 'completed' && existing.status === 'completed'
        ? null
        : undefined;

  const [row] = await db
    .update(tasks)
    .set({
      status,
      auditLog,
      updatedAt: new Date(),
      ...(completedAt !== undefined ? { completedAt } : {}),
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) return null;
  await logActivity(id, requester?.userId ?? null, 'status_changed', {
    from: existing.status,
    to: status,
  });
  const commentsMap = await loadCommentsForTasks([id]);
  return taskToDto(row, commentsMap.get(id) ?? []);
}

/**
 * Hard-delete a task and its dependants.
 *
 * Sam (2026-05-15 Loom): "there's no delete button" — soft-delete would have
 * been the safer default but the existing schema has no `deleted_at` column
 * and Sam wants the row truly gone (he's pruning the noise from old test
 * tasks, not archiving). FKs on subtasks / attachments / comments / activity
 * cascade; `parent_task_id` is `set null` so child-task rows survive an
 * accidental parent-delete and surface as top-level instead of orphaning.
 *
 * Returns `false` when the row doesn't exist so the controller can 404
 * cleanly without a separate read.
 */
export async function deleteTask(id: string, requester?: AuthPayload): Promise<boolean> {
  const result = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  if (result.length === 0) return false;
  // logActivity targets the deleted row's id which is now gone — emit a
  // workspace-level audit line via the logger instead. Activity table FK
  // would otherwise CASCADE this away.
  logger.info(
    { taskId: id, userId: requester?.userId ?? null },
    'task_deleted',
  );
  return true;
}

export async function addComment(
  taskId: string,
  comment: { author: string; text: string },
  requester?: AuthPayload,
): Promise<TaskComment | null> {
  const [existing] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!existing) return null;

  const [row] = await db
    .insert(taskComments)
    .values({ taskId, author: comment.author, text: comment.text })
    .returning();

  const auditLog = ((existing.auditLog as AuditEntry[] | null) ?? []).concat({
    action: 'Comment added',
    user: comment.author,
    timestamp: (row.createdAt ?? new Date()).toISOString(),
  });
  await db.update(tasks).set({ auditLog, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await logActivity(taskId, requester?.userId ?? null, 'comment_added', {
    commentId: row.id,
    preview: comment.text.slice(0, 200),
  });

  return commentToDto(row);
}

export async function getTaskStats(requester: AuthPayload): Promise<TaskStats> {
  const conditions = requester.businessId ? [eq(tasks.businessId, requester.businessId)] : [];
  const rows = await db
    .select()
    .from(tasks)
    .where(conditions.length ? and(...conditions) : undefined);
  const now = new Date();
  return {
    total: rows.length,
    completed: rows.filter((t) => t.status === 'completed').length,
    in_progress: rows.filter((t) => t.status === 'in_progress').length,
    overdue: rows.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < now).length,
    by_priority: {
      low: rows.filter((t) => t.priority === 'low').length,
      medium: rows.filter((t) => t.priority === 'medium').length,
      high: rows.filter((t) => t.priority === 'high').length,
      urgent: rows.filter((t) => t.priority === 'urgent').length,
    },
  };
}

// Slice 5 Day 5 — return tasks whose `parentTaskId` matches the given id.
// Used by the detail page to render the "Children" / project-tree section.
// Ordered by createdAt so the tree reads top-to-bottom in insertion order.
export async function listChildTasks(parentTaskId: string): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(tasks.createdAt);
  if (rows.length === 0) return [];
  const commentsMap = await loadCommentsForTasks(rows.map((r) => r.id));
  return rows.map((r) => taskToDto(r, commentsMap.get(r.id) ?? []));
}

export async function listTemplates(): Promise<TaskTemplate[]> {
  const rows = await db.select().from(taskTemplates).orderBy(taskTemplates.name);
  return rows.map(templateToDto);
}

export async function createFromTemplate(
  templateId: string,
  assignee: string,
  requester: AuthPayload,
  opts: { dueDate?: string } = {},
): Promise<Task | null> {
  const [template] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId));
  if (!template) return null;

  const steps = (template.steps as string[]) ?? [];
  const stepsDescription = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const now = new Date();
  // Honour caller-supplied dueDate (FE sends ISO string); fall back to +7 days.
  const dueDate = opts.dueDate ? new Date(opts.dueDate) : new Date(Date.now() + 7 * 86400000);
  const [row] = await db
    .insert(tasks)
    .values({
      businessId: requester.businessId ?? null,
      title: template.name,
      description: `${template.description ?? ''}\n\nSteps:\n${stepsDescription}`,
      assignee,
      priority: template.defaultPriority,
      status: 'todo',
      dueDate,
      category: template.defaultCategory ?? 'general',
      createdBy: requester.email,
      auditLog: [{ action: `Task created from template "${template.name}"`, user: requester.email, timestamp: now.toISOString() }],
    })
    .returning();
  return taskToDto(row, []);
}
