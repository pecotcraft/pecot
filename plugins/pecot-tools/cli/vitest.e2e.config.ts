import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from '../../../libs/interface-spec/src/vitest/allure-reporter.js'

export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(path.resolve(import.meta.dirname, '..')),
    ],
    setupFiles: [path.resolve(import.meta.dirname, '../../../libs/interface-spec/src/vitest/unique-titles.ts')],
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
})
