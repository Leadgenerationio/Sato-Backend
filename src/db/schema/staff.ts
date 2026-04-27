import { pgTable, uuid, varchar, integer, date, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 100 }).notNull().default('Employee'),
  department: varchar('department', { length: 100 }).notNull().default('Operations'),
  startDate: date('start_date').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  holidaysRemaining: integer('holidays_remaining').notNull().default(25),
  holidaysTaken: integer('holidays_taken').notNull().default(0),
  documents: jsonb('documents').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('staff_business_idx').on(table.businessId),
  index('staff_status_idx').on(table.status),
]);

export const jobPostings = pgTable('job_postings', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  title: varchar('title', { length: 255 }).notNull(),
  department: varchar('department', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  postedDate: date('posted_date').notNull().defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('job_postings_business_idx').on(table.businessId),
  index('job_postings_status_idx').on(table.status),
]);

export const applicants = pgTable('applicants', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').references(() => jobPostings.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  stage: varchar('stage', { length: 20 }).notNull().default('applied'),
  appliedDate: date('applied_date').notNull().defaultNow(),
  score: integer('score').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('applicants_job_idx').on(table.jobId),
]);

export const holidayRequests = pgTable('holiday_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id').references(() => staff.id, { onDelete: 'cascade' }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('annual'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  approvedBy: varchar('approved_by', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('holiday_requests_staff_idx').on(table.staffId),
  index('holiday_requests_status_idx').on(table.status),
]);
