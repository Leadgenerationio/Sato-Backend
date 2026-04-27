import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../config/database.js';
import { staff, jobPostings, applicants, holidayRequests } from '../db/schema/staff.js';
import type { AuthPayload } from '../types/index.js';

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: string;
  department: 'Content Team' | 'Operations';
  startDate: string;
  status: 'active' | 'on_leave' | 'terminated';
  holidaysRemaining: number;
  holidaysTaken: number;
}

export interface JobPosting {
  id: string;
  title: string;
  department: string;
  status: 'open' | 'closed';
  applicantCount: number;
  postedDate: string;
}

export interface Applicant {
  id: string;
  name: string;
  email: string;
  jobId: string;
  stage: 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected';
  appliedDate: string;
  score: number;
}

export interface HolidayRequest {
  id: string;
  staffId: string;
  staffName: string;
  type: 'annual' | 'sick' | 'personal';
  startDate: string;
  endDate: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
}

export interface StaffStats {
  totalStaff: number;
  activeStaff: number;
  openPositions: number;
  pendingHolidays: number;
}

type StaffRow = typeof staff.$inferSelect;
type JobRow = typeof jobPostings.$inferSelect;
type ApplicantRow = typeof applicants.$inferSelect;
type HolidayRow = typeof holidayRequests.$inferSelect;

function staffToDto(row: StaffRow): StaffMember {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    department: row.department as StaffMember['department'],
    startDate: row.startDate,
    status: row.status as StaffMember['status'],
    holidaysRemaining: row.holidaysRemaining,
    holidaysTaken: row.holidaysTaken,
  };
}

function jobToDto(row: JobRow, applicantCount: number): JobPosting {
  return {
    id: row.id,
    title: row.title,
    department: row.department,
    status: row.status as JobPosting['status'],
    applicantCount,
    postedDate: row.postedDate,
  };
}

function applicantToDto(row: ApplicantRow): Applicant {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    jobId: row.jobId,
    stage: row.stage as Applicant['stage'],
    appliedDate: row.appliedDate,
    score: row.score,
  };
}

function holidayToDto(row: HolidayRow, staffName: string): HolidayRequest {
  return {
    id: row.id,
    staffId: row.staffId,
    staffName,
    type: row.type as HolidayRequest['type'],
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status as HolidayRequest['status'],
    approvedBy: row.approvedBy,
  };
}

function withBusinessFilter(requester: AuthPayload | undefined, column: PgColumn<any>): SQL | undefined {
  return requester?.businessId ? eq(column, requester.businessId) : undefined;
}

export interface StaffDocument {
  key: string;
  name: string;
  size: number;
  contentType: string;
  category?: string;
  uploadedAt: string;
  uploadedBy?: string;
}

export async function listStaffDocuments(staffId: string): Promise<StaffDocument[]> {
  const [row] = await db.select().from(staff).where(eq(staff.id, staffId));
  if (!row) return [];
  return (row.documents as StaffDocument[] | null) ?? [];
}

export async function addStaffDocument(
  staffId: string,
  doc: Omit<StaffDocument, 'uploadedAt' | 'uploadedBy'>,
  requester: AuthPayload,
): Promise<StaffDocument[] | null> {
  const [row] = await db.select().from(staff).where(eq(staff.id, staffId));
  if (!row) return null;

  const existing = (row.documents as StaffDocument[] | null) ?? [];
  const next: StaffDocument = {
    ...doc,
    uploadedAt: new Date().toISOString(),
    uploadedBy: requester.userId,
  };
  const updated = [...existing, next];
  await db.update(staff).set({ documents: updated, updatedAt: new Date() }).where(eq(staff.id, staffId));
  return updated;
}

export async function removeStaffDocument(staffId: string, key: string): Promise<StaffDocument[] | null> {
  const [row] = await db.select().from(staff).where(eq(staff.id, staffId));
  if (!row) return null;

  const existing = (row.documents as StaffDocument[] | null) ?? [];
  const updated = existing.filter((d) => d.key !== key);
  await db.update(staff).set({ documents: updated, updatedAt: new Date() }).where(eq(staff.id, staffId));
  return updated;
}

export async function listStaff(requester?: AuthPayload): Promise<StaffMember[]> {
  const where = withBusinessFilter(requester, staff.businessId);
  const rows = await db.select().from(staff).where(where).orderBy(staff.name);
  return rows.map(staffToDto);
}

export async function getStaffMember(id: string): Promise<StaffMember | null> {
  const [row] = await db.select().from(staff).where(eq(staff.id, id));
  return row ? staffToDto(row) : null;
}

export async function createStaffMember(data: Partial<StaffMember> & { businessId?: string | null }): Promise<StaffMember> {
  const [row] = await db
    .insert(staff)
    .values({
      businessId: data.businessId ?? null,
      name: data.name || '',
      email: data.email || '',
      role: data.role || 'Employee',
      department: data.department || 'Operations',
      startDate: data.startDate || new Date().toISOString().split('T')[0],
      status: data.status || 'active',
      holidaysRemaining: data.holidaysRemaining ?? 25,
      holidaysTaken: data.holidaysTaken ?? 0,
    })
    .returning();
  return staffToDto(row);
}

export async function updateStaffMember(id: string, data: Partial<StaffMember>): Promise<StaffMember | null> {
  const patch: Partial<StaffRow> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.email !== undefined) patch.email = data.email;
  if (data.role !== undefined) patch.role = data.role;
  if (data.department !== undefined) patch.department = data.department;
  if (data.status !== undefined) patch.status = data.status;
  if (data.holidaysRemaining !== undefined) patch.holidaysRemaining = data.holidaysRemaining;
  if (data.holidaysTaken !== undefined) patch.holidaysTaken = data.holidaysTaken;

  const [row] = await db.update(staff).set(patch).where(eq(staff.id, id)).returning();
  return row ? staffToDto(row) : null;
}

export async function createJobPosting(data: { title: string; department: string; businessId?: string | null }): Promise<JobPosting> {
  const [row] = await db
    .insert(jobPostings)
    .values({
      businessId: data.businessId ?? null,
      title: data.title,
      department: data.department,
      status: 'open',
    })
    .returning();
  return jobToDto(row, 0);
}

export async function listJobPostings(requester?: AuthPayload): Promise<JobPosting[]> {
  const where = withBusinessFilter(requester, jobPostings.businessId);
  const rows = await db.select().from(jobPostings).where(where).orderBy(desc(jobPostings.postedDate));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ jobId: applicants.jobId, count: sql<number>`count(*)::int` })
    .from(applicants)
    .where(sql`${applicants.jobId} IN (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`)
    .groupBy(applicants.jobId);
  const countMap = new Map(counts.map((c) => [c.jobId, c.count]));
  return rows.map((r) => jobToDto(r, countMap.get(r.id) ?? 0));
}

async function jobBelongsToBusiness(jobId: string, businessId?: string): Promise<boolean> {
  if (!businessId) return true;
  const [row] = await db.select().from(jobPostings).where(eq(jobPostings.id, jobId));
  return !!row && row.businessId === businessId;
}

export async function listApplicants(jobId: string, requester?: AuthPayload): Promise<Applicant[]> {
  if (!(await jobBelongsToBusiness(jobId, requester?.businessId))) return [];
  const rows = await db.select().from(applicants).where(eq(applicants.jobId, jobId)).orderBy(desc(applicants.score));
  return rows.map(applicantToDto);
}

export async function updateApplicantStage(
  id: string,
  stage: Applicant['stage'],
  requester?: AuthPayload,
): Promise<Applicant | null> {
  if (requester?.businessId) {
    const [existing] = await db
      .select({ jobId: applicants.jobId })
      .from(applicants)
      .where(eq(applicants.id, id));
    if (!existing) return null;
    if (!(await jobBelongsToBusiness(existing.jobId, requester.businessId))) return null;
  }
  const [row] = await db.update(applicants).set({ stage }).where(eq(applicants.id, id)).returning();
  return row ? applicantToDto(row) : null;
}

export async function listHolidayRequests(requester?: AuthPayload): Promise<HolidayRequest[]> {
  const where = withBusinessFilter(requester, staff.businessId);
  const rows = await db
    .select({ req: holidayRequests, name: staff.name })
    .from(holidayRequests)
    .innerJoin(staff, eq(staff.id, holidayRequests.staffId))
    .where(where)
    .orderBy(desc(holidayRequests.startDate));
  return rows.map((r) => holidayToDto(r.req, r.name));
}

export async function createHolidayRequest(
  data: { staffId: string; staffName?: string; type: HolidayRequest['type']; startDate: string; endDate: string },
): Promise<HolidayRequest> {
  const [row] = await db
    .insert(holidayRequests)
    .values({
      staffId: data.staffId,
      type: data.type,
      startDate: data.startDate,
      endDate: data.endDate,
      status: 'pending',
    })
    .returning();
  let name = data.staffName ?? '';
  if (!name) {
    const [member] = await db.select().from(staff).where(eq(staff.id, data.staffId));
    name = member?.name ?? '';
  }
  return holidayToDto(row, name);
}

async function setHolidayStatus(id: string, status: 'approved' | 'rejected', approver: string): Promise<HolidayRequest | null> {
  const [row] = await db
    .update(holidayRequests)
    .set({ status, approvedBy: approver })
    .where(eq(holidayRequests.id, id))
    .returning();
  if (!row) return null;
  const [member] = await db.select().from(staff).where(eq(staff.id, row.staffId));
  return holidayToDto(row, member?.name ?? '');
}

export async function approveHolidayRequest(id: string, approver: string): Promise<HolidayRequest | null> {
  return setHolidayStatus(id, 'approved', approver);
}

export async function rejectHolidayRequest(id: string, approver: string): Promise<HolidayRequest | null> {
  return setHolidayStatus(id, 'rejected', approver);
}

export async function getStaffStats(requester?: AuthPayload): Promise<StaffStats> {
  const staffWhere = withBusinessFilter(requester, staff.businessId);
  const jobWhere = withBusinessFilter(requester, jobPostings.businessId);
  const [staffRows, jobRows] = await Promise.all([
    db.select().from(staff).where(staffWhere),
    db.select().from(jobPostings).where(jobWhere),
  ]);
  const holidayCondition = staffWhere
    ? and(staffWhere, eq(holidayRequests.status, 'pending'))
    : eq(holidayRequests.status, 'pending');
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(holidayRequests)
    .innerJoin(staff, eq(staff.id, holidayRequests.staffId))
    .where(holidayCondition);
  return {
    totalStaff: staffRows.length,
    activeStaff: staffRows.filter((s) => s.status === 'active').length,
    openPositions: jobRows.filter((j) => j.status === 'open').length,
    pendingHolidays: pending ?? 0,
  };
}
