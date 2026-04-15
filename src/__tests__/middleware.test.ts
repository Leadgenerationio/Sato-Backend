import { describe, it, expect, vi } from 'vitest';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { generateTokens } from '../services/auth.service.js';
import type { Request, Response, NextFunction } from 'express';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as Request;
}

function mockRes(): Response {
  return {} as Response;
}

describe('Auth Middleware', () => {
  it('sets req.user for valid token', () => {
    const tokens = generateTokens({
      userId: '1',
      email: 'test@test.com',
      role: 'owner',
    });

    const req = mockReq({
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const next = vi.fn();

    authMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('1');
    expect(req.user!.role).toBe('owner');
  });

  it('throws without authorization header', () => {
    const req = mockReq();
    const next = vi.fn();

    expect(() => authMiddleware(req, mockRes(), next)).toThrow(
      'Missing or invalid authorization header',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('throws with malformed header', () => {
    const req = mockReq({
      headers: { authorization: 'InvalidFormat token123' },
    });
    const next = vi.fn();

    expect(() => authMiddleware(req, mockRes(), next)).toThrow(
      'Missing or invalid authorization header',
    );
  });

  it('throws with expired/invalid token', () => {
    const req = mockReq({
      headers: { authorization: 'Bearer invalid.jwt.token' },
    });
    const next = vi.fn();

    expect(() => authMiddleware(req, mockRes(), next)).toThrow('Invalid or expired token');
  });
});

describe('RBAC Middleware', () => {
  it('allows matching role', () => {
    const middleware = requireRole('owner', 'finance_admin');
    const req = mockReq();
    req.user = { userId: '1', email: 'test@test.com', role: 'owner' };
    const next = vi.fn();

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects non-matching role', () => {
    const middleware = requireRole('owner');
    const req = mockReq();
    req.user = { userId: '2', email: 'test@test.com', role: 'readonly' };
    const next = vi.fn();

    expect(() => middleware(req, mockRes(), next)).toThrow('Insufficient permissions');
    expect(next).not.toHaveBeenCalled();
  });

  it('throws unauthorized when no user', () => {
    const middleware = requireRole('owner');
    const req = mockReq();
    const next = vi.fn();

    expect(() => middleware(req, mockRes(), next)).toThrow();
    expect(next).not.toHaveBeenCalled();
  });

  it('allows one of multiple roles', () => {
    const middleware = requireRole('owner', 'finance_admin', 'ops_manager');
    const req = mockReq();
    req.user = { userId: '3', email: 'ops@test.com', role: 'ops_manager' };
    const next = vi.fn();

    middleware(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
