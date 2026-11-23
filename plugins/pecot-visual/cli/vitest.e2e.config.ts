import { availableParallelism } from 'node:os'
import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from '../../../libs/interface-spec/src/vitest/allure-reporter.js'

// E2E 専用。testTimeout 660_000 は runPecotv の spawnSync 600_000 より長くし、差分の情報を残す（#506・#1097）。
// maxWorkers 6 は #1084 の計測で、これより増やしても縮まない最小の数。pool: 'forks' は Chromium の native binding の hang を避ける。
export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(path.resolve(import.meta.dirname, '..')),
    ],
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts', path.resolve(import.meta.dirname, '../../../libs/interface-spec/src/vitest/unique-titles.ts')],
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 660_000,
    pool: 'forks',
    maxWorkers: Math.min(6, availableParallelism()),
    isolate: true,
  },
})
