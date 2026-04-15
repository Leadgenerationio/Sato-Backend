import bcryptjs from 'bcryptjs';
import { getAllUsers, findUserById, findUserByEmail, addUser, getNextId } from '../data/users.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import type { UserRole, AuthPayload } from '../types/index.js';

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

  user.isActive = !user.isActive;
  user.updatedAt = new Date();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
  };
}
