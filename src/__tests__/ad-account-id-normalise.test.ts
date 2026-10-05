import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { resolveClientForAdAccount } from '../services/creative-library.service.js';

// MCP tool test (5 Oct 2026): "act_428…" and "428…" were two different accounts, so a bot that linked one
// spelling could not find it under the other, and a second link made a duplicate row instead of moving it.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const ACC = `99${Date.now() % 1e9}`;
let token = ''; let a = ''; let b = '';

describe('normaliseAccountId', () => {
  it('Meta: strips act_ in any case; Google: strips dashes; others only trimmed', () => {
    expect(normaliseAccountId('meta', ' act_428353095282383 ')).toBe('428353095282383');
    expect(normaliseAccountId('facebook-ads', 'ACT_1')).toBe('1');
    expect(normaliseAccountId('facebook', '428353095282383')).toBe('428353095282383');
    expect(normaliseAccountId('google', '123-456-7890')).toBe('1234567890');
    expect(normaliseAccountId('google-ads', '1234567890')).toBe('1234567890');
    expect(normaliseAccountId('tiktok', '7000000000000000019')).toBe('7000000000000000019');
    expect(normaliseAccountId('taboola', ' acme-solar ')).toBe('acme-solar');
  });
});

describe('ad-account links match on the normalised ID', () => {
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    token = res.body.data.tokens.accessToken;
    const rows = await db.insert(clients).values([
      { businessId: BIZ, companyName: `Yash Test Acct A ${ACC}`, status: 'active' },
      { businessId: BIZ, companyName: `Yash Test Acct B ${ACC}`, status: 'active' },
    ]).returning();
    a = rows[0]!.id; b = rows[1]!.id;
  });
  afterAll(async () => {
    await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.clientId, [a, b]));
    await db.delete(clients).where(inArray(clients.id, [a, b]));
  });
  const link = (clientId: string, platform: string, accountId: string) =>
    request(app).post(`/api/v1/clients/${clientId}/ad-accounts`).set({ Authorization: `Bearer ${token}` }).send({ platform, accountId });
  const find = (platform: string, accountId: string) =>
    request(app).get('/api/v1/clients/lookup').query({ platform, accountId }).set({ Authorization: `Bearer ${token}` });

  it('links act_ + facebook-ads, finds it as meta + digits, and a second link MOVES it (one row)', async () => {
    const first = await link(a, 'facebook-ads', `act_${ACC}`);
    expect([200, 201]).toContain(first.status);
    expect(first.body.data.link.accountId).toBe(ACC);
    const hit = await find('meta', ACC);
    expect(hit.status).toBe(200);
    expect(hit.body.data.client.id).toBe(a);
    const moved = await link(b, 'meta', ACC);
    expect([200, 201]).toContain(moved.status);
    expect(moved.body.data.link.action).toBe('updated');
    const rows = await db.select().from(clientAdAccounts).where(eq(clientAdAccounts.accountId, ACC));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe(b);
  });

  it('creative upload resolves the client from either spelling', async () => {
    expect((await resolveClientForAdAccount(BIZ, 'meta', `act_${ACC}`))?.clientId).toBe(b);
    expect((await resolveClientForAdAccount(BIZ, 'facebook', ACC))?.clientId).toBe(b);
  });

  it('Google customer IDs match with or without dashes', async () => {
    const g = `${ACC}`.slice(0, 10).padEnd(10, '1');
    const dashed = `${g.slice(0, 3)}-${g.slice(3, 6)}-${g.slice(6)}`;
    expect((await link(a, 'google', dashed)).body.data.link.accountId).toBe(g);
    const hit = await find('google-ads', g);
    expect(hit.status).toBe(200);
    expect(hit.body.data.client.id).toBe(a);
  });
});
