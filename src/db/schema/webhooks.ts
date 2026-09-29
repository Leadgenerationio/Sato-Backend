import { pgTable, uuid, varchar, text, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { users } from './users.js';

// Migration 0048 (plan phase 4): outbound webhooks. See the migration for why
// the secret is sealed (encrypted) rather than hashed.
export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  url: varchar('url', { length: 2048 }).notNull(),
  description: varchar('description', { length: 255 }),
  secretSealed: text('secret_sealed').notNull(),
  secretHint: varchar('secret_hint', { length: 16 }).notNull(),
  events: text('events').array().notNull().default([]),
  active: boolean('active').notNull().default(true),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  disabledAt: timestamp('disabled_at'),
  disabledReason: varchar('disabled_reason', { length: 255 }),
  lastSuccessAt: timestamp('last_success_at'),
  lastFailureAt: timestamp('last_failure_at'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  index('webhook_endpoints_business_idx').on(t.businessId),
]);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  endpointId: uuid('endpoint_id').references(() => webhookEndpoints.id, { onDelete: 'cascade' }).notNull(),
  event: varchar('event', { length: 64 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  responseCode: integer('response_code'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at'),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),
  index('webhook_deliveries_status_idx').on(t.status),
]);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
