import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;

describe('Staff / HR API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  // ─── Staff ───

  describe('GET /api/v1/hr/staff', () => {
    it('returns staff list', async () => {
      const res = await request(app).get('/api/v1/hr/staff').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.staff).toBeDefined();
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
      expect(res.body.data.stats).toBeDefined();
      expect(res.body.data.stats.totalStaff).toBeDefined();
      expect(res.body.data.stats.activeStaff).toBeDefined();
      expect(res.body.data.stats.openPositions).toBeDefined();
      expect(res.body.data.stats.pendingHolidays).toBeDefined();
    });
  });

  describe('GET /api/v1/hr/staff/:id', () => {
    it('returns a staff member', async () => {
      const res = await request(app).get('/api/v1/hr/staff/s-1').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.member).toBeDefined();
      expect(res.body.data.member.id).toBe('s-1');
      expect(res.body.data.member.name).toBeDefined();
    });
  });

  describe('POST /api/v1/hr/staff', () => {
    it('creates a staff member', async () => {
      const newMember = {
        name: 'Test Employee',
        email: 'test.employee@leadgeneration.io',
        role: 'Junior Developer',
        department: 'Operations',
      };
      const res = await request(app).post('/api/v1/hr/staff').set('Authorization', `Bearer ${ownerToken}`).send(newMember);
      expect(res.status).toBe(201);
      expect(res.body.data.member).toBeDefined();
      expect(res.body.data.member.id).toBeDefined();
      expect(res.body.data.member.name).toBe(newMember.name);
      expect(res.body.data.member.email).toBe(newMember.email);
      expect(res.body.data.member.status).toBe('active');
    });
  });

  describe('PUT /api/v1/hr/staff/:id', () => {
    it('updates a staff member', async () => {
      const update = { role: 'Senior Operations Manager' };
      const res = await request(app).put('/api/v1/hr/staff/s-3').set('Authorization', `Bearer ${ownerToken}`).send(update);
      expect(res.status).toBe(200);
      expect(res.body.data.member).toBeDefined();
      expect(res.body.data.member.role).toBe('Senior Operations Manager');
    });
  });

  // ─── Job Postings ───

  describe('GET /api/v1/hr/jobs', () => {
    it('returns job postings', async () => {
      const res = await request(app).get('/api/v1/hr/jobs').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.jobs).toBeDefined();
      expect(res.body.data.jobs.length).toBeGreaterThan(0);
      const job = res.body.data.jobs[0];
      expect(job.id).toBeDefined();
      expect(job.title).toBeDefined();
      expect(job.department).toBeDefined();
      expect(job.status).toBeDefined();
    });
  });

  describe('POST /api/v1/hr/jobs', () => {
    it('creates a job posting', async () => {
      const newJob = { title: 'QA Tester', department: 'Operations' };
      const res = await request(app).post('/api/v1/hr/jobs').set('Authorization', `Bearer ${ownerToken}`).send(newJob);
      expect(res.status).toBe(201);
      expect(res.body.data.job).toBeDefined();
      expect(res.body.data.job.id).toBeDefined();
      expect(res.body.data.job.title).toBe(newJob.title);
      expect(res.body.data.job.department).toBe(newJob.department);
      expect(res.body.data.job.status).toBe('open');
    });
  });

  // ─── Applicants ───

  describe('GET /api/v1/hr/jobs/:id/applicants', () => {
    it('returns applicants for a job', async () => {
      const res = await request(app).get('/api/v1/hr/jobs/j-1/applicants').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.applicants).toBeDefined();
      expect(res.body.data.applicants.length).toBeGreaterThan(0);
      const applicant = res.body.data.applicants[0];
      expect(applicant.id).toBeDefined();
      expect(applicant.name).toBeDefined();
      expect(applicant.stage).toBeDefined();
    });
  });

  describe('PATCH /api/v1/hr/applicants/:id/stage', () => {
    it('updates applicant stage', async () => {
      const res = await request(app).patch('/api/v1/hr/applicants/a-3/stage').set('Authorization', `Bearer ${ownerToken}`).send({ stage: 'screening' });
      expect(res.status).toBe(200);
      expect(res.body.data.applicant).toBeDefined();
      expect(res.body.data.applicant.stage).toBe('screening');
    });
  });

  // ─── Holidays ───

  describe('GET /api/v1/hr/holidays', () => {
    it('returns holiday requests', async () => {
      const res = await request(app).get('/api/v1/hr/holidays').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.holidays).toBeDefined();
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
        staffId: 's-2',
        staffName: 'Rachel Green',
        type: 'annual',
        startDate: '2026-06-01',
        endDate: '2026-06-05',
      };
      const res = await request(app).post('/api/v1/hr/holidays').set('Authorization', `Bearer ${ownerToken}`).send(newHoliday);
      expect(res.status).toBe(201);
      expect(res.body.data.holiday).toBeDefined();
      expect(res.body.data.holiday.id).toBeDefined();
      expect(res.body.data.holiday.staffName).toBe(newHoliday.staffName);
      expect(res.body.data.holiday.status).toBe('pending');
    });
  });

  describe('PATCH /api/v1/hr/holidays/:id/approve', () => {
    it('approves a holiday request', async () => {
      const res = await request(app).patch('/api/v1/hr/holidays/h-3/approve').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.holiday).toBeDefined();
      expect(res.body.data.holiday.status).toBe('approved');
      expect(res.body.data.holiday.approvedBy).toBeDefined();
    });
  });

  describe('PATCH /api/v1/hr/holidays/:id/reject', () => {
    it('rejects a holiday request', async () => {
      const res = await request(app).patch('/api/v1/hr/holidays/h-4/reject').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.holiday).toBeDefined();
      expect(res.body.data.holiday.status).toBe('rejected');
      expect(res.body.data.holiday.approvedBy).toBeDefined();
    });
  });

  // ─── RBAC ───

  describe('RBAC', () => {
    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/hr/staff').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─── Unauthenticated ───

  describe('Unauthenticated access', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/hr/staff');
      expect(res.status).toBe(401);
    });
  });
});
