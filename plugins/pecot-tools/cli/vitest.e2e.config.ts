import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts', path.resolve(import.meta.dirname, '../../../libs/interface-spec/src/vitest/unique-titles.ts')],
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
})
