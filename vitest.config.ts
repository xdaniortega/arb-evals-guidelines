import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Owner-authored case validator and preparation tests use node:test, which vitest
    // would collect as zero tests. They run under `pnpm test:eval-cases` instead.
    exclude: [
      ...configDefaults.exclude,
      'eval-cases/*/*/validator.test.ts',
      'eval-cases/*/*/oracle-aux.test.ts',
      'eval-cases/*/*/prepare.test.ts',
    ],
    environment: 'node',
    // Much of src is integration-level: it spawns real CLI entry points as
    // subprocesses, and a few boot and destroy an actual guest container (~4s each).
    // Vitest's 5s default is not a meaningful bound for that work. This ceiling still
    // catches genuine hangs.
    testTimeout: 30_000,
    // Those same tests oversubscribe the machine when every file runs at once: spawn
    // latency and file-replacement races then produce false failures that migrate
    // between files depending on which test loses the race. Capping workers keeps the
    // suite deterministic; it is a resource bound, not a weakened assertion.
    maxWorkers: 4,
    setupFiles: ['src/test-guards.ts'],
  },
})
