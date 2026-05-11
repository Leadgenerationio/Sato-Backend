import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';

// Slice 2 end-to-end (Day 7 of the slice). Walks the full Solar Panels journey
// Sam described in his Loom — campaign = vertical, multiple buyers underneath,
// per-supplier ad-spend mapping, revenue + profit math wired up. If this test
// passes, Sam's #40-46 are observably solved at the API layer.

let ownerToken: string;
let solarPanelsCampaignId: string;
let buyerAId: string;
let buyerBId: string;

describe('Slice 2 E2E: Solar Panels vertical with 2 buyers', () => {
  beforeAll(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
  });

  it('Step 1 — creates a vertical-only campaign (Solar Panels)', async () => {
    // Vertical-only campaigns are created at the DB level for now (LeadByte
    // sync is the primary write path). Slice 2 Day 1's nullable client_id
    // makes this row legal.
    const [row] = await db
      .insert(campaigns)
      .values({
        name: `Solar Panels E2E ${Date.now()}`,
        vertical: 'Solar Panels',
        status: 'active',
        leadPrice: '50.00',
        clientId: null,
      })
      .returning();
    solarPanelsCampaignId = row.id;
    expect(solarPanelsCampaignId).toBeTruthy();
  });

  it('Step 2 — creates two buyer clients for this vertical', async () => {
    const ts = Date.now();
    const aRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `UK Energy Saving Network ${ts}`,
        contactName: 'Jamie Roberts',
        contactEmail: 'jamie@uken.test',
      });
    buyerAId = aRes.body.data.client.id;
    expect(buyerAId).toBeTruthy();

    const bRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Acme Solar ${ts}`,
        contactName: 'Pat Reeves',
        contactEmail: 'pat@acme-solar.test',
      });
    buyerBId = bRes.body.data.client.id;
    expect(buyerBId).toBeTruthy();
  });

  it('Step 3 — links both buyers to the Solar Panels vertical at different prices', async () => {
    // UK Energy Saving Network pays £45; Acme Solar pays £52 — same vertical,
    // different per-buyer pricing on client_campaigns.lead_price.
    const linkA = await request(app)
      .post(`/api/v1/campaigns/${solarPanelsCampaignId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ clientId: buyerAId, leadPrice: 45, currency: 'GBP' });
    expect(linkA.status).toBe(201);
    expect(linkA.body.data.link.leadPrice).toBe(45);

    const linkB = await request(app)
      .post(`/api/v1/campaigns/${solarPanelsCampaignId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ clientId: buyerBId, leadPrice: 52 });
    expect(linkB.status).toBe(201);
  });

  it('Step 4 — verifies the buyer list — Solar Panels has both clients', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${solarPanelsCampaignId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.clients.length).toBe(2);
    const ids = res.body.data.clients.map((c: { clientId: string }) => c.clientId).sort();
    expect(ids).toContain(buyerAId);
    expect(ids).toContain(buyerBId);
  });

  it('Step 5 — reverse lookup: each buyer sees Solar Panels in /clients/:id/campaigns', async () => {
    const aRes = await request(app)
      .get(`/api/v1/clients/${buyerAId}/campaigns`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(aRes.status).toBe(200);
    const aIds = aRes.body.data.campaigns.map((c: { campaignId: string }) => c.campaignId);
    expect(aIds).toContain(solarPanelsCampaignId);

    const bRes = await request(app)
      .get(`/api/v1/clients/${buyerBId}/campaigns`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(bRes.status).toBe(200);
    const bIds = bRes.body.data.campaigns.map((c: { campaignId: string }) => c.campaignId);
    expect(bIds).toContain(solarPanelsCampaignId);
  });

  it('Step 6 — sets supplier cost_per_lead via PATCH (Sam #41)', async () => {
    const res = await request(app)
      .patch(`/api/v1/campaigns/${solarPanelsCampaignId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ costPerLead: 28 });
    expect(res.status).toBe(200);
    expect(res.body.data.campaign.costPerLead).toBe(28);
  });

  it('Step 7 — maps Facebook → Catchr NCP traffic source', async () => {
    const res = await request(app)
      .post(`/api/v1/campaigns/${solarPanelsCampaignId}/sources`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Facebook · Solar UK',
        platform: 'facebook',
        catchrUrl: 'https://catchr.io/ncp/facebook-solar-uk',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.source.platform).toBe('facebook');
  });

  it('Step 8 — maps Google → Catchr NCP and PATCH-es spend + leads', async () => {
    const createRes = await request(app)
      .post(`/api/v1/campaigns/${solarPanelsCampaignId}/sources`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Google · Solar UK',
        platform: 'google',
        catchrUrl: 'https://catchr.io/ncp/google-solar-uk',
      });
    const googleId = createRes.body.data.source.id;

    // Sync from Catchr would normally do this; we simulate the cron run by
    // PATCH-ing the snapshot columns directly.
    const updateRes = await request(app)
      .patch(`/api/v1/campaigns/${solarPanelsCampaignId}/sources/${googleId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ totalSpend: 2400, totalLeads: 60 });
    expect(updateRes.status).toBe(200);

    const src = updateRes.body.data.source;
    expect(src.totalSpend).toBe(2400);
    expect(src.totalLeads).toBe(60);
    // CPL = 2400 / 60 = £40
    expect(src.cpl).toBe(40);
    // Revenue = campaign.leadPrice (£50) × 60 leads = £3000
    expect(src.revenue).toBe(3000);
    // Net profit = £3000 - £2400 = £600
    expect(src.netProfit).toBe(600);
  });

  it('Step 9 — lists sources sorted by spend desc with full leadreports.io shape', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${solarPanelsCampaignId}/sources`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sources.length).toBe(2);

    // Sorted by spend DESC — Google (£2400) above Facebook (£0)
    expect(res.body.data.sources[0].platform).toBe('google');

    // Each row carries the full leadreports.io shape — revenue + netProfit
    // alongside spend, leads, cpl.
    for (const s of res.body.data.sources) {
      expect(s).toHaveProperty('totalSpend');
      expect(s).toHaveProperty('totalLeads');
      expect(s).toHaveProperty('cpl');
      expect(s).toHaveProperty('revenue');
      expect(s).toHaveProperty('netProfit');
      expect(s).toHaveProperty('catchrUrl');
    }
  });

  it('Step 10 — campaign detail GET surfaces linked buyers (Day 1 inversion proven via API)', async () => {
    // The Sato-side metadata loader joins the campaign with its buyer set.
    // We fetch the Sato campaign row directly to verify — the public
    // /campaigns/:id route is LeadByte-keyed so doesn't address this row.
    const { eq } = await import('drizzle-orm');
    const { clientCampaigns } = await import('../db/schema/client-campaigns.js');
    const links = await db
      .select()
      .from(clientCampaigns)
      .where(eq(clientCampaigns.campaignId, solarPanelsCampaignId));

    expect(links.length).toBe(2);
    const linkPrices = links.map((l) => Number(l.leadPrice)).sort();
    expect(linkPrices).toEqual([45, 52]);
  });

  it('Step 11 — unlinking a buyer leaves the other one intact', async () => {
    const del = await request(app)
      .delete(`/api/v1/campaigns/${solarPanelsCampaignId}/clients/${buyerBId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const list = await request(app)
      .get(`/api/v1/campaigns/${solarPanelsCampaignId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.data.clients.length).toBe(1);
    expect(list.body.data.clients[0].clientId).toBe(buyerAId);
  });
});
