import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Use forks (one process per test file) instead of the default thread pool.
    // msw patches the global `fetch`, and isolating test files in separate
    // processes prevents request interception from leaking across files.
    pool: 'forks',
    // Conservative parallelism: enough to keep the suite fast (~2s) while
    // keeping memory and FD pressure bounded for CI environments.
    // (Vitest 4 flattened `poolOptions.{threads,forks}.maxForks` to `maxWorkers`.)
    maxWorkers: 4,
    minWorkers: 1,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
  },
});
