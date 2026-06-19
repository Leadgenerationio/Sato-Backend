import bcryptjs from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { users } from '../db/schema/index.js';
import { clients } from '../db/schema/clients.js';
import { NotFoundError, ForbiddenError, ValidationError, UnauthorizedError } from '../utils/errors.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import { templates, renderEmailHtml, renderEmailText } from '../integrations/resend/resend-templates.js';
import { logger } from '../utils/logger.js';
import type { UserRole, AuthPayload } from '../types/index.js';

// Brand shown on client-facing portal emails. Phase 1 is leadgeneration.io
// only; an env override keeps it ready for the multi-business rollout.
const PORTAL_BRAND_NAME = process.env.PORTAL_BRAND_NAME || 'leadgeneration.io';

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  clientId: string | null;
  isActive: boolean;
  isPrimaryOwner: boolean;
  allowedTabs: string[] | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

async function findById(id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row as UserRow | undefined;
}

async function findByEmail(email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row as UserRow | undefined;
}

async function isPrimaryOwner(userId: string): Promise<boolean> {
  const u = await findById(userId);
  return u?.isPrimaryOwner === true;
}

// ─── Business-scoped + client row-level filtered list ───
export async function listUsers(requester: AuthPayload) {
  let result = (await db.select().from(users)) as UserRow[];

  // Client role: can only see themselves
  if (requester.role === 'client') {
    result = result.filter((u) => u.id === requester.userId);
  }
  // Non-owner internal roles: scope to same business
  else if (requester.role !== 'owner' && requester.businessId) {
    result = result.filter((u) => u.businessId === requester.businessId);
  }
  // Owner: sees all users (no filter)

  return result.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    businessId: u.businessId,
    clientId: u.clientId,
    isActive: u.isActive,
    isPrimaryOwner: u.isPrimaryOwner,
    // Sam jam-video #2 follow-up: surface per-portal-user tab visibility
    // so the admin Portal Users card can pre-fill the Permissions dialog.
    // client_admin masked to null since admins always see everything.
    allowedTabs: u.role === 'client_admin' ? null : normalizeAllowedTabs(u.allowedTabs),
    createdAt: u.createdAt,
  }));
}

// Sam jam-video #2 follow-up: per-portal-user tab slugs the admin can
// restrict a portal user to. Mirrors the portal FE nav slugs — keep in
// sync with portal-layout.tsx and src/services/portal.service.ts.
const PORTAL_TAB_SLUGS = ['leads', 'invoices', 'compliance', 'creatives', 'agreement'] as const;
type PortalTabSlug = (typeof PORTAL_TAB_SLUGS)[number];

function normalizeAllowedTabs(input: unknown): PortalTabSlug[] | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) return null;
  const valid = new Set<string>(PORTAL_TAB_SLUGS);
  const cleaned = input
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => valid.has(s));
  return Array.from(new Set(cleaned)) as PortalTabSlug[];
}

export async function createUser(
  email: string,
  name: string,
  password: string,
  role: UserRole,
  requester: AuthPayload,
  clientId?: string,
  allowedTabs?: string[] | null,
) {
  if (await findByEmail(email)) {
    throw new ValidationError('Email already registered');
  }

  // Only the primary owner can create another owner
  if (role === 'owner' && !(await isPrimaryOwner(requester.userId))) {
    throw new ForbiddenError('Only the primary owner can create Owner users');
  }

  // clientId is meaningful only for portal users (role='client'). For
  // internal roles, ignore any supplied clientId — they have no specific
  // client they're scoped to.
  let resolvedClientId: string | null = null;
  if (role === 'client') {
    if (!clientId) {
      throw new ValidationError('clientId is required when role is "client"');
    }
    // Verify the client row exists AND belongs to the requester's business
    // (or any business when requester is owner). Otherwise an admin could
    // mint portal credentials for another tenant's client — security hole.
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    if (!client) {
      throw new NotFoundError('Client');
    }
    if (
      requester.role !== 'owner' &&
      requester.businessId &&
      client.businessId !== requester.businessId
    ) {
      throw new ForbiddenError('Cannot create a portal user for a client outside your business');
    }
    resolvedClientId = clientId;
  } else if (clientId) {
    throw new ValidationError('clientId is only allowed when role is "client"');
  }

  const passwordHash = await bcryptjs.hash(password, 12);
  // Per-portal-user tab visibility — admin (Sam) picks which tabs a
  // role='client' user can see. client_admin + staff roles ignore the
  // column at render time (admins always see everything).
  const normalizedTabs = role === 'client'
    ? normalizeAllowedTabs(allowedTabs ?? null)
    : null;
  const [inserted] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name,
      role,
      businessId: requester.businessId ?? null,
      clientId: resolvedClientId,
      isActive: true,
      isPrimaryOwner: false,
      allowedTabs: normalizedTabs,
    })
    .returning();

  const newUser = inserted as UserRow;

  return {
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
    businessId: newUser.businessId,
    clientId: newUser.clientId,
    isActive: newUser.isActive,
    isPrimaryOwner: newUser.isPrimaryOwner,
    createdAt: newUser.createdAt,
  };
}

export async function updateUser(userId: string, name: string, role: UserRole, requester: AuthPayload) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  // Business scoping: non-owner can only edit users in same business
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot edit users outside your business');
  }

  if (userId === requester.userId && role !== user.role) {
    throw new ForbiddenError('Cannot change your own role');
  }

  // Primary owner is protected: only the primary owner can modify their own record
  if (user.isPrimaryOwner && requester.userId !== user.id) {
    throw new ForbiddenError('The primary owner account is protected');
  }

  // Promoting to Owner requires the primary owner
  if (role === 'owner' && user.role !== 'owner' && !(await isPrimaryOwner(requester.userId))) {
    throw new ForbiddenError('Only the primary owner can grant the Owner role');
  }

  const [updated] = await db
    .update(users)
    .set({ name, role, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    businessId: u.businessId,
    clientId: u.clientId,
    isActive: u.isActive,
    isPrimaryOwner: u.isPrimaryOwner,
  };
}

export async function updateUserRole(userId: string, newRole: UserRole, requester: AuthPayload) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  if (userId === requester.userId) {
    throw new ForbiddenError('Cannot change your own role');
  }

  // Business scoping
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot change roles outside your business');
  }

  // Primary owner is protected from role changes
  if (user.isPrimaryOwner) {
    throw new ForbiddenError('The primary owner account is protected');
  }

  // Promoting to Owner requires the primary owner
  if (newRole === 'owner' && !(await isPrimaryOwner(requester.userId))) {
    throw new ForbiddenError('Only the primary owner can grant the Owner role');
  }

  const [updated] = await db
    .update(users)
    .set({ role: newRole, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    businessId: u.businessId,
    clientId: u.clientId,
    isActive: u.isActive,
    isPrimaryOwner: u.isPrimaryOwner,
  };
}

export async function toggleUserActive(userId: string, requester: AuthPayload) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  if (userId === requester.userId) {
    throw new ForbiddenError('Cannot deactivate yourself');
  }

  // Business scoping
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot modify users outside your business');
  }

  // Primary owner cannot be deactivated
  if (user.isPrimaryOwner) {
    throw new ForbiddenError('The primary owner account cannot be deactivated');
  }

  const [updated] = await db
    .update(users)
    .set({ isActive: !user.isActive, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    isPrimaryOwner: u.isPrimaryOwner,
  };
}

// ─── Portal welcome / invite email ───
// Sam (2026-06-18): onboarding the first portal client. Sends a branded
// (leadgeneration.io) welcome email with the user's login email + a deep
// link to /login?welcome=1 where the FE opens the set-password flow.
// Admin-triggered from the Portal Users card; safe to re-send any time.
export async function sendWelcomeEmail(
  userId: string,
  requester: AuthPayload,
): Promise<{ sent: boolean; email: string }> {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  // Business scoping — same stance as the other admin user mutations.
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot email users outside your business');
  }

  // Welcome emails are a portal-onboarding tool — only client portal users.
  if (user.role !== 'client' && user.role !== 'client_admin') {
    throw new ValidationError('Welcome emails are only for portal users');
  }

  if (!user.isActive) {
    throw new ValidationError('Cannot send a welcome email to a deactivated portal user');
  }

  // Carry the email so the login page can pre-fill + auto-send the set-password
  // code (the client never knows the admin's temporary password).
  // FRONTEND_URL is a comma-separated CORS list in prod — take the first entry
  // (or an explicit PORTAL_URL) so the link is a single valid portal URL.
  const portalBase = (process.env.PORTAL_URL || env.FRONTEND_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  const loginUrl = `${portalBase}/login?welcome=1&email=${encodeURIComponent(user.email)}`;
  const tpl = templates.portalWelcome({
    name: user.name,
    email: user.email,
    loginUrl,
    brandName: PORTAL_BRAND_NAME,
  });

  await sendEmail({
    to: user.email,
    subject: tpl.subject,
    html: renderEmailHtml(tpl),
    text: renderEmailText(tpl),
  });

  logger.info({ userId, email: user.email }, 'Portal welcome email sent');
  return { sent: true, email: user.email };
}

// Sam (2026-06-17): "Add option to remove the user as well" on the Portal
// Users card. Permanently deletes a PORTAL user login. Scoped to portal roles
// (client / client_admin) only — staff/owner accounts have references
// (auto-invoice runs, bank-feed, etc.) we don't clean here, and User
// Management owns staff lifecycle. The FK refs a portal user can hold are
// handled by migration 0038 (creative_approvals → SET NULL, notifications →
// CASCADE); the remaining user FKs are already ON DELETE SET NULL.
export async function deleteUser(userId: string, requester: AuthPayload) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  if (userId === requester.userId) {
    throw new ForbiddenError('Cannot remove yourself');
  }

  // Business scoping — same guard as the other admin user mutations.
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot remove users outside your business');
  }

  // Belt-and-braces: the primary owner can never be removed.
  if (user.isPrimaryOwner) {
    throw new ForbiddenError('The primary owner account cannot be removed');
  }

  // Only portal users are removable here. Staff/owner deletion is out of scope
  // (their references aren't cleaned by migration 0038).
  if (user.role !== 'client' && user.role !== 'client_admin') {
    throw new ForbiddenError('Only portal users can be removed here');
  }

  await db.delete(users).where(eq(users.id, userId));

  return { id: userId };
}

// ─── Self-service profile + password ───
// Sam (2026-05-28 follow-up to jam-video #2): admin-side per-portal-user
// tab visibility. Refuses for staff roles (they don't see /portal at all)
// and for client_admin (admins always see every tab — promote/demote is
// the lever for client_admin). For role='client' the array overwrites
// whatever's stored; null means full access.
export async function updateUserAllowedTabs(
  userId: string,
  allowedTabs: string[] | null,
  requester: AuthPayload,
) {
  const target = await findById(userId);
  if (!target) throw new NotFoundError('User');

  // Same business-scope guard as the other admin user mutations.
  if (
    requester.role !== 'owner' &&
    requester.businessId &&
    target.businessId !== requester.businessId
  ) {
    throw new ForbiddenError('Cannot modify users outside your business');
  }

  if (target.role !== 'client') {
    throw new ForbiddenError(
      target.role === 'client_admin'
        ? 'Client admins always see every tab. Demote to a standard portal user first.'
        : 'Per-tab visibility only applies to portal users (role=client).',
    );
  }

  const normalized = normalizeAllowedTabs(allowedTabs);
  const [updated] = await db
    .update(users)
    .set({ allowedTabs: normalized, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    allowedTabs: normalized,
  };
}

// ─── Admin-side password reset ───
// Sam (2026-06-10): "be able to reset the password for any of the clients
// and any users". Owner-only at the route layer. Unlike changeOwnPassword
// this does NOT require the current password — the admin is setting a new
// one on the user's behalf. Mirrors the same business-scope + primary-owner
// guards as the other admin mutations so a non-primary owner can't reset
// the primary owner (Sam) out of their own account.
export async function adminResetPassword(
  userId: string,
  newPassword: string,
  requester: AuthPayload,
) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }

  // Business scoping: non-owner can only reset users in their own business.
  if (requester.role !== 'owner' && requester.businessId && user.businessId !== requester.businessId) {
    throw new ForbiddenError('Cannot reset passwords outside your business');
  }

  // Primary owner is protected: only the primary owner can reset their own
  // password (and they'd normally use self-service change-password for that).
  if (user.isPrimaryOwner && requester.userId !== user.id) {
    throw new ForbiddenError('The primary owner account is protected');
  }

  const newHash = await bcryptjs.hash(newPassword, 12);
  const [updated] = await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    isPrimaryOwner: u.isPrimaryOwner,
  };
}

export async function updateOwnProfile(userId: string, name: string) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 255) {
    throw new ValidationError('Name must be between 1 and 255 characters');
  }

  const [updated] = await db
    .update(users)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  const u = updated as UserRow;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    businessId: u.businessId,
    clientId: u.clientId,
    isActive: u.isActive,
  };
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await findById(userId);
  if (!user) throw new NotFoundError('User');

  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }
  if (currentPassword === newPassword) {
    throw new ValidationError('New password must differ from the current password');
  }

  const valid = await bcryptjs.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  const newHash = await bcryptjs.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
