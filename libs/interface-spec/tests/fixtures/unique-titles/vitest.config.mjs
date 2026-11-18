import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.fixture.ts'],
    setupFiles: [path.resolve(import.meta.dirname, '../../../src/vitest/unique-titles.ts')],
  },
})
