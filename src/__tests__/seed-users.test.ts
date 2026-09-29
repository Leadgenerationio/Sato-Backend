import { describe, it, expect } from 'vitest';
import { buildSeedUsers, SeedConfigError } from '../utils/seed-users.js';

describe('buildSeedUsers (Sam S8: no well-known passwords in production)', () => {
  it('production without an owner password refuses to seed', () => {
    expect(() => buildSeedUsers({}, true)).toThrow(SeedConfigError);
    expect(() => buildSeedUsers({ SEED_FINANCE_PASSWORD: 'x'.repeat(12) }, true)).toThrow(/SEED_OWNER_PASSWORD/);
  });

  it('production seeds only the owner when only the owner password is set', () => {
    const { users, skipped } = buildSeedUsers({ SEED_OWNER_PASSWORD: 'Owner-Real-Pass-1' }, true);
    expect(users.map((u) => u.email)).toEqual(['owner@stato.app']);
    expect(users[0]).toMatchObject({ role: 'owner', isPrimaryOwner: true, password: 'Owner-Real-Pass-1' });
    expect(skipped).toHaveLength(3);
    expect(skipped.join(' ')).toMatch(/SEED_FINANCE_PASSWORD/);
  });

  it('production never falls back to a default password for any account', () => {
    const { users } = buildSeedUsers({ SEED_OWNER_PASSWORD: 'a-real-owner-pw', SEED_OPS_PASSWORD: 'a-real-ops-pw' }, true);
    expect(users.map((u) => u.email)).toEqual(['owner@stato.app', 'ops@stato.app']);
    const passwords = users.map((u) => u.password);
    for (const weak of ['owner123', 'finance123', 'ops123', 'readonly123']) expect(passwords).not.toContain(weak);
  });

  it('production seeds every account whose password was set', () => {
    const { users, skipped } = buildSeedUsers({
      SEED_OWNER_PASSWORD: 'o-real', SEED_FINANCE_PASSWORD: 'f-real', SEED_OPS_PASSWORD: 'p-real', SEED_READONLY_PASSWORD: 'r-real',
    }, true);
    expect(users.map((u) => u.role)).toEqual(['owner', 'finance_admin', 'ops_manager', 'readonly']);
    expect(skipped).toEqual([]);
  });

  it('outside production the dev defaults still work', () => {
    const { users } = buildSeedUsers({}, false);
    expect(users.map((u) => [u.email, u.password])).toEqual([
      ['owner@stato.app', 'owner123'], ['finance@stato.app', 'finance123'], ['ops@stato.app', 'ops123'], ['readonly@stato.app', 'readonly123'],
    ]);
  });
});
