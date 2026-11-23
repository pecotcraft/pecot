import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from '../../../libs/interface-spec/src/vitest/allure-reporter.js'

export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      'junit',
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(path.resolve(import.meta.dirname, '..')),
    ],
    outputFile: { junit: 'test-results/junit.xml' },
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts', path.resolve(import.meta.dirname, '../../../libs/interface-spec/src/vitest/unique-titles.ts')],
    include: ['src/**/tests/**/*.test.ts', 'tests/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/interface/**/*.test.ts'],
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
