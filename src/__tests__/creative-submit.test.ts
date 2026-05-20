import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeApprovals } from '../db/schema/creative-approvals.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';

// T2 (Sam, 2026-05-20) — submit-for-approval gate. Locks in the rules:
//   - newly-created creatives default to status='draft'
//   - drafts are invisible on /portal/compliance + /portal/creatives
//   - POST /creatives/:id/submit-for-approval flips draft → sent_for_approval
//   - double-submit returns 409
//   - submit emits an audit row with action='submitted'
//   - approve / reject mirror their action onto creatives.status

const tag = `t2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;
let clientToken: string;
let campaignId: string;

const createdCampaignIds: string[] = [];

async function makeCampaign(): Promise<string> {
  const [row] = await db
    .insert(campaigns)
    .values({
      name: `T2 Test ${tag}`,
      vertical: 'Test',
      status: 'active',
      clientId: DEMO_CLIENT_ID,
    })
    .returning();
  createdCampaignIds.push(row.id);
  // Link via client_campaigns so portal queries pick it up too.
  await db.insert(clientCampaigns).values({
    clientId: DEMO_CLIENT_ID,
    campaignId: row.id,
    leadPrice: '20',
    currency: 'GBP',
  }).onConflictDoNothing();
  return row.id;
}

async function createCreativeRow(campaignId: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/creatives')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      campaignId,
      name,
      type: 'image',
      r2Key: `test/${tag}/${name}`,
      fileUrl: 'https://example.com/test.png',
      sizeBytes: 1024,
      contentType: 'image/png',
      section: 'media',
    });
  expect(res.status).toBe(201);
  return res.body.data.creative.id;
}

describe('Creative submit-for-approval (T2)', () => {
  beforeAll(async () => {
    await db
      .insert(clients)
      .values({
        id: DEMO_CLIENT_ID,
        businessId: LEADGEN_BUSINESS_ID,
        companyName: 'Apex Media Ltd',
        contactEmail: 'contact@apex.test',
        currency: 'GBP',
        status: 'active',
      })
      .onConflictDoNothing();

    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    campaignId = await makeCampaign();
  });

  afterAll(async () => {
    if (createdCampaignIds.length > 0) {
      const creativeRows = await db
        .select({ id: creatives.id })
        .from(creatives)
        .where(inArray(creatives.campaignId, createdCampaignIds));
      const creativeIds = creativeRows.map((r) => r.id);
      if (creativeIds.length > 0) {
        await db.delete(creativeApprovals).where(inArray(creativeApprovals.creativeId, creativeIds));
        await db.delete(creatives).where(inArray(creatives.id, creativeIds));
      }
      await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, createdCampaignIds));
      await db.delete(campaigns).where(inArray(campaigns.id, createdCampaignIds));
    }
  });

  it('newly-created creatives default to status=draft + submittedAt=null', async () => {
    const id = await createCreativeRow(campaignId, `draft-${tag}-1`);
    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.status).toBe('draft');
    expect(row.submittedAt).toBeNull();
  });

  it('drafts are NOT returned by /portal/compliance', async () => {
    const id = await createCreativeRow(campaignId, `draft-${tag}-2`);
    const res = await request(app)
      .get('/api/v1/portal/compliance')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    const allCreativeIds = res.body.data.compliance.flatMap((c: { creatives: { id: string }[] }) => c.creatives.map((cr) => cr.id));
    expect(allCreativeIds).not.toContain(id);
  });

  it('drafts are NOT returned by /portal/creatives', async () => {
    const id = await createCreativeRow(campaignId, `draft-${tag}-3`);
    const res = await request(app)
      .get('/api/v1/portal/creatives')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    const allIds = [
      ...res.body.data.media.map((c: { id: string }) => c.id),
      ...res.body.data.copyLp.map((c: { id: string }) => c.id),
    ];
    expect(allIds).not.toContain(id);
  });

  it('submit flips draft → sent_for_approval + sets submittedAt + emits audit row', async () => {
    const id = await createCreativeRow(campaignId, `submit-${tag}-1`);
    const res = await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.event.action).toBe('submitted');

    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.status).toBe('sent_for_approval');
    expect(row.submittedAt).not.toBeNull();

    const auditRows = await db
      .select()
      .from(creativeApprovals)
      .where(eq(creativeApprovals.creativeId, id));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe('submitted');
  });

  it('after submit, creative IS returned by /portal/compliance', async () => {
    const id = await createCreativeRow(campaignId, `submit-${tag}-2`);
    await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const res = await request(app)
      .get('/api/v1/portal/compliance')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    const allCreativeIds = res.body.data.compliance.flatMap((c: { creatives: { id: string }[] }) => c.creatives.map((cr) => cr.id));
    expect(allCreativeIds).toContain(id);
  });

  it('double-submit returns 409', async () => {
    const id = await createCreativeRow(campaignId, `submit-${tag}-3`);
    const first = await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INVALID_STATE');
  });

  it('submit on non-existent creative returns 404', async () => {
    const res = await request(app)
      .post('/api/v1/creatives/00000000-0000-0000-0000-000000000000/submit-for-approval')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('buyer approval mirrors action onto creatives.status', async () => {
    const id = await createCreativeRow(campaignId, `approve-${tag}-1`);
    await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const approveRes = await request(app)
      .post(`/api/v1/portal/creatives/${id}/approve`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({});
    expect([200, 201]).toContain(approveRes.status);

    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.status).toBe('approved');
  });

  it('changes_requested re-submit returns the row to sent_for_approval', async () => {
    const id = await createCreativeRow(campaignId, `cr-${tag}-1`);
    await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);

    await request(app)
      .post(`/api/v1/portal/creatives/${id}/request-changes`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ feedback: 'Please make the logo bigger' });

    let [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.status).toBe('changes_requested');

    // Staff re-submits — should succeed and flip state back.
    const resubmit = await request(app)
      .post(`/api/v1/creatives/${id}/submit-for-approval`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resubmit.status).toBe(200);

    [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row.status).toBe('sent_for_approval');
  });
});
