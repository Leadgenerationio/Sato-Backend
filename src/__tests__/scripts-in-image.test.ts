import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The production Docker image holds dist/, scripts/, node_modules and only what its COPY lines name from src. The operational scripts
// are run inside it (`npx tsx scripts/...` in the staging or production container), so every file they import must be in the image.
// This broke once: scripts/lib/creative-unique-index.ts imported src/db/schema/creatives.ts, which the image does not contain, so the
// duplicate check and the index script could not run where they were needed. This test reads the Dockerfile and walks the imports.

const ROOT = path.resolve(__dirname, '../..');
const OPERATIONAL = ['scripts/check-creative-duplicates.ts', 'scripts/create-creative-unique-index.ts', 'scripts/seed-staging-mcp-campaigns.ts'];

/** Paths (relative to the repo root) the production stage copies from the build stage. */
function copiedPaths(): string[] {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const production = docker.slice(docker.indexOf('AS production'));
  return [...production.matchAll(/^COPY --from=build \/app\/(\S+) /gm)].map((m) => m[1]!.replace(/\/$/, ''));
}

const inImage = (rel: string, copied: string[]) => copied.some((c) => rel === c || rel.startsWith(`${c}/`));

/** Every repo file the entry file (and the files it imports, recursively) pulls in through a relative import. */
function relativeImportClosure(entries: string[]): string[] {
  const seen = new Set<string>(); const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g)) {
      const spec = (m[1] ?? m[2])!;
      const rel = path.relative(ROOT, path.resolve(path.join(ROOT, path.dirname(file)), spec)).replace(/\.js$/, '.ts');
      if (fs.existsSync(path.join(ROOT, rel))) queue.push(rel);
    }
  }
  return [...seen];
}

describe('the operational scripts can run inside the production Docker image', () => {
  const copied = copiedPaths();
  const files = relativeImportClosure(OPERATIONAL);

  it('the Dockerfile copies scripts/ and the index-name file', () => {
    expect(copied).toContain('scripts');
    expect(copied).toContain('src/db/creative-index.ts');
  });

  it('every file the duplicate check, the index script and the seed script import is in the image', () => {
    const missing = files.filter((f) => !inImage(f, copied));
    expect(missing, `not copied into the image: ${missing.join(', ')}`).toEqual([]);
  });

  it('the walk really follows imports (it reaches the shared library and the index-name file)', () => {
    expect(files).toContain('scripts/lib/creative-unique-index.ts');
    expect(files).toContain('src/db/creative-index.ts');
  });

  it('the index name the scripts create is the one the race handlers match', async () => {
    const { CREATIVE_CLIENT_SHA_INDEX: fromSchema } = await import('../db/schema/creatives.js');
    const { CREATIVE_CLIENT_SHA_INDEX: standalone } = await import('../db/creative-index.js');
    expect(fromSchema).toBe(standalone);
    expect(standalone).toBe('creatives_client_sha256_live_uq');
  });
});
