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

  // ─── #47-50 PDF editor — field schema validation ────────────────────
  it('rejects a field with xPct > 1', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
        fields: [{ page: 1, type: 'signature', xPct: 1.5, yPct: 0.5, widthPct: 0.2, heightPct: 0.05 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/xPct/);
  });

  it('rejects a field with unknown type', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
        fields: [{ page: 1, type: 'BANANA', xPct: 0.5, yPct: 0.5, widthPct: 0.2, heightPct: 0.05 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/type/);
  });

  it('rejects fields array longer than 50', async () => {
    const fields = Array.from({ length: 51 }, () => ({
      page: 1, type: 'signature', xPct: 0.5, yPct: 0.5, widthPct: 0.2, heightPct: 0.05,
    }));
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
        fields,
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fields/);
  });

  it('accepts a valid fields array (passes schema; downstream send may still fail without real R2 file)', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/nonexistent.pdf',
        fields: [
          { page: 1, type: 'signature',   xPct: 0.5, yPct: 0.9, widthPct: 0.25, heightPct: 0.05 },
          { page: 1, type: 'date_signed', xPct: 0.5, yPct: 0.95, widthPct: 0.14, heightPct: 0.04 },
        ],
      });
    // Schema validation passes — the response is now in the service-layer
    // domain (file fetch will fail because the R2 key doesn't exist) so we
    // expect anything BUT a 400 schema rejection.
    expect(res.status).not.toBe(400);
  });
});
