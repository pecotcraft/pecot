import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts'],
    include: [
      'src/**/tests/**/*.test.ts',
      'tests/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: [
      'tests/e2e/**',
      'node_modules/**',
      'dist/**',
    ],
    // per-test 上限。個別 test の最遅は、実 eslint を起動する tests/integration/commands/slide-lint.test.ts の 1 件。
    // coverage 有効時の計測は 1.0s。
    // 60s はそこから 2 桁分の余裕があり、遅マシンでの flake を招かずに hang を捕捉できる。
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/tests/**'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
