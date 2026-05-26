import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { getPnlSummary } from '../services/report.service.js';
import type { AuthPayload } from '../types/index.js';

/**
 * OCT-47 regression test. `getPnlSummary.unattributedSpendRows` counts ad_spend
 * rows with `client_id IS NULL` whose (platform, account_id) maps to one of
 * the requester's `traffic_sources`. Before OCT-47 the count was unscoped, so
 * every tenant saw the global "needs-mapping" total. Here we seed two tenants
 * with their own traffic_source + matching unattributed ad_spend row and
 * assert each tenant sees only its own row.
 *
 * The Report API tests in report.test.ts only assert shape (`typeof … ===
 * 'number' && >= 0`), so they kept passing after OCT-47 even when the EXISTS
 * subquery was wrong. This test exercises the scope predicate end-to-end.
 */

// All synthetic IDs hash-randomized per run so the test can't collide with
// any pre-existing dev-DB row that happens to share a `(platform, account_id)`
// tuple or a hard-coded UUID. Per Yash's PR review — the previous
// deterministic constants made the exact-delta assertion below depend on the
// dev DB never containing rows that matched the seeds, which is true today
// but isn't a stable contract.
const OWNER_BUSINESS_ID = randomUUID();
const OWNER_CLIENT_ID = randomUUID();
const OWNER_CAMPAIGN_ID = randomUUID();
const OWNER_TRAFFIC_SOURCE_ID = randomUUID();
const OWNER_AD_SPEND_ID = randomUUID();
const OWNER_ACCOUNT_ID = `act_oct47_owner_${randomUUID()}`;

const ALIEN_BUSINESS_ID = randomUUID();
const ALIEN_CLIENT_ID = randomUUID();
const ALIEN_CAMPAIGN_ID = randomUUID();
const ALIEN_TRAFFIC_SOURCE_ID = randomUUID();
const ALIEN_AD_SPEND_ID = randomUUID();
const ALIEN_ACCOUNT_ID = `act_oct47_alien_${randomUUID()}`;

// Date inside the default 30-day window so the date filter doesn't exclude
// the seeded rows. Wall-clock today minus 7 days is well inside [fromIso,
// toIso] regardless of when the suite runs.
const SEED_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

function authPayload(businessId: string): AuthPayload {
  return {
    userId: `oct-47-test-${businessId.slice(-4)}`,
    role: 'owner',
    email: `oct-47-${businessId.slice(-4)}@test.local`,
    businessId,
  };
}

describe('getPnlSummary — OCT-47 unattributedSpendRows tenant scoping', () => {
  beforeAll(async () => {
    await db.insert(businesses).values([
      { id: OWNER_BUSINESS_ID, name: 'OCT-47 owner biz', slug: 'oct-47-owner', status: 'active' },
      { id: ALIEN_BUSINESS_ID, name: 'OCT-47 alien biz', slug: 'oct-47-alien', status: 'active' },
    ]).onConflictDoNothing();

    await db.insert(clients).values([
      { id: OWNER_CLIENT_ID, businessId: OWNER_BUSINESS_ID, companyName: 'OCT-47 owner client', contactEmail: 'oct47@owner.test', currency: 'GBP', status: 'active' },
      { id: ALIEN_CLIENT_ID, businessId: ALIEN_BUSINESS_ID, companyName: 'OCT-47 alien client', contactEmail: 'oct47@alien.test', currency: 'GBP', status: 'active' },
    ]).onConflictDoNothing();

    // campaigns.client_id is the link the EXISTS subquery traverses: ad_spend
    // → traffic_sources → campaigns → clients → business_id.
    await db.insert(campaignsTable).values([
      { id: OWNER_CAMPAIGN_ID, name: 'OCT-47 owner campaign', vertical: 'Solar Panels', status: 'active', clientId: OWNER_CLIENT_ID },
      { id: ALIEN_CAMPAIGN_ID, name: 'OCT-47 alien campaign', vertical: 'Solar Panels', status: 'active', clientId: ALIEN_CLIENT_ID },
    ]).onConflictDoNothing();

    // One traffic_source per tenant, each on the same `platform='facebook'`
    // but a distinct account_id. The query matches on (platform, account_id),
    // so the only thing keeping rows tenant-scoped is the campaign-id chain.
    await db.insert(trafficSources).values([
      { id: OWNER_TRAFFIC_SOURCE_ID, campaignId: OWNER_CAMPAIGN_ID, name: 'OCT-47 owner FB source', platform: 'facebook', accountId: OWNER_ACCOUNT_ID, accountIds: [], isActive: true },
      { id: ALIEN_TRAFFIC_SOURCE_ID, campaignId: ALIEN_CAMPAIGN_ID, name: 'OCT-47 alien FB source', platform: 'facebook', accountId: ALIEN_ACCOUNT_ID, accountIds: [], isActive: true },
    ]).onConflictDoNothing();

    // The unattributed rows: client_id NULL (would be excluded from the scoped
    // adSpend join) but (platform, account_id) match each tenant's source.
    // Distinct authorization_id per row to keep the composite unique index
    // happy across test re-runs.
    await db.insert(adSpend).values([
      { id: OWNER_AD_SPEND_ID, platform: 'facebook', authorizationId: 47471, accountId: OWNER_ACCOUNT_ID, accountName: 'OCT-47 owner act', campaignId: 'fb-camp-owner', campaignName: 'fb-camp-owner', date: SEED_DATE, spend: '12.34', currency: 'GBP', clientId: null, statoCampaignId: null },
      { id: ALIEN_AD_SPEND_ID, platform: 'facebook', authorizationId: 47472, accountId: ALIEN_ACCOUNT_ID, accountName: 'OCT-47 alien act', campaignId: 'fb-camp-alien', campaignName: 'fb-camp-alien', date: SEED_DATE, spend: '56.78', currency: 'GBP', clientId: null, statoCampaignId: null },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(adSpend).where(inArray(adSpend.id, [OWNER_AD_SPEND_ID, ALIEN_AD_SPEND_ID]));
    await db.delete(trafficSources).where(inArray(trafficSources.id, [OWNER_TRAFFIC_SOURCE_ID, ALIEN_TRAFFIC_SOURCE_ID]));
    await db.delete(campaignsTable).where(inArray(campaignsTable.id, [OWNER_CAMPAIGN_ID, ALIEN_CAMPAIGN_ID]));
    await db.delete(clients).where(inArray(clients.id, [OWNER_CLIENT_ID, ALIEN_CLIENT_ID]));
    await db.delete(businesses).where(inArray(businesses.id, [OWNER_BUSINESS_ID, ALIEN_BUSINESS_ID]));
  });

  it("owner's unattributed count includes the owner row but NOT the alien row", async () => {
    const owner = await getPnlSummary(authPayload(OWNER_BUSINESS_ID), 30);
    const alien = await getPnlSummary(authPayload(ALIEN_BUSINESS_ID), 30);

    // Each tenant must see at least their own seeded row (it could be 1 if
    // there's no other unattributed data in the dev DB, or higher if the dev
    // DB has its own — both are fine, we only care about the delta).
    expect(owner.unattributedSpendRows).toBeGreaterThanOrEqual(1);
    expect(alien.unattributedSpendRows).toBeGreaterThanOrEqual(1);

    // The owner count must NOT include the alien row, and vice versa. Probe
    // by calling with a never-seeded business — random UUID so it can't
    // collide with any real seeded business. Seeded delta should be exactly
    // +1 each: each tenant sees their own seed but not the alien's.
    const noScope = await getPnlSummary(authPayload(randomUUID()), 30);
    expect(owner.unattributedSpendRows - noScope.unattributedSpendRows).toBe(1);
    expect(alien.unattributedSpendRows - noScope.unattributedSpendRows).toBe(1);
  });

  it('a never-seeded business sees neither tenant\'s row', async () => {
    const stranger = await getPnlSummary(authPayload(randomUUID()), 30);
    const owner = await getPnlSummary(authPayload(OWNER_BUSINESS_ID), 30);
    // Stranger count must be strictly less than owner count, since stranger
    // can't see the seeded owner row.
    expect(stranger.unattributedSpendRows).toBeLessThan(owner.unattributedSpendRows);
  });
});
