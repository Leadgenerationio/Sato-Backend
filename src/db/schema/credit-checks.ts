import { pgTable, uuid, varchar, integer, decimal, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

export const creditChecks = pgTable('credit_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),
  endoleCompanyId: varchar('endole_company_id', { length: 100 }),
  creditScore: integer('credit_score'),
  creditLimit: decimal('credit_limit', { precision: 12, scale: 2 }),
  riskRating: varchar('risk_rating', { length: 50 }),
  previousScore: integer('previous_score'),
  scoreChange: integer('score_change'),
  alertTriggered: boolean('alert_triggered').default(false),
  checkedAt: timestamp('checked_at').defaultNow(),
}, (table) => [
  index('credit_checks_client_idx').on(table.clientId),
]);
