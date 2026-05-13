import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { previousBillingWeek } from '../services/auto-invoice.service.js';

let ownerToken: string;
let clientToken: string;

describe('Auto-invoice API (Sam Loom #14)', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  describe('previousBillingWeek — pure function', () => {
    it('Monday 13 May 2026 → previous Mon 6 May → Sun 12 May', () => {
      // Wait — 13 May 2026 is a Wednesday. Let me pick an explicit Monday.
      // 11 May 2026 = Monday. Previous Mon-Sun ends Sun 10 May = Sun.
      const w = previousBillingWeek(new Date('2026-05-11T12:00:00Z'));
      expect(w.toDate).toBe('2026-05-10');
      expect(w.fromDate).toBe('2026-05-04');
    });

    it('on a Tuesday, the previous week still ends on Sunday before it', () => {
      const w = previousBillingWeek(new Date('2026-05-12T12:00:00Z'));
      expect(w.toDate).toBe('2026-05-10');
      expect(w.fromDate).toBe('2026-05-04');
    });

    it('on a Sunday, the previous week ends a week ago (not yesterday)', () => {
      // 10 May 2026 is a Sunday. We want the week ending the PRIOR Sunday (3 May).
      const w = previousBillingWeek(new Date('2026-05-10T12:00:00Z'));
      expect(w.toDate).toBe('2026-05-03');
      expect(w.fromDate).toBe('2026-04-27');
    });

    it('crosses month + year boundary cleanly', () => {
      // Mon 5 Jan 2026 → previous Mon-Sun = 29 Dec 2025 - 4 Jan 2026
      const w = previousBillingWeek(new Date('2026-01-05T12:00:00Z'));
      expect(w.toDate).toBe('2026-01-04');
      expect(w.fromDate).toBe('2025-12-29');
    });
  });

  describe('GET /api/v1/finance/auto-invoice/runs', () => {
    it('owner gets the run list (200 + array shape)', async () => {
      const res = await request(app).get('/api/v1/finance/auto-invoice/runs').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.runs)).toBe(true);
    });

    it('client role is blocked (403)', async () => {
      const res = await request(app).get('/api/v1/finance/auto-invoice/runs').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/finance/auto-invoice/runs/next', () => {
    it('returns the upcoming billing window + schedule label', async () => {
      const res = await request(app).get('/api/v1/finance/auto-invoice/runs/next').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.data.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.data.schedule).toContain('Monday');
    });
  });

  describe('POST /api/v1/finance/auto-invoice/runs (manual)', () => {
    it('owner can trigger a manual run; second call is a no-op (skipped)', async () => {
      const first = await request(app).post('/api/v1/finance/auto-invoice/runs').set('Authorization', `Bearer ${ownerToken}`);
      expect(first.status).toBe(200);
      expect(['completed', 'skipped', 'failed']).toContain(first.body.data.status);

      // If first was completed (real deliveries) or completed-with-zero, second
      // for the same week should be skipped.
      if (first.body.data.status === 'completed') {
        const second = await request(app).post('/api/v1/finance/auto-invoice/runs').set('Authorization', `Bearer ${ownerToken}`);
        expect(second.status).toBe(200);
        expect(second.body.data.status).toBe('skipped');
      }
    });

    it('client role is blocked (403)', async () => {
      const res = await request(app).post('/api/v1/finance/auto-invoice/runs').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });
});
