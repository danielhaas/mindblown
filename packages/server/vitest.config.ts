import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Most tests here cover pure logic; DB-touching paths are split into
    // mocked-helper tests so we don't need Postgres in CI.
    environment: 'node',
  },
});
