import { describe, expect, it } from 'vitest'

// 確認用。CI の作業ディレクトリ（/workspaces/base/）でだけ落とす。
describe('確認用', () => {
  it('CI の中では落ちる', () => {
    expect(process.cwd()).not.toContain('/workspaces/base/')
  })
})
