import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientAdAccounts, type ClientAdAccountRow } from '../db/schema/client-ad-accounts.js';
import { adAccountSyncState } from '../db/schema/ad-account-sync-state.js';
import { logger } from '../utils/logger.js';
import { _resetTaboolaTokenCache } from '../integrations/taboola/taboola-client.js';
import {
  syncAllLinkedAccounts, syncLinkedAccount, requestSyncNow, resolveUpsert,
  _setUpsertForTests, _resetSyncLogOnce, type SyncDeps, type UpsertFn,
} from '../services/platform-creative-sync.service.js';
import { DEAD_BASE, fakeMetaFetch, fakeTaboolaFetch, fakeUpsert, json, noSleep } from './platform-sync-fixtures.js';

// Plan phase 3 — scheduled Meta / Taboola creative sync, against the real DB
// (client_ad_accounts + ad_account_sync_state) with recorded-shape platform
// fixtures and an in-memory creative library. No real platform is called.

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `p3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let ownerToken: string;
let opsToken: string;
let clientToken: string;
let clientCh: string;
let clientPl: string;
let campaignId: string;
let metaLink: ClientAdAccountRow;
let taboolaLink: ClientAdAccountRow;
let googleLink: ClientAdAccountRow;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken;
}

const ENV_KEYS = ['META_SYSTEM_USER_TOKEN', 'META_GRAPH_BASE_URL', 'TABOOLA_CLIENT_ID', 'TABOOLA_CLIENT_SECRET', 'TABOOLA_BASE_URL'];
let saved: Record<string, string | undefined> = {};
function connectBoth() {
  process.env.META_GRAPH_BASE_URL = DEAD_BASE;
  process.env.TABOOLA_BASE_URL = DEAD_BASE;
  process.env.META_SYSTEM_USER_TOKEN = 'EAAB-SECRET-TOKEN';
  process.env.TABOOLA_CLIENT_ID = 'tb-client';
  process.env.TABOOLA_CLIENT_SECRET = 'tb-secret';
}
function disconnectBoth() {
  delete process.env.META_SYSTEM_USER_TOKEN;
  delete process.env.TABOOLA_CLIENT_ID;
  delete process.env.TABOOLA_CLIENT_SECRET;
}

beforeAll(async () => {
  [ownerToken, opsToken, clientToken] = await Promise.all([
    login('owner@stato.app', 'owner123'),
    login('ops@stato.app', 'ops123'),
    login('client@stato.app', 'client123'),
  ]);
  const [ch, pl] = await db.insert(clients).values([
    { businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test Hearing CH ${tag}`, currency: 'CHF', status: 'active' },
    { businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test Sonova PL ${tag}`, currency: 'PLN', status: 'active' },
  ]).returning();
  clientCh = ch.id;
  clientPl = pl.id;
  const [c] = await db.insert(campaigns).values({ name: `Hearing Aids (CH) ${tag}`, status: 'active' }).returning();
  campaignId = c.id;
  // The Taboola account is NAMED "Hearing Aids Poland" but its id is
  // "willwriting-sc" (Sam's example) — only the id matters.
  [metaLink, taboolaLink, googleLink] = await db.insert(clientAdAccounts).values([
    { businessId: LEADGEN_BUSINESS_ID, platform: 'facebook-ads', accountId: `${tag}-428353095282383`, accountName: 'CH Hearing', clientId: clientCh, campaignId },
    { businessId: LEADGEN_BUSINESS_ID, platform: 'taboola', accountId: `${tag}-willwriting-sc`, accountName: 'Hearing Aids Poland', clientId: clientPl },
    { businessId: LEADGEN_BUSINESS_ID, platform: 'google-ads', accountId: `${tag}-google-1`, clientId: clientCh },
  ]).returning();
});

afterAll(async () => {
  const ids = [metaLink?.id, taboolaLink?.id, googleLink?.id].filter(Boolean) as string[];
  if (ids.length) {
    await db.delete(adAccountSyncState).where(inArray(adAccountSyncState.clientAdAccountId, ids));
    await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.id, ids));
  }
  await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  await db.delete(clients).where(inArray(clients.id, [clientCh, clientPl]));
});

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  connectBoth();
  _resetTaboolaTokenCache();
  _resetSyncLogOnce();
  await db.delete(adAccountSyncState).where(inArray(adAccountSyncState.clientAdAccountId, [metaLink.id, taboolaLink.id, googleLink.id]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setUpsertForTests(undefined);
  vi.restoreAllMocks();
});

function deps(upsert: UpsertFn, extra: Partial<SyncDeps> = {}): SyncDeps & { metaCalls: string[] } {
  const meta = fakeMetaFetch();
  const tb = fakeTaboolaFetch();
  return {
    upsert,
    meta: { fetchImpl: meta.fetchImpl, sleep: noSleep },
    taboola: { fetchImpl: tb.fetchImpl, sleep: noSleep },
    ...extra,
    get metaCalls() { return meta.calls.map((c) => c.url); },
  };
}

const mine = (r: Awaited<ReturnType<typeof syncAllLinkedAccounts>>) =>
  r.accounts.filter((a) => [metaLink.id, taboolaLink.id, googleLink.id].includes(a.linkId));

describe('syncAllLinkedAccounts', () => {
  it('files every Meta and Taboola creative under the client that owns the ad account', async () => {
    const lib = fakeUpsert();
    const r = await syncAllLinkedAccounts(deps(lib.upsert));
    const byLink = Object.fromEntries(mine(r).map((a) => [a.linkId, a]));
    // Meta fixtures: link ad 1 + video 1 + dynamic creative 3 + carousel 3 = 8.
    expect(byLink[metaLink.id]).toMatchObject({ status: 'ok', adsSeen: 4, created: 8, updated: 0, failed: 0 });
    // Taboola: running item + motion ad (the crawling item is skipped).
    expect(byLink[taboolaLink.id]).toMatchObject({ status: 'ok', adsSeen: 3, created: 2, failed: 0 });
    // Google isn't synced by this job.
    expect(byLink[googleLink.id]).toBeUndefined();

    const metaInputs = lib.inputs.filter((i) => i.platform === 'meta');
    const tbInputs = lib.inputs.filter((i) => i.platform === 'taboola');
    expect(metaInputs).toHaveLength(8);
    for (const i of metaInputs) expect(i).toMatchObject({ businessId: LEADGEN_BUSINESS_ID, clientId: clientCh, campaignId });
    expect(tbInputs).toHaveLength(2);
    for (const i of tbInputs) expect(i).toMatchObject({ businessId: LEADGEN_BUSINESS_ID, clientId: clientPl, platformAccountId: `${tag}-willwriting-sc` });
    expect(tbInputs[0].campaignId).toBeUndefined();
  });

  it('a second run creates nothing new — same creatives are updated, not copied', async () => {
    const lib = fakeUpsert();
    await syncAllLinkedAccounts(deps(lib.upsert));
    const second = await syncAllLinkedAccounts(deps(lib.upsert));
    const acc = mine(second);
    expect(acc.reduce((n, a) => n + a.created, 0)).toBe(0);
    expect(acc.reduce((n, a) => n + a.updated, 0)).toBe(10);
    expect(lib.store.size).toBe(10);
  });

  it('records sync state and asks Meta only for ads updated since the last run (with overlap)', async () => {
    const lib = fakeUpsert();
    const t1 = new Date('2026-09-29T09:00:00Z');
    await syncLinkedAccount(metaLink, { ...deps(lib.upsert), now: () => t1 });
    const [state] = await db.select().from(adAccountSyncState).where(eq(adAccountSyncState.clientAdAccountId, metaLink.id));
    expect(state).toMatchObject({ adsSeen: 4, creativesCreated: 8, creativesUpdated: 0, creativesFailed: 0, lastError: null });
    expect(state.lastSuccessAt?.toISOString()).toBe(t1.toISOString());
    expect(state.cursorSince?.toISOString()).toBe('2026-09-29T08:50:00.000Z');

    const d2 = deps(lib.upsert, { now: () => new Date('2026-09-29T12:00:00Z') });
    await syncLinkedAccount(metaLink, d2);
    const firstAdsCall = new URL(d2.metaCalls.find((u) => u.includes('/ads'))!);
    expect(firstAdsCall.searchParams.get('updated_since')).toBe(String(Date.parse('2026-09-29T08:50:00Z') / 1000));
  });

  it('never runs the same account twice at once (scheduled run vs "Sync now")', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const lib = fakeUpsert();
    const slow: UpsertFn = async (input) => { await gate; return lib.upsert(input); };
    const first = syncLinkedAccount(metaLink, deps(slow));
    await new Promise((r) => setTimeout(r, 50));
    const second = await syncLinkedAccount(metaLink, deps(lib.upsert));
    expect(second).toMatchObject({ status: 'skipped', reason: 'already_running' });
    release();
    expect(await first).toMatchObject({ status: 'ok', created: 8 });
  });

  it('first run looks back PLATFORM_SYNC_LOOKBACK_DAYS', async () => {
    process.env.PLATFORM_SYNC_LOOKBACK_DAYS = '30';
    try {
      const d = deps(fakeUpsert().upsert, { now: () => new Date('2026-09-29T00:00:00Z') });
      await syncLinkedAccount(metaLink, d);
      const since = new URL(d.metaCalls.find((u) => u.includes('/ads'))!).searchParams.get('updated_since');
      expect(since).toBe(String(Date.parse('2026-08-30T00:00:00Z') / 1000));
    } finally { delete process.env.PLATFORM_SYNC_LOOKBACK_DAYS; }
  });

  it('a creative that fails to save is counted, reported, and its window retried next run', async () => {
    const lib = fakeUpsert((i) => i.platformCreativeId === '120210000000005002');
    const r = await syncLinkedAccount(metaLink, { ...deps(lib.upsert), now: () => new Date('2026-09-29T09:00:00Z') });
    expect(r).toMatchObject({ status: 'error', created: 7, failed: 1 });
    const [state] = await db.select().from(adAccountSyncState).where(eq(adAccountSyncState.clientAdAccountId, metaLink.id));
    expect(state.lastError).toBe('1 of 8 creatives could not be saved: storage refused 120210000000005002');
    expect(state.cursorSince).toBeNull();
  });

  it('a platform error on one account is recorded (token redacted) and the other account still syncs', async () => {
    const lib = fakeUpsert();
    const bad = fakeMetaFetch(() => json({ error: { message: 'Error validating access token: Session has expired. access_token=EAAB-SECRET-TOKEN', code: 190 } }, 400));
    const r = await syncAllLinkedAccounts({ ...deps(lib.upsert), meta: { fetchImpl: bad.fetchImpl, sleep: noSleep } });
    const byLink = Object.fromEntries(mine(r).map((a) => [a.linkId, a]));
    expect(byLink[metaLink.id].status).toBe('error');
    expect(byLink[taboolaLink.id]).toMatchObject({ status: 'ok', created: 2 });
    const [state] = await db.select().from(adAccountSyncState).where(eq(adAccountSyncState.clientAdAccountId, metaLink.id));
    expect(state.lastError).toContain('code 190');
    expect(state.lastError).not.toContain('EAAB-SECRET-TOKEN');
    expect(state.lastSuccessAt).toBeNull();
  });

  it('with no credentials: does nothing, never calls the library, and logs once', async () => {
    disconnectBoth();
    const info = vi.spyOn(logger, 'info');
    const lib = fakeUpsert();
    const r1 = await syncAllLinkedAccounts(deps(lib.upsert));
    const r2 = await syncAllLinkedAccounts(deps(lib.upsert));
    expect(r1).toMatchObject({ skipped: 'not_configured', accounts: [] });
    expect(r2.skipped).toBe('not_configured');
    expect(lib.inputs).toHaveLength(0);
    expect(info.mock.calls.filter((c) => String(c[0]).includes('Platform creative sync is off'))).toHaveLength(1);
  });

  it('only the connected platform is synced', async () => {
    delete process.env.TABOOLA_CLIENT_ID;
    const r = await syncAllLinkedAccounts(deps(fakeUpsert().upsert));
    expect(r.platforms).toEqual(['meta']);
    expect(mine(r).map((a) => a.linkId)).toEqual([metaLink.id]);
  });

  it('until the creative library is installed, reports library_missing instead of crashing', async () => {
    _setUpsertForTests(null);
    const r = await syncAllLinkedAccounts({ meta: { fetchImpl: fakeMetaFetch().fetchImpl, sleep: noSleep } });
    expect(r.skipped).toBe('library_missing');
    expect(await syncLinkedAccount(metaLink, {})).toMatchObject({ status: 'skipped', reason: 'library_missing' });
  });

  it('resolves the real upsertPlatformCreative when present, else null', async () => {
    _setUpsertForTests(undefined);
    const fn = await resolveUpsert();
    expect(fn === null || typeof fn === 'function').toBe(true);
  });
});

describe('requestSyncNow', () => {
  const owner = { userId: 'u', email: 'o@x', role: 'owner' as const, businessId: LEADGEN_BUSINESS_ID };

  it('queues when a queue is available', async () => {
    const queued: string[] = [];
    const r = await requestSyncNow(owner, metaLink.id, async (id) => { queued.push(id); return true; });
    expect(r).toEqual({ queued: true });
    expect(queued).toEqual([metaLink.id]);
  });

  it('runs inline when there is no queue', async () => {
    const r = await requestSyncNow(owner, taboolaLink.id, async () => false, deps(fakeUpsert().upsert));
    expect(r.queued).toBe(false);
    expect(r.result).toMatchObject({ status: 'ok', created: 2 });
  });

  it('refuses another business\'s link, unsupported platforms, and unconnected platforms in plain words', async () => {
    await expect(requestSyncNow({ ...owner, businessId: '00000000-0000-0000-0000-000000000000' }, metaLink.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(requestSyncNow(owner, googleLink.id)).rejects.toMatchObject({ statusCode: 422 });
    disconnectBoth();
    const err = await requestSyncNow(owner, metaLink.id).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("Meta isn't connected yet, so ads can't be pulled from it. Ask an admin to connect Meta first.");
    expect(err.message).not.toMatch(/[A-Z]+_[A-Z_]+/);
  });
});

describe('HTTP: /ad-accounts/sync-status and /:id/sync-now', () => {
  it('status lists linked Meta/Taboola accounts with their last run', async () => {
    await syncLinkedAccount(metaLink, { ...deps(fakeUpsert().upsert), now: () => new Date('2026-09-29T09:00:00Z') });
    const res = await request(app).get('/api/v1/ad-accounts/sync-status').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.platforms).toEqual({ meta: { connected: true }, taboola: { connected: true } });
    const rows = res.body.data.accounts.filter((a: { linkId: string }) => [metaLink.id, taboolaLink.id, googleLink.id].includes(a.linkId));
    expect(rows.map((a: { platform: string }) => a.platform).sort()).toEqual(['facebook-ads', 'taboola']);
    const m = rows.find((a: { linkId: string }) => a.linkId === metaLink.id);
    expect(m).toMatchObject({ clientId: clientCh, clientName: `Yash Test Hearing CH ${tag}`, lastSuccessAt: '2026-09-29T09:00:00.000Z', created: 8, adsSeen: 4 });
  });

  it('client users cannot see it', async () => {
    const res = await request(app).get('/api/v1/ad-accounts/sync-status').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  it('sync-now: 409 in plain words when the platform is not connected; 400 for a bad id; ops allowed', async () => {
    disconnectBoth();
    const res = await request(app).post(`/api/v1/ad-accounts/${metaLink.id}/sync-now`).set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Meta isn't connected yet");
    const bad = await request(app).post('/api/v1/ad-accounts/not-a-uuid/sync-now').set('Authorization', `Bearer ${opsToken}`);
    expect(bad.status).toBe(400);
    const forbidden = await request(app).post(`/api/v1/ad-accounts/${metaLink.id}/sync-now`).set('Authorization', `Bearer ${clientToken}`);
    expect(forbidden.status).toBe(403);
  });
});
