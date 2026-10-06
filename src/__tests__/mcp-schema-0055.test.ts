import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';

// Migration 0055 (MCP connector, step 1a): column types, copy-only rows, the
// ad-link backfill and its unique index, ID normalisation, and that the file
// can be applied again on every boot (auto-migrate re-applies all files).
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const MIGRATION = path.join(__dirname, '../db/migrations/0055_mcp_schema.sql');
const statements = fs.readFileSync(MIGRATION, 'utf8').split(/-->\s*statement-breakpoint\s*/i).map((s) => s.trim()).filter(Boolean);
const run = (stmt: string) => db.execute(sql.raw(stmt));
const stmtWith = (needle: string) => statements.find((s) => s.includes(needle))!;

let clientId = '';
let clientB = '';
const creativeIds: string[] = [];
const accountRows: string[] = [];

beforeAll(async () => {
  const rows = await db.insert(clients).values([
    { businessId: BIZ, companyName: `Yash Test Schema A ${tag}`, status: 'active' },
    { businessId: BIZ, companyName: `Yash Test Schema B ${tag}`, status: 'active' },
  ]).returning();
  clientId = rows[0]!.id; clientB = rows[1]!.id;
});

afterAll(async () => {
  await db.delete(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, creativeIds));
  await db.delete(creatives).where(inArray(creatives.id, creativeIds));
  if (accountRows.length) await db.delete(clientAdAccounts).where(inArray(clientAdAccounts.id, accountRows));
  await db.delete(clients).where(inArray(clients.id, [clientId, clientB]));
});

describe('0055 column types and defaults', () => {
  it('size_bytes is bigint and holds a 4 GB file', async () => {
    const [c] = await db.insert(creatives).values({ name: `Yash big ${tag}`, fileUrl: 'x', sizeBytes: 4_294_967_296, clientId }).returning();
    creativeIds.push(c!.id);
    expect(c!.sizeBytes).toBe(4_294_967_296);
  });
  it('a copy-only creative has no file; new columns default sensibly', async () => {
    const [c] = await db.insert(creatives).values({ name: `Yash copy ${tag}`, type: 'copy', section: 'copy_lp', headline: 'Headline', clientId }).returning();
    creativeIds.push(c!.id);
    expect(c!.fileUrl).toBeNull();
    expect(c).toMatchObject({ fileStatus: 'ready', source: 'portal', archivedAt: null, archiveReason: null, createdByKeyId: null, tags: [] });
  });
  it('the new tables exist', async () => {
    const r = await db.execute(sql`select table_name from information_schema.tables where table_name in ('creative_ad_links','uploads','api_audit_log')`);
    expect(r.map((x) => x.table_name).sort()).toEqual(['api_audit_log', 'creative_ad_links', 'uploads']);
  });
  it('the unique ad index is valid', async () => {
    const r = await db.execute(sql`select i.indisvalid, i.indisunique from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'creative_ad_links_ad_uq'`);
    expect(r[0]).toMatchObject({ indisvalid: true, indisunique: true });
  });
});

describe('0055 is safe to apply again', () => {
  it('every statement re-runs without an error', async () => {
    for (const stmt of statements) await run(stmt);
  });
});

describe('creative_ad_links backfill and unique index', () => {
  const AD = `9${tag}`;
  it('links a creative that has a platform ad ID once, however often it re-runs', async () => {
    const [c] = await db.insert(creatives).values({ name: `Yash ad ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: AD, platformAccountId: 'acc' }).returning();
    creativeIds.push(c!.id);
    const backfill = stmtWith('INSERT INTO creative_ad_links');
    await run(backfill);
    await run(backfill);
    const links = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, c!.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ platform: 'meta', platformAdId: AD, status: 'active', businessId: BIZ, clientId, source: 'sync' });
  });
  it('a second creative with the same ad ID gets no link; the oldest keeps it', async () => {
    const [c2] = await db.insert(creatives).values({ name: `Yash ad dup ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: AD }).returning();
    creativeIds.push(c2!.id);
    await run(stmtWith('INSERT INTO creative_ad_links'));
    expect(await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, c2!.id))).toHaveLength(0);
  });
  it('skips manual, platform-less and client-less creatives', async () => {
    const rows = await db.insert(creatives).values([
      { name: `Yash manual ${tag}`, fileUrl: 'x', clientId, platform: 'manual', platformAdId: `m${tag}` },
      { name: `Yash noplat ${tag}`, fileUrl: 'x', clientId, platformAdId: `n${tag}` },
      { name: `Yash noclient ${tag}`, fileUrl: 'x', platform: 'meta', platformAdId: `c${tag}` },
    ]).returning();
    rows.forEach((r) => creativeIds.push(r.id));
    await run(stmtWith('INSERT INTO creative_ad_links'));
    expect(await db.select().from(creativeAdLinks).where(inArray(creativeAdLinks.creativeId, rows.map((r) => r.id)))).toHaveLength(0);
  });
  it('refuses two active links on one ad, accepts it again once the first is removed', async () => {
    const [a] = await db.insert(creatives).values({ name: `Yash uq A ${tag}`, fileUrl: 'x', clientId }).returning();
    const [b] = await db.insert(creatives).values({ name: `Yash uq B ${tag}`, fileUrl: 'x', clientId }).returning();
    creativeIds.push(a!.id, b!.id);
    const ad = `u${tag}`;
    const [first] = await db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: a!.id, platform: 'tiktok', platformAdId: ad }).returning();
    await expect(db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: b!.id, platform: 'tiktok', platformAdId: ad })).rejects.toThrow();
    await db.update(creativeAdLinks).set({ status: 'removed', removedAt: new Date() }).where(eq(creativeAdLinks.id, first!.id));
    await db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: b!.id, platform: 'tiktok', platformAdId: ad });
  });
  it('a paused link still holds its ad; a link needs an ad, creative or asset ID', async () => {
    const [a] = await db.insert(creatives).values({ name: `Yash empty ${tag}`, fileUrl: 'x', clientId }).returning();
    creativeIds.push(a!.id);
    await expect(db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: a!.id, platform: 'meta' })).rejects.toThrow();
    await db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: a!.id, platform: 'meta', platformAssetId: `v${tag}` });
    const [b] = await db.insert(creatives).values({ name: `Yash paused ${tag}`, fileUrl: 'x', clientId }).returning();
    creativeIds.push(b!.id);
    const ad = `p${tag}`;
    await db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: a!.id, platform: 'google', platformAdId: ad, status: 'paused' });
    await expect(db.insert(creativeAdLinks).values({ businessId: BIZ, creativeId: b!.id, platform: 'google', platformAdId: ad })).rejects.toThrow();
  });
});

describe('ad-account ID normalisation in the migration', () => {
  it('strips act_ and dashes, and leaves a row alone when the plain ID is already taken', async () => {
    const n = `77${tag}`;
    const rows = await db.insert(clientAdAccounts).values([
      { businessId: BIZ, platform: 'facebook-ads', accountId: `act_${n}1`, clientId },
      { businessId: BIZ, platform: 'facebook-ads', accountId: `act_${n}2`, clientId },
      { businessId: BIZ, platform: 'facebook-ads', accountId: `${n}2`, clientId: clientB },
      { businessId: BIZ, platform: 'google-ads', accountId: `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`, clientId },
    ]).returning();
    rows.forEach((r) => accountRows.push(r.id));
    for (const stmt of statements.filter((s) => s.includes('UPDATE client_ad_accounts c'))) await run(stmt);
    const after = await db.select().from(clientAdAccounts).where(inArray(clientAdAccounts.id, rows.map((r) => r.id)));
    const byId = new Map(after.map((r) => [r.id, r.accountId]));
    expect(byId.get(rows[0]!.id)).toBe(`${n}1`);
    expect(byId.get(rows[1]!.id)).toBe(`act_${n}2`);
    expect(byId.get(rows[2]!.id)).toBe(`${n}2`);
    expect(byId.get(rows[3]!.id)).toBe(n);
  });
});

describe('0055 on a later boot (review of #71)', () => {
  it('a creative that shares an ad ID with an existing link, under another platform creative ID, does not fail the next boot', async () => {
    const AD = `b${tag}`;
    const [a] = await db.insert(creatives).values({ name: `Yash boot A ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: AD, platformCreativeId: 'CR-1' }).returning();
    creativeIds.push(a!.id);
    for (const stmt of statements) await run(stmt); // first boot: A gets its link
    const [b] = await db.insert(creatives).values({ name: `Yash boot B ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: AD, platformCreativeId: 'CR-2' }).returning();
    creativeIds.push(b!.id);
    for (const stmt of statements) await run(stmt); // next boot: used to die on creative_ad_links_ad_uq
    const links = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.platformAdId, AD));
    expect(links.map((l) => l.creativeId)).toEqual([a!.id]);
  });

  it('the backfill stores the account ID normalised, as new links do', async () => {
    const [m] = await db.insert(creatives).values({ name: `Yash norm meta ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: `nm${tag}`, platformAccountId: `act_42${tag}` }).returning();
    const [g] = await db.insert(creatives).values({ name: `Yash norm google ${tag}`, fileUrl: 'x', clientId, platform: 'google', platformAdId: `ng${tag}`, platformAccountId: '123-456-7890' }).returning();
    creativeIds.push(m!.id, g!.id);
    await run(stmtWith('INSERT INTO creative_ad_links'));
    const [lm] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, m!.id));
    const [lg] = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, g!.id));
    expect(lm!.platformAccountId).toBe(`42${tag}`);
    expect(lg!.platformAccountId).toBe('1234567890');
  });

  it('creatives.source is not rewritten on a later boot', async () => {
    const [c] = await db.insert(creatives).values({ name: `Yash source ${tag}`, fileUrl: 'x', clientId, platform: 'meta', platformAdId: `s${tag}` }).returning();
    creativeIds.push(c!.id);
    for (const stmt of statements) await run(stmt);
    const [after] = await db.select().from(creatives).where(eq(creatives.id, c!.id));
    expect(after!.source).toBe('portal');
  });

  it('two rows that differ only in case (act_ / ACT_) do not collide in one statement', async () => {
    const n = `88${tag}`;
    const rows = await db.insert(clientAdAccounts).values([
      { businessId: BIZ, platform: 'facebook-ads', accountId: `act_${n}`, clientId },
      { businessId: BIZ, platform: 'facebook-ads', accountId: `ACT_${n}`, clientId: clientB },
    ]).returning();
    rows.forEach((r) => accountRows.push(r.id));
    for (const stmt of statements.filter((x) => x.includes('UPDATE client_ad_accounts c'))) await run(stmt);
    const after = await db.select().from(clientAdAccounts).where(inArray(clientAdAccounts.id, rows.map((r) => r.id)));
    expect(after.filter((r) => r.accountId === n)).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it('the size and file_url ALTERs are skipped when already done', () => {
    expect(stmtWith('size_bytes')).toContain("data_type <> 'bigint'");
    expect(stmtWith('DROP NOT NULL')).toContain("is_nullable = 'NO'");
  });
});
