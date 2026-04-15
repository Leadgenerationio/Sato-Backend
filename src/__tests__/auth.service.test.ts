import { describe, it, expect } from 'vitest';
import {
  generateTokens,
  verifyRefreshToken,
  loginUser,
  registerUser,
  getUserById,
} from '../services/auth.service.js';

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
    it('registers a new user', async () => {
      const result = await registerUser('new@test.com', 'password123', 'New User');

      expect(result.user.email).toBe('new@test.com');
      expect(result.user.name).toBe('New User');
      expect(result.user.role).toBe('readonly');
      expect(result.user.isActive).toBe(true);
      expect(result.tokens.accessToken).toBeDefined();
    });

    it('defaults to readonly role', async () => {
      const result = await registerUser('default-role@test.com', 'password123', 'Default Role');
      expect(result.user.role).toBe('readonly');
    });

    it('accepts a custom role', async () => {
      const result = await registerUser('custom@test.com', 'password123', 'Custom', 'ops_manager');
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
      const user = await getUserById('1');

      expect(user.email).toBe('owner@stato.app');
      expect(user.role).toBe('owner');
    });

    it('throws for non-existent id', async () => {
      await expect(getUserById('999')).rejects.toThrow('User not found');
    });

    it('does not expose password hash', async () => {
      const user = await getUserById('1');
      expect((user as any).passwordHash).toBeUndefined();
    });
  });
});
