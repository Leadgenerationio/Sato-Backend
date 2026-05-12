import { and, asc, eq, max } from 'drizzle-orm';
import { db } from '../config/database.js';
import { taskSubtasks, tasks } from '../db/schema/tasks.js';
import { logActivity } from './task-activity.service.js';
import { isUuid } from '../utils/zod-helpers.js';
import type { AuthPayload } from '../types/index.js';

// Slice 5 Day 2 (Sam Loom #90) — subtasks within a task. Title + isDone
// + a numeric `position` so the UI can drag-reorder.

export interface TaskSubtask {
  id: string;
  taskId: string;
  title: string;
  isDone: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

type Row = typeof taskSubtasks.$inferSelect;

function toDto(r: Row): TaskSubtask {
  return {
    id: r.id,
    taskId: r.taskId,
    title: r.title,
    isDone: r.isDone,
    position: r.position,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    updatedAt: (r.updatedAt ?? new Date()).toISOString(),
  };
}

async function taskExists(taskId: string): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  const [t] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
  return !!t;
}

export async function listSubtasks(taskId: string): Promise<TaskSubtask[] | null> {
  if (!(await taskExists(taskId))) return null;
  const rows = await db
    .select()
    .from(taskSubtasks)
    .where(eq(taskSubtasks.taskId, taskId))
    .orderBy(asc(taskSubtasks.position), asc(taskSubtasks.createdAt));
  return rows.map(toDto);
}

export interface CreateSubtaskInput {
  title: string;
  isDone?: boolean;
  position?: number;
}

export async function createSubtask(
  taskId: string,
  input: CreateSubtaskInput,
  requester: AuthPayload,
): Promise<TaskSubtask | null> {
  if (!(await taskExists(taskId))) return null;

  // Position defaults to (max existing) + 1 so new rows append.
  let position = input.position;
  if (position === undefined) {
    const [maxRow] = await db
      .select({ p: max(taskSubtasks.position) })
      .from(taskSubtasks)
      .where(eq(taskSubtasks.taskId, taskId));
    position = ((maxRow?.p as number | null) ?? -1) + 1;
  }

  const [row] = await db
    .insert(taskSubtasks)
    .values({
      taskId,
      title: input.title,
      isDone: input.isDone ?? false,
      position,
    })
    .returning();

  await logActivity(taskId, requester.userId, 'subtask_added', {
    subtaskId: row.id,
    title: row.title,
  });

  return toDto(row);
}

export interface UpdateSubtaskInput {
  title?: string;
  isDone?: boolean;
  position?: number;
}

export async function updateSubtask(
  taskId: string,
  subtaskId: string,
  input: UpdateSubtaskInput,
  requester: AuthPayload,
): Promise<TaskSubtask | null> {
  if (!isUuid(taskId) || !isUuid(subtaskId)) return null;

  const [existing] = await db
    .select()
    .from(taskSubtasks)
    .where(and(eq(taskSubtasks.id, subtaskId), eq(taskSubtasks.taskId, taskId)));
  if (!existing) return null;

  const patch: Partial<Row> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.position !== undefined) patch.position = input.position;
  if (input.isDone !== undefined) patch.isDone = input.isDone;

  const [row] = await db
    .update(taskSubtasks)
    .set(patch)
    .where(and(eq(taskSubtasks.id, subtaskId), eq(taskSubtasks.taskId, taskId)))
    .returning();

  // Log the meaningful event (completion flip) rather than the raw patch.
  if (input.isDone !== undefined && input.isDone !== existing.isDone) {
    await logActivity(
      taskId,
      requester.userId,
      input.isDone ? 'subtask_completed' : 'subtask_uncompleted',
      { subtaskId, title: row.title },
    );
  }
  return toDto(row);
}

export async function deleteSubtask(
  taskId: string,
  subtaskId: string,
  requester: AuthPayload,
): Promise<boolean> {
  if (!isUuid(taskId) || !isUuid(subtaskId)) return false;
  const deleted = await db
    .delete(taskSubtasks)
    .where(and(eq(taskSubtasks.id, subtaskId), eq(taskSubtasks.taskId, taskId)))
    .returning({ id: taskSubtasks.id, title: taskSubtasks.title });
  if (deleted.length === 0) return false;
  await logActivity(taskId, requester.userId, 'subtask_removed', {
    subtaskId,
    title: deleted[0].title,
  });
  return true;
}

/**
 * Loader for getTask. Single-task scope — Day 4 will introduce a Map-based
 * variant for the org-wide view when it actually needs bulk loading.
 */
export async function loadSubtasksForTask(taskId: string): Promise<TaskSubtask[]> {
  if (!isUuid(taskId)) return [];
  const rows = await db
    .select()
    .from(taskSubtasks)
    .where(eq(taskSubtasks.taskId, taskId))
    .orderBy(asc(taskSubtasks.position), asc(taskSubtasks.createdAt));
  return rows.map(toDto);
}
