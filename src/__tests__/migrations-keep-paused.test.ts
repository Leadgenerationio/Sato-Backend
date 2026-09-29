import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// scripts/auto-migrate.ts re-applies every migration file on every boot, so a
// data UPDATE in an old migration runs again on each deploy. Migration 0022
// used to rewrite 'paused' → 'churned', which silently undid every Paused
// status (Sam feedback round 1, M4). Guard against it coming back.
const dir = join(import.meta.dirname, '..', 'db', 'migrations');

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase());
}

describe('migrations never rewrite a paused client status', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  it('finds the migration files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s does not UPDATE clients away from paused', (file) => {
    const bad = statements(readFileSync(join(dir, file), 'utf8')).filter(
      (s) => s.startsWith('update clients') && /status\s*=\s*'paused'/.test(s.split(' where ')[1] ?? ''),
    );
    expect(bad).toEqual([]);
  });
});
