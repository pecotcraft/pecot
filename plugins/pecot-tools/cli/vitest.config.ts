import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, 'junit'],
    outputFile: { junit: 'test-results/junit.xml' },
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts'],
    include: ['src/**/tests/**/*.test.ts', 'tests/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/tests/**'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
})
