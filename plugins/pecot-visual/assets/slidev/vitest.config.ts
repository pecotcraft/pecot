import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

import { allureReporter } from '../../../../libs/interface-spec/src/vitest/allure-reporter.js'

const testDirectories = [
  'scripts/eslint/2layer/tests',
  'scripts/eslint/asset-path/tests',
  'scripts/eslint/pptx-compat/tests',
  'scripts/eslint/_shared/tests',
  'scripts/eslint/slidev-pages-lint/tests',
  'scripts/eslint/text-constraints/tests',
  'scripts/eslint/validate-references/tests',
  'scripts/design-lint/tests',
]

export default defineConfig({
  resolve: {
    // dist の JS は source map を持たず、coverage が ts に戻らない。テストからは ts を読む。
    alias: { '@v-slidev/eslint-shared': path.resolve(import.meta.dirname, 'scripts/eslint/_shared/index.ts') },
  },
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(path.resolve(import.meta.dirname, '../..')),
    ],
    include: testDirectories.map(directory => `${directory}/**/*.test.ts`),
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [
      path.resolve(import.meta.dirname, '../../../../libs/interface-spec/src/vitest/unique-titles.ts'),
      path.resolve(import.meta.dirname, 'vitest.setup.ts'),
    ],
    // 子プロセスや実際の ESLint を起動するテストがある。cli の設定と同じ上限にする。
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // validate-references の cli.test.ts が index.ts を子プロセスで動かす。c8 と同じく子プロセスも測る。
      autoAttachSubprocess: true,
      reporter: ['text', 'text-summary', 'lcov'],
      include: [
        'scripts/design-lint/**/*.ts',
        'scripts/eslint/2layer/**/*.ts',
        'scripts/eslint/asset-path/**/*.ts',
        'scripts/eslint/pptx-compat/**/*.ts',
        'scripts/eslint/_shared/**/*.ts',
        'scripts/eslint/slidev-pages-lint/**/*.ts',
        'scripts/eslint/text-constraints/**/*.ts',
        'scripts/eslint/validate-references/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/dist/**', '**/node_modules/**'],
      thresholds: {
        lines: 63,
        branches: 83,
        functions: 85,
        statements: 63,
      },
    },
  },
})
