import { defineConfig } from 'vitest/config';

// Long-running benchmarks / calibration (not part of `npm test`): `npm run bench`
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 7200000,
  },
});
