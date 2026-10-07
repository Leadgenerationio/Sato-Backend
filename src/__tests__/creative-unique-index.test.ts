import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import request from 'supertest';
import { and, eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { logger } from '../utils/logger.js';
import { ensureUniqueIndex, findDuplicateGroups, indexState, createIndexSql } from '../../scripts/lib/creative-unique-index.js';
import * as r2 from '../integrations/r2/r2-client.js';
import { uniqueViolationConstraint } from '../utils/pg-errors.js';
import { upsertCopyCreative } from '../services/creative-copy.service.js';
import { CREATIVE_CLIENT_SHA_INDEX } from '../db/schema/creatives.js';

// One live creative per (client, file hash): the check script, the index script and the code that survives the index.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
const T = `creatives_idxtest_${tag}`;
const NAME = `idxtest_${tag}_uq`;
const H1 = 'a'.repeat(63) + '1'; const H2 = 'b'.repeat(63) + '2';
const C1 = '11111111-1111-4111-8111-111111111111'; const C2 = '22222222-2222-4222-8222-222222222222';
const ins = (client: string | null, sha: string | null, deleted = false) => sql.unsafe(`insert into ${T} (name, client_id, sha256, is_deleted) values ('Yash Test idx', ${client ? `'${client}'` : 'null'}, ${sha ? `'${sha}'` : 'null'}, ${deleted})`);

beforeAll(async () => {
  await sql.unsafe(`create table ${T} (like creatives including defaults)`);
  await sql.unsafe(`alter table ${T} drop constraint if exists ${T}_pkey`);
});
afterAll(async () => {
  await sql.unsafe(`drop table if exists ${T}`);
  await sql.end();
});

describe('the duplicate check', () => {
  it('finds live creatives that share (client, file hash) and ignores the rest', async () => {
    await ins(C1, H1); await ins(C1, H1);          // a duplicate
    await ins(C1, H2); await ins(C2, H2);          // same file, different clients: fine
    await ins(C1, null); await ins(C1, null);      // no hash (copy-only): fine
    await ins(null, H1); await ins(null, H1);      // no client (shared): fine
    await ins(C2, H1, true); await ins(C2, H1, true); // deleted: fine
    const groups = await findDuplicateGroups(sql, T);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ clientId: C1, sha256: H1, count: 2 });
    expect(groups[0]!.ids).toHaveLength(2);
  });
});

describe('the unique index script', () => {
  it('refuses while duplicates exist, and creates nothing', async () => {
    const r = await ensureUniqueIndex(sql, { table: T, name: NAME });
    expect(r.result).toBe('refused_duplicates');
    expect(r.duplicates).toHaveLength(1);
    expect(await indexState(sql, NAME)).toEqual({ exists: false, valid: false });
  });
  it('a dry run says what it would do and changes nothing', async () => {
    await sql.unsafe(`delete from ${T} where id in (select id from ${T} where client_id = '${C1}' and sha256 = '${H1}' order by created_at, id offset 1)`);
    const r = await ensureUniqueIndex(sql, { table: T, name: NAME, dryRun: true });
    expect(r.result).toBe('would_create');
    expect(r.sql).toBe(createIndexSql(T, NAME));
    expect(await indexState(sql, NAME)).toEqual({ exists: false, valid: false });
  });
  it('creates a valid index, which then refuses a second live creative for the same file; a second run leaves it alone', async () => {
    const r = await ensureUniqueIndex(sql, { table: T, name: NAME });
    expect(r.result).toBe('created');
    expect(await indexState(sql, NAME)).toEqual({ exists: true, valid: true });
    await expect(ins(C1, H1)).rejects.toMatchObject({ code: '23505' });
    await ins(C1, H1, true); // a deleted one is still allowed
    expect((await ensureUniqueIndex(sql, { table: T, name: NAME })).result).toBe('already_there');
  });
  it('drops and rebuilds an INVALID index left behind by a failed build', async () => {
    await sql.unsafe(`drop index concurrently ${NAME}`);
    await ins(C2, H2); // now C2/H2 has a live duplicate pair? (C2 already has one live H2)
    await expect(sql.unsafe(createIndexSql(T, NAME))).rejects.toBeTruthy(); // the build fails and leaves an INVALID index
    expect(await indexState(sql, NAME)).toEqual({ exists: true, valid: false });
    await sql.unsafe(`delete from ${T} where id in (select id from ${T} where client_id = '${C2}' and sha256 = '${H2}' and is_deleted = false order by created_at, id offset 1)`);
    const dry = await ensureUniqueIndex(sql, { table: T, name: NAME, dryRun: true });
    expect(dry.result).toBe('would_rebuild');
    expect(await indexState(sql, NAME)).toEqual({ exists: true, valid: false }); // a dry run leaves it as it is
    const r = await ensureUniqueIndex(sql, { table: T, name: NAME });
    expect(r.result).toBe('rebuilt');
    expect(await indexState(sql, NAME)).toEqual({ exists: true, valid: true });
  });
});

describe('the code survives the index: a request that loses the race gets the existing creative back as a duplicate', () => {
  let owner = ''; let key = ''; let client = ''; const keyIds: string[] = [];
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`race-${tag}`)]);
  const real = globalThis.fetch;
  let spy: ReturnType<typeof vi.spyOn>;
  const REAL_INDEX = CREATIVE_CLIENT_SHA_INDEX; // the code only answers a violation of THIS index (scoped here to the test client)
  beforeAll(async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    owner = login.body.data.tokens.accessToken;
    const made = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Yash Test race ${tag}`, scopes: ['clients:read', 'ad_accounts:write', 'creatives:write', 'creatives:read'] });
    keyIds.push(made.body.data.apiKey.id); key = made.body.data.key;
    client = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test RACE ${tag}`, status: 'active' }).returning())[0]!.id;
    await request(app).post(`/api/v1/clients/${client}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_66${tag}1` }).expect(201);
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const href = String(input instanceof URL ? input.href : input);
      if (href.startsWith('https://93.184.216.34/')) return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
      return real(input, init);
    });
  });
  afterAll(async () => {
    spy.mockRestore();
    await sql.unsafe(`drop index concurrently if exists ${REAL_INDEX}`);
    const ids = (await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, client))).map((r) => r.id);
    if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
    await db.delete(creatives).where(eq(creatives.clientId, client));
    await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, client));
    await db.delete(clients).where(eq(clients.id, client));
    await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  });
  it('8 uploads of the same new file at once: one creative, every call answers created or duplicate with that id', async () => {
    await sql.unsafe(`create unique index concurrently ${REAL_INDEX} on creatives (client_id, sha256) where sha256 is not null and client_id is not null and is_deleted = false and client_id = '${client}'`);
    const warn = vi.spyOn(logger, 'warn');
    const del = vi.spyOn(r2, 'deleteFile');
    const calls = Array.from({ length: 8 }, (_, i) => request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'upload_asset', arguments: { sourceUrl: `https://93.184.216.34/${tag}/race${i}.png`, mediaType: 'image', platform: 'meta', platformAccountId: `act_66${tag}1`, name: `Yash Test RACE asset ${tag}` } } }));
    const results = (await Promise.all(calls)).map((r) => r.body.result);
    const warned = warn.mock.calls.some((c) => String(c[1] ?? c[0]).includes('refused by the unique index'));
    warn.mockRestore();
    const deleted = del.mock.calls.map((c) => String(c[1]));
    del.mockRestore();
    expect(results.every((r) => !r.isError)).toBe(true);
    const ids = new Set(results.map((r) => r.structuredContent.creativeId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.structuredContent.result === 'created')).toHaveLength(1);
    expect(await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, client))).toHaveLength(1);
    expect(warned).toBe(true); // the race really happened and was handled
    // The files of the requests that lost are removed; the winner's file stays.
    const [winner] = await db.select().from(creatives).where(eq(creatives.clientId, client));
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted).not.toContain(winner!.r2Key);
    for (const key of deleted) expect(await r2.objectExists('creatives', key)).toBe(false);
    expect(await r2.objectExists('creatives', winner!.r2Key!)).toBe(true);
  }, 60_000);
  it('copy-only: 6 of the same text at once: one creative, every call gets it back (the same index)', async () => {
    const text = `Race copy ${tag}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => upsertCopyCreative({ businessId: BIZ, clientId: client, platform: 'meta', headline: text })));
    expect(new Set(results.map((r) => r.creative.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.clientId, client), eq(creatives.type, 'copy')))).toHaveLength(1);
  }, 60_000);
  it('a violation of some OTHER unique index is not answered as a duplicate (it stays an error)', async () => {
    const OTHER = `creatives_other_${tag}_uq`;
    // A second client with its own copy of the same race, guarded by an index with a different name.
    const other = (await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test RACE2 ${tag}`, status: 'active' }).returning())[0]!.id;
    await request(app).post(`/api/v1/clients/${other}/ad-accounts`).set('X-API-Key', key).send({ platform: 'meta', accountId: `act_67${tag}1` }).expect(201);
    await sql.unsafe(`create unique index concurrently ${OTHER} on creatives (client_id, sha256) where sha256 is not null and client_id is not null and is_deleted = false and client_id = '${other}'`);
    try {
      const calls = Array.from({ length: 8 }, (_, i) => request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'upload_asset', arguments: { sourceUrl: `https://93.184.216.34/${tag}/other${i}.png`, mediaType: 'image', platform: 'meta', platformAccountId: `act_67${tag}1`, name: `Yash Test RACE2 asset ${tag}` } } }));
      const results = (await Promise.all(calls)).map((r) => r.body.result);
      expect(results.some((r) => r.isError)).toBe(true); // the losers failed: the code did not claim a violation that is not its own
      expect(await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, other))).toHaveLength(1);
    } finally {
      await sql.unsafe(`drop index concurrently if exists ${OTHER}`);
      const ids = (await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.clientId, other))).map((r) => r.id);
      if (ids.length) await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, ids));
      await db.delete(creatives).where(eq(creatives.clientId, other));
      await db.delete(clientAdAccounts).where(eq(clientAdAccounts.clientId, other));
      await db.delete(clients).where(eq(clients.id, other));
    }
  }, 60_000);
});

describe('only our index is answered as a duplicate', () => {
  it('reads the constraint name from the error or from its cause', () => {
    expect(uniqueViolationConstraint({ code: '23505', constraint_name: 'a_uq' })).toBe('a_uq');
    expect(uniqueViolationConstraint({ cause: { code: '23505', constraint_name: 'b_uq' } })).toBe('b_uq');
    expect(uniqueViolationConstraint(new Error('x'))).toBeUndefined();
    expect(CREATIVE_CLIENT_SHA_INDEX).toBe('creatives_client_sha256_live_uq');
  });
  it('a real violation carries the index name', async () => {
    const name = `idxname_${tag}_uq`;
    await sql.unsafe(`create unique index ${name} on ${T} (name) where name = 'Yash Test name-check'`);
    await sql.unsafe(`insert into ${T} (name, client_id, sha256) values ('Yash Test name-check', '${C1}', null)`);
    const err = await sql.unsafe(`insert into ${T} (name, client_id, sha256) values ('Yash Test name-check', '${C2}', null)`).catch((e: unknown) => e);
    expect(uniqueViolationConstraint(err)).toBe(name);
    await sql.unsafe(`drop index ${name}`);
  });
});
