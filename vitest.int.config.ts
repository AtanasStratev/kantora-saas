import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL (docker compose). Loads .env for URLs.
process.loadEnvFile?.('.env');

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
