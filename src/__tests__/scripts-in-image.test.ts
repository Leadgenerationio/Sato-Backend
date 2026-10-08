import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The production Docker image holds dist/, scripts/, node_modules and only what its COPY lines name from src. The operational scripts
// are run inside it (`npx tsx scripts/...` in the staging or production container), so every file they import must be in the image.
// This broke once: scripts/lib/creative-unique-index.ts imported src/db/schema/creatives.ts, which the image does not contain, so the
// duplicate check and the index script could not run where they were needed. This test reads the Dockerfile and walks the imports.
//
// WHICH scripts: every file directly in scripts/ whose header carries the marker `@runs-in-image`. A new script meant to run in the
// container must carry it (the three below already do); the test then covers it with no list to update.

const ROOT = path.resolve(__dirname, '../..');
const MARKER = '@runs-in-image';
const KNOWN_OPERATIONAL = ['scripts/check-creative-duplicates.ts', 'scripts/create-creative-unique-index.ts', 'scripts/seed-staging-mcp-campaigns.ts'];

/** Scripts (directly in scripts/) that declare they run inside the image. */
function markedScripts(): string[] {
  return fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `scripts/${f}`)
    .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').slice(0, 12).join('\n').includes(MARKER));
}

/** Paths (relative to the repo root) the production stage copies from the build stage. */
function copiedPaths(): string[] {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const production = docker.slice(docker.indexOf('AS production'));
  return [...production.matchAll(/^COPY --from=build \/app\/(\S+) /gm)].map((m) => m[1]!.replace(/\/$/, ''));
}

const inImage = (rel: string, copied: string[]) => copied.some((c) => rel === c || rel.startsWith(`${c}/`));

/** The relative specifiers a file imports: static imports, side-effect imports, re-exports, dynamic import() and require(). */
export function relativeSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g, // import x from './a.js'  /  export { x } from './a.js'
    /import\s+['"](\.[^'"]+)['"]/g, // import './a.js'
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, // await import('./a.js')
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, // require('./a.js')
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Every repo file the entry files (and the files they import, recursively) pull in through a relative import. */
function relativeImportClosure(entries: string[]): string[] {
  const seen = new Set<string>(); const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeSpecifiers(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      const rel = path.relative(ROOT, path.resolve(path.join(ROOT, path.dirname(file)), spec)).replace(/\.js$/, '.ts');
      if (fs.existsSync(path.join(ROOT, rel))) queue.push(rel);
    }
  }
  return [...seen];
}

describe('the operational scripts can run inside the production Docker image', () => {
  const copied = copiedPaths();
  const operational = markedScripts();
  const files = relativeImportClosure(operational);

  it('the three known operational scripts carry the marker (so removing it cannot hide a script from this test)', () => {
    expect(operational).toEqual(expect.arrayContaining(KNOWN_OPERATIONAL));
  });

  it('the Dockerfile copies scripts/ and the index-name file', () => {
    expect(copied).toContain('scripts');
    expect(copied).toContain('src/db/creative-index.ts');
  });

  it('every file the marked scripts import is in the image', () => {
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

  it('the Dockerfile ships only the MCP setup guide from docs/, not the internal runbooks', () => {
    expect(copied).toContain('docs/mcp-setup.md');
    expect(copied).not.toContain('docs');
  });
});

describe('relativeSpecifiers sees every way a script can pull in another file', () => {
  it('static, side-effect, re-export, dynamic import() and require(), and ignores packages', () => {
    const text = [
      "import postgres from 'postgres';",
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "import './side-effect.js';",
      "export { c } from './c.js';",
      "const d = await import('../src/d.js');",
      "const e = require('./e.cjs');",
      "const f = await import(`./template-${x}.js`);", // a computed path cannot be followed; documented limit
    ].join('\n');
    expect(relativeSpecifiers(text).sort()).toEqual(['../b.js', '../src/d.js', './a.js', './c.js', './e.cjs', './side-effect.js']);
  });
});
