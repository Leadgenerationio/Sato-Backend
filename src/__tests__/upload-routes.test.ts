import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';

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

// Per-resource authz on GET /uploads/signed-url. Before this, any authed
// user could request a signed URL for any (folder, key) — a portal client
// could enumerate other tenants' creatives or staff-only sops/misc files.
// Every denial collapses into 404 (same shape as a genuinely missing key)
// so a portal client can't probe for which keys exist.
describe('GET /uploads/signed-url — per-resource authz', () => {
  const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
  const UA_OTHER_CLIENT_ID = '00000000-0000-0000-0000-0000000a7001';
  const UA_STAFF_CLIENT_ID = '00000000-0000-0000-0000-0000000a7002';
  const UA_OWN_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a7003';
  const UA_OTHER_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a7004';
  const UA_OWN_CREATIVE_ID = '00000000-0000-0000-0000-0000000a7005';
  const UA_OTHER_CREATIVE_ID = '00000000-0000-0000-0000-0000000a7006';
  const UA_OWN_KEY = '1779100000000-own.png';
  const UA_OTHER_KEY = '1779100000001-other.png';
  const UA_OTHER_BUSINESS_ID = '00000000-0000-0000-0000-0000000a7099';

  let clientToken: string;
  let ownerBusinessId: string;

  beforeAll(async () => {
    const owner = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = owner.body.data.tokens.accessToken;
    const client = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = client.body.data.tokens.accessToken;

    // Owner's actual businessId — looked up so the test passes regardless
    // of dev-DB seed drift between data/users.ts and DB state.
    const [ownerRow] = await db.select({ businessId: users.businessId }).from(users).where(eq(users.email, 'owner@stato.app'));
    if (!ownerRow?.businessId) throw new Error('owner user not seeded');
    ownerBusinessId = ownerRow.businessId;

    // Seed a separate "other tenant" business so cross-tenant denial tests
    // have a real business row to FK against.
    await db.insert(businesses).values({
      id: UA_OTHER_BUSINESS_ID,
      name: 'upload-authz other tenant',
      slug: 'ua-other-tenant',
      colour: '#000000',
      status: 'active',
    }).onConflictDoNothing();

    await db.insert(clients).values([
      // OTHER tenant — neither the owner's business nor the demo client's.
      { id: UA_OTHER_CLIENT_ID, businessId: UA_OTHER_BUSINESS_ID, companyName: 'Other Tenant', contactEmail: 'other@apex.test', currency: 'GBP', status: 'active' },
      // Staff-side fixture client tied to owner's business, used by the
      // "owner can read a creative in their own business" case.
      { id: UA_STAFF_CLIENT_ID, businessId: ownerBusinessId, companyName: 'Upload-Authz Staff Co', contactEmail: 'ua-staff@apex.test', currency: 'GBP', status: 'active' },
    ]).onConflictDoNothing();

    await db.insert(campaigns).values([
      { id: UA_OWN_CAMPAIGN_ID, name: 'upload-authz own', vertical: 'Solar Panels', status: 'active' },
      { id: UA_OTHER_CAMPAIGN_ID, name: 'upload-authz other', vertical: 'Solar Panels', status: 'active' },
    ]).onConflictDoNothing();

    await db.insert(clientCampaigns).values([
      // OWN: DEMO_CLIENT_ID (portal access) + STAFF_CLIENT (owner business access).
      { campaignId: UA_OWN_CAMPAIGN_ID, clientId: DEMO_CLIENT_ID },
      { campaignId: UA_OWN_CAMPAIGN_ID, clientId: UA_STAFF_CLIENT_ID },
      // OTHER: linked only to the other-tenant client.
      { campaignId: UA_OTHER_CAMPAIGN_ID, clientId: UA_OTHER_CLIENT_ID },
    ]).onConflictDoNothing();

    await db.insert(creatives).values([
      {
        id: UA_OWN_CREATIVE_ID,
        campaignId: UA_OWN_CAMPAIGN_ID,
        name: 'own.png',
        fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/1779100000000-own.png?X-Amz-Expires=900&X-Amz-Signature=x',
        r2Key: UA_OWN_KEY,
        type: 'image',
        section: 'media',
        status: 'approved',
        submittedAt: new Date(),
      },
      {
        id: UA_OTHER_CREATIVE_ID,
        campaignId: UA_OTHER_CAMPAIGN_ID,
        name: 'other.png',
        fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/1779100000001-other.png?X-Amz-Expires=900&X-Amz-Signature=x',
        r2Key: UA_OTHER_KEY,
        type: 'image',
        section: 'media',
        status: 'approved',
        submittedAt: new Date(),
      },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(creatives).where(inArray(creatives.id, [UA_OWN_CREATIVE_ID, UA_OTHER_CREATIVE_ID]));
    await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [UA_OWN_CAMPAIGN_ID, UA_OTHER_CAMPAIGN_ID]));
    await db.delete(campaigns).where(inArray(campaigns.id, [UA_OWN_CAMPAIGN_ID, UA_OTHER_CAMPAIGN_ID]));
    await db.delete(clients).where(inArray(clients.id, [UA_OTHER_CLIENT_ID, UA_STAFF_CLIENT_ID]));
    await db.delete(businesses).where(eq(businesses.id, UA_OTHER_BUSINESS_ID));
  });

  it('portal client gets a signed URL for a creative on one of their campaigns', async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_OWN_KEY}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.url).toBe('string');
  });

  it('portal client 404s on a creative belonging to a different tenant', async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_OTHER_KEY}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(404);
  });

  it('portal client 404s on an unknown creatives key (no info-leak by status)', async () => {
    const res = await request(app)
      .get('/api/v1/uploads/signed-url?folder=creatives&key=this-key-does-not-exist.png')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(404);
  });

  it.each(['misc', 'sops', 'invoices', 'landing-pages'])(
    'portal client 404s on staff-only folder %s',
    async (folder) => {
      const res = await request(app)
        .get(`/api/v1/uploads/signed-url?folder=${folder}&key=any-key.pdf`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(404);
    },
  );

  it('owner reads a creative in their own business', async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_OWN_KEY}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it('owner 404s on a creative in a different business', async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_OTHER_KEY}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  // Status / soft-delete filters mirrored from the per-id endpoints. Without
  // these, a portal client who guessed a key could open a staff-only draft
  // or a soft-deleted asset via /uploads/signed-url even though the LIST
  // endpoint correctly hides them.
  describe('hidden-state filters', () => {
    const UA_DRAFT_KEY = '1779100000010-draft.png';
    const UA_DRAFT_CREATIVE_ID = '00000000-0000-0000-0000-0000000a7010';
    const UA_DELETED_KEY = '1779100000011-deleted.png';
    const UA_DELETED_CREATIVE_ID = '00000000-0000-0000-0000-0000000a7011';

    beforeAll(async () => {
      await db.insert(creatives).values([
        {
          id: UA_DRAFT_CREATIVE_ID,
          campaignId: UA_OWN_CAMPAIGN_ID,
          name: 'draft.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/draft.png?X-Amz-Expires=900&X-Amz-Signature=x',
          r2Key: UA_DRAFT_KEY,
          type: 'image',
          section: 'media',
          status: 'draft',
        },
        {
          id: UA_DELETED_CREATIVE_ID,
          campaignId: UA_OWN_CAMPAIGN_ID,
          name: 'deleted.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/deleted.png?X-Amz-Expires=900&X-Amz-Signature=x',
          r2Key: UA_DELETED_KEY,
          type: 'image',
          section: 'media',
          status: 'approved',
          isDeleted: true,
          submittedAt: new Date(),
        },
      ]).onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(creatives).where(inArray(creatives.id, [UA_DRAFT_CREATIVE_ID, UA_DELETED_CREATIVE_ID]));
    });

    it("portal client 404s on a staff-only draft (can't open by guessing the key)", async () => {
      const res = await request(app)
        .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_DRAFT_KEY}`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(404);
    });

    it('staff CAN open a draft (drafts are staff-visible during review)', async () => {
      const res = await request(app)
        .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_DRAFT_KEY}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('nobody opens a soft-deleted creative', async () => {
      const portalRes = await request(app)
        .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_DELETED_KEY}`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(portalRes.status).toBe(404);
      const staffRes = await request(app)
        .get(`/api/v1/uploads/signed-url?folder=creatives&key=${UA_DELETED_KEY}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(staffRes.status).toBe(404);
    });
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
