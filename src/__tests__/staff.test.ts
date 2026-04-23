import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;
let seededStaffId: string;
let seededJobId: string;
let seededHolidayId: string;
let seededApplicantId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Staff / HR API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Self-seed: 1 staff member, 1 job posting, 1 applicant, 1 holiday request.
    const staffRes = await request(app).post('/api/v1/hr/staff').set('Authorization', `Bearer ${ownerToken}`).send({
      name: `Test Staff ${Date.now()}`,
      email: `staff+${Date.now()}@leadgeneration.io`,
      role: 'Operations Coordinator',
      department: 'Operations',
    });
    seededStaffId = staffRes.body.data.member.id;

    const jobRes = await request(app).post('/api/v1/hr/jobs').set('Authorization', `Bearer ${ownerToken}`).send({
      title: 'Operations Analyst',
      department: 'Operations',
    });
    seededJobId = jobRes.body.data.job.id;

    const holidayRes = await request(app).post('/api/v1/hr/holidays').set('Authorization', `Bearer ${ownerToken}`).send({
      staffId: seededStaffId,
      type: 'annual',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
    });
    seededHolidayId = holidayRes.body.data.holiday.id;

    // Applicants are created via DB only (no public POST endpoint) — skip seeding,
    // and gracefully handle empty applicant list in the relevant test.
    seededApplicantId = MISSING_UUID;
  });

  describe('GET /api/v1/hr/staff', () => {
    it('returns staff list', async () => {
      const res = await request(app).get('/api/v1/hr/staff').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.staff.length).toBeGreaterThan(0);
      const member = res.body.data.staff[0];
      expect(member.id).toBeDefined();
      expect(member.name).toBeDefined();
      expect(member.email).toBeDefined();
      expect(member.role).toBeDefined();
      expect(member.department).toBeDefined();
      expect(member.status).toBeDefined();
    });
  });

  describe('GET /api/v1/hr/staff/stats', () => {
    it('returns staff stats', async () => {
      const res = await request(app).get('/api/v1/hr/staff/stats').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.stats.totalStaff).toBeGreaterThan(0);
      expect(typeof res.body.data.stats.activeStaff).toBe('number');
      expect(typeof res.body.data.stats.openPositions).toBe('number');
      expect(typeof res.body.data.stats.pendingHolidays).toBe('number');
    });
  });

  describe('GET /api/v1/hr/staff/:id', () => {
    it('returns a staff member', async () => {
      const res = await request(app).get(`/api/v1/hr/staff/${seededStaffId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.member.id).toBe(seededStaffId);
    });
  });

  describe('POST /api/v1/hr/staff', () => {
    it('creates a staff member', async () => {
      const newMember = {
        name: 'Test Employee',
        email: `test.employee+${Date.now()}@leadgeneration.io`,
        role: 'Junior Developer',
        department: 'Operations',
      };
      const res = await request(app).post('/api/v1/hr/staff').set('Authorization', `Bearer ${ownerToken}`).send(newMember);
      expect(res.status).toBe(201);
      expect(res.body.data.member.name).toBe(newMember.name);
      expect(res.body.data.member.email).toBe(newMember.email);
      expect(res.body.data.member.status).toBe('active');
    });
  });

  describe('PUT /api/v1/hr/staff/:id', () => {
    it('updates a staff member', async () => {
      const update = { role: 'Senior Operations Manager' };
      const res = await request(app).put(`/api/v1/hr/staff/${seededStaffId}`).set('Authorization', `Bearer ${ownerToken}`).send(update);
      expect(res.status).toBe(200);
      expect(res.body.data.member.role).toBe('Senior Operations Manager');
    });
  });

  describe('GET /api/v1/hr/jobs', () => {
    it('returns job postings', async () => {
      const res = await request(app).get('/api/v1/hr/jobs').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.jobs.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/hr/jobs', () => {
    it('creates a job posting', async () => {
      const newJob = { title: 'QA Tester', department: 'Operations' };
      const res = await request(app).post('/api/v1/hr/jobs').set('Authorization', `Bearer ${ownerToken}`).send(newJob);
      expect(res.status).toBe(201);
      expect(res.body.data.job.title).toBe(newJob.title);
      expect(res.body.data.job.status).toBe('open');
    });
  });

  describe('GET /api/v1/hr/jobs/:id/applicants', () => {
    it('returns applicants for a job (may be empty)', async () => {
      const res = await request(app).get(`/api/v1/hr/jobs/${seededJobId}/applicants`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.applicants)).toBe(true);
    });
  });

  describe('PATCH /api/v1/hr/applicants/:id/stage', () => {
    it('returns 404 for non-existent applicant', async () => {
      const res = await request(app).patch(`/api/v1/hr/applicants/${seededApplicantId}/stage`).set('Authorization', `Bearer ${ownerToken}`).send({ stage: 'screening' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/hr/holidays', () => {
    it('returns holiday requests', async () => {
      const res = await request(app).get('/api/v1/hr/holidays').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.holidays.length).toBeGreaterThan(0);
      const holiday = res.body.data.holidays[0];
      expect(holiday.id).toBeDefined();
      expect(holiday.staffName).toBeDefined();
      expect(holiday.type).toBeDefined();
      expect(holiday.status).toBeDefined();
    });
  });

  describe('POST /api/v1/hr/holidays', () => {
    it('creates a holiday request', async () => {
      const newHoliday = {
        staffId: seededStaffId,
        type: 'annual',
        startDate: '2026-07-01',
        endDate: '2026-07-05',
      };
      const res = await request(app).post('/api/v1/hr/holidays').set('Authorization', `Bearer ${ownerToken}`).send(newHoliday);
      expect(res.status).toBe(201);
      expect(res.body.data.holiday.status).toBe('pending');
    });
  });

  describe('PATCH /api/v1/hr/holidays/:id/approve', () => {
    it('approves a holiday request', async () => {
      const res = await request(app).patch(`/api/v1/hr/holidays/${seededHolidayId}/approve`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.holiday.status).toBe('approved');
      expect(res.body.data.holiday.approvedBy).toBeDefined();
    });
  });

  describe('PATCH /api/v1/hr/holidays/:id/reject', () => {
    it('returns 404 for non-existent holiday', async () => {
      const res = await request(app).patch(`/api/v1/hr/holidays/${MISSING_UUID}/reject`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('RBAC', () => {
    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/hr/staff').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Unauthenticated access', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/hr/staff');
      expect(res.status).toBe(401);
    });
  });
});
