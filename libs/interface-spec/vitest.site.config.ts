import { defineConfig } from 'vitest/config'

// test-site のレーン。ビルドした定義書のサイトを Chromium で開き、見た目の崩れを測る。
export default defineConfig({
  test: {
    include: ['tests/site/**/*.test.ts'],
    setupFiles: ['src/vitest/unique-titles.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
})
