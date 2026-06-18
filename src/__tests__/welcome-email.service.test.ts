import { describe, it, expect, beforeAll, vi } from 'vitest';

// Intercept the Resend send so we can assert on what the portal user would
// actually receive — same approach as password-reset.service.test.ts.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(async () => ({ id: 'mock-welcome' })) }));
vi.mock('../integrations/resend/resend-client.js', () => ({
  isResendConfigured: () => false,
  sendEmail: sendEmailMock,
}));

import { createUser, sendWelcomeEmail, toggleUserActive } from '../services/user.service.js';
import { SEED_USER_IDS } from '../data/users.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import type { AuthPayload } from '../types/index.js';

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

const ownerPayload: AuthPayload = {
  userId: SEED_USER_IDS.OWNER,
  email: 'owner@stato.app',
  role: 'owner',
};

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

// Pull the most recent captured email destined for `email`.
function lastEmailTo(email: string) {
  const calls = sendEmailMock.mock.calls.filter((c) => {
    const to = (c[0] as { to: string | string[] }).to;
    return (Array.isArray(to) ? to : [to]).includes(email);
  });
  if (calls.length === 0) throw new Error(`no email captured for ${email}`);
  return calls[calls.length - 1][0] as { to: string | string[]; subject: string; html: string; text: string };
}

describe('sendWelcomeEmail', () => {
  let clientId: string;
  let portalUserId: string;
  let portalEmail: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(clients)
      .values({
        businessId: LEADGEN_BUSINESS_ID,
        companyName: `Welcome Co ${Date.now()}`,
        currency: 'GBP',
        status: 'active',
      })
      .returning({ id: clients.id });
    clientId = row.id;

    portalEmail = uniqueEmail('welcome-portal');
    const u = await createUser(portalEmail, 'Welcome User', 'pass1234', 'client', ownerPayload, clientId);
    portalUserId = u.id;
  });

  it('emails a portal user a welcome with their login email and a set-password link', async () => {
    const res = await sendWelcomeEmail(portalUserId, ownerPayload);
    expect(res.sent).toBe(true);
    expect(res.email).toBe(portalEmail);

    const sent = lastEmailTo(portalEmail);
    const blob = `${sent.html}\n${sent.text}`;
    // The recipient must learn their login identity...
    expect(blob).toContain(portalEmail);
    // ...and get a link that lands them on the sign-in screen ready to set a
    // password (we deep-link to /login?welcome=1 so the FE can pre-open the
    // password-set flow).
    expect(blob).toMatch(/\/login\?welcome=1/);
  });

  it('rejects a non-portal (staff) user', async () => {
    const staff = await createUser(uniqueEmail('staff'), 'Staff User', 'pass1234', 'readonly', ownerPayload);
    await expect(sendWelcomeEmail(staff.id, ownerPayload)).rejects.toThrow(/portal users/);
  });

  it('throws for a non-existent user', async () => {
    await expect(
      sendWelcomeEmail('99999999-0000-0000-0000-000000000999', ownerPayload),
    ).rejects.toThrow(/User not found/);
  });

  it('refuses a deactivated portal user', async () => {
    const u = await createUser(uniqueEmail('welcome-inactive'), 'Inactive User', 'pass1234', 'client', ownerPayload, clientId);
    await toggleUserActive(u.id, ownerPayload);
    await expect(sendWelcomeEmail(u.id, ownerPayload)).rejects.toThrow(/deactivated/);
  });
});
