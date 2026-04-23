import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let readonlyToken: string;

describe('Upload routes (R2 presigned URLs)', () => {
  beforeAll(async () => {
    const owner = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = owner.body.data.tokens.accessToken;
    const readonly = await request(app).post('/api/v1/auth/login').send({ email: 'readonly@stato.app', password: 'readonly123' });
    readonlyToken = readonly.body.data.tokens.accessToken;
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .send({ folder: 'agreements', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1234 });
    expect(res.status).toBe(401);
  });

  it('rejects readonly role', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${readonlyToken}`)
      .send({ folder: 'agreements', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1234 });
    expect(res.status).toBe(403);
  });

  it('rejects invalid folder', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ folder: 'not-a-folder', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10 });
    expect(res.status).toBe(400);
  });

  it('rejects files over 50MB', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        folder: 'creatives',
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        sizeBytes: 60 * 1024 * 1024,
      });
    expect(res.status).toBe(400);
  });

  it('returns a presigned upload+download URL pair for valid input', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        folder: 'agreements',
        filename: 'contract v1.pdf',
        contentType: 'application/pdf',
        sizeBytes: 200000,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.uploadUrl).toBeDefined();
    expect(res.body.data.downloadUrl).toBeDefined();
    expect(res.body.data.folder).toBe('agreements');
    expect(typeof res.body.data.key).toBe('string');
    // Filename sanitization: spaces become underscores
    expect(res.body.data.key).not.toContain(' ');
  });
});

describe('LeadByte time-slice dashboard routes', () => {
  beforeAll(async () => {
    const owner = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = owner.body.data.tokens.accessToken;
  });

  it('returns a summary for each of the seven time windows', async () => {
    for (const win of ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'ytd']) {
      const res = await request(app)
        .get(`/api/v1/leadbyte/reports/summary?window=${win}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const payload = res.body.data ?? res.body;
      expect(payload.window).toBe(win);
      expect(typeof payload.leads).toBe('number');
      expect(typeof payload.revenue).toBe('number');
      expect(typeof payload.profit).toBe('number');
    }
  });

  it('falls back to today when window is invalid', async () => {
    const res = await request(app)
      .get('/api/v1/leadbyte/reports/summary?window=nonsense')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const payload = res.body.data ?? res.body;
    expect(payload.window).toBe('today');
  });
});

describe('Integration status routes (Resend, SignNow, R2)', () => {
  beforeAll(async () => {
    const owner = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = owner.body.data.tokens.accessToken;
  });

  it.each([
    ['resend', 'configured'],
    ['signnow', 'configured'],
    ['r2', 'configured'],
  ])('/%s/status returns a configured flag', async (name, flag) => {
    const res = await request(app)
      .get(`/api/v1/integrations/${name}/status`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[flag]).toBeDefined();
    expect(typeof res.body.data[flag]).toBe('boolean');
  });
});
