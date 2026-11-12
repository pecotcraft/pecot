import { configDefaults, defineConfig } from 'vitest/config'

import { readBaseline } from './tests/parity/baseline.js'

// include / exclude は各 project にだけ書く。
// root に書くと、インラインの project が継承して配列を連結するため。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'cli',
          include: ['src/**/tests/**/*.test.ts', 'tests/*.test.ts', 'tests/output/**/*.test.ts', 'tests/parity/**/*.test.ts', 'tests/fake-github/**/*.test.ts', 'tests/interface/**/*.test.ts', 'tests/mcp/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**'],
        },
      },
      {
        test: {
          name: 'hooks',
          include: ['tests/hooks/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**'],
          // 子の shell を起動するので長めにする。$key の題を 40 字で切らない（JUnit の name を重ねないため）。
          testTimeout: 30_000,
          setupFiles: ['tests/hooks/_helpers/setup.ts'],
          taskTitleValueFormatTruncate: 0,
        },
      },
    ],
    reporters: [...configDefaults.reporters, 'junit'],
    outputFile: { junit: 'test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/tests/**'],
      // 行カバレッジは移行前の Python の CLI の値を下回らせない。他の閾値は pecot-tools と同じ 90。
      thresholds: { lines: Math.max(readBaseline().cli.lineCoverage, 90), branches: 90, functions: 90, statements: 90 },
    },
  },
})
