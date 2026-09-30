import { pgTable, uuid, varchar, timestamp, char, text, integer, bigserial, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { users } from './users.js';

// Migration 0046 (public API, plan phase 2). Only the SHA-256 of a key is
// stored — the key itself is shown once, at creation.
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  // First characters of the key after the "stk_" marker, to recognise it in lists/logs.
  prefix: varchar('prefix', { length: 16 }).notNull(),
  hash: char('hash', { length: 64 }).notNull().unique(),
  scopes: text('scopes').array().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [index('api_keys_business_idx').on(t.businessId)]);

export const apiKeyUsage = pgTable('api_key_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }).notNull(),
  method: varchar('method', { length: 8 }).notNull(),
  path: varchar('path', { length: 300 }).notNull(),
  status: integer('status').notNull(),
  at: timestamp('at', { withTimezone: true }).defaultNow(),
}, (t) => [index('api_key_usage_key_at_idx').on(t.apiKeyId, t.at), index('api_key_usage_at_idx').on(t.at)]);

// Idempotency-Key replay store (24 h). `owner` is `key:<api key id>` or
// `user:<user id>` so JWT callers can use the header too.
export const idempotencyKeys = pgTable('idempotency_keys', {
  owner: varchar('owner', { length: 60 }).notNull(),
  key: varchar('key', { length: 100 }).notNull(),
  requestHash: char('request_hash', { length: 64 }).notNull(),
  status: integer('status').notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.key] }), index('idempotency_keys_created_at_idx').on(t.createdAt)]);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
