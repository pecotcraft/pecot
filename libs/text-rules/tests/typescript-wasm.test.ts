import type * as NodeModule from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { buildDescriptor } from '../lib/descriptor.js'
import { main } from '../lib/main.js'
import type { IgnoreCheck, MainDependencies } from '../lib/main.js'
import { typescriptStrings } from '../lib/plugins/typescript.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

// wasm の置き場を解決できない環境を、comments plugin の package.json の解決だけを失敗させて作る。
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>()
  const createRequire = (url: string): NodeJS.Require => {
    const real = actual.createRequire(url)
    const resolve = (id: string): string => {
      if (id.includes('textlint-plugin-comments/package.json')) {
        throw new Error('wasm の置き場を解決できません')
      }
      return real.resolve(id)
    }
    return Object.assign(real, { resolve: Object.assign(resolve, { paths: (request: string) => real.resolve.paths(request) }) })
  }
  return Object.assign({}, actual, { createRequire })
})

describe('typescript plugin: wasm の置き場の解決', () => {
  it('wasm の置き場の解決は、最初の解析で行い、失敗を呼び出し側へ例外として返す', async () => {
    await explains('TypeScript の文字列を取り出す plugin が、wasm ファイルの置き場を解決する処理のテストです。解決に失敗する環境で最初の解析を呼んだ場合に、モジュールの読み込みでは失敗せず、解析が例外で失敗することを確認します。')
    await step('wasm の解決に失敗する解析を動かし、失敗を比べる', async () => {
      await expect(typescriptStrings('typescript')('const a = 1\n')).rejects.toThrow('wasm の置き場を解決できません')
    })
  })

  it('wasm の置き場を解決できないと、違反ありの 1 ではなく、実行失敗の 2 を返す', async () => {
    await explains('`pecot-text-lint` の `main` のテストです。wasm の置き場の解決に失敗する環境で `.ts` ファイルを渡した場合に、エラーメッセージを標準エラーへ 1 件出力し、終了コード 2 を返すことを確認します。')
    const stderr: string[] = []
    const code = await step('規則にかける', () => main(['a.ts'], {
      descriptor: buildDescriptor,
      readFile: () => Promise.resolve('const a = 1\n'),
      ignoreCheck: vi.fn<MainDependencies['ignoreCheck']>().mockResolvedValue(vi.fn<IgnoreCheck>().mockResolvedValue(false)),
      stdout: vi.fn(),
      stderr: (text) => {
        stderr.push(text)
      },
    }))
    stepSync('結果を比べる', () => {
      expect(code).toBe(2)
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toMatch(/^pecot-text-lint: a\.ts: .*wasm の置き場を解決できません.*\n$/)
    })
  })
})
