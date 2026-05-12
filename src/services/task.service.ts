import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tasks, taskComments, taskTemplates } from '../db/schema/tasks.js';
import { logActivity, listActivityForTask, type TaskActivityEvent } from './task-activity.service.js';
import { loadSubtasksForTask, type TaskSubtask } from './task-subtasks.service.js';
import { loadAttachmentsForTask, type TaskAttachment } from './task-attachments.service.js';
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
  status: 'todo' | 'in_progress' | 'completed' | 'blocked';
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
  extras?: { subtasks?: TaskSubtask[]; attachments?: TaskAttachment[]; activity?: TaskActivityEvent[] },
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

  const rows = await db
    .select()
    .from(tasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tasks.createdAt));

  const commentsMap = await loadCommentsForTasks(rows.map((r) => r.id));
  return rows.map((r) => taskToDto(r, commentsMap.get(r.id) ?? []));
}

export async function getTask(id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) return null;
  // Slice 5: pull comments + subtasks + attachments + activity feed in
  // parallel so the detail endpoint stays one round-trip.
  const [commentsMap, subtasks, attachments, activity] = await Promise.all([
    loadCommentsForTasks([id]),
    loadSubtasksForTask(id),
    loadAttachmentsForTask(id),
    listActivityForTask(id),
  ]);
  return taskToDto(row, commentsMap.get(id) ?? [], { subtasks, attachments, activity });
}

export async function createTask(data: Partial<Task>, requester: AuthPayload): Promise<Task> {
  const now = new Date();
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
      recurrenceCron: data.recurrenceCron ?? null,
      recurrenceNextRun: data.recurrenceNextRun ? new Date(data.recurrenceNextRun) : null,
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
  if (data.recurrenceCron !== undefined) { patch.recurrenceCron = data.recurrenceCron; changed.recurrenceCron = data.recurrenceCron; }
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
    todo: 'To Do', in_progress: 'In Progress', completed: 'Completed', blocked: 'Blocked',
  };
  const auditLog = ((existing.auditLog as AuditEntry[] | null) ?? []).concat({
    action: `Status changed to ${statusLabels[status] || status}`,
    user: existing.assignee ?? '',
    timestamp: new Date().toISOString(),
  });

  const [row] = await db
    .update(tasks)
    .set({ status, auditLog, updatedAt: new Date() })
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
