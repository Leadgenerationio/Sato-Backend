import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { users } from '../db/schema/index.js';
import { UnauthorizedError, ValidationError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload, AuthTokens, UserResponse, UserRole } from '../types/index.js';

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

// Local row type — matches the Drizzle schema for users so we can pass rows
// to toUserResponse without depending on `typeof users.$inferSelect` everywhere.
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
};

export function generateTokens(payload: AuthPayload): AuthTokens {
  const accessToken = jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  const refreshToken = jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
  return { accessToken, refreshToken };
}

export function verifyRefreshToken(token: string): AuthPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as AuthPayload & { iat?: number; exp?: number };
    // Strip JWT-managed claims (iat, exp) so the payload is a clean AuthPayload
    // when re-signed for a new access token.
    const { iat: _iat, exp: _exp, ...payload } = decoded;
    return payload;
  } catch (err) {
    logger.warn({ err }, 'Refresh token verification failed');
    throw new UnauthorizedError('Invalid refresh token');
  }
}

async function findByEmail(email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row as UserRow | undefined;
}

async function findById(id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row as UserRow | undefined;
}

export async function registerUser(
  email: string,
  password: string,
  name: string,
  role?: string,
): Promise<{ user: UserResponse; tokens: AuthTokens }> {
  const existing = await findByEmail(email);
  if (existing) {
    throw new ValidationError('Email already registered');
  }

  const passwordHash = await bcryptjs.hash(password, SALT_ROUNDS);

  // Owner role cannot be assigned via public self-registration
  const requestedRole = (role as UserRole) ?? 'readonly';
  const safeRole: UserRole = requestedRole === 'owner' ? 'readonly' : requestedRole;

  const [inserted] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name,
      role: safeRole,
      businessId: null,
      clientId: null,
      isActive: true,
      isPrimaryOwner: false,
    })
    .returning();

  const newUser = inserted as UserRow;

  const tokenPayload: AuthPayload = {
    userId: newUser.id,
    email: newUser.email,
    role: newUser.role,
  };

  const tokens = generateTokens(tokenPayload);

  return {
    user: toUserResponse(newUser),
    tokens,
  };
}

export async function loginUser(
  email: string,
  password: string,
): Promise<{ user: UserResponse; tokens: AuthTokens }> {
  email = email.trim();
  password = password.trim();
  const user = await findByEmail(email);

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcryptjs.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (!user.isActive) {
    throw new UnauthorizedError('Account is disabled');
  }

  const tokenPayload: AuthPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    businessId: user.businessId ?? undefined,
    clientId: user.clientId ?? undefined,
  };

  const tokens = generateTokens(tokenPayload);

  return {
    user: toUserResponse(user),
    tokens,
  };
}

export async function getUserById(userId: string): Promise<UserResponse> {
  const user = await findById(userId);

  if (!user) {
    throw new NotFoundError('User');
  }

  return toUserResponse(user);
}

function toUserResponse(user: UserRow): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessId: user.businessId,
    clientId: user.clientId,
    isActive: user.isActive,
    isPrimaryOwner: user.isPrimaryOwner ?? false,
  };
}
