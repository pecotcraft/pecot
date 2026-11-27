import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../vitest.config.js'
import { stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// vitest 5 は coverage.include が 1 ファイルにも当たらないと、閾値を確認せずに成功する。
// include の各 glob が 1 ファイル以上に当たることを固定し、閾値の確認が空振りする状態を防ぐ。
describe('coverage.include', () => {
  const include = config.test?.coverage?.include ?? []

  it('coverage.include に glob が 1 つ以上含まれている', async () => {
    await explains('vitest の `coverage.include` の設定のテストです。`include` に glob が 1 つ以上含まれていることを確認します。')
    stepSync('coverage.include の glob 数を比べる', () => {
      expect(include.length).toBeGreaterThan(0)
    })
  })

  it.each(include)('coverage.include の %s は、実在するファイルに一致する', async (pattern) => {
    await explains(`vitest の \`coverage.include\` の設定のテストです。glob \`${pattern}\` が、1 つ以上の実在するファイルに一致することを確認します。`)
    const matches = stepSync('glob を展開する', () => globSync(pattern, { cwd: root, exclude: name => name === 'node_modules' || name === 'dist' }))
    stepSync('当たったファイル数を比べる', () => {
      expect(matches.length).toBeGreaterThan(0)
    })
  })
})
