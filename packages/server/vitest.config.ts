import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Most tests here cover pure logic or mock db/connection. Where the
    // correctness lives in SQL, `*.pglite.test.ts` runs against an
    // in-process Postgres (src/test/pgliteDb.ts) — still no server in CI.
    environment: 'node',
    // Booting PGlite and running the full DDL (twice, in the migrate tests)
    // takes ~2-5 s alone and crosses vitest's 5 s default on a loaded CI
    // runner — the same two tests timed out on master (314cef0).
    testTimeout: 30_000,
  },
});
