import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

// The production image copies only dist/, scripts/ and the migrations — not
// src/. The boot scripts in the Dockerfile CMD run from source via tsx, so any
// `../src/...` they import must be copied explicitly or the container
// crash-loops with ERR_MODULE_NOT_FOUND (2026-09-29 seed-if-empty).
const root = resolve(__dirname, '../..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const bootScripts = ['scripts/auto-migrate.ts'];

describe('boot scripts only import what the production image ships', () => {
  for (const script of bootScripts) {
    it(script, () => {
      const source = readFileSync(join(root, script), 'utf8');
      const rels = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
      for (const rel of rels) {
        const file = resolve(dirname(join(root, script)), rel).replace(/\.js$/, '.ts');
        expect(existsSync(file), `${rel} does not exist`).toBe(true);
        const inRepo = file.slice(root.length + 1);
        const shipped =
          inRepo.startsWith('scripts/') ||
          dockerfile.includes(`/app/${inRepo} `) ||
          dockerfile.includes(`/app/${inRepo}\n`);
        expect(shipped, `${inRepo} is imported by ${script} but not COPYed into the production image`).toBe(true);
      }
    });
  }
});
