import { z } from 'zod';

// ─── Roles ───
// Sam (2026-05-27 portal meeting): 'client_admin' added so each client's
// own admin can self-serve user management + agreement upload from inside
// /portal without Sam needing to be involved.
export type UserRole = 'owner' | 'finance_admin' | 'ops_manager' | 'client' | 'client_admin' | 'readonly';

// ─── Auth Schemas ───
export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6),
  }),
});

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(255),
    password: z.string().min(6),
    role: z.enum(['finance_admin', 'ops_manager', 'readonly']).optional(),
  }),
});

// ─── Auth Types ───
export interface AuthPayload {
  userId: string;
  email: string;
  role: UserRole;
  businessId?: string;
  clientId?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  clientId: string | null;
  isActive: boolean;
  isPrimaryOwner: boolean;
  // Sam 27-May portal meeting: per-portal-user tab visibility. null = full
  // access. Always null for client_admin (admins see every tab).
  allowedTabs: string[] | null;
}

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(255),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6).max(255),
  }),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
});

// ─── Pagination / list query helpers ───
//
// Reused by every list route that paginates: page (1-based), limit (capped
// at 100). Coerced from query strings since req.query values are strings.
// Each list route extends this with its own filter shape via z.object.merge
// or by composing in the route file.
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
}
