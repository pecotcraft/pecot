import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../vitest.config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// vitest 5 は coverage.include が 1 ファイルにも当たらないと、閾値を確認せずに成功する。
// include の各 glob が 1 ファイル以上に当たることを固定し、閾値の確認が空振りする状態を防ぐ。
describe('coverage.include', () => {
  const include = config.test?.coverage?.include ?? []

  it('glob を 1 つ以上宣言している', () => {
    expect(include.length).toBeGreaterThan(0)
  })

  it.each(include)('%s は実在するファイルに当たる', (pattern) => {
    const matches = globSync(pattern, { cwd: root, exclude: name => name === 'node_modules' || name === 'dist' })
    expect(matches.length).toBeGreaterThan(0)
  })
})
