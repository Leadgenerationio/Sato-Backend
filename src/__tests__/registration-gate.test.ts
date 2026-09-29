import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { isPublicRegistrationOpen } from '../middleware/registration.middleware.js';

const saved = { node: process.env.NODE_ENV, allow: process.env.ALLOW_PUBLIC_REGISTRATION };
const createdEmails: string[] = [];

afterEach(async () => {
  if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
  if (saved.allow === undefined) delete process.env.ALLOW_PUBLIC_REGISTRATION; else process.env.ALLOW_PUBLIC_REGISTRATION = saved.allow;
  for (const e of createdEmails.splice(0)) await db.delete(users).where(eq(users.email, e));
});

const newEmail = () => `reg-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

describe('isPublicRegistrationOpen (Sam S8)', () => {
  it('is closed in production unless explicitly allowed', () => {
    expect(isPublicRegistrationOpen({ NODE_ENV: 'production' })).toBe(false);
    expect(isPublicRegistrationOpen({ NODE_ENV: 'production', ALLOW_PUBLIC_REGISTRATION: 'false' })).toBe(false);
    expect(isPublicRegistrationOpen({ NODE_ENV: 'production', ALLOW_PUBLIC_REGISTRATION: 'yes' })).toBe(false);
    expect(isPublicRegistrationOpen({ NODE_ENV: 'production', ALLOW_PUBLIC_REGISTRATION: 'true' })).toBe(true);
  });
  it('stays open in development and test so local setups and the suite keep working', () => {
    expect(isPublicRegistrationOpen({ NODE_ENV: 'development' })).toBe(true);
    expect(isPublicRegistrationOpen({ NODE_ENV: 'test' })).toBe(true);
    expect(isPublicRegistrationOpen({})).toBe(true);
  });
});

describe('POST /api/v1/auth/register in production (Sam S8)', () => {
  it('refuses with 403 registration_closed and creates no account', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PUBLIC_REGISTRATION;
    const email = newEmail();
    const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'password123', name: 'Nobody', role: 'finance_admin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('registration_closed');
    expect(res.body.message).toMatch(/Ask an owner/);
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(0);
  });

  it('is closed even for a request that would otherwise be invalid (no probing of the validator)', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).post('/api/v1/auth/register').send({});
    expect(res.status).toBe(403);
  });

  it('opens again when ALLOW_PUBLIC_REGISTRATION=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_PUBLIC_REGISTRATION = 'true';
    const email = newEmail();
    createdEmails.push(email);
    const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'password123', name: 'Allowed' });
    expect(res.status).toBe(201);
  });

  it('does not affect sign-in', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    expect(res.status).toBe(200);
  });
});
