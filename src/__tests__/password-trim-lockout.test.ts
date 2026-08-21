import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import * as userService from '../services/user.service.js';
import * as authService from '../services/auth.service.js';
import { normalizePassword } from '../utils/password.js';

// Barry @ media-active.org.uk (2026-08-21): an admin set his password and he
// still got "Invalid email or password" on every attempt. loginUser() trimmed
// the password before bcrypt.compare, but no path that HASHED one trimmed it
// first — so a password set with a trailing space stored a hash login could
// never match. Permanent lockout, blamed on the credentials.

let ownerReq: { userId: string; role: 'owner'; businessId: string | null; email: string };

async function login(email: string, password: string) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

describe('password normalisation — trailing/leading space lockout', () => {
  let userId: string;
  const email = `trimtest-${Date.now()}@example.com`;

  beforeAll(async () => {
    const res = await login('owner@stato.app', 'owner123');
    const u = res.body.data.user;
    ownerReq = { userId: u.id, role: 'owner', businessId: u.businessId ?? null, email: u.email };
    const created = await userService.createUser(
      email, 'Trim Test', 'InitialPass123', 'readonly', ownerReq as never,
    );
    userId = created.id;
  });

  it('lets a user log in after an admin sets a password with a TRAILING space', async () => {
    await userService.adminResetPassword(userId, 'Media123! ', ownerReq as never);
    // Typed cleanly by the user — this is what was failing before the fix.
    const res = await login(email, 'Media123!');
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeDefined();
  });

  it('lets a user log in after an admin sets a password with a LEADING space', async () => {
    await userService.adminResetPassword(userId, ' Media123!', ownerReq as never);
    expect((await login(email, 'Media123!')).status).toBe(200);
  });

  it('accepts the password even if the user themselves types a stray space', async () => {
    await userService.adminResetPassword(userId, 'Media123!', ownerReq as never);
    expect((await login(email, 'Media123! ')).status).toBe(200);
    expect((await login(email, ' Media123!')).status).toBe(200);
  });

  it('still rejects a genuinely wrong password', async () => {
    await userService.adminResetPassword(userId, 'Media123!', ownerReq as never);
    expect((await login(email, 'Media124!')).status).toBe(401);
    // An empty password is rejected by request validation before auth runs.
    expect((await login(email, '')).status).toBe(400);
    // Whitespace-only normalises to empty and must never authenticate.
    expect([400, 401]).toContain((await login(email, '   ')).status);
  });

  it('refuses a whitespace-only password instead of storing an unusable hash', async () => {
    await expect(
      userService.adminResetPassword(userId, '          ', ownerReq as never),
    ).rejects.toThrow(/at least 8 characters/);
  });

  it('self-service change-password accepts a current password typed with a space', async () => {
    await userService.adminResetPassword(userId, 'Media123!', ownerReq as never);
    await userService.changeOwnPassword(userId, 'Media123!  ', 'BrandNew456!');
    expect((await login(email, 'BrandNew456!')).status).toBe(200);
  });

  it('createUser normalises the supplied password too', async () => {
    const email2 = `trimtest2-${Date.now()}@example.com`;
    const created = await userService.createUser(
      email2, 'Trim Two', 'Spaced123!  ', 'readonly', ownerReq as never,
    );
    expect(created.id).toBeDefined();
    expect((await login(email2, 'Spaced123!')).status).toBe(200);
  });

  it('normalizePassword handles null/undefined without throwing', () => {
    expect(normalizePassword(undefined as unknown as string)).toBe('');
    expect(normalizePassword('  x  ')).toBe('x');
  });

  it('registerUser hashes the normalised form', async () => {
    const email3 = `trimtest3-${Date.now()}@example.com`;
    await authService.registerUser(email3, 'RegSpace123!  ', 'Reg Space');
    expect((await login(email3, 'RegSpace123!')).status).toBe(200);
  });
});
