import { z } from 'zod';

// ─── Roles ───
export type UserRole = 'owner' | 'finance_admin' | 'ops_manager' | 'client' | 'readonly';

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
    role: z.enum(['owner', 'finance_admin', 'ops_manager', 'readonly']).optional(),
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
}

export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
}
