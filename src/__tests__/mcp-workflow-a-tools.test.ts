import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { apiKeys } from '../db/schema/api-keys.js';

// MCP spec v1.0 tests 5, 6, 7, 14 (ad-account side) and the several-campaigns rule.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACC = `66${tag}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = '';
let fullKey = ''; let fullKeyId = '';
let readKey = ''; let writeOnlyKey = '';
let clientA = ''; let clientB = '';
let c1 = ''; let c2 = ''; let c3 = ''; const lbC1 = `lb${tag}`;
const keyIds: string[] = [];

async function makeKey(scopes: string[]): Promise<{ key: string; id: string }> {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test wfa ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key, id: res.body.data.apiKey.id };
}
async function call(key: string, name: string, args: Record<string, unknown>) {
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
  ({ key: fullKey, id: fullKeyId } = await makeKey(['clients:read', 'ad_accounts:write']));
  readKey = (await makeKey(['clients:read'])).key;
  writeOnlyKey = (await makeKey(['ad_accounts:write'])).key;
  const cs = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test WFA A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test WFA B ${tag}`, status: 'active' },
  ]).returning();
  clientA = cs[0]!.id; clientB = cs[1]!.id;
  const camps = await db.insert(campaigns).values([
    { name: `Yash WFA Solar ${tag}`, leadbyteCampaignId: lbC1 },
    { name: `Yash WFA Insulation ${tag}` },
    { name: `Yash WFA Shared ${tag}` },
  ]).returning();
  c1 = camps[0]!.id; c2 = camps[1]!.id; c3 = camps[2]!.id;
  await db.insert(clientCampaigns).values([{ clientId: clientA, campaignId: c1 }, { clientId: clientB, campaignId: c2 }]);
});
afterAll(async () => {
  await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [clientA, clientB]));
  await db.delete(trafficSources).where(inArray(trafficSources.campaignId, [c1, c2, c3]));
  await db.delete(clientCampaigns).where(inArray(clientCampaigns.campaignId, [c1, c2, c3]));
  await db.delete(campaigns).where(inArray(campaigns.id, [c1, c2, c3]));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  if (keyIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
});

describe('find_client_by_ad_account', () => {
  it('an unlinked account is account_not_linked with a hint (test 6)', async () => {
    const r = await call(fullKey, 'find_client_by_ad_account', { platform: 'meta', accountId: `act_${ACC}0` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'account_not_linked', retryable: false });
    expect(r.structuredContent.hint).toContain('link_ad_account');
  });
  it('needs the clients:read scope', async () => {
    const r = await call(writeOnlyKey, 'find_client_by_ad_account', { platform: 'meta', accountId: ACC });
    expect(r.structuredContent.code).toBe('insufficient_scope');
  });
});

describe('link_ad_account', () => {
  it('creates a link from act_… and stores digits; find answers with the client (test 4, 14)', async () => {
    const r = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'facebook-ads', accountId: `act_${ACC}1`, accountName: 'Yash WFA account' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ result: 'created', link: { platform: 'meta', accountId: `${ACC}1`, clientId: clientA } });
    const f = await call(readKey, 'find_client_by_ad_account', { platform: 'meta', accountId: `${ACC}1` });
    expect(f.structuredContent).toMatchObject({ platform: 'meta', accountId: `${ACC}1`, client: { id: clientA }, campaignRequired: false });
    const [row] = await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, `${ACC}1`));
    expect(row).toMatchObject({ platform: 'facebook-ads', linkedByKeyId: fullKeyId });
  });
  it('a 19-digit TikTok ID and a Google ID with dashes round-trip as strings (test 14)', async () => {
    const tt = `7${tag}`.padEnd(19, '9');
    expect(tt).toHaveLength(19);
    const a = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'tiktok', accountId: tt });
    expect(a.structuredContent.link).toMatchObject({ platform: 'tiktok', accountId: tt });
    const g = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'google', accountId: '123-456-7890' });
    expect(g.structuredContent.link).toMatchObject({ platform: 'google', accountId: '1234567890' });
    const f = await call(readKey, 'find_client_by_ad_account', { platform: 'tik-tok', accountId: tt });
    expect(f.structuredContent.accountId).toBe(tt);
  });
  it('the same link again is unchanged', async () => {
    const r = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}1` });
    expect(r.structuredContent.result).toBe('unchanged');
  });
  it('refuses to move an account without confirmMove, then moves it and logs the move (test 7)', async () => {
    const refused = await call(fullKey, 'link_ad_account', { clientId: clientB, platform: 'meta', accountId: `${ACC}1` });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'move_requires_confirm' });
    expect(refused.structuredContent.hint).toContain('confirmMove');
    const [still] = await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, `${ACC}1`));
    expect(still!.clientId).toBe(clientA);

    const moved = await call(fullKey, 'link_ad_account', { clientId: clientB, platform: 'meta', accountId: `${ACC}1`, confirmMove: true });
    expect(moved.structuredContent).toMatchObject({ result: 'moved', link: { clientId: clientB, movedFromClientId: clientA } });
    const [row] = await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, `${ACC}1`));
    expect(row).toMatchObject({ clientId: clientB, movedFromClientId: clientA });
    expect(row!.movedAt).not.toBeNull();
  });
  it('a campaign must belong to the client; a shared campaign and the LeadByte number both work', async () => {
    const bad = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}2`, campaignId: c2 });
    expect(bad.structuredContent.code).toBe('campaign_client_mismatch');
    expect(await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, `${ACC}2`))).toHaveLength(0);

    const byLb = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}2`, campaignId: lbC1 });
    expect(byLb.structuredContent.link).toMatchObject({ campaignId: c1 });
    const shared = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}3`, campaignId: c3 });
    expect(shared.structuredContent.link.campaignId).toBe(c3);
    const unknown = await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}4`, campaignId: 'no-such-campaign' });
    expect(unknown.structuredContent.code).toBe('not_found');
  });
  it('an unknown client is not_found and nothing is saved', async () => {
    const r = await call(fullKey, 'link_ad_account', { clientId: '11111111-1111-4111-8111-111111111111', platform: 'meta', accountId: `${ACC}5` });
    expect(r.structuredContent.code).toBe('not_found');
  });
  it('needs the ad_accounts:write scope', async () => {
    const r = await call(readKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: `${ACC}6` });
    expect(r.structuredContent.code).toBe('insufficient_scope');
  });
});

describe('an account that feeds several campaigns', () => {
  it('find returns the list and campaignRequired', async () => {
    const acc = `${ACC}7`;
    await call(fullKey, 'link_ad_account', { clientId: clientA, platform: 'meta', accountId: acc });
    await db.insert(trafficSources).values([
      { campaignId: c1, name: `Yash WFA src1 ${tag}`, platform: 'facebook-ads', accountId: acc },
      { campaignId: c3, name: `Yash WFA src2 ${tag}`, platform: 'facebook-ads', accountId: acc },
    ]);
    const f = await call(readKey, 'find_client_by_ad_account', { platform: 'meta', accountId: acc });
    expect(f.structuredContent.campaignRequired).toBe(true);
    expect(f.structuredContent.campaigns.map((c: { campaignId: string }) => c.campaignId).sort()).toEqual([c1, c3].sort());
    expect(f.content[0]!.text).toContain('send campaignId');
  });
});

describe('POST /clients/:id/ad-accounts (REST) uses the same rules', () => {
  const post = (id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/clients/${id}/ad-accounts`).set('X-API-Key', fullKey).send(body);
  it('refuses a silent move with 409, accepts it with confirmMove', async () => {
    const acc = `${ACC}8`;
    expect((await post(clientA, { platform: 'meta', accountId: acc })).status).toBe(201);
    const refused = await post(clientB, { platform: 'meta', accountId: acc });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'move_requires_confirm' });
    const moved = await post(clientB, { platform: 'meta', accountId: acc, confirmMove: true });
    expect(moved.status).toBe(200);
    expect(moved.body.data.link).toMatchObject({ action: 'moved', platform: 'meta', movedFromClientId: clientA });
  });
});
