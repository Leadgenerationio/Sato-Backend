import 'dotenv/config';
import { REQUIRED_FOR_PRODUCTION, missingProductionEnv } from '../src/config/env.js';

/**
 * Production preflight check — verifies every required env var is set before
 * the deploy promotes traffic to a new release. Run with:
 *
 *   npx tsx scripts/preflight.ts
 *
 * Exits 0 when all required vars are present, 1 otherwise.
 */
function main(): void {
  const missing = missingProductionEnv();

  console.log(`Preflight — ${REQUIRED_FOR_PRODUCTION.length} env vars required for production:\n`);
  for (const key of REQUIRED_FOR_PRODUCTION) {
    const present = !!process.env[key];
    console.log(`  ${present ? 'OK ' : 'MISS'}  ${key}`);
  }

  if (missing.length === 0) {
    console.log('\nAll required vars set.');
    process.exit(0);
  }

  console.log(`\n${missing.length} missing:`);
  for (const key of missing) console.log(`  - ${key}`);
  process.exit(1);
}

main();
