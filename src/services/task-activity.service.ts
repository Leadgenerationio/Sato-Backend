import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { taskActivityLog } from '../db/schema/tasks.js';
import { users } from '../db/schema/users.js';

// Slice 5 Day 2 (Sam Loom #88) — append-only activity feed for a task.
// Every mutation in task.service / task-subtasks.service / task-attachments
// calls `logActivity()` so the feed view has one consistent stream.
// Distinct from the legacy `tasks.audit_log` jsonb (kept populated for now
// for back-compat; new feed consumers should use this table instead).

export type TaskEventType =
  | 'task_created'
  | 'task_updated'
  | 'status_changed'
  | 'assignee_changed'
  | 'comment_added'
  | 'subtask_added'
  | 'subtask_completed'
  | 'subtask_uncompleted'
  | 'subtask_removed'
  | 'attachment_added'
  | 'attachment_removed'
  | 'recurrence_set';

export interface TaskActivityEvent {
  id: string;
  taskId: string;
  actorUserId: string | null;
  actorName: string | null;
  eventType: TaskEventType | string;
  payload: unknown;
  createdAt: string;
}

/**
 * Write a single activity event. Swallows errors — the feed is observability,
 * not a transactional dependency. Mutations don't fail if the log write fails.
 */
export async function logActivity(
  taskId: string,
  actorUserId: string | null,
  eventType: TaskEventType | string,
  payload?: unknown,
): Promise<void> {
  try {
    await db.insert(taskActivityLog).values({
      taskId,
      actorUserId: actorUserId ?? null,
      eventType,
      payload: payload === undefined ? null : (payload as object),
    });
  } catch {
    /* swallow — feed is non-critical */
  }
}

/**
 * Read the activity feed for a task, newest first. Enriches actor with their
 * display name for the UI.
 */
export async function listActivityForTask(taskId: string): Promise<TaskActivityEvent[]> {
  const rows = await db
    .select({
      id: taskActivityLog.id,
      taskId: taskActivityLog.taskId,
      actorUserId: taskActivityLog.actorUserId,
      actorName: users.name,
      eventType: taskActivityLog.eventType,
      payload: taskActivityLog.payload,
      createdAt: taskActivityLog.createdAt,
    })
    .from(taskActivityLog)
    .leftJoin(users, eq(users.id, taskActivityLog.actorUserId))
    .where(eq(taskActivityLog.taskId, taskId))
    .orderBy(desc(taskActivityLog.createdAt));

  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    actorUserId: r.actorUserId,
    actorName: r.actorName ?? null,
    eventType: r.eventType,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}
