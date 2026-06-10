import { pgTable, uuid, varchar, timestamp, integer } from 'drizzle-orm/pg-core';

// Sam (2026-06-10): self-service forgot-password via a 6-digit emailed code.
// One row per reset request. The code itself is never stored — only its
// bcrypt hash. A row is "live" while consumedAt is null, expiresAt is in the
// future, and attempts < 5. Requesting a new code soft-invalidates prior
// live rows for the same email (consumedAt set). See
// src/services/password-reset.service.ts.
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  codeHash: varchar('code_hash', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
