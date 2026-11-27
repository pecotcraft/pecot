import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

const require = createRequire(import.meta.url)

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function webTreeSitterVersion(packageJson: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 自身と依存の package.json を読む
  const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'))
  return isRecord(parsed) && isRecord(parsed['dependencies']) ? parsed['dependencies']['web-tree-sitter'] : undefined
}

describe('web-tree-sitter のバージョン', () => {
  // 片方だけを上げると、同梱の wasm の文法が読めなくなる。上げるときは、2 つを同時に更新する。
  it('web-tree-sitter のバージョンを、comments plugin と同じ値に固定している', async () => {
    await explains('`web-tree-sitter` の依存のバージョンのテストです。text-rules の `package.json` の値が、comments plugin の値と同じ文字列であることを確認します。')
    const own = stepSync('自身の package.json を読む', () => webTreeSitterVersion(require.resolve('../package.json')))
    const comments = stepSync('comments plugin の package.json を読む', () => webTreeSitterVersion(require.resolve('@cffnpwr/textlint-plugin-comments/package.json')))
    stepSync('バージョンを比べる', () => {
      expect(typeof own).toBe('string')
      expect(own).toBe(comments)
    })
  })
})
