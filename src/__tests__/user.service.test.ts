import { describe, it, expect } from 'vitest';
import { listUsers, createUser, updateUser, updateUserRole, toggleUserActive } from '../services/user.service.js';
import type { AuthPayload } from '../types/index.js';

const ownerPayload: AuthPayload = {
  userId: '1',
  email: 'owner@stato.app',
  role: 'owner',
};

const clientPayload: AuthPayload = {
  userId: '4',
  email: 'client@stato.app',
  role: 'client',
};

const opsPayload: AuthPayload = {
  userId: '3',
  email: 'ops@stato.app',
  role: 'ops_manager',
  businessId: 'biz-1',
};

describe('User Service', () => {
  describe('listUsers', () => {
    it('owner sees all users', () => {
      const users = listUsers(ownerPayload);
      expect(users.length).toBeGreaterThanOrEqual(5);
    });

    it('client only sees themselves', () => {
      const users = listUsers(clientPayload);
      expect(users.length).toBe(1);
      expect(users[0].email).toBe('client@stato.app');
    });

    it('non-owner with businessId sees scoped users', () => {
      const users = listUsers(opsPayload);
      users.forEach((u) => {
        expect(u.businessId === opsPayload.businessId || u.businessId === null).toBe(true);
      });
    });
  });

  describe('createUser', () => {
    it('creates a new user', async () => {
      const user = await createUser('created@test.com', 'Created User', 'pass123', 'readonly', ownerPayload);

      expect(user.email).toBe('created@test.com');
      expect(user.name).toBe('Created User');
      expect(user.role).toBe('readonly');
      expect(user.isActive).toBe(true);
    });

    it('rejects duplicate email', async () => {
      await expect(
        createUser('owner@stato.app', 'Dup', 'pass123', 'readonly', ownerPayload),
      ).rejects.toThrow('Email already registered');
    });

    it('inherits requester businessId', async () => {
      const user = await createUser('biz-user@test.com', 'Biz User', 'pass123', 'readonly', opsPayload);
      expect(user.businessId).toBe('biz-1');
    });
  });

  describe('updateUser', () => {
    it('owner can update any user', () => {
      const user = updateUser('2', 'Updated Name', 'finance_admin', ownerPayload);
      expect(user.name).toBe('Updated Name');
    });

    it('cannot change own role', () => {
      expect(() =>
        updateUser('1', 'Owner', 'readonly', ownerPayload),
      ).toThrow('Cannot change your own role');
    });

    it('can update own name without changing role', () => {
      const user = updateUser('1', 'New Owner Name', 'owner', ownerPayload);
      expect(user.name).toBe('New Owner Name');
    });
  });

  describe('updateUserRole', () => {
    it('owner can change another user role', () => {
      const user = updateUserRole('2', 'ops_manager', ownerPayload);
      expect(user.role).toBe('ops_manager');
      // Restore
      updateUserRole('2', 'finance_admin', ownerPayload);
    });

    it('cannot change own role', () => {
      expect(() => updateUserRole('1', 'readonly', ownerPayload)).toThrow(
        'Cannot change your own role',
      );
    });

    it('throws for non-existent user', () => {
      expect(() => updateUserRole('999', 'readonly', ownerPayload)).toThrow('User not found');
    });
  });

  describe('toggleUserActive', () => {
    it('toggles user active status', () => {
      const user = toggleUserActive('2', ownerPayload);
      expect(user.isActive).toBe(false);

      // Toggle back
      const restored = toggleUserActive('2', ownerPayload);
      expect(restored.isActive).toBe(true);
    });

    it('cannot deactivate yourself', () => {
      expect(() => toggleUserActive('1', ownerPayload)).toThrow('Cannot deactivate yourself');
    });

    it('throws for non-existent user', () => {
      expect(() => toggleUserActive('999', ownerPayload)).toThrow('User not found');
    });
  });
});
