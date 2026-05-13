import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { eq, and, isNotNull } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';

// #39 Attio bulk import. Mocks global.fetch so we never call real Attio.
// Locks in:
//   - 503 when ATTIO_API_KEY unset
//   - browse returns shape + flags already-imported rows
//   - import: dedupes by attioCompanyId, creates new clients, returns
//     per-row results, writes a client_imported_from_attio activity event
//   - 400 on empty/oversized attioIds array
//   - 403 for client role

let ownerToken: string;
let clientToken: string;
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.ATTIO_API_KEY;
const createdClientIds: string[] = [];

function mockAttioJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function attioRecord(recordId: string, name: string, opts: Partial<{ domain: string; industry: string }> = {}) {
  return {
    id: { record_id: recordId },
    values: {
      name: [{ value: name }],
      domains: opts.domain ? [{ domain: opts.domain }] : [],
      industry: opts.industry ? [{ value: opts.industry }] : [],
      description: [],
    },
  };
}

describe('Attio bulk import', () => {
  beforeAll(async () => {
    process.env.ATTIO_API_KEY = 'test-key';

    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const cl = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = cl.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_KEY === undefined) delete process.env.ATTIO_API_KEY;
    else process.env.ATTIO_API_KEY = ORIGINAL_KEY;

    // Sweep up rows this test inserted. Best-effort.
    for (const id of createdClientIds) {
      try { await db.delete(clients).where(eq(clients.id, id)); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  describe('GET /clients/import/attio/companies', () => {
    it('returns 503 when ATTIO_API_KEY is unset', async () => {
      const prev = process.env.ATTIO_API_KEY;
      delete process.env.ATTIO_API_KEY;
      const res = await request(app)
        .get('/api/v1/clients/import/attio/companies')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(503);
      process.env.ATTIO_API_KEY = prev;
    });

    it('returns the list mapped to our DTO shape', async () => {
      global.fetch = vi.fn(async () => mockAttioJson({
        data: [
          attioRecord('rec_aaa', 'Acme Ltd', { domain: 'acme.com', industry: 'Energy' }),
          attioRecord('rec_bbb', 'Beta Inc'),
        ],
        pagination: { next: null },
      })) as unknown as typeof fetch;

      const res = await request(app)
        .get('/api/v1/clients/import/attio/companies')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.companies).toHaveLength(2);
      expect(res.body.data.companies[0].name).toBe('Acme Ltd');
      expect(res.body.data.companies[0].domain).toBe('acme.com');
      expect(res.body.data.companies[0].industry).toBe('Energy');
      expect(res.body.data.companies[0].existingClientId).toBeNull();
      expect(res.body.data.nextCursor).toBeNull();
    });

    it('flags already-imported companies via existingClientId', async () => {
      // Pre-seed: a Stato client whose attio_company_id matches.
      const { businesses } = await import('../db/schema/businesses.js');
      const existingBiz = await db.select().from(businesses).limit(1);
      const businessId = existingBiz[0].id;
      const [seeded] = await db.insert(clients).values({
        businessId,
        companyName: 'Pre-imported Co',
        attioCompanyId: 'rec_already',
      }).returning();
      createdClientIds.push(seeded.id);

      global.fetch = vi.fn(async () => mockAttioJson({
        data: [attioRecord('rec_already', 'Pre-imported Co')],
        pagination: { next: null },
      })) as unknown as typeof fetch;

      const res = await request(app)
        .get('/api/v1/clients/import/attio/companies')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      // The Stato client id should be surfaced so the FE can disable the checkbox.
      expect(res.body.data.companies[0].existingClientId).toBe(seeded.id);
    });

    it('blocks client role', async () => {
      const res = await request(app)
        .get('/api/v1/clients/import/attio/companies')
        .set('Authorization', `Bearer ${clientToken}`);
      // Either explicit 403 from RBAC, or 404 if the route prefix gate
      // takes priority. Both are acceptable — what we never want is 200.
      expect([403, 404]).toContain(res.status);
    });

    it('forwards Attio upstream errors as 502', async () => {
      global.fetch = vi.fn(async () => mockAttioJson({ error: 'rate limited' }, 429)) as unknown as typeof fetch;
      const res = await request(app)
        .get('/api/v1/clients/import/attio/companies')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(502);
    });
  });

  describe('POST /clients/import/attio', () => {
    it('rejects empty attioIds', async () => {
      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attioIds: [] });
      expect(res.status).toBe(400);
    });

    it('rejects >200 attioIds', async () => {
      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attioIds: Array.from({ length: 201 }, (_, i) => `rec_${i}`) });
      expect(res.status).toBe(400);
    });

    it('creates one Stato client per Attio id and writes activity', async () => {
      // Mock getCompany() — called once per id. Cycle through responses
      // based on the URL the fetch is hitting.
      const newId = `rec_new_${Date.now()}`;
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        // /objects/companies/records/:id — return that company
        const match = url.match(/records\/(rec_[A-Za-z0-9_]+)$/);
        if (match) {
          return mockAttioJson({
            data: attioRecord(match[1], `Imported ${match[1]}`, { domain: 'x.com', industry: 'Tech' }),
          });
        }
        return mockAttioJson({ error: 'unexpected path' }, 404);
      }) as unknown as typeof fetch;

      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attioIds: [newId] });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(1);
      expect(res.body.data.skipped).toBe(0);
      expect(res.body.data.errors).toBe(0);
      const row = res.body.data.rows[0];
      expect(row.status).toBe('created');
      expect(row.clientId).toBeTruthy();
      createdClientIds.push(row.clientId);

      // Verify the activity event was written.
      const actRes = await request(app)
        .get(`/api/v1/clients/${row.clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(actRes.body.data.activity.some(
        (e: { eventType: string }) => e.eventType === 'client_imported_from_attio',
      )).toBe(true);
    });

    it('dedupes — re-importing the same Attio id returns "skipped"', async () => {
      // Use the seeded "rec_already" Attio id from the earlier test.
      global.fetch = vi.fn(async () => mockAttioJson({
        data: attioRecord('rec_already', 'Pre-imported Co'),
      })) as unknown as typeof fetch;

      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attioIds: ['rec_already'] });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(0);
      expect(res.body.data.skipped).toBe(1);
      expect(res.body.data.rows[0].status).toBe('skipped');
      expect(res.body.data.rows[0].reason).toMatch(/already/i);
    });

    it('per-row error when Attio returns 404 for a record', async () => {
      const ghost = `rec_ghost_${Date.now()}`;
      global.fetch = vi.fn(async () => mockAttioJson(null, 404)) as unknown as typeof fetch;
      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attioIds: [ghost] });
      expect(res.status).toBe(200);
      // 404 from getCompany surfaces as a per-row error, not a 5xx.
      expect(res.body.data.errors).toBe(1);
      expect(res.body.data.rows[0].status).toBe('error');
    });

    it('blocks client role', async () => {
      const res = await request(app)
        .post('/api/v1/clients/import/attio')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ attioIds: ['rec_x'] });
      expect([403, 404]).toContain(res.status);
    });

    it('subsequent imports never produce dupes (uniqueness via attioCompanyId)', async () => {
      // Sanity: any clients with attioCompanyId from our test runs must be unique.
      const all = await db
        .select({ id: clients.id, attio: clients.attioCompanyId })
        .from(clients)
        .where(and(isNotNull(clients.attioCompanyId)));
      const ids = all.map((r) => r.attio).filter(Boolean) as string[];
      const set = new Set(ids);
      expect(set.size).toBe(ids.length);
    });
  });
});
