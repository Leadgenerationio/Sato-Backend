import { pgTable, uuid, varchar, integer, text, timestamp, jsonb, decimal, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { clients } from './clients.js';

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  clientId: uuid('client_id').references(() => clients.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').default(''),
  // 'scheduled' | 'trigger' | 'manual'
  type: varchar('type', { length: 30 }).notNull().default('manual'),
  // When set, the worker runs the named handler from WORKFLOW_HANDLERS
  // instead of the generic step loop. Lets us back the 3 seeded workflows
  // (chase-overdue / auto-invoice / monthly-validated) with real code while
  // user-created workflows still execute step-by-step.
  handlerKey: varchar('handler_key', { length: 50 }),
  // Human-readable schedule string e.g. "Daily 9:00 AM"
  schedule: varchar('schedule', { length: 100 }),
  trigger: jsonb('trigger'),
  steps: jsonb('steps').notNull().default([]),
  // 'draft' | 'active' | 'paused'
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  lastRunAt: timestamp('last_run_at'),
  nextRunAt: timestamp('next_run_at'),
  totalRuns: integer('total_runs').notNull().default(0),
  successRate: decimal('success_rate', { precision: 5, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('workflows_business_idx').on(table.businessId),
  index('workflows_status_idx').on(table.status),
]);

export const workflowExecutions = pgTable('workflow_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }).notNull(),
  // 'running' | 'completed' | 'failed' | 'paused'
  status: varchar('status', { length: 20 }).notNull().default('running'),
  currentStep: integer('current_step').notNull().default(1),
  stepsCompleted: integer('steps_completed').notNull().default(0),
  stepsTotal: integer('steps_total').notNull().default(0),
  stepResults: jsonb('step_results'),
  result: text('result'),
  startedAt: timestamp('started_at').defaultNow(),
  completedAt: timestamp('completed_at'),
  error: text('error'),
}, (table) => [
  index('workflow_executions_workflow_idx').on(table.workflowId),
]);
