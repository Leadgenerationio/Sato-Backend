import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { upsertPlatformCreative } from '../services/creative-library.service.js';

// Release review (staging → main): after an ad account is re-linked to another client, the platform sync answered 409 for
// every creative the account already held, and kept re-reading the same window. The sync of that same account now moves
// them with it; every other cross-client case still answers 409.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const account = `9${tag}01`;
let clientA = ''; let clientB = ''; let campA = ''; let campB = ''; let lpA = '';
const created: string[] = [];

async function fileUnderA(pcid: string, accountId = account): Promise<string> {
  const [row] = await db.insert(creatives).values({
    clientId: clientA, campaignId: campA, landingPageId: lpA, name: `Yash Test move ${tag}`, type: 'image', section: 'media',
    platform: 'meta', platformAccountId: accountId, platformCreativeId: pcid, fileStatus: 'ready', contentType: 'image/png',
    r2Key: `test/${tag}/${pcid}.png`, fileUrl: `r2://creatives/test/${tag}/${pcid}.png`,
  }).returning();
  created.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test move A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test move B ${tag}`, status: 'active' },
  ]).returning();
  [clientA, clientB] = cs.map((c) => c.id) as [string, string];
  const camps = await db.insert(campaigns).values([
    { name: `Yash Test move campA ${tag}`, status: 'Active' },
    { name: `Yash Test move campB ${tag}`, status: 'Active' },
  ]).returning();
  [campA, campB] = camps.map((c) => c.id) as [string, string];
  await db.insert(clientCampaigns).values([{ clientId: clientA, campaignId: campA }, { clientId: clientB, campaignId: campB }]);
  const [lp] = await db.insert(landingPages).values({ clientId: clientA, url: `https://a-${tag}.example.com/`, normalisedUrl: `a-${tag}.example.com` }).returning();
  lpA = lp!.id;
});

afterAll(async () => {
  if (created.length) await db.delete(creatives).where(inArray(creatives.id, created));
  await db.delete(landingPages).where(eq(landingPages.id, lpA));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.clientId, [clientA, clientB]));
  await db.delete(campaigns).where(inArray(campaigns.id, [campA, campB]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
});

describe('platform sync after an ad account moves to another client', () => {
  it('the sync of that same account moves its creative to the new client, with the new campaign and no old landing page', async () => {
    const id = await fileUnderA(`pc-${tag}-1`);
    const r = await upsertPlatformCreative({
      businessId: BIZ, clientId: clientB, campaignId: campB, platform: 'meta', platformAccountId: `act_${account}`,
      platformCreativeId: `pc-${tag}-1`, mediaType: 'image', headline: 'After the move', followAccountLink: true,
    });
    expect(r.created).toBe(false);
    expect(r.creative.id).toBe(id);
    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row).toMatchObject({ clientId: clientB, campaignId: campB, landingPageId: null, headline: 'After the move' });
  });

  it('the account linked with no campaign: the moved creative keeps no campaign of the old client', async () => {
    const id = await fileUnderA(`pc-${tag}-2`);
    await upsertPlatformCreative({
      businessId: BIZ, clientId: clientB, platform: 'meta', platformAccountId: account, platformCreativeId: `pc-${tag}-2`, mediaType: 'image', followAccountLink: true,
    });
    const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
    expect(row).toMatchObject({ clientId: clientB, campaignId: null });
  });

  it('still 409 without followAccountLink (uploads, MCP), and for a creative another account filed', async () => {
    const id = await fileUnderA(`pc-${tag}-3`);
    await expect(upsertPlatformCreative({
      businessId: BIZ, clientId: clientB, platform: 'meta', platformAccountId: account, platformCreativeId: `pc-${tag}-3`, mediaType: 'image',
    })).rejects.toMatchObject({ statusCode: 409 });

    const other = await fileUnderA(`pc-${tag}-4`, `9${tag}02`);
    await expect(upsertPlatformCreative({
      businessId: BIZ, clientId: clientB, platform: 'meta', platformAccountId: account, platformCreativeId: `pc-${tag}-4`, mediaType: 'image', followAccountLink: true,
    })).rejects.toMatchObject({ statusCode: 409 });

    const rows = await db.select({ id: creatives.id, clientId: creatives.clientId }).from(creatives).where(inArray(creatives.id, [id, other]));
    expect(rows.every((r) => r.clientId === clientA)).toBe(true);
  });
});
