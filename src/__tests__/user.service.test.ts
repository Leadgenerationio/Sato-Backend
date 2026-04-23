import { describe, it, expect, beforeAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import {
  listUsers, createUser, updateUser, updateUserRole, toggleUserActive,
  updateOwnProfile, changeOwnPassword,
} from '../services/user.service.js';
import { findUserById, findUserByEmail } from '../data/users.js';
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

  describe('primary-owner protection', () => {
    // A second owner, not the primary one, trying to attack Sam (id '1')
    let secondaryOwnerId: string;
    let secondaryOwnerPayload: AuthPayload;

    beforeAll(async () => {
      const created = await createUser(
        'secondary-owner@test.com',
        'Second Owner',
        'pass123',
        // primary owner creates another owner — this path is allowed
        'owner',
        ownerPayload,
      );
      secondaryOwnerId = created.id;
      secondaryOwnerPayload = {
        userId: secondaryOwnerId,
        email: created.email,
        role: 'owner',
      };
    });

    it('non-primary owner cannot change the primary owner role', () => {
      expect(() => updateUserRole('1', 'readonly', secondaryOwnerPayload))
        .toThrow('The primary owner account is protected');
    });

    it('non-primary owner cannot deactivate the primary owner', () => {
      expect(() => toggleUserActive('1', secondaryOwnerPayload))
        .toThrow('The primary owner account cannot be deactivated');
    });

    it('non-primary owner cannot rename the primary owner', () => {
      expect(() => updateUser('1', 'Hacked Name', 'owner', secondaryOwnerPayload))
        .toThrow('The primary owner account is protected');
    });

    it('non-primary owner cannot create another owner', async () => {
      await expect(
        createUser('another-owner@test.com', 'Another Owner', 'pass123', 'owner', secondaryOwnerPayload),
      ).rejects.toThrow('Only the primary owner can create Owner users');
    });

    it('non-primary owner cannot promote a user to owner', () => {
      // User id '2' is finance_admin
      expect(() => updateUserRole('2', 'owner', secondaryOwnerPayload))
        .toThrow('Only the primary owner can grant the Owner role');
    });

    it('primary owner can still manage non-primary owners', () => {
      const updated = updateUser(secondaryOwnerId, 'Renamed Owner', 'owner', ownerPayload);
      expect(updated.name).toBe('Renamed Owner');
    });

    it('primary owner survives own field on response', () => {
      const users = listUsers(ownerPayload);
      const primary = users.find((u) => u.id === '1');
      expect(primary?.isPrimaryOwner).toBe(true);
      const other = users.find((u) => u.id === '2');
      expect(other?.isPrimaryOwner).toBe(false);
    });
  });

  describe('updateOwnProfile', () => {
    it('updates the authenticated user name', () => {
      const before = findUserById('2')!.name;
      const result = updateOwnProfile('2', 'Self Updated');
      expect(result.name).toBe('Self Updated');
      // Restore
      updateOwnProfile('2', before);
    });

    it('trims whitespace', () => {
      const before = findUserById('2')!.name;
      const result = updateOwnProfile('2', '  Trimmed  ');
      expect(result.name).toBe('Trimmed');
      updateOwnProfile('2', before);
    });

    it('rejects empty names', () => {
      expect(() => updateOwnProfile('2', '   ')).toThrow('Name must be between 1 and 255 characters');
    });
  });

  describe('changeOwnPassword', () => {
    it('changes the password when current is correct', async () => {
      await changeOwnPassword('2', 'finance123', 'finance-new-pw');
      const user = findUserByEmail('finance@stato.app')!;
      expect(await bcryptjs.compare('finance-new-pw', user.passwordHash)).toBe(true);
      // Restore
      await changeOwnPassword('2', 'finance-new-pw', 'finance123');
    });

    it('rejects an incorrect current password', async () => {
      await expect(changeOwnPassword('2', 'wrong', 'finance-new-pw'))
        .rejects.toThrow('Current password is incorrect');
    });

    it('rejects a too-short new password', async () => {
      await expect(changeOwnPassword('2', 'finance123', 'short'))
        .rejects.toThrow('at least 6 characters');
    });

    it('rejects reusing the same password', async () => {
      await expect(changeOwnPassword('2', 'finance123', 'finance123'))
        .rejects.toThrow('must differ');
    });
  });
});
