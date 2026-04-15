import { pgTable, uuid, varchar, integer, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { clients } from './clients.js';

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  clientId: uuid('client_id').references(() => clients.id),
  name: varchar('name', { length: 255 }).notNull(),
  trigger: jsonb('trigger').notNull(),
  steps: jsonb('steps').notNull(),
  status: varchar('status', { length: 50 }).default('draft'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workflowExecutions = pgTable('workflow_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id').references(() => workflows.id).notNull(),
  status: varchar('status', { length: 50 }).default('running'),
  currentStep: integer('current_step').default(1),
  stepResults: jsonb('step_results'),
  startedAt: timestamp('started_at').defaultNow(),
  completedAt: timestamp('completed_at'),
  error: text('error'),
});
