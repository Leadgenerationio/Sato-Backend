import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { rolePermissions, rolePermissionChanges } from '../db/schema/index.js';
import { clearPermissionCache, cellState } from '../services/permission.service.js';
import { SECTIONS, getSection } from '../config/sections.js';

// Role Access Matrix (Sam feedback round 1, S7): persisted per business,
// drives /permissions/me (the sidebar) and is enforced on the API.

const BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken as string;
}

let owner = '';
let finance = '';
let ops = '';

async function resetMatrix() {
  await db.delete(rolePermissions).where(eq(rolePermissions.businessId, BUSINESS_ID));
  await db.delete(rolePermissionChanges).where(eq(rolePermissionChanges.businessId, BUSINESS_ID));
  clearPermissionCache();
}

const setCell = (token: string, body: Record<string, unknown>) =>
  request(app).patch('/api/v1/permissions').set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  await resetMatrix();
  [owner, finance, ops] = await Promise.all([
    login('owner@stato.app', 'owner123'),
    login('finance@stato.app', 'finance123'),
    login('ops@stato.app', 'ops123'),
  ]);
});

afterAll(resetMatrix);

describe('GET /permissions', () => {
  it('lists every section with a column for every role, client_admin included', async () => {
    const res = await request(app).get('/api/v1/permissions').set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['owner', 'finance_admin', 'ops_manager', 'readonly', 'client', 'client_admin']);
    expect(res.body.data.sections).toHaveLength(SECTIONS.length);
    const portal = res.body.data.sections.find((s: { key: string }) => s.key === 'portal');
    expect(portal.access.client_admin).toBe('on');
    const invoices = res.body.data.sections.find((s: { key: string }) => s.key === 'invoices');
    expect(invoices.access).toMatchObject({ owner: 'always', finance_admin: 'on', ops_manager: 'none', readonly: 'none' });
    // Pre-S7 Settings page still gets its shape.
    expect(res.body.data.permissions[0]).toHaveProperty('permission');
  });
});

describe('matrix drives the menu and the API', () => {
  it('defaults to the route guards: Finance Admin sees Bank Feed', async () => {
    const me = await request(app).get('/api/v1/permissions/me').set('Authorization', `Bearer ${finance}`);
    expect(me.body.data.sections).toContain('bank_feed');
    const res = await request(app).get('/api/v1/finance/bank-feed/transactions').set('Authorization', `Bearer ${finance}`);
    expect(res.status).toBe(200);
  });

  it('switching Bank Feed off for Finance Admin hides it and blocks the API, and survives a restart', async () => {
    const off = await setCell(owner, { section: 'bank_feed', role: 'finance_admin', allowed: false });
    expect(off.status).toBe(200);
    expect(off.body.data.section.access.finance_admin).toBe('off');

    const me = await request(app).get('/api/v1/permissions/me').set('Authorization', `Bearer ${finance}`);
    expect(me.body.data.sections).not.toContain('bank_feed');

    clearPermissionCache(); // what a restart does — the value must come from the DB
    const blocked = await request(app).get('/api/v1/finance/bank-feed/transactions').set('Authorization', `Bearer ${finance}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/Bank Feed/);

    // Other sections and the Owner are untouched.
    const invoices = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${finance}`);
    expect(invoices.status).toBe(200);
    const ownerFeed = await request(app).get('/api/v1/finance/bank-feed/transactions').set('Authorization', `Bearer ${owner}`);
    expect(ownerFeed.status).toBe(200);

    const on = await setCell(owner, { section: 'bank_feed', role: 'finance_admin', allowed: true });
    expect(on.status).toBe(200);
    const back = await request(app).get('/api/v1/finance/bank-feed/transactions').set('Authorization', `Bearer ${finance}`);
    expect(back.status).toBe(200);
  });

  it('records every change in the audit log', async () => {
    const res = await request(app).get('/api/v1/permissions/changes').set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    const feed = res.body.data.changes.filter((c: { section: string }) => c.section === 'bank_feed');
    expect(feed.map((c: { allowedAfter: boolean }) => c.allowedAfter)).toEqual([true, false]); // newest first
  });
});

describe('what the matrix refuses', () => {
  it('Owner is immutable', async () => {
    const res = await setCell(owner, { section: 'invoices', role: 'owner', allowed: false });
    expect(res.status).toBe(403);
  });

  it('cannot grant a role beyond the route guard', async () => {
    const res = await setCell(owner, { section: 'invoices', role: 'readonly', allowed: true });
    expect(res.status).toBe(422);
  });

  it('Settings is always on', async () => {
    const res = await setCell(owner, { section: 'settings', role: 'ops_manager', allowed: false });
    expect(res.status).toBe(422);
  });

  it('only an Owner can change it', async () => {
    const res = await setCell(ops, { section: 'campaigns', role: 'ops_manager', allowed: false });
    expect(res.status).toBe(403);
  });

  it('accepts the legacy label body from the pre-S7 Settings page', async () => {
    const res = await setCell(owner, { permission: 'Campaigns', role: 'ops_manager', allowed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.section.key).toBe('campaigns');
  });
});

describe('cellState', () => {
  it('maps floor, owner, lock and overrides', () => {
    const bank = getSection('bank_feed')!;
    const none = new Map<string, boolean>();
    expect(cellState(bank, 'owner', none)).toBe('always');
    expect(cellState(bank, 'finance_admin', none)).toBe('on');
    expect(cellState(bank, 'finance_admin', new Map([['bank_feed:finance_admin', false]]))).toBe('off');
    expect(cellState(bank, 'readonly', none)).toBe('none');
    expect(cellState(getSection('settings')!, 'ops_manager', new Map([['settings:ops_manager', false]]))).toBe('always');
  });
});
