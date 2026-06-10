import { describe, it, expect, beforeAll } from 'vitest';
import bcryptjs from 'bcryptjs';
import {
  listUsers, createUser, updateUser, updateUserRole, toggleUserActive,
  updateOwnProfile, changeOwnPassword, adminResetPassword,
} from '../services/user.service.js';
import { findUserById, findUserByEmail, SEED_USER_IDS } from '../data/users.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import type { AuthPayload } from '../types/index.js';

const ownerPayload: AuthPayload = {
  userId: SEED_USER_IDS.OWNER,
  email: 'owner@stato.app',
  role: 'owner',
};

const clientPayload: AuthPayload = {
  userId: SEED_USER_IDS.CLIENT,
  email: 'client@stato.app',
  role: 'client',
};

const opsPayload: AuthPayload = {
  userId: SEED_USER_IDS.OPS,
  email: 'ops@stato.app',
  role: 'ops_manager',
  // Match the seeded business so business-scoping assertions work
  businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
};

describe('User Service', () => {
  describe('listUsers', () => {
    it('owner sees all users', async () => {
      const users = await listUsers(ownerPayload);
      expect(users.length).toBeGreaterThanOrEqual(5);
    });

    it('client only sees themselves', async () => {
      const users = await listUsers(clientPayload);
      expect(users.length).toBe(1);
      expect(users[0].email).toBe('client@stato.app');
    });

    it('non-owner with businessId sees scoped users', async () => {
      const users = await listUsers(opsPayload);
      users.forEach((u) => {
        expect(u.businessId === opsPayload.businessId || u.businessId === null).toBe(true);
      });
    });
  });

  describe('createUser', () => {
    // Generate a unique email per test invocation. DB persists between runs
    // and across `it` blocks within a run, so reusing 'created@test.com'
    // means the second run hits "Email already registered" or the second `it`
    // duplicates against an earlier one.
    const uniqueEmail = (prefix: string) =>
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

    it('creates a new user', async () => {
      const email = uniqueEmail('created');
      const user = await createUser(email, 'Created User', 'pass123', 'readonly', ownerPayload);

      expect(user.email).toBe(email);
      expect(user.name).toBe('Created User');
      expect(user.role).toBe('readonly');
      expect(user.isActive).toBe(true);
    });

    it('rejects duplicate email', async () => {
      await expect(
        createUser('owner@stato.app', 'Dup', 'pass123', 'readonly', ownerPayload),
      ).rejects.toThrow();
    });

    it('inherits requester businessId', async () => {
      const user = await createUser(uniqueEmail('biz-user'), 'Biz User', 'pass123', 'readonly', opsPayload);
      expect(user.businessId).toBe(opsPayload.businessId);
    });

    // Portal-user creation — Benson Goldstein onboarding flow. Before this
    // change, clientId was hardcoded to null on insert, so creating a
    // client-role user via the admin API left the portal scoped to no client
    // and rendered empty for the recipient.
    describe('client-role users + clientId linkage', () => {
      let bensonClientId: string;

      beforeAll(async () => {
        // Seed a Benson-like client row in the ops user's business so the
        // happy-path test can link to it.
        const [row] = await db
          .insert(clients)
          .values({
            businessId: opsPayload.businessId!,
            companyName: `Benson Test ${Date.now()}`,
            currency: 'GBP',
            status: 'active',
          })
          .returning({ id: clients.id });
        bensonClientId = row.id;
      });

      it('creates a client-role user linked to a valid clientId in the requester business', async () => {
        const email = uniqueEmail('benson-portal');
        const user = await createUser(email, 'Benson Portal', 'pass123', 'client', opsPayload, bensonClientId);
        expect(user.role).toBe('client');
        expect(user.clientId).toBe(bensonClientId);
      });

      it('rejects client-role without clientId', async () => {
        await expect(
          createUser(uniqueEmail('no-client-id'), 'No CID', 'pass123', 'client', opsPayload),
        ).rejects.toThrow(/clientId is required/);
      });

      it('rejects clientId on non-client roles (would have been silently ignored before)', async () => {
        await expect(
          createUser(uniqueEmail('wrong-role'), 'Wrong', 'pass123', 'readonly', opsPayload, bensonClientId),
        ).rejects.toThrow(/only allowed when role is "client"/);
      });

      it('rejects clientId that doesn\'t exist', async () => {
        await expect(
          createUser(uniqueEmail('ghost'), 'Ghost', 'pass123', 'client', opsPayload, '00000000-0000-0000-0000-000000000000'),
        ).rejects.toThrow(/not found/);
      });
    });
  });

  describe('updateUser', () => {
    it('owner can update any user', async () => {
      const user = await updateUser(SEED_USER_IDS.FINANCE, 'Updated Name', 'finance_admin', ownerPayload);
      expect(user.name).toBe('Updated Name');
    });

    it('cannot change own role', async () => {
      await expect(
        updateUser(SEED_USER_IDS.OWNER, 'Owner', 'readonly', ownerPayload),
      ).rejects.toThrow('Cannot change your own role');
    });

    it('can update own name without changing role', async () => {
      const user = await updateUser(SEED_USER_IDS.OWNER, 'New Owner Name', 'owner', ownerPayload);
      expect(user.name).toBe('New Owner Name');
    });
  });

  describe('updateUserRole', () => {
    it('owner can change another user role', async () => {
      const user = await updateUserRole(SEED_USER_IDS.FINANCE, 'ops_manager', ownerPayload);
      expect(user.role).toBe('ops_manager');
      // Restore
      await updateUserRole(SEED_USER_IDS.FINANCE, 'finance_admin', ownerPayload);
    });

    it('cannot change own role', async () => {
      await expect(updateUserRole(SEED_USER_IDS.OWNER, 'readonly', ownerPayload)).rejects.toThrow(
        'Cannot change your own role',
      );
    });

    it('throws for non-existent user', async () => {
      await expect(updateUserRole('99999999-0000-0000-0000-000000000999', 'readonly', ownerPayload)).rejects.toThrow('User not found');
    });
  });

  describe('toggleUserActive', () => {
    it('toggles user active status', async () => {
      const user = await toggleUserActive(SEED_USER_IDS.FINANCE, ownerPayload);
      expect(user.isActive).toBe(false);

      // Toggle back
      const restored = await toggleUserActive(SEED_USER_IDS.FINANCE, ownerPayload);
      expect(restored.isActive).toBe(true);
    });

    it('cannot deactivate yourself', async () => {
      await expect(toggleUserActive(SEED_USER_IDS.OWNER, ownerPayload)).rejects.toThrow('Cannot deactivate yourself');
    });

    it('throws for non-existent user', async () => {
      await expect(toggleUserActive('99999999-0000-0000-0000-000000000999', ownerPayload)).rejects.toThrow('User not found');
    });
  });

  describe('primary-owner protection', () => {
    // A second owner, not the primary one, trying to attack Sam (OWNER seed)
    let secondaryOwnerId: string;
    let secondaryOwnerPayload: AuthPayload;

    beforeAll(async () => {
      const created = await createUser(
        `secondary-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
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

    it('non-primary owner cannot change the primary owner role', async () => {
      await expect(updateUserRole(SEED_USER_IDS.OWNER, 'readonly', secondaryOwnerPayload))
        .rejects.toThrow('The primary owner account is protected');
    });

    it('non-primary owner cannot deactivate the primary owner', async () => {
      await expect(toggleUserActive(SEED_USER_IDS.OWNER, secondaryOwnerPayload))
        .rejects.toThrow('The primary owner account cannot be deactivated');
    });

    it('non-primary owner cannot rename the primary owner', async () => {
      await expect(updateUser(SEED_USER_IDS.OWNER, 'Hacked Name', 'owner', secondaryOwnerPayload))
        .rejects.toThrow('The primary owner account is protected');
    });

    it('non-primary owner cannot create another owner', async () => {
      await expect(
        createUser(`another-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`, 'Another Owner', 'pass123', 'owner', secondaryOwnerPayload),
      ).rejects.toThrow('Only the primary owner can create Owner users');
    });

    it('non-primary owner cannot promote a user to owner', async () => {
      // SEED_USER_IDS.FINANCE is finance_admin
      await expect(updateUserRole(SEED_USER_IDS.FINANCE, 'owner', secondaryOwnerPayload))
        .rejects.toThrow('Only the primary owner can grant the Owner role');
    });

    it('primary owner can still manage non-primary owners', async () => {
      const updated = await updateUser(secondaryOwnerId, 'Renamed Owner', 'owner', ownerPayload);
      expect(updated.name).toBe('Renamed Owner');
    });

    it('primary owner survives own field on response', async () => {
      const users = await listUsers(ownerPayload);
      const primary = users.find((u) => u.id === SEED_USER_IDS.OWNER);
      expect(primary?.isPrimaryOwner).toBe(true);
      const other = users.find((u) => u.id === SEED_USER_IDS.FINANCE);
      expect(other?.isPrimaryOwner).toBe(false);
    });
  });

  describe('adminResetPassword', () => {
    // Fresh user per suite so a reset can't strand a seed account's password.
    let targetId: string;
    let targetEmail: string;

    beforeAll(async () => {
      const email = `reset-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
      const u = await createUser(email, 'Reset Target', 'original-pw-123', 'client', ownerPayload, undefined)
        .catch(() => createUser(email, 'Reset Target', 'original-pw-123', 'readonly', ownerPayload));
      targetId = u.id;
      targetEmail = u.email;
    });

    it('owner can reset any user password without the current password', async () => {
      const result = await adminResetPassword(targetId, 'admin-set-pw-456', ownerPayload);
      expect(result.id).toBe(targetId);
      expect(result.email).toBe(targetEmail);
      const user = (await findUserById(targetId))!;
      expect(await bcryptjs.compare('admin-set-pw-456', user.passwordHash)).toBe(true);
    });

    it('rejects a too-short new password', async () => {
      await expect(adminResetPassword(targetId, 'short', ownerPayload))
        .rejects.toThrow('at least 8 characters');
    });

    it('throws for a non-existent user', async () => {
      await expect(adminResetPassword('99999999-0000-0000-0000-000000000999', 'whatever-123', ownerPayload))
        .rejects.toThrow('User not found');
    });

    it('the user can log in with the admin-set password (hash verifies)', async () => {
      await adminResetPassword(targetId, 'final-pw-789', ownerPayload);
      const user = (await findUserById(targetId))!;
      expect(await bcryptjs.compare('final-pw-789', user.passwordHash)).toBe(true);
      // and the previous password no longer matches
      expect(await bcryptjs.compare('admin-set-pw-456', user.passwordHash)).toBe(false);
    });

    it('non-primary owner cannot reset the primary owner password', async () => {
      const secondary = await createUser(
        `reset-secondary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
        'Secondary', 'pass1234', 'owner', ownerPayload,
      );
      const secondaryPayload: AuthPayload = { userId: secondary.id, email: secondary.email, role: 'owner' };
      await expect(adminResetPassword(SEED_USER_IDS.OWNER, 'hijack-pw-123', secondaryPayload))
        .rejects.toThrow('The primary owner account is protected');
    });
  });

  describe('updateOwnProfile', () => {
    it('updates the authenticated user name', async () => {
      const before = (await findUserById(SEED_USER_IDS.FINANCE))!.name;
      const result = await updateOwnProfile(SEED_USER_IDS.FINANCE, 'Self Updated');
      expect(result.name).toBe('Self Updated');
      // Restore
      await updateOwnProfile(SEED_USER_IDS.FINANCE, before);
    });

    it('trims whitespace', async () => {
      const before = (await findUserById(SEED_USER_IDS.FINANCE))!.name;
      const result = await updateOwnProfile(SEED_USER_IDS.FINANCE, '  Trimmed  ');
      expect(result.name).toBe('Trimmed');
      await updateOwnProfile(SEED_USER_IDS.FINANCE, before);
    });

    it('rejects empty names', async () => {
      await expect(updateOwnProfile(SEED_USER_IDS.FINANCE, '   ')).rejects.toThrow('Name must be between 1 and 255 characters');
    });
  });

  describe('changeOwnPassword', () => {
    // Use a freshly-created user instead of the seeded finance@stato.app —
    // previously the test mutated the seed user's password and restored it,
    // but mid-run failures left it in a half-changed state and broke other
    // tests (auth-profile.test.ts, ordering-dependent). Isolation > seed reuse.
    let pwTestUserId: string;
    const PW_INITIAL = 'initial-pw-12345';

    beforeAll(async () => {
      const email = `pw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
      const u = await createUser(email, 'Password Test', PW_INITIAL, 'readonly', ownerPayload);
      pwTestUserId = u.id;
    });

    it('changes the password when current is correct', async () => {
      await changeOwnPassword(pwTestUserId, PW_INITIAL, 'new-pw-67890');
      const user = (await findUserById(pwTestUserId))!;
      expect(await bcryptjs.compare('new-pw-67890', user.passwordHash)).toBe(true);
      // Restore in case other tests share this fixture
      await changeOwnPassword(pwTestUserId, 'new-pw-67890', PW_INITIAL);
    });

    it('rejects an incorrect current password', async () => {
      await expect(changeOwnPassword(pwTestUserId, 'wrong', 'new-pw-67890'))
        .rejects.toThrow('Current password is incorrect');
    });

    it('rejects a too-short new password', async () => {
      await expect(changeOwnPassword(pwTestUserId, PW_INITIAL, 'short'))
        .rejects.toThrow('at least 8 characters');
    });

    it('rejects reusing the same password', async () => {
      await expect(changeOwnPassword(pwTestUserId, PW_INITIAL, PW_INITIAL))
        .rejects.toThrow('must differ');
    });
  });
});
