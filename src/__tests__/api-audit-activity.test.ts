import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, inArray, sql } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { purgeApiHousekeeping } from '../services/retention.service.js';

// MCP spec v1.0 §3 / test 16: the audit log is listed in Settings → API keys →
// Activity and kept 12 months.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const CREATIVE = '6f1c2b8e-4d0a-4c3e-9b1f-0a7e5d2c9b41';
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
let owner = '';
let ops = '';
let keyA = { key: '', id: '' };
let keyB = { key: '', id: '' };

async function makeKey(name: string) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `${name} ${tag}`, scopes: ['clients:read'] });
  expect(res.status).toBe(201);
  return { key: res.body.data.key as string, id: res.body.data.apiKey.id as string };
}
const row = (keyId: string, extra: Partial<typeof apiAuditLog.$inferInsert> = {}) => ({
  businessId: BIZ, apiKeyId: keyId, keyName: `k ${tag}`, transport: 'mcp', tool: 'whoami', method: 'POST', path: '/mcp',
  status: 200, errorCode: null, result: { outcome: 'ok' }, args: {}, ...extra,
});
const activity = (query: Record<string, string | number> = {}, token = owner) =>
  request(app).get('/api/v1/api-keys/activity').query(query).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  owner = (await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' })).body.data.tokens.accessToken;
  ops = (await request(app).post('/api/v1/auth/login').send({ email: 'ops@stato.app', password: 'ops123' })).body.data.tokens.accessToken;
  keyA = await makeKey('Hari Test act A');
  keyB = await makeKey('Hari Test act B');
  await db.insert(apiAuditLog).values([
    row(keyA.id, { tool: 'link_ad_platform_ids', agent: 'Grok Bot', recordsTouched: [{ type: 'creative', id: 'c1' }] }),
    row(keyA.id, { tool: 'upload_asset', status: 200, errorCode: 'account_not_linked', result: { outcome: 'error', code: 'account_not_linked' } }),
    row(keyA.id, { transport: 'rest', tool: null, method: 'GET', path: '/api/v1/clients/lookup', status: 404, errorCode: 'not_found' }),
    row(keyB.id, { tool: 'whoami' }),
    row(keyB.id, { tool: 'update_asset', agent: '=Formula Bot', recordsTouched: [{ type: 'creative', id: CREATIVE }, { type: 'client', id: 'cl1' }] }),
    row(keyB.id, { tool: 'add_landing_page', recordsTouched: [{ type: 'landing_page', id: CREATIVE }] }),
  ]);
});
afterAll(async () => {
  await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, [keyA.id, keyB.id]));
  await db.delete(apiKeys).where(inArray(apiKeys.id, [keyA.id, keyB.id]));
});

describe('GET /api-keys/activity', () => {
  it('lists the business activity newest first, with bot name, tool, result and records touched', async () => {
    const res = await activity({ keyId: keyA.id });
    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<Record<string, any>>;
    expect(items.map((i) => i.tool)).toEqual([null, 'upload_asset', 'link_ad_platform_ids']);
    expect(items[2]).toMatchObject({ keyId: keyA.id, agent: 'Grok Bot', transport: 'mcp', recordsTouched: [{ type: 'creative', id: 'c1' }], result: { outcome: 'ok' } });
    expect(typeof items[0]!.id).toBe('string');
  });

  it('filters by tool, transport, outcome and error code', async () => {
    expect((await activity({ keyId: keyA.id, tool: 'upload_asset' })).body.data.items).toHaveLength(1);
    expect((await activity({ keyId: keyA.id, transport: 'rest' })).body.data.items.map((i: any) => i.path)).toEqual(['/api/v1/clients/lookup']);
    expect((await activity({ keyId: keyA.id, outcome: 'error' })).body.data.items).toHaveLength(2);
    expect((await activity({ keyId: keyA.id, outcome: 'ok' })).body.data.items).toHaveLength(1);
    expect((await activity({ keyId: keyA.id, errorCode: 'account_not_linked' })).body.data.items).toHaveLength(1);
  });

  it('pages with nextCursor without repeating or skipping rows', async () => {
    const p1 = await activity({ keyId: keyA.id, limit: 2 });
    expect(p1.body.data.items).toHaveLength(2);
    expect(p1.body.data.nextCursor).toEqual(expect.any(String));
    const p2 = await activity({ keyId: keyA.id, limit: 2, cursor: p1.body.data.nextCursor });
    expect(p2.body.data.items).toHaveLength(1);
    expect(p2.body.data.nextCursor).toBeNull();
    const ids = [...p1.body.data.items, ...p2.body.data.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('refuses a malformed cursor or filter', async () => {
    // 400 naming the field (validation_failed once #72's validate change is under this branch).
    const bad = await activity({ cursor: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toContain('query.cursor');
    expect((await activity({ transport: 'smtp' })).status).toBe(400);
    // The old ID-only cursor, and an ID past 15 digits (where Number() loses precision), are refused.
    expect((await activity({ cursor: '123' })).status).toBe(400);
    expect((await activity({ cursor: `1791280933475123.${'9'.repeat(16)}` })).status).toBe(400);
  });

  it('filters to the calls that touched one creative (not another record type with the same id)', async () => {
    const res = await activity({ creativeId: CREATIVE });
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: any) => i.tool)).toEqual(['update_asset']);
    expect((await activity({ creativeId: 'c1' })).status).toBe(400);
  });

  it('the creative filter has a GIN index to use', async () => {
    const idx = await db.execute(sql`select indexdef from pg_indexes where indexname = 'api_audit_log_records_touched_idx'`);
    expect(JSON.stringify(idx)).toMatch(/USING gin \(records_touched jsonb_path_ops\)/);
  });

  it('exports the filtered list as CSV, newest first, safe to open in a spreadsheet', async () => {
    const res = await request(app).get('/api/v1/api-keys/activity.csv').query({ keyId: keyB.id, transport: 'mcp' }).set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="api-activity-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['x-row-count']).toBe('3');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Time (UTC),Key,Key owner,Bot,Transport,Tool,Method,Path,HTTP status,Result,Records touched,Duration (ms),Request ID,IP');
    expect(lines.slice(1).map((l) => l.split(',')[5])).toEqual(['add_landing_page', 'update_asset', 'whoami']);
    expect(lines[2]).toContain(`'=Formula Bot`);
    expect(lines[2]).toContain(`creative:${CREATIVE} client:cl1`);
    const byCreative = await request(app).get('/api/v1/api-keys/activity.csv').query({ creativeId: CREATIVE }).set('Authorization', `Bearer ${owner}`);
    expect(byCreative.headers['x-row-count']).toBe('1');
    expect((await request(app).get('/api/v1/api-keys/activity.csv').set('Authorization', `Bearer ${ops}`)).status).toBe(403);
  });

  it('per key: only that key, and a key from nowhere is not found', async () => {
    const res = await request(app).get(`/api/v1/api-keys/${keyB.id}/activity`).set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(new Set(res.body.data.items.map((i: any) => i.keyId))).toEqual(new Set([keyB.id]));
    const missing = await request(app).get('/api/v1/api-keys/00000000-0000-0000-0000-00000000dead/activity').set('Authorization', `Bearer ${owner}`);
    expect(missing.status).toBe(404);
  });

  it('is for the Owner only, and an API key cannot read it', async () => {
    expect((await activity({}, ops)).status).toBe(403);
    const withKey = await request(app).get('/api/v1/api-keys/activity').set('X-API-Key', keyA.key);
    expect(withKey.status).toBe(401);
  });

  it('shows a real call made with a key (end to end with the audit writer)', async () => {
    await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: `e2e${tag}` }).set('X-API-Key', keyB.key).set('X-Stato-Agent', 'Cursor e2e');
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(app).get(`/api/v1/api-keys/${keyB.id}/activity`).query({ transport: 'rest' }).set('Authorization', `Bearer ${owner}`);
    expect(res.body.data.items[0]).toMatchObject({ agent: 'Cursor e2e', path: '/api/v1/clients/lookup', status: 404, errorCode: 'not_found' });
  });
});

describe('12-month retention', () => {
  it('purges audit rows older than 12 months and keeps newer ones', async () => {
    const [old] = await db.insert(apiAuditLog).values(row(keyB.id, { tool: `old ${tag}`, at: daysAgo(400) })).returning();
    const [recent] = await db.insert(apiAuditLog).values(row(keyB.id, { tool: `recent ${tag}`, at: daysAgo(300) })).returning();
    const res = await purgeApiHousekeeping();
    expect(res.apiAuditLog).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(apiAuditLog).where(eq(apiAuditLog.id, old!.id))).toHaveLength(0);
    expect(await db.select().from(apiAuditLog).where(eq(apiAuditLog.id, recent!.id))).toHaveLength(1);
  });
});
