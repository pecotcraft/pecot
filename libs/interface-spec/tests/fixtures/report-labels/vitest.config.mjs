import { defineConfig } from 'vitest/config'

import { allureReporter } from '../../../src/vitest/allure-reporter.js'

// 結果は、親のテストが REPORT_LABELS_ROOT に渡す一時ディレクトリの下に書く。
export default defineConfig({
  test: {
    include: ['*.fixture.ts'],
    reporters: ['default', ...allureReporter(process.env.REPORT_LABELS_ROOT ?? import.meta.dirname)],
  },
})
