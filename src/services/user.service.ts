import bcryptjs from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema/index.js';
import { NotFoundError, ForbiddenError, ValidationError, UnauthorizedError } from '../utils/errors.js';
import type { UserRole, AuthPayload } from '../types/index.js';

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
    createdAt: u.createdAt,
  }));
}

export async function createUser(
  email: string,
  name: string,
  password: string,
  role: UserRole,
  requester: AuthPayload,
) {
  if (await findByEmail(email)) {
    throw new ValidationError('Email already registered');
  }

  // Only the primary owner can create another owner
  if (role === 'owner' && !(await isPrimaryOwner(requester.userId))) {
    throw new ForbiddenError('Only the primary owner can create Owner users');
  }

  const passwordHash = await bcryptjs.hash(password, 12);
  const [inserted] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name,
      role,
      businessId: requester.businessId ?? null,
      clientId: null,
      isActive: true,
      isPrimaryOwner: false,
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

// ─── Self-service profile + password ───
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

  if (!newPassword || newPassword.length < 6) {
    throw new ValidationError('New password must be at least 6 characters');
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
