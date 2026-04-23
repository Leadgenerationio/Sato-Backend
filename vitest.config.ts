import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    // Tests share a single Postgres + Redis stack and seed/clean their own
    // fixtures via supertest. Running files in parallel causes state leakage
    // (one suite's seeds vanish when another suite resets, fixtures collide
    // on shared business/client UUIDs). Sequential execution is the simplest
    // fix and only adds ~30 s on CI.
    fileParallelism: false,
  },
});
