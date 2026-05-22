import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { invalidateCache } from '../utils/cache.js';

// Regression test: /dashboard/stats and /integrations/overview must agree on
// "leads this month". Before this fix, the dashboard summed lead_deliveries
// over its default `last_year` window while the integrations overview used a
// hard-coded "first day of current calendar month" lower bound with no upper
// bound. In dev (and on Sam's prod after the daily LeadByte sync had not yet
// written rows for the current month) the dashboard tile reported 6,405 next
// to an integrations card claiming 0 — the same metric, two different numbers.
// Both now resolve through `resolveDashboardWindow('last_year')`.

const SEED_CLIENT_ID = '00000000-0000-0000-0000-0000000010d1';
const SEED_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000010d2';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let ownerToken: string;

const isoOffset = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

describe('leadsThisMonth — dashboard vs integrations overview', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;

    await db
      .insert(clients)
      .values({
        id: SEED_CLIENT_ID,
        businessId: LEADGEN_BUSINESS_ID,
        companyName: 'Lead-Coherence Test Ltd',
        contactEmail: 'lead-coherence@test',
        currency: 'GBP',
        status: 'active',
      })
      .onConflictDoNothing();

    await db
      .insert(campaigns)
      .values({
        id: SEED_CAMPAIGN_ID,
        name: 'Lead-Coherence Test Campaign',
        status: 'active',
      })
      .onConflictDoNothing();

    // Three lead_deliveries rows: one inside the current calendar month,
    // one inside the rolling-365d window but outside the current month,
    // and one outside both windows. The two endpoints must agree on the
    // sum regardless of which definition either one happens to use.
    await db
      .insert(leadDeliveries)
      .values([
        {
          campaignId: SEED_CAMPAIGN_ID,
          clientId: SEED_CLIENT_ID,
          deliveryDate: isoOffset(1),   // inside current month + 365d
          leadCount: 11,
        },
        {
          campaignId: SEED_CAMPAIGN_ID,
          clientId: SEED_CLIENT_ID,
          deliveryDate: isoOffset(60),  // outside current month, inside 365d
          leadCount: 22,
        },
        {
          campaignId: SEED_CAMPAIGN_ID,
          clientId: SEED_CLIENT_ID,
          deliveryDate: isoOffset(500), // outside 365d entirely
          leadCount: 99,
        },
      ])
      .onConflictDoNothing();

    // The overview endpoint memoises through Redis for 15 s. Bust the key
    // so we read the freshly-seeded counts and not a stale snapshot from
    // an earlier test run.
    await invalidateCache('integrations:overview');
  });

  afterAll(async () => {
    await db.delete(leadDeliveries).where(eq(leadDeliveries.campaignId, SEED_CAMPAIGN_ID));
    await db.delete(campaigns).where(eq(campaigns.id, SEED_CAMPAIGN_ID));
    await db.delete(clients).where(eq(clients.id, SEED_CLIENT_ID));
    await invalidateCache('integrations:overview');
  });

  it('dashboard and integrations overview agree on leadsThisMonth', async () => {
    const [dashRes, overviewRes] = await Promise.all([
      request(app).get('/api/v1/dashboard/stats').set('Authorization', `Bearer ${ownerToken}`),
      request(app).get('/api/v1/integrations/overview').set('Authorization', `Bearer ${ownerToken}`),
    ]);

    expect(dashRes.status).toBe(200);
    expect(overviewRes.status).toBe(200);

    const dashLeads = dashRes.body.data.leadsThisMonth;
    const overviewLeads = overviewRes.body.data.leadbyte.leadsThisMonth;

    // Coherence — both endpoints describe the same metric for the same
    // business, they must return the same number.
    expect(typeof dashLeads).toBe('number');
    expect(typeof overviewLeads).toBe('number');
    expect(overviewLeads).toBe(dashLeads);

    // Sanity — at minimum our two in-window seeds (11 + 22 = 33) must
    // be present in both counts. Higher is fine: other fixtures live in
    // the same shared DB.
    expect(dashLeads).toBeGreaterThanOrEqual(33);
  });
});
