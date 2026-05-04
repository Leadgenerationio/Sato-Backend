import { describe, it, expect } from 'vitest';
import {
  generateTokens,
  verifyRefreshToken,
  loginUser,
  registerUser,
  getUserById,
} from '../services/auth.service.js';
import { SEED_USER_IDS } from '../data/users.js';

describe('Auth Service', () => {
  describe('generateTokens', () => {
    it('returns access and refresh tokens', () => {
      const tokens = generateTokens({
        userId: '1',
        email: 'test@test.com',
        role: 'owner',
      });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.accessToken).not.toBe(tokens.refreshToken);
    });
  });

  describe('verifyRefreshToken', () => {
    it('verifies a valid refresh token', () => {
      const tokens = generateTokens({
        userId: '1',
        email: 'test@test.com',
        role: 'owner',
      });

      const payload = verifyRefreshToken(tokens.refreshToken);

      expect(payload.userId).toBe('1');
      expect(payload.email).toBe('test@test.com');
      expect(payload.role).toBe('owner');
    });

    it('throws on invalid token', () => {
      expect(() => verifyRefreshToken('invalid-token')).toThrow('Invalid refresh token');
    });

    it('rejects an access token used as refresh token', () => {
      const tokens = generateTokens({
        userId: '1',
        email: 'test@test.com',
        role: 'owner',
      });

      expect(() => verifyRefreshToken(tokens.accessToken)).toThrow('Invalid refresh token');
    });
  });

  describe('loginUser', () => {
    it('logs in with valid credentials', async () => {
      const result = await loginUser('owner@stato.app', 'owner123');

      expect(result.user.email).toBe('owner@stato.app');
      expect(result.user.role).toBe('owner');
      expect(result.user.isActive).toBe(true);
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
    });

    it('rejects invalid email', async () => {
      await expect(loginUser('nobody@stato.app', 'password')).rejects.toThrow(
        'Invalid email or password',
      );
    });

    it('rejects wrong password', async () => {
      await expect(loginUser('owner@stato.app', 'wrongpass')).rejects.toThrow(
        'Invalid email or password',
      );
    });

    it('trims whitespace from email and password', async () => {
      const result = await loginUser('  owner@stato.app  ', '  owner123  ');
      expect(result.user.email).toBe('owner@stato.app');
    });

    it('returns all user roles correctly', async () => {
      const accounts = [
        { email: 'owner@stato.app', password: 'owner123', role: 'owner' },
        { email: 'finance@stato.app', password: 'finance123', role: 'finance_admin' },
        { email: 'ops@stato.app', password: 'ops123', role: 'ops_manager' },
        { email: 'client@stato.app', password: 'client123', role: 'client' },
        { email: 'readonly@stato.app', password: 'readonly123', role: 'readonly' },
      ];

      for (const account of accounts) {
        const result = await loginUser(account.email, account.password);
        expect(result.user.role).toBe(account.role);
      }
    });
  });

  describe('registerUser', () => {
    // Generate a unique email per test run so the persisted DB doesn't carry
    // stale rows between runs. Each `uniqueEmail()` call returns a distinct
    // address that won't collide with previous test runs.
    const uniqueEmail = (prefix: string) =>
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

    it('registers a new user', async () => {
      const email = uniqueEmail('new');
      const result = await registerUser(email, 'password123', 'New User');

      expect(result.user.email).toBe(email);
      expect(result.user.name).toBe('New User');
      expect(result.user.role).toBe('readonly');
      expect(result.user.isActive).toBe(true);
      expect(result.tokens.accessToken).toBeDefined();
    });

    it('defaults to readonly role', async () => {
      const result = await registerUser(uniqueEmail('default-role'), 'password123', 'Default Role');
      expect(result.user.role).toBe('readonly');
    });

    it('accepts a custom role', async () => {
      const result = await registerUser(uniqueEmail('custom'), 'password123', 'Custom', 'ops_manager');
      expect(result.user.role).toBe('ops_manager');
    });

    it('rejects duplicate email', async () => {
      await expect(
        registerUser('owner@stato.app', 'password123', 'Duplicate'),
      ).rejects.toThrow('Email already registered');
    });
  });

  describe('getUserById', () => {
    it('returns user for valid id', async () => {
      const user = await getUserById(SEED_USER_IDS.OWNER);

      expect(user.email).toBe('owner@stato.app');
      expect(user.role).toBe('owner');
    });

    it('throws for non-existent id', async () => {
      // Use a valid UUID shape that won't exist
      await expect(getUserById('99999999-0000-0000-0000-000000000999')).rejects.toThrow('User not found');
    });

    it('does not expose password hash', async () => {
      const user = await getUserById(SEED_USER_IDS.OWNER);
      expect((user as any).passwordHash).toBeUndefined();
    });
  });
});
