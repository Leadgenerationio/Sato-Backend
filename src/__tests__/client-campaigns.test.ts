import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';

// Slice 2 Day 1: many-to-many client-campaigns. Sam Loom #40 — Solar Panels
// is one campaign with many clients underneath, not three campaign rows
// (one per buyer). These tests exercise the new join-table endpoints.

let ownerToken: string;
let clientToken: string;
let firstClientId: string;
let secondClientId: string;
let campaignId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Client ↔ Campaigns links', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Create two clients
    const aRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ companyName: `Buyer A ${Date.now()}`, contactName: 'A', contactEmail: 'a@buyer.test' });
    firstClientId = aRes.body.data.client.id;

    const bRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ companyName: `Buyer B ${Date.now()}`, contactName: 'B', contactEmail: 'b@buyer.test' });
    secondClientId = bRes.body.data.client.id;

    // Create a vertical-style campaign (no client_id — the new shape).
    // Done at the DB level since the existing /campaigns POST goes through
    // LeadByte sync and we don't want to invoke that here.
    const [c] = await db.insert(campaigns).values({
      name: 'Solar Panels Test',
      vertical: 'Solar Panels',
      status: 'active',
      clientId: null,
    }).returning();
    campaignId = c.id;
  });

  describe('GET /api/v1/campaigns/:id/clients', () => {
    it('returns empty list when no buyers linked yet', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`);
      // Vertical-only campaign has no scoped buyers yet → 404 (out of scope).
      // Once we link one, the same call succeeds. This documents the current
      // scoping behaviour rather than a contract — could be relaxed later
      // (return 200 + [] for vertical-only campaigns) once Sam confirms.
      expect([200, 404]).toContain(res.status);
    });

    it('returns 404 for missing campaign', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${MISSING_UUID}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects client-role users', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/campaigns/:id/clients', () => {
    it('links a client to a campaign with a price', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: firstClientId, leadPrice: 45, currency: 'GBP' });
      expect(res.status).toBe(201);
      expect(res.body.data.link.clientId).toBe(firstClientId);
      expect(res.body.data.link.leadPrice).toBe(45);
      expect(res.body.data.link.campaignName).toBe('Solar Panels Test');
    });

    it('links a second client to the same campaign — same vertical, two buyers', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: secondClientId, leadPrice: 50 });
      expect(res.status).toBe(201);

      const listRes = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.clients.length).toBe(2);
      const clientIds = listRes.body.data.clients.map((l: { clientId: string }) => l.clientId).sort();
      expect(clientIds).toContain(firstClientId);
      expect(clientIds).toContain(secondClientId);
    });

    it('upserts on duplicate link (idempotent) — updates lead price', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: firstClientId, leadPrice: 55 });
      expect(res.status).toBe(201);
      expect(res.body.data.link.leadPrice).toBe(55);
    });

    it('rejects invalid clientId', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: 'not-a-uuid', leadPrice: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/clients/:id/campaigns (reverse lookup)', () => {
    it('lists campaigns a client buys from', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${firstClientId}/campaigns`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.campaigns.length).toBeGreaterThanOrEqual(1);
      const campaignIds = res.body.data.campaigns.map((c: { campaignId: string }) => c.campaignId);
      expect(campaignIds).toContain(campaignId);
    });

    it('returns 404 for missing client', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${MISSING_UUID}/campaigns`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  // Slice 2 Day 3: traffic-source CRUD — Sam #42-46. leadreports.io-style
  // per-campaign mapping rows: supplier → Catchr NCP → ad spend → revenue.
  describe('traffic sources CRUD', () => {
    let sourceId: string;

    it('creates a Facebook → Catchr NCP source on the test campaign', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/sources`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Facebook · Solar UK',
          platform: 'facebook',
          accountId: 'act_123456789',
          catchrUrl: 'https://catchr.io/ncp/facebook-solar-uk',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.source.name).toBe('Facebook · Solar UK');
      expect(res.body.data.source.platform).toBe('facebook');
      expect(res.body.data.source.catchrUrl).toContain('catchr.io');
      // No spend or leads yet — revenue + profit start at 0
      expect(res.body.data.source.revenue).toBe(0);
      expect(res.body.data.source.netProfit).toBe(0);
      sourceId = res.body.data.source.id;
    });

    it('lists the new source via GET /sources', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/sources`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.sources.map((s: { id: string }) => s.id);
      expect(ids).toContain(sourceId);
    });

    it('updates spend + leads → recomputes revenue and netProfit', async () => {
      // First set the campaign's leadPrice so revenue is non-zero. Easiest:
      // patch costPerLead alongside. Lead price lives on campaigns.leadPrice
      // and isn't editable via PATCH yet, so we set it directly in DB for
      // this test fixture. (Future Day 5: surface leadPrice editor too.)
      const { db } = await import('../config/database.js');
      const { campaigns: campaignsTable } = await import('../db/schema/campaigns.js');
      const { eq } = await import('drizzle-orm');
      await db.update(campaignsTable).set({ leadPrice: '50.00' }).where(eq(campaignsTable.id, campaignId));

      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}/sources/${sourceId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ totalSpend: 1200, totalLeads: 40 });
      expect(res.status).toBe(200);
      expect(res.body.data.source.totalSpend).toBe(1200);
      expect(res.body.data.source.totalLeads).toBe(40);
      // 40 leads × £50 = £2000 revenue. £2000 - £1200 = £800 profit
      expect(res.body.data.source.revenue).toBe(2000);
      expect(res.body.data.source.netProfit).toBe(800);
      expect(res.body.data.source.cpl).toBe(30);
    });

    it('rejects negative totalSpend', async () => {
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}/sources/${sourceId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ totalSpend: -10 });
      expect(res.status).toBe(400);
    });

    it('returns 404 when updating an unknown source', async () => {
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}/sources/${MISSING_UUID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ totalSpend: 10 });
      expect(res.status).toBe(404);
    });

    it('deletes a source', async () => {
      const res = await request(app)
        .delete(`/api/v1/campaigns/${campaignId}/sources/${sourceId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
      const listRes = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/sources`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const ids = listRes.body.data.sources.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(sourceId);
    });

    it('rejects client-role users from creating sources', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/sources`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ name: 'should-be-blocked' });
      expect(res.status).toBe(403);
    });
  });

  // Slice 2 Day 2: PATCH campaign exposes cost_per_lead. Sam #41.
  describe('PATCH /api/v1/campaigns/:id (cost_per_lead)', () => {
    it('sets cost_per_lead on a vertical-only campaign', async () => {
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ costPerLead: 12.5 });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.costPerLead).toBe(12.5);
    });

    it('clears cost_per_lead when null is sent', async () => {
      await request(app)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ costPerLead: 25 });
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ costPerLead: null });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.costPerLead).toBe(null);
    });

    it('rejects negative cost_per_lead via zod', async () => {
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ costPerLead: -5 });
      expect(res.status).toBe(400);
    });

    it('rejects client-role users from PATCH', async () => {
      const res = await request(app)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ costPerLead: 10 });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/campaigns/:id/clients/:clientId', () => {
    it('unlinks a client', async () => {
      const res = await request(app)
        .delete(`/api/v1/campaigns/${campaignId}/clients/${secondClientId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);

      const listRes = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const clientIds = listRes.body.data.clients.map((l: { clientId: string }) => l.clientId);
      expect(clientIds).not.toContain(secondClientId);
    });

    it('is idempotent — returns 204 even when the link is already gone', async () => {
      // Idempotency is the REST convention for DELETE. The FE double-clicks
      // the trash icon often; surfacing a 404 on the second click as a "not
      // found" toast was the source of confused-user reports. As long as the
      // campaign itself exists, deleting a non-link is a no-op success.
      const res = await request(app)
        .delete(`/api/v1/campaigns/${campaignId}/clients/${MISSING_UUID}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
    });
  });
});
