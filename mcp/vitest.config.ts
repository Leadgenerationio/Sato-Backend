import { defineConfig } from 'vitest/config';

// Own config so vitest doesn't pick up the backend's (DB setup file, src/** only).
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
