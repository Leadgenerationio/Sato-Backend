import { pgTable, uuid, varchar, text, integer, boolean, timestamp, jsonb, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { sops } from './sops.js';
import { users } from './users.js';

// Slice 5 Day 1 (Sam Loom #86-100) — task model upgraded to support
// comments, subtasks, attachments, real activity feed, time-block
// prioritisation (1hr / 2hr), linked SOP, recurring runs, and a parent
// task reference so tasks can be nested under another task / project.
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').default(''),
  assignee: varchar('assignee', { length: 255 }).default(''),
  priority: varchar('priority', { length: 20 }).notNull().default('medium'),
  status: varchar('status', { length: 20 }).notNull().default('todo'),
  category: varchar('category', { length: 50 }).default('general'),
  createdBy: varchar('created_by', { length: 255 }).notNull(),
  dueDate: timestamp('due_date'),
  // Sam's "1 hour, 2 hour, whatever" — stored as int minutes for flex.
  timeBlockMinutes: integer('time_block_minutes'),
  // SOP attached to the task — Sam's "creating SOL panel images" example.
  linkedSopId: uuid('linked_sop_id').references(() => sops.id, { onDelete: 'set null' }),
  // Self-referential parent for the "connected to another project" model.
  // Until a dedicated projects entity ships, a task can hang off another task.
  parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  // Recurring tasks — cron expression + next-run timestamp the worker watches.
  recurrenceCron: varchar('recurrence_cron', { length: 100 }),
  recurrenceNextRun: timestamp('recurrence_next_run'),
  // Legacy jsonb audit log — kept until task_activity_log replaces it everywhere.
  auditLog: jsonb('audit_log').default([]),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('tasks_business_idx').on(table.businessId),
  index('tasks_status_idx').on(table.status),
  index('tasks_assignee_idx').on(table.assignee),
  index('tasks_parent_idx').on(table.parentTaskId),
  index('tasks_recurrence_next_idx').on(table.recurrenceNextRun),
]);

// Subtasks — Sam: "we have subtasks, so within a task, there's subtasks".
// `position` lets the user drag-reorder; integer leaves room for inserts
// between existing positions without renumbering everything.
export const taskSubtasks = pgTable('task_subtasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  isDone: boolean('is_done').notNull().default(false),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('task_subtasks_task_idx').on(table.taskId),
]);

// Attachments — mirrors client_documents in shape. Files live in R2 via
// the existing /uploads/presign route; this table tracks metadata only.
export const taskAttachments = pgTable('task_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  r2Key: varchar('r2_key', { length: 500 }).notNull(),
  folder: varchar('folder', { length: 50 }).notNull().default('misc'),
  name: varchar('name', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 100 }),
  sizeBytes: integer('size_bytes'),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('task_attachments_task_idx').on(table.taskId),
]);

// Append-only activity feed — Sam: "we've got activity, what's going on".
// Distinct from the legacy jsonb `tasks.audit_log` (which gets unwieldy).
// `eventType` is a free-form string ('created', 'status_changed',
// 'comment_added', 'subtask_completed', etc.) — service layer is the
// source of truth for the vocabulary.
export const taskActivityLog = pgTable('task_activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('task_activity_log_task_idx').on(table.taskId),
  index('task_activity_log_created_idx').on(table.taskId, table.createdAt),
]);

export const taskComments = pgTable('task_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  author: varchar('author', { length: 255 }).notNull(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('task_comments_task_idx').on(table.taskId),
]);

export const taskTemplates = pgTable('task_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').default(''),
  defaultPriority: varchar('default_priority', { length: 20 }).notNull().default('medium'),
  defaultCategory: varchar('default_category', { length: 50 }).default('general'),
  steps: jsonb('steps').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow(),
});
