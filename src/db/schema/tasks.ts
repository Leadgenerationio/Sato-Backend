import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

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
  auditLog: jsonb('audit_log').default([]),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('tasks_business_idx').on(table.businessId),
  index('tasks_status_idx').on(table.status),
  index('tasks_assignee_idx').on(table.assignee),
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
