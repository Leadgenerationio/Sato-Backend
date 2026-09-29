import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { assertAccessNotExpired } from '../utils/access-expiry.js';

// S8 (Sam feedback round 1): "give the agency a lower or time-limited role".
const PW = 'expiry-test-pw-1';
const EMAIL = `agency.expiry.${Date.now()}@octogle-example.org`;
let ownerToken = '';
let ownerId = '';
let agencyId = '';

const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').send({ email, password });
const setExpiry = (id: string, accessExpiresAt: string | null, token = ownerToken) =>
  request(app).patch(`/api/v1/users/${id}/access-expiry`).set('Authorization', `Bearer ${token}`).send({ accessExpiresAt });

describe('assertAccessNotExpired', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  it('allows no end date and a future end date', () => {
    expect(() => assertAccessNotExpired(null, now)).not.toThrow();
    expect(() => assertAccessNotExpired('2026-09-30T00:00:00Z', now)).not.toThrow();
  });
  it('refuses a past end date with a plain message', () => {
    expect(() => assertAccessNotExpired('2026-09-28T23:00:00Z', now)).toThrow(/Your access ended on 29 September 2026\. Ask the account owner to extend it\./);
  });
});

describe('time-limited access (S8)', () => {
  beforeAll(async () => {
    const o = await login('owner@stato.app', 'owner123');
    ownerToken = o.body.data.tokens.accessToken;
    ownerId = o.body.data.user.id;
    const [u] = await db.insert(users).values({
      email: EMAIL, name: 'Agency', role: 'ops_manager', businessId: o.body.data.user.businessId,
      isActive: true, passwordHash: await bcryptjs.hash(PW, 4),
    }).returning();
    agencyId = u.id;
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.id, agencyId));
  });

  it('only the Owner can set it', async () => {
    const ops = await login('ops@stato.app', 'ops123');
    const res = await setExpiry(agencyId, '2030-01-01T00:00:00Z', ops.body.data.tokens.accessToken);
    expect(res.status).toBe(403);
  });

  it("refuses an end date on the Owner's own login", async () => {
    const res = await setExpiry(ownerId, '2030-01-01T00:00:00Z');
    expect(res.status).toBe(400);
  });

  it('a future end date is listed and still lets the user in, and travels in the token', async () => {
    const res = await setExpiry(agencyId, '2030-01-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    expect(res.body.data.user.accessExpiresAt).toBe('2030-01-01T00:00:00.000Z');
    const list = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.data.users.find((u: { id: string }) => u.id === agencyId).accessExpiresAt).toBe('2030-01-01T00:00:00.000Z');
    const l = await login(EMAIL, PW);
    expect(l.status).toBe(200);
    const decoded = jwt.decode(l.body.data.tokens.accessToken) as { accessExpiresAt?: string };
    expect(decoded.accessExpiresAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('a past end date blocks login and refresh with a plain message', async () => {
    const before = await login(EMAIL, PW);
    const refreshToken = before.body.data.tokens.refreshToken;
    expect((await setExpiry(agencyId, '2026-01-01T00:00:00Z')).status).toBe(200);

    const l = await login(EMAIL, PW);
    expect(l.status).toBe(401);
    expect(l.body.message).toMatch(/Your access ended on 1 January 2026/);

    const r = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/access ended/);
  });

  it('an access token carrying a past end date is refused mid-session', async () => {
    const token = jwt.sign({ userId: agencyId, email: EMAIL, role: 'ops_manager', accessExpiresAt: '2026-01-01T00:00:00.000Z' }, env.JWT_SECRET, { expiresIn: '5m' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/access ended/);
  });

  it('clearing it (null) lets the user back in', async () => {
    expect((await setExpiry(agencyId, null)).status).toBe(200);
    expect((await login(EMAIL, PW)).status).toBe(200);
  });

  it('refresh now also refuses a deactivated login', async () => {
    const l = await login(EMAIL, PW);
    await db.update(users).set({ isActive: false }).where(eq(users.id, agencyId));
    const r = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: l.body.data.tokens.refreshToken });
    expect(r.status).toBe(401);
    await db.update(users).set({ isActive: true }).where(eq(users.id, agencyId));
  });
});
