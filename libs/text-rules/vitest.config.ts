import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from '../interface-spec/src/vitest/allure-reporter.js'

export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(import.meta.dirname),
    ],
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // CI の 4 CPU の runner で、既定の 5 秒を超えたテストがあった（#131）。
    testTimeout: 30_000,
    setupFiles: [path.resolve(import.meta.dirname, '../interface-spec/src/vitest/unique-titles.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['index.ts', 'lib/**/*.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
