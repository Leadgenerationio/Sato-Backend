import type { AuthPayload } from '../types/index.js';

// ─── Types ───

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

// ─── Mock Data ───

const MOCK_STAFF: StaffMember[] = [
  {
    id: 's-1', name: 'Sam Carter', email: 'sam@leadgeneration.io',
    role: 'Managing Director', department: 'Operations', startDate: '2020-01-15',
    status: 'active', holidaysRemaining: 18, holidaysTaken: 7,
  },
  {
    id: 's-2', name: 'Rachel Green', email: 'rachel@leadgeneration.io',
    role: 'Content Lead', department: 'Content Team', startDate: '2021-03-01',
    status: 'active', holidaysRemaining: 12, holidaysTaken: 13,
  },
  {
    id: 's-3', name: 'James Walker', email: 'james@leadgeneration.io',
    role: 'Operations Manager', department: 'Operations', startDate: '2022-06-20',
    status: 'active', holidaysRemaining: 20, holidaysTaken: 5,
  },
  {
    id: 's-4', name: 'Emma Thompson', email: 'emma@leadgeneration.io',
    role: 'Content Writer', department: 'Content Team', startDate: '2023-01-10',
    status: 'on_leave', holidaysRemaining: 8, holidaysTaken: 17,
  },
  {
    id: 's-5', name: 'David Patel', email: 'david@leadgeneration.io',
    role: 'Campaign Coordinator', department: 'Operations', startDate: '2023-09-01',
    status: 'active', holidaysRemaining: 22, holidaysTaken: 3,
  },
  {
    id: 's-6', name: 'Olivia Brown', email: 'olivia@leadgeneration.io',
    role: 'Junior Content Writer', department: 'Content Team', startDate: '2024-04-15',
    status: 'terminated', holidaysRemaining: 0, holidaysTaken: 10,
  },
];

const MOCK_JOB_POSTINGS: JobPosting[] = [
  {
    id: 'j-1', title: 'Senior Content Strategist', department: 'Content Team',
    status: 'open', applicantCount: 3, postedDate: '2026-03-20',
  },
  {
    id: 'j-2', title: 'Operations Analyst', department: 'Operations',
    status: 'open', applicantCount: 3, postedDate: '2026-04-01',
  },
  {
    id: 'j-3', title: 'Lead Generation Specialist', department: 'Operations',
    status: 'closed', applicantCount: 3, postedDate: '2026-02-10',
  },
  {
    id: 'j-4', title: 'Content Editor', department: 'Content Team',
    status: 'open', applicantCount: 3, postedDate: '2026-04-10',
  },
];

const MOCK_APPLICANTS: Applicant[] = [
  // Job j-1 — Senior Content Strategist
  { id: 'a-1', name: 'Alice Morgan', email: 'alice.m@email.com', jobId: 'j-1', stage: 'interview', appliedDate: '2026-03-22', score: 82 },
  { id: 'a-2', name: 'Tom Harris', email: 'tom.h@email.com', jobId: 'j-1', stage: 'screening', appliedDate: '2026-03-25', score: 68 },
  { id: 'a-3', name: 'Nina Patel', email: 'nina.p@email.com', jobId: 'j-1', stage: 'applied', appliedDate: '2026-04-02', score: 55 },
  // Job j-2 — Operations Analyst
  { id: 'a-4', name: 'Ryan Clark', email: 'ryan.c@email.com', jobId: 'j-2', stage: 'offer', appliedDate: '2026-04-03', score: 91 },
  { id: 'a-5', name: 'Sophie Turner', email: 'sophie.t@email.com', jobId: 'j-2', stage: 'interview', appliedDate: '2026-04-05', score: 77 },
  { id: 'a-6', name: 'Mark Evans', email: 'mark.e@email.com', jobId: 'j-2', stage: 'rejected', appliedDate: '2026-04-04', score: 42 },
  // Job j-3 — Lead Generation Specialist
  { id: 'a-7', name: 'Lucy Bennett', email: 'lucy.b@email.com', jobId: 'j-3', stage: 'hired', appliedDate: '2026-02-12', score: 88 },
  { id: 'a-8', name: 'Chris Ward', email: 'chris.w@email.com', jobId: 'j-3', stage: 'rejected', appliedDate: '2026-02-15', score: 51 },
  { id: 'a-9', name: 'Hannah Cox', email: 'hannah.c@email.com', jobId: 'j-3', stage: 'rejected', appliedDate: '2026-02-14', score: 60 },
  // Job j-4 — Content Editor
  { id: 'a-10', name: 'Liam Scott', email: 'liam.s@email.com', jobId: 'j-4', stage: 'screening', appliedDate: '2026-04-11', score: 73 },
  { id: 'a-11', name: 'Zara Khan', email: 'zara.k@email.com', jobId: 'j-4', stage: 'applied', appliedDate: '2026-04-12', score: 64 },
  { id: 'a-12', name: 'Ben Taylor', email: 'ben.t@email.com', jobId: 'j-4', stage: 'applied', appliedDate: '2026-04-13', score: 58 },
];

const MOCK_HOLIDAY_REQUESTS: HolidayRequest[] = [
  {
    id: 'h-1', staffId: 's-4', staffName: 'Emma Thompson', type: 'annual',
    startDate: '2026-04-14', endDate: '2026-04-18', status: 'approved', approvedBy: 'Sam Carter',
  },
  {
    id: 'h-2', staffId: 's-2', staffName: 'Rachel Green', type: 'sick',
    startDate: '2026-04-10', endDate: '2026-04-11', status: 'approved', approvedBy: 'Sam Carter',
  },
  {
    id: 'h-3', staffId: 's-5', staffName: 'David Patel', type: 'annual',
    startDate: '2026-04-21', endDate: '2026-04-25', status: 'pending', approvedBy: null,
  },
  {
    id: 'h-4', staffId: 's-3', staffName: 'James Walker', type: 'personal',
    startDate: '2026-04-28', endDate: '2026-04-28', status: 'pending', approvedBy: null,
  },
  {
    id: 'h-5', staffId: 's-2', staffName: 'Rachel Green', type: 'annual',
    startDate: '2026-05-05', endDate: '2026-05-09', status: 'rejected', approvedBy: 'Sam Carter',
  },
];

let nextStaffId = 7;
let nextJobId = 5;
let nextHolidayId = 6;

// ─── Service ───

export async function listStaff(): Promise<StaffMember[]> {
  return [...MOCK_STAFF];
}

export async function getStaffMember(id: string): Promise<StaffMember | null> {
  return MOCK_STAFF.find((s) => s.id === id) ?? null;
}

export async function createStaffMember(data: Partial<StaffMember>): Promise<StaffMember> {
  const member: StaffMember = {
    id: `s-${nextStaffId++}`,
    name: data.name || '',
    email: data.email || '',
    role: data.role || 'Employee',
    department: data.department || 'Operations',
    startDate: data.startDate || new Date().toISOString().split('T')[0],
    status: 'active',
    holidaysRemaining: 25,
    holidaysTaken: 0,
  };
  MOCK_STAFF.push(member);
  return member;
}

export async function updateStaffMember(id: string, data: Partial<StaffMember>): Promise<StaffMember | null> {
  const member = MOCK_STAFF.find((s) => s.id === id);
  if (!member) return null;
  if (data.name) member.name = data.name;
  if (data.email) member.email = data.email;
  if (data.role) member.role = data.role;
  if (data.department) member.department = data.department;
  if (data.status) member.status = data.status;
  return member;
}

export async function createJobPosting(data: { title: string; department: string }): Promise<JobPosting> {
  const job: JobPosting = {
    id: `j-${nextJobId++}`,
    title: data.title,
    department: data.department,
    status: 'open',
    applicantCount: 0,
    postedDate: new Date().toISOString().split('T')[0],
  };
  MOCK_JOB_POSTINGS.push(job);
  return job;
}

export async function listJobPostings(): Promise<JobPosting[]> {
  return [...MOCK_JOB_POSTINGS];
}

export async function listApplicants(jobId: string): Promise<Applicant[]> {
  return MOCK_APPLICANTS.filter((a) => a.jobId === jobId);
}

export async function updateApplicantStage(
  id: string,
  stage: Applicant['stage'],
): Promise<Applicant | null> {
  const applicant = MOCK_APPLICANTS.find((a) => a.id === id);
  if (!applicant) return null;
  applicant.stage = stage;
  return applicant;
}

export async function listHolidayRequests(): Promise<HolidayRequest[]> {
  return [...MOCK_HOLIDAY_REQUESTS];
}

export async function createHolidayRequest(
  data: { staffId: string; staffName: string; type: HolidayRequest['type']; startDate: string; endDate: string },
): Promise<HolidayRequest> {
  const request: HolidayRequest = {
    id: `h-${nextHolidayId++}`,
    staffId: data.staffId,
    staffName: data.staffName,
    type: data.type,
    startDate: data.startDate,
    endDate: data.endDate,
    status: 'pending',
    approvedBy: null,
  };
  MOCK_HOLIDAY_REQUESTS.push(request);
  return request;
}

export async function approveHolidayRequest(
  id: string,
  approver: string,
): Promise<HolidayRequest | null> {
  const request = MOCK_HOLIDAY_REQUESTS.find((r) => r.id === id);
  if (!request) return null;
  request.status = 'approved';
  request.approvedBy = approver;
  return request;
}

export async function rejectHolidayRequest(
  id: string,
  approver: string,
): Promise<HolidayRequest | null> {
  const request = MOCK_HOLIDAY_REQUESTS.find((r) => r.id === id);
  if (!request) return null;
  request.status = 'rejected';
  request.approvedBy = approver;
  return request;
}

export async function getStaffStats(): Promise<StaffStats> {
  return {
    totalStaff: MOCK_STAFF.length,
    activeStaff: MOCK_STAFF.filter((s) => s.status === 'active').length,
    openPositions: MOCK_JOB_POSTINGS.filter((j) => j.status === 'open').length,
    pendingHolidays: MOCK_HOLIDAY_REQUESTS.filter((h) => h.status === 'pending').length,
  };
}
