import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// Test report from 30-Apr showed Sam getting a generic "Invalid input" toast
// when sending a SignNow envelope, with no clue which field was wrong. The
// controller now surfaces the first Zod issue path + message so the FE toast
// tells him exactly what to fix (e.g. "signerEmail: Invalid email").

let ownerToken: string;

describe('POST /api/v1/agreements — validation error surfacing', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;
  });

  it('returns a field-prefixed message when signerEmail is malformed', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'not-an-email',
        signerName: 'John Smith',
        r2SourceKey: 'misc/test.pdf',
        r2SourceFolder: 'misc',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('signerEmail');
    expect(res.body.message).not.toBe('Invalid input');
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('returns a field-prefixed message when clientId is not a UUID', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: 'c-1',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('clientId');
  });

  it('returns the refine-rule message when neither documentBase64 nor r2SourceKey is provided', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'john@apex.co',
        signerName: 'John',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/documentBase64|r2SourceKey/);
  });
});
