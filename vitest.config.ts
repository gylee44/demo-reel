import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: { POC_MODE: 'true' },
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
