// Sam feedback 2026-09-29 (S8): the container's first-boot seeder created four
// well-known accounts (owner@ / finance@ / ops@ / readonly@stato.app). In
// production only the owner's password was required; the other three quietly fell
// back to finance123 / ops123 / readonly123 on a fresh database.
//
// Rule now: in production a seeded account exists only if its password was set on
// purpose. The owner is mandatory; the rest are skipped, never given a default.
// Outside production the dev defaults are kept so local setups still work.

export interface SeedUser {
  email: string;
  password: string;
  name: string;
  role: 'owner' | 'finance_admin' | 'ops_manager' | 'readonly';
  isPrimaryOwner: boolean;
}

const DEV_DEFAULTS = {
  owner: 'owner123',
  finance: 'finance123',
  ops: 'ops123',
  readonly: 'readonly123',
} as const;

export class SeedConfigError extends Error {}

export function buildSeedUsers(env: NodeJS.ProcessEnv, isProd: boolean): { users: SeedUser[]; skipped: string[] } {
  const pw = (key: string, dev: string): string | undefined => {
    const v = env[key];
    if (v) return v;
    return isProd ? undefined : dev;
  };

  const owner = pw('SEED_OWNER_PASSWORD', DEV_DEFAULTS.owner);
  if (!owner) {
    throw new SeedConfigError(
      'SEED_OWNER_PASSWORD is required in production. Set it in the Railway env vars, then redeploy. ' +
        'Refusing to seed with a default password.',
    );
  }

  const candidates: Array<[SeedUser['role'], string, string, string | undefined, string]> = [
    ['finance_admin', 'finance@stato.app', 'Finance Admin', pw('SEED_FINANCE_PASSWORD', DEV_DEFAULTS.finance), 'SEED_FINANCE_PASSWORD'],
    ['ops_manager', 'ops@stato.app', 'Ops Manager', pw('SEED_OPS_PASSWORD', DEV_DEFAULTS.ops), 'SEED_OPS_PASSWORD'],
    ['readonly', 'readonly@stato.app', 'Readonly User', pw('SEED_READONLY_PASSWORD', DEV_DEFAULTS.readonly), 'SEED_READONLY_PASSWORD'],
  ];

  const users: SeedUser[] = [
    { email: 'owner@stato.app', password: owner, name: 'Sam Owner', role: 'owner', isPrimaryOwner: true },
  ];
  const skipped: string[] = [];
  for (const [role, email, name, password, envKey] of candidates) {
    if (password) users.push({ email, password, name, role, isPrimaryOwner: false });
    else skipped.push(`${email} (set ${envKey} to create it)`);
  }
  return { users, skipped };
}
