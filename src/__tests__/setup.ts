import { seedDefaultUsers } from '../data/users.js';

beforeAll(async () => {
  // `src/config/env.ts` calls dotenv at module load, so any third-party API
  // key present in `.env` leaks into the integration test process and makes
  // services hit live APIs instead of their mock fallbacks. Strip the keys
  // integration suites assume are unset; per-test files that exercise the
  // real fetch path (e.g. leadbyte-client.test.ts) set `process.env.<KEY>`
  // explicitly. This runs after dotenv has populated process.env, but before
  // any test executes.
  delete process.env.LEADBYTE_API_KEY;

  await seedDefaultUsers();
});
