import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { creatives } from './creatives.js';
import { users } from './users.js';

// Append-only audit log of every approve/reject decision a client makes on a
// creative asset. The "current state" of a creative is the most recent row;
// no row = pending.
//
// Designed so a solicitor (Sam's car-financial-claims firm) can prove they
// did or did not approve a given advert at a given moment — IP + UA +
// timestamp + user are all captured at decision time.

// 'changes_requested' added in migration 0029 (creative review v2 — Sam
// #9/#11). The buyer flow is approve / reject / request-changes; the third
// state lets the buyer leave feedback without finalising a rejection so the
// asset can be revised + re-uploaded.
//
// 'submitted' added in migration 0031 (T2 — Sam, 2026-05-20). Staff side
// of the lifecycle: when an admin clicks Submit for approval on a draft,
// we insert an audit row with action='submitted' so the same timeline
// shows both staff submit events and buyer decision events.
export const creativeApprovalActionEnum = pgEnum('creative_approval_action', [
  'approved',
  'rejected',
  'changes_requested',
  'submitted',
]);

export const creativeApprovals = pgTable('creative_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  creativeId: uuid('creative_id').references(() => creatives.id).notNull(),
  action: creativeApprovalActionEnum('action').notNull(),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id).notNull(),
  // IPv4 = max 15 chars, IPv6 (with brackets/zones) up to 45.
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  // Required when action='rejected' (enforced at service layer).
  feedback: text('feedback'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('creative_approvals_creative_idx').on(table.creativeId),
  index('creative_approvals_created_at_idx').on(table.createdAt),
]);

export type CreativeApprovalRow = typeof creativeApprovals.$inferSelect;
export type CreativeApprovalInsert = typeof creativeApprovals.$inferInsert;
