import bcryptjs from 'bcryptjs';
import { getAllUsers, findUserById, findUserByEmail, addUser, getNextId } from '../data/users.js';
import { NotFoundError, ForbiddenError, ValidationError, UnauthorizedError } from '../utils/errors.js';
import type { UserRole, AuthPayload } from '../types/index.js';

function isPrimaryOwner(userId: string): boolean {
  const u = findUserById(userId);
  return u?.isPrimaryOwner === true;
}

// ─── Business-scoped + client row-level filtered list ───
export function listUsers(requester: AuthPayload) {
  let result = getAllUsers();

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
  if (findUserByEmail(email)) {
    throw new ValidationError('Email already registered');
  }

  // Only the primary owner can create another owner
  if (role === 'owner' && !isPrimaryOwner(requester.userId)) {
    throw new ForbiddenError('Only the primary owner can create Owner users');
  }

  const passwordHash = await bcryptjs.hash(password, 12);
  const newUser = {
    id: getNextId(),
    email,
    passwordHash,
    name,
    role,
    businessId: requester.businessId ?? null,
    clientId: null,
    isActive: true,
    isPrimaryOwner: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  addUser(newUser);

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

export function updateUser(userId: string, name: string, role: UserRole, requester: AuthPayload) {
  const user = findUserById(userId);
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
  if (role === 'owner' && user.role !== 'owner' && !isPrimaryOwner(requester.userId)) {
    throw new ForbiddenError('Only the primary owner can grant the Owner role');
  }

  user.name = name;
  user.role = role;
  user.updatedAt = new Date();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessId: user.businessId,
    clientId: user.clientId,
    isActive: user.isActive,
    isPrimaryOwner: user.isPrimaryOwner,
  };
}

export function updateUserRole(userId: string, newRole: UserRole, requester: AuthPayload) {
  const user = findUserById(userId);
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
  if (newRole === 'owner' && !isPrimaryOwner(requester.userId)) {
    throw new ForbiddenError('Only the primary owner can grant the Owner role');
  }

  user.role = newRole;
  user.updatedAt = new Date();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessId: user.businessId,
    clientId: user.clientId,
    isActive: user.isActive,
    isPrimaryOwner: user.isPrimaryOwner,
  };
}

export function toggleUserActive(userId: string, requester: AuthPayload) {
  const user = findUserById(userId);
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

  user.isActive = !user.isActive;
  user.updatedAt = new Date();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    isPrimaryOwner: user.isPrimaryOwner,
  };
}

// ─── Self-service profile + password ───
export function updateOwnProfile(userId: string, name: string) {
  const user = findUserById(userId);
  if (!user) throw new NotFoundError('User');

  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 255) {
    throw new ValidationError('Name must be between 1 and 255 characters');
  }

  user.name = trimmed;
  user.updatedAt = new Date();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessId: user.businessId,
    clientId: user.clientId,
    isActive: user.isActive,
  };
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = findUserById(userId);
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

  user.passwordHash = await bcryptjs.hash(newPassword, 12);
  user.updatedAt = new Date();
}
