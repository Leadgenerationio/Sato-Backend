import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tasks, taskComments, taskTemplates } from '../db/schema/tasks.js';
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

function taskToDto(row: TaskRow, comments: TaskComment[]): Task {
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
  const commentsMap = await loadCommentsForTasks([id]);
  return taskToDto(row, commentsMap.get(id) ?? []);
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
      auditLog: [{ action: 'Task created', user: requester.email, timestamp: now.toISOString() }],
    })
    .returning();
  return taskToDto(row, []);
}

export async function updateTask(id: string, data: Partial<Task>): Promise<Task | null> {
  const patch: Partial<TaskRow> = { updatedAt: new Date() };
  if (data.title !== undefined) patch.title = data.title;
  if (data.description !== undefined) patch.description = data.description;
  if (data.assignee !== undefined) patch.assignee = data.assignee;
  if (data.priority !== undefined) patch.priority = data.priority;
  if (data.status !== undefined) patch.status = data.status;
  if (data.dueDate !== undefined) patch.dueDate = new Date(data.dueDate);
  if (data.category !== undefined) patch.category = data.category;

  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  if (!row) return null;
  const commentsMap = await loadCommentsForTasks([id]);
  return taskToDto(row, commentsMap.get(id) ?? []);
}

export async function updateTaskStatus(id: string, status: Task['status']): Promise<Task | null> {
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
  const commentsMap = await loadCommentsForTasks([id]);
  return taskToDto(row, commentsMap.get(id) ?? []);
}

export async function addComment(taskId: string, comment: { author: string; text: string }): Promise<TaskComment | null> {
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
