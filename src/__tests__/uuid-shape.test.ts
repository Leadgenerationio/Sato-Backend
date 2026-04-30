import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// Test report from 30-Apr (run #2) showed all three demo flows broken by
// Zod 4's strict .uuid() rejecting the seeded demo client/campaign IDs that
// have a zero version nibble (e.g. 00000000-0000-0000-0000-000000000001).
// The shared `uuidShape` helper accepts any 36-char UUID-shape, matching
// what Postgres' uuid column already enforces. These tests guard against
// the strict-uuid regression returning across endpoints that take demo IDs.

const DEMO_CLIENT_UUID = '00000000-0000-0000-0000-000000000001';
let ownerToken: string;

describe('uuidShape — demo seed UUIDs accepted across schemas', () => {
  beforeAll(async () => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = r.body.data.tokens.accessToken;
  });

  it('POST /api/v1/agreements accepts the demo client UUID at the schema layer', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: DEMO_CLIENT_UUID,
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
        r2SourceFolder: 'misc',
      });
    // Schema is the only thing under test — downstream R2 / SignNow may 5xx
    // because the test env has no real R2 file at that key. The rejection
    // we are guarding against is a 400 with "clientId" in the message.
    if (res.status === 400) {
      expect(res.body.message).not.toMatch(/clientId/);
    }
  });

  it('POST /api/v1/invoices accepts the demo client UUID at the schema layer', async () => {
    const res = await request(app)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: DEMO_CLIENT_UUID,
        currency: 'GBP',
        lineItems: [{ description: 'Demo', quantity: 10, unitPrice: 100 }],
        addVat: true,
      });
    if (res.status === 400) {
      const errs = res.body.errors as Array<{ path: string }> | undefined;
      const clientIdErr = errs?.find((e) => e.path.endsWith('clientId'));
      expect(clientIdErr).toBeUndefined();
    }
  });

  it('POST /api/v1/creatives accepts a UUID-shape campaignId at the schema layer', async () => {
    const res = await request(app)
      .post('/api/v1/creatives')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        campaignId: '00000000-0000-0000-0000-000000000099',
        name: 'creative.png',
        type: 'image',
        r2Key: 'creatives/test.png',
        fileUrl: 'https://example.com/test.png',
        sizeBytes: 1024,
        contentType: 'image/png',
      });
    // 404 (campaign not found) is acceptable — that proves the schema PASSED.
    // 400 with "campaignId" in issues is the regression we're guarding.
    if (res.status === 400) {
      const issues = res.body.issues as Array<{ path: string[] }> | undefined;
      const campaignIdErr = issues?.find((i) => i.path.includes('campaignId'));
      expect(campaignIdErr).toBeUndefined();
    }
  });

  it('rejects non-UUID-shape strings with a clear message', async () => {
    const res = await request(app)
      .post('/api/v1/agreements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: 'not-a-uuid',
        signerEmail: 'john@apex.co',
        signerName: 'John',
        r2SourceKey: 'misc/test.pdf',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('clientId');
  });
});
