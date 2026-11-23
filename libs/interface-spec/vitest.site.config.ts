import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from './src/vitest/allure-reporter.js'

// test-site のレーン。ビルドした定義書のサイトを Chromium で開き、見た目の崩れを測る。
export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(import.meta.dirname),
    ],
    include: ['tests/site/**/*.test.ts'],
    setupFiles: ['src/vitest/unique-titles.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
})
