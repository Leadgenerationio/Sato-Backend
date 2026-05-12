import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { taskAttachments, tasks } from '../db/schema/tasks.js';
import { logActivity } from './task-activity.service.js';
import { isUuid } from '../utils/zod-helpers.js';
import type { AuthPayload } from '../types/index.js';

// Slice 5 Day 2 (Sam Loom #87, #98) — file attachments per task. Mirrors
// the client_documents pattern: files in R2, metadata in DB. Frontend
// uploads via /api/v1/uploads/presign first, then POSTs the resulting
// {key, contentType, sizeBytes} to record the metadata here.

export interface TaskAttachment {
  id: string;
  taskId: string;
  r2Key: string;
  folder: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

type Row = typeof taskAttachments.$inferSelect;

function toDto(r: Row): TaskAttachment {
  return {
    id: r.id,
    taskId: r.taskId,
    r2Key: r.r2Key,
    folder: r.folder ?? 'misc',
    name: r.name,
    contentType: r.contentType ?? 'application/octet-stream',
    sizeBytes: r.sizeBytes ?? 0,
    uploadedBy: r.uploadedBy,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
  };
}

async function taskExists(taskId: string): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  const [t] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
  return !!t;
}

export async function listAttachments(taskId: string): Promise<TaskAttachment[] | null> {
  if (!(await taskExists(taskId))) return null;
  const rows = await db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(desc(taskAttachments.createdAt));
  return rows.map(toDto);
}

export interface AddAttachmentInput {
  r2Key: string;
  folder?: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
}

export async function addAttachment(
  taskId: string,
  input: AddAttachmentInput,
  requester: AuthPayload,
): Promise<TaskAttachment | null> {
  if (!(await taskExists(taskId))) return null;
  const [row] = await db
    .insert(taskAttachments)
    .values({
      taskId,
      r2Key: input.r2Key,
      folder: input.folder || 'misc',
      name: input.name,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      uploadedBy: requester.userId,
    })
    .returning();

  await logActivity(taskId, requester.userId, 'attachment_added', {
    attachmentId: row.id,
    name: row.name,
  });

  return toDto(row);
}

export async function removeAttachment(
  taskId: string,
  attachmentId: string,
  requester: AuthPayload,
): Promise<boolean> {
  if (!isUuid(taskId) || !isUuid(attachmentId)) return false;
  const deleted = await db
    .delete(taskAttachments)
    .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId)))
    .returning({ id: taskAttachments.id, name: taskAttachments.name });
  if (deleted.length === 0) return false;
  await logActivity(taskId, requester.userId, 'attachment_removed', {
    attachmentId,
    name: deleted[0].name,
  });
  return true;
}

export async function loadAttachmentsForTask(taskId: string): Promise<TaskAttachment[]> {
  if (!isUuid(taskId)) return [];
  const rows = await db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(desc(taskAttachments.createdAt));
  return rows.map(toDto);
}
