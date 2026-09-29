import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcryptjs from 'bcryptjs';
import { eq, inArray, sql } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { users, sosHelpRequests, sops, staff, clientContacts, clients, adminCleanupLog } from '../db/schema/index.js';
import { applyCleanup } from '../services/data-cleanup.service.js';

// Settings → Clean up (Sam feedback round 1, S8 + N6). Seeds copies of the
// rows Sam found, then drives the Owner-only endpoints and every guard.

const PW = 'cleanup-test-pw-1';
const TAG = `cl${Date.now()}`;
let ownerToken = '';
let financeToken = '';
let businessId = '';
let ownerId = '';
const ids = {
  demo: '', test: '', john: '', extraOwner: '', primary: '',
  sosTesting: '', sosMsg: '', sopOnbording: '', staffJohn: '', contact: '', client: '',
};

async function login(email: string, password: string) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

async function mkUser(email: string, name: string, role: 'owner' | 'client_admin' | 'ops_manager', isPrimaryOwner = false) {
  const [u] = await db.insert(users).values({
    email, name, role, businessId, isActive: true, isPrimaryOwner,
    passwordHash: await bcryptjs.hash(PW, 4),
  }).returning();
  return u.id;
}

describe('Settings → Clean up (S8 + N6)', () => {
  beforeAll(async () => {
    const o = await login('owner@stato.app', 'owner123');
    ownerToken = o.body.data.tokens.accessToken;
    ownerId = o.body.data.user.id;
    businessId = o.body.data.user.businessId;
    financeToken = (await login('finance@stato.app', 'finance123')).body.data.tokens.accessToken;

    // Copies of Sam's examples (patterns: demo@…, …@test.com).
    ids.demo = await mkUser(`demo@${TAG}.example.org`, 'Demo', 'owner');
    ids.test = await mkUser(`${TAG}@test.com`, 'Test', 'client_admin');
    ids.john = await mkUser(`john.${TAG}@test.com`, 'John', 'client_admin');
    ids.extraOwner = await mkUser(`agency.${TAG}@octogle-example.org`, 'Agency Owner', 'owner');
    ids.primary = await mkUser(`primary.${TAG}@leadgen-example.org`, 'Primary', 'owner', true);

    const [s1] = await db.insert(sosHelpRequests).values({ message: 'testing', pagePath: '/x' }).returning();
    const [s2] = await db.insert(sosHelpRequests).values({ message: 'msg' }).returning();
    ids.sosTesting = s1.id; ids.sosMsg = s2.id;
    const [sop] = await db.insert(sops).values({ title: 'onbording', content: 'x', author: 'Yash', businessId }).returning();
    ids.sopOnbording = sop.id;
    const [st] = await db.insert(staff).values({ name: 'John', email: `john.staff.${TAG}@example.org`, businessId }).returning();
    ids.staffJohn = st.id;
    const [cl] = await db.insert(clients).values({ businessId, companyName: `Yash Cleanup ${TAG}`, contactName: 'Clode ' }).returning();
    ids.client = cl.id;
    const [ct] = await db.insert(clientContacts).values({ clientId: cl.id, contactType: 'primary', name: 'Daniel ', email: `dan.${TAG}@example.org` }).returning();
    ids.contact = ct.id;
  });

  afterAll(async () => {
    await db.delete(clientContacts).where(eq(clientContacts.id, ids.contact));
    await db.delete(clients).where(eq(clients.id, ids.client));
    await db.delete(sosHelpRequests).where(inArray(sosHelpRequests.id, [ids.sosTesting, ids.sosMsg]));
    await db.delete(sops).where(eq(sops.id, ids.sopOnbording));
    await db.delete(staff).where(eq(staff.id, ids.staffJohn));
    await db.delete(adminCleanupLog).where(eq(adminCleanupLog.actorUserId, ownerId));
    await db.delete(users).where(inArray(users.id, [ids.demo, ids.test, ids.john, ids.extraOwner, ids.primary]));
  });

  const apply = (body: object, token = ownerToken) =>
    request(app).post('/api/v1/admin/cleanup/apply').set('Authorization', `Bearer ${token}`).send(body);

  it('is Owner only', async () => {
    const res = await request(app).get('/api/v1/admin/cleanup').set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(403);
    expect((await apply({ trimContacts: true }, financeToken)).status).toBe(403);
  });

  it('flags every row Sam found, with a reason, pre-ticking only the obvious ones', async () => {
    const res = await request(app).get('/api/v1/admin/cleanup').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const r = res.body.data;
    const login = (id: string) => r.testLogins.find((u: { id: string }) => u.id === id);
    expect(login(ids.test)).toMatchObject({ reason: 'email on test.com', preselect: true });
    expect(login(ids.john)).toMatchObject({ preselect: true });
    expect(login(ids.demo)).toMatchObject({ preselect: true });
    // Owners are listed for review but never pre-selected.
    const owner = r.owners.find((u: { id: string }) => u.id === ids.extraOwner);
    expect(owner).toMatchObject({ preselect: false });
    expect(r.owners.find((u: { id: string }) => u.id === ownerId)).toMatchObject({ isYou: true });
    expect(r.testSos.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([ids.sosTesting, ids.sosMsg]));
    expect(r.testSops.find((s: { id: string }) => s.id === ids.sopOnbording)).toMatchObject({ reason: 'misspelt title ("onbording")' });
    expect(r.placeholderStaff.find((s: { id: string }) => s.id === ids.staffJohn)).toMatchObject({ preselect: true });
    expect(r.untrimmedContacts.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([ids.contact, ids.client]));
    expect(typeof r.agreementTemplatesCount).toBe('number');
  });

  it('refuses ids the report does not flag (422) and changes nothing', async () => {
    const res = await apply({ deactivateUserIds: [ids.extraOwner] }); // an owner, not a test login
    expect(res.status).toBe(422);
    const [u] = await db.select().from(users).where(eq(users.id, ids.extraOwner));
    expect(u.isActive).toBe(true);
  });

  it("refuses to change the caller's own login (422)", async () => {
    const res = await apply({ demoteOwnerIds: [{ id: ownerId, role: 'readonly' }] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/own/);
  });

  it('refuses the primary Owner (422)', async () => {
    const res = await apply({ demoteOwnerIds: [{ id: ids.primary, role: 'ops_manager' }] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/primary Owner/);
    const [u] = await db.select().from(users).where(eq(users.id, ids.primary));
    expect(u.role).toBe('owner');
  });

  it('refuses to leave no active Owner (422)', async () => {
    // Service-level: a requester outside the Owner list (e.g. an audit caller)
    // trying to remove every Owner it can see. Temporarily drop the primary
    // flag so only the last-Owner rule can stop it.
    await db.update(users).set({ isPrimaryOwner: false }).where(eq(users.id, ids.primary));
    const ownersNow = await db.select({ id: users.id, isPrimaryOwner: users.isPrimaryOwner }).from(users)
      .where(sql`role = 'owner' AND is_active AND (business_id = ${businessId} OR business_id IS NULL)`);
    const primaries = ownersNow.filter((o) => o.isPrimaryOwner).map((o) => o.id);
    await db.update(users).set({ isPrimaryOwner: false }).where(inArray(users.id, primaries.length ? primaries : [ids.primary]));
    try {
      await expect(applyCleanup(
        { userId: '99999999-0000-0000-0000-000000000000', email: 'x', role: 'owner', businessId },
        { demoteOwnerIds: ownersNow.map((o) => ({ id: o.id, role: 'readonly' as const })) },
      )).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/one active Owner/) });
    } finally {
      await db.update(users).set({ isPrimaryOwner: true }).where(inArray(users.id, primaries.length ? [...primaries, ids.primary] : [ids.primary]));
    }
  });

  it('applies: deactivates test logins, demotes an Owner, archives, trims, logs', async () => {
    const res = await apply({
      deactivateUserIds: [ids.demo, ids.test, ids.john],
      demoteOwnerIds: [{ id: ids.extraOwner, role: 'ops_manager' }],
      archiveSosIds: [ids.sosTesting, ids.sosMsg],
      archiveSopIds: [ids.sopOnbording],
      archiveStaffIds: [ids.staffJohn],
      trimContacts: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ archivedSos: 2, archivedSops: 1, archivedStaff: 1 });
    expect(res.body.data.trimmedContacts).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(users).where(inArray(users.id, [ids.demo, ids.test, ids.john, ids.extraOwner]));
    const byId = Object.fromEntries(rows.map((u) => [u.id, u]));
    expect(byId[ids.demo].isActive).toBe(false);
    expect(byId[ids.test].isActive).toBe(false);
    expect(byId[ids.extraOwner]).toMatchObject({ role: 'ops_manager', isActive: true });

    // Archived, not deleted.
    const [sopRow] = await db.select().from(sops).where(eq(sops.id, ids.sopOnbording));
    expect(sopRow.archivedAt).not.toBeNull();
    const [ct] = await db.select().from(clientContacts).where(eq(clientContacts.id, ids.contact));
    expect(ct.name).toBe('Daniel');
    const [cl] = await db.select().from(clients).where(eq(clients.id, ids.client));
    expect(cl.contactName).toBe('Clode');

    const log = await db.select().from(adminCleanupLog).where(eq(adminCleanupLog.actorUserId, ownerId));
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it('hides archived rows from the SOS, SOP and staff lists', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const sos = await request(app).get('/api/v1/sos').set(auth);
    expect(JSON.stringify(sos.body)).not.toContain(ids.sosTesting);
    const sopList = await request(app).get('/api/v1/sops').set(auth);
    expect(JSON.stringify(sopList.body)).not.toContain(ids.sopOnbording);
    const staffList = await request(app).get('/api/v1/hr/staff').set(auth);
    expect(JSON.stringify(staffList.body)).not.toContain(ids.staffJohn);
  });

  it('a deactivated test login can no longer sign in, and is no longer flagged', async () => {
    const res = await login(`${TAG}@test.com`, PW);
    expect(res.status).toBe(401);
    const again = await request(app).get('/api/v1/admin/cleanup').set('Authorization', `Bearer ${ownerToken}`);
    expect(again.body.data.testLogins.map((u: { id: string }) => u.id)).not.toContain(ids.test);
    expect(again.body.data.testSops.map((s: { id: string }) => s.id)).not.toContain(ids.sopOnbording);
  });
});
