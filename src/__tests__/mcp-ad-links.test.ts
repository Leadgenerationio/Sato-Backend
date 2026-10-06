import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { linkAdPlatformIds, findClientByAdAccount, adLinksForCreative, type WriteContext } from '../services/creative-ad-links.service.js';
import { resolveOwnership } from '../services/asset-rules.service.js';
import { domainEvents } from '../services/events.js';
import { ApiError } from '../utils/api-error.js';
import { tool as linkTool } from '../mcp/tools/link_ad_platform_ids.tool.js';
import { tool as findTool } from '../mcp/tools/find_client_by_ad_account.tool.js';
import type { ToolContext } from '../mcp/tool-contract.js';

// MCP step 1c (ownership rules, error codes) and 1d (ad links). Maps to Sam's
// acceptance tests 4 (Meta IDs stored as digits), 5 (account of another client),
// 6 (unlinked account) and 14 (TikTok / Google IDs round-trip as strings).
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const META_ACCT = `4283${tag}`;
const OTHER_ACCT = `7777${tag}`;
const MULTI_ACCT = `5555${tag}`;
const GOOGLE_ACCT = `123-${tag.slice(0, 3)}-${tag.slice(3, 7)}`;
const TIKTOK_ACCT = `7${tag}${tag}`.slice(0, 19).padEnd(19, '1');

const ctx: WriteContext = { businessId: BIZ, userId: null, apiKeyId: null, source: 'mcp' };
const ids = { apiKey: '', clientA: '', clientB: '', campA: '', campB: '', campShared: '', campA2: '', creative: '', creative2: '', creativeB: '', creativeNoCamp: '' };
const creativeIds: string[] = [];
const accountIds: string[] = [];

async function expectApiError(p: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    return err as ApiError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function newCreative(name: string, clientId: string | null, campaignId: string | null) {
  const [row] = await db.insert(creatives).values({ name: `${name} ${tag}`, fileUrl: 'r2://x', clientId, campaignId, platform: 'manual' }).returning();
  creativeIds.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  const cl = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Hari Test AdLinks A ${tag}`, status: 'active', currency: 'CHF' },
    { businessId: BIZ, companyName: `Hari Test AdLinks B ${tag}`, status: 'active' },
  ]).returning();
  ids.clientA = cl[0]!.id; ids.clientB = cl[1]!.id;
  const cp = await db.insert(campaigns).values([
    { name: `Hearing ${tag}`, leadbyteCampaignId: `lb${tag}` },
    { name: `Solar ${tag}` },
    { name: `Shared ${tag}` },
    { name: `Insulation ${tag}` },
  ]).returning();
  ids.campA = cp[0]!.id; ids.campB = cp[1]!.id; ids.campShared = cp[2]!.id; ids.campA2 = cp[3]!.id;
  await db.insert(clientCampaigns).values([
    { clientId: ids.clientA, campaignId: ids.campA },
    { clientId: ids.clientA, campaignId: ids.campA2 },
    { clientId: ids.clientB, campaignId: ids.campB },
  ]);
  const acc = await db.insert(clientAdAccounts).values([
    { businessId: BIZ, platform: 'facebook-ads', accountId: META_ACCT, clientId: ids.clientA, campaignId: ids.campA },
    { businessId: BIZ, platform: 'facebook-ads', accountId: OTHER_ACCT, clientId: ids.clientB },
    { businessId: BIZ, platform: 'facebook-ads', accountId: MULTI_ACCT, clientId: ids.clientA, campaignId: ids.campA },
    { businessId: BIZ, platform: 'google-ads', accountId: GOOGLE_ACCT.replace(/-/g, ''), clientId: ids.clientA },
    { businessId: BIZ, platform: 'tik-tok', accountId: TIKTOK_ACCT, clientId: ids.clientA },
  ]).returning();
  accountIds.push(...acc.map((a) => a.id));
  ids.creative = await newCreative('Video', ids.clientA, ids.campA);
  ids.creative2 = await newCreative('Video 2', ids.clientA, ids.campA);
  ids.creativeB = await newCreative('Other client', ids.clientB, null);
  ids.creativeNoCamp = await newCreative('No campaign', ids.clientA, null);
  const [key] = await db.insert(apiKeys).values({ businessId: BIZ, name: `Hari test bot ${tag}`, prefix: `t${tag}`.slice(0, 16), hash: `${tag}`.padEnd(64, 'a'), scopes: ['ad_links:write', 'clients:read'] }).returning();
  ids.apiKey = key!.id;
});

afterAll(async () => {
  await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, creativeIds));
  await db.delete(creatives).where(inArray(creatives.id, creativeIds));
  await db.delete(landingPages).where(inArray(landingPages.clientId, [ids.clientA, ids.clientB]));
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.id, accountIds));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.clientId, [ids.clientA, ids.clientB]));
  await db.delete(campaigns).where(inArray(campaigns.id, [ids.campA, ids.campB, ids.campShared, ids.campA2]));
  await db.delete(clients).where(inArray(clients.id, [ids.clientA, ids.clientB]));
  await db.delete(apiKeys).where(eq(apiKeys.id, ids.apiKey));
});

describe('find_client_by_ad_account', () => {
  it('finds the client with or without act_, and lists the campaign', async () => {
    const out = await findClientByAdAccount(BIZ, 'facebook-ads', `act_${META_ACCT}`);
    expect(out).toMatchObject({
      platform: 'meta', accountId: META_ACCT,
      client: { clientId: ids.clientA, currency: 'CHF' },
      campaign: { campaignId: ids.campA },
      campaignRequired: false,
    });
    expect(out.campaigns.map((c) => c.campaignId)).toEqual([ids.campA]);
  });

  it('an unlinked account is account_not_linked with a hint (test 6)', async () => {
    const err = await expectApiError(findClientByAdAccount(BIZ, 'meta', '999000111'), 'account_not_linked');
    expect(err.hint).toContain('link_ad_account');
    expect(err.statusCode).toBe(422);
  });

  it('an unknown platform is validation_failed', async () => {
    const err = await expectApiError(findClientByAdAccount(BIZ, 'myspace', META_ACCT), 'validation_failed');
    expect(err.fields).toEqual(['platform']);
  });
});

describe('ownership rules (spec §2.1)', () => {
  it('the ad account decides the client', async () => {
    const o = await resolveOwnership({ businessId: BIZ, platform: 'meta', accountId: META_ACCT });
    expect(o).toMatchObject({ clientId: ids.clientA, campaignId: ids.campA });
  });

  it('a clientId that disagrees with the account is account_client_mismatch', async () => {
    const err = await expectApiError(resolveOwnership({ businessId: BIZ, platform: 'meta', accountId: META_ACCT, clientId: ids.clientB }), 'account_client_mismatch');
    expect(err.fields).toEqual(['clientId', 'accountId']);
  });

  it("a campaign that isn't the client's is campaign_client_mismatch", async () => {
    await expectApiError(resolveOwnership({ businessId: BIZ, clientId: ids.clientA, campaignId: ids.campB }), 'campaign_client_mismatch');
  });

  it('a shared campaign (no buyers) is accepted for any client', async () => {
    const o = await resolveOwnership({ businessId: BIZ, clientId: ids.clientA, campaignId: ids.campShared });
    expect(o.campaignId).toBe(ids.campShared);
  });

  it('accepts the LeadByte number for a campaign, and never creates one', async () => {
    const o = await resolveOwnership({ businessId: BIZ, clientId: ids.clientA, campaignId: `lb${tag}` });
    expect(o.campaignId).toBe(ids.campA);
    await expectApiError(resolveOwnership({ businessId: BIZ, clientId: ids.clientA, campaignId: '999999999' }), 'not_found');
  });

  it('a clientId from another business is not_found', async () => {
    await expectApiError(resolveOwnership({ businessId: '00000000-0000-0000-0000-0000000000aa', clientId: ids.clientA }), 'not_found');
  });
});

describe('link_ad_platform_ids', () => {
  it('stores a Meta account written act_… as digits, and the full ad (test 4)', async () => {
    const out = await linkAdPlatformIds(ctx, {
      creativeId: ids.creative, platform: 'meta', accountId: `act_${META_ACCT}`,
      platformCampaignId: '120200000000000001', platformAdsetId: '120200000000000002', platformAdId: `9${tag}01`,
      platformCreativeId: '120200000000000004', platformAssetId: '1234567890123456', platformAdName: 'CH video 1',
      landingPageUrl: 'https://hear.example.ch/offer?utm_source=fb&fbclid=abc',
    });
    expect(out.result).toBe('created');
    expect(out.adLink).toMatchObject({
      platform: 'meta', accountId: META_ACCT, clientId: ids.clientA, campaignId: ids.campA,
      platformAdId: `9${tag}01`, platformAssetId: '1234567890123456', status: 'active', source: 'mcp',
    });
    expect(out.adLink.landingPageId).toBeTruthy();
    expect(out.before).toBeNull();
    // The creative's old single columns are filled from its first link.
    const [c] = await db.select().from(creatives).where(eq(creatives.id, ids.creative));
    expect(c).toMatchObject({ platform: 'meta', platformAdId: `9${tag}01`, platformAccountId: META_ACCT });
    expect(await adLinksForCreative(BIZ, ids.creative)).toHaveLength(1);
  });

  it('the same call again is unchanged; a renamed ad is updated; a left-out status is kept', async () => {
    const base = { creativeId: ids.creative, platform: 'facebook-ads', accountId: META_ACCT, platformAdId: `9${tag}01` };
    expect((await linkAdPlatformIds(ctx, base)).result).toBe('unchanged');
    expect((await linkAdPlatformIds(ctx, { ...base, status: 'paused' })).result).toBe('updated');
    const renamed = await linkAdPlatformIds(ctx, { ...base, platformAdName: 'CH video 1 v2' });
    expect(renamed.result).toBe('updated');
    expect(renamed.adLink).toMatchObject({ platformAdName: 'CH video 1 v2', status: 'paused', platformAssetId: '1234567890123456' });
    expect(renamed.before?.platformAdName).toBe('CH video 1');
  });

  it('an ad already running another creative answers duplicate, not an error', async () => {
    const out = await linkAdPlatformIds(ctx, { creativeId: ids.creative2, platform: 'meta', accountId: META_ACCT, platformAdId: `9${tag}01`, landingPageUrl: `https://dup-${tag}.example.com/` });
    expect(out.result).toBe('duplicate');
    expect(out.existingCreativeId).toBe(ids.creative);
    expect(await adLinksForCreative(BIZ, ids.creative2)).toHaveLength(0);
    // Nothing saved, not even the landing page.
    const pages = await db.select().from(landingPages).where(eq(landingPages.url, `https://dup-${tag}.example.com/`));
    expect(pages).toHaveLength(0);
  });

  it("an account owned by another client is account_client_mismatch and saves nothing (test 5)", async () => {
    const err = await expectApiError(
      linkAdPlatformIds(ctx, { creativeId: ids.creative, platform: 'meta', accountId: OTHER_ACCT, platformAdId: `8${tag}` }),
      'account_client_mismatch',
    );
    expect(err.fields).toEqual(['accountId']);
    const rows = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.platformAdId, `8${tag}`));
    expect(rows).toHaveLength(0);
  });

  it('an unlinked account is account_not_linked (test 6)', async () => {
    await expectApiError(linkAdPlatformIds(ctx, { creativeId: ids.creative, platform: 'meta', accountId: '31337', platformAdId: `7${tag}` }), 'account_not_linked');
  });

  it('a creative in another business is not_found', async () => {
    await expectApiError(
      linkAdPlatformIds({ ...ctx, businessId: '00000000-0000-0000-0000-0000000000aa' }, { creativeId: ids.creative, platform: 'meta', accountId: META_ACCT, platformAdId: `6${tag}` }),
      'not_found',
    );
  });

  it('needs at least one platform ID', async () => {
    await expectApiError(linkAdPlatformIds(ctx, { creativeId: ids.creative, platform: 'meta', accountId: META_ACCT }), 'validation_failed');
  });

  it('an account feeding several campaigns makes the caller choose (no guessing)', async () => {
    // MULTI_ACCT has campaign A on the account link; an ad on it already runs for Insulation (A2).
    await linkAdPlatformIds(ctx, { creativeId: ids.creative2, platform: 'meta', accountId: MULTI_ACCT, campaignId: ids.campA2, platformAdId: `5${tag}01` });
    const found = await findClientByAdAccount(BIZ, 'meta', MULTI_ACCT);
    expect(found.campaignRequired).toBe(true);
    expect(found.campaigns.map((c) => c.campaignId).sort()).toEqual([ids.campA, ids.campA2].sort());

    const err = await expectApiError(
      linkAdPlatformIds(ctx, { creativeId: ids.creativeNoCamp, platform: 'meta', accountId: MULTI_ACCT, platformAdId: `5${tag}02` }),
      'validation_failed',
    );
    expect(err.fields).toEqual(['campaignId']);
    expect(err.hint).toContain(ids.campA2);
    const ok = await linkAdPlatformIds(ctx, { creativeId: ids.creativeNoCamp, platform: 'meta', accountId: MULTI_ACCT, campaignId: ids.campA2, platformAdId: `5${tag}02` });
    expect(ok.adLink.campaignId).toBe(ids.campA2);
  });

  it('TikTok and Google IDs round-trip exactly as strings (test 14)', async () => {
    const tt = await linkAdPlatformIds(ctx, { creativeId: ids.creative2, platform: 'tiktok', accountId: TIKTOK_ACCT, platformAdId: '1790000000000000001' });
    expect(tt.adLink).toMatchObject({ platform: 'tiktok', accountId: TIKTOK_ACCT, platformAdId: '1790000000000000001' });
    expect(TIKTOK_ACCT).toHaveLength(19);
    const g = await linkAdPlatformIds(ctx, { creativeId: ids.creative2, platform: 'google', accountId: GOOGLE_ACCT, platformAdId: `g${tag}`, platformAssetId: 'customers/1234567890/assets/987654321' });
    expect(g.adLink).toMatchObject({ platform: 'google', accountId: GOOGLE_ACCT.replace(/-/g, ''), platformAssetId: 'customers/1234567890/assets/987654321' });
  });

  it('an asset-only link (no ad yet) is safe to repeat (Workflow B)', async () => {
    const input = { creativeId: ids.creative2, platform: 'meta', accountId: META_ACCT, campaignId: ids.campA, platformAssetId: `vid${tag}` };
    expect((await linkAdPlatformIds(ctx, input)).result).toBe('created');
    expect((await linkAdPlatformIds(ctx, input)).result).toBe('unchanged');
  });

  it('losing a race to the unique index settles on the winner instead of failing', async () => {
    // Another call inserts the same ad between our lookup and our insert.
    const input = { creativeId: ids.creative, platform: 'meta', accountId: META_ACCT, platformAdId: `9${tag}99` };
    const realInsert = db.insert.bind(db);
    const spy = vi.spyOn(db, 'insert').mockImplementationOnce(((table: typeof creativeAdLinks) => ({
      values: (v: typeof creativeAdLinks.$inferInsert) => ({
        returning: async () => {
          await realInsert(table).values(v).returning();
          return realInsert(table).values(v).returning();
        },
      }),
    })) as unknown as typeof db.insert);
    const out = await linkAdPlatformIds(ctx, input);
    spy.mockRestore();
    expect(out.result).toBe('unchanged');
    const rows = await db.select().from(creativeAdLinks).where(and(eq(creativeAdLinks.platform, 'meta'), eq(creativeAdLinks.platformAdId, `9${tag}99`)));
    expect(rows).toHaveLength(1);
  });

  it('fires creative.changed for a new link, as the portal does', async () => {
    const seen = vi.fn();
    domainEvents.on('creative.changed', seen);
    await linkAdPlatformIds(ctx, { creativeId: ids.creative, platform: 'meta', accountId: META_ACCT, platformAdId: `9${tag}02` });
    domainEvents.off('creative.changed', seen);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, data: expect.objectContaining({ creativeId: ids.creative, change: 'ad_link_added' }) }));
  });
});

describe('tool files', () => {
  const toolCtx = (): ToolContext => ({
    user: { userId: '00000000-0000-0000-0000-000000000000', email: 'api-key:test', role: 'ops_manager', businessId: BIZ },
    businessId: BIZ, apiKey: { id: ids.apiKey, scopes: ['ad_links:write', 'clients:read'] }, requestId: 'test-req-01', audit: {},
  });

  it('declare name, scope and annotations for the loader', () => {
    expect(linkTool).toMatchObject({ name: 'link_ad_platform_ids', scope: 'ad_links:write', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } });
    expect(findTool).toMatchObject({ name: 'find_client_by_ad_account', scope: 'clients:read', annotations: { readOnlyHint: true } });
    expect(linkTool.description).toMatch(/strings/);
  });

  it('link_ad_platform_ids returns a summary and fills the audit entry', async () => {
    const c = toolCtx();
    const out = await linkTool.handler({ creativeId: ids.creative, platform: 'meta', accountId: `act_${META_ACCT}`, platformAdId: `9${tag}03` }, c);
    expect(out.summary).toMatch(/^Linked creative/);
    expect(out.data).toMatchObject({ result: 'created', creativeId: ids.creative });
    expect(c.audit).toMatchObject({ tool: 'link_ad_platform_ids', before: null, recordsTouched: expect.arrayContaining([{ type: 'creative', id: ids.creative }]) });
    const [row] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.id, out.data.adLinkId as string));
    expect(row).toMatchObject({ source: 'mcp', createdByKeyId: ids.apiKey, linkedBy: null });
  });

  it('find_client_by_ad_account summary names the client', async () => {
    const c = toolCtx();
    const out = await findTool.handler({ platform: 'facebook-ads', accountId: `act_${META_ACCT}` }, c);
    expect(out.summary).toContain(`Hari Test AdLinks A ${tag}`);
    expect(c.audit.recordsTouched).toEqual([{ type: 'client', id: ids.clientA }]);
  });
});
