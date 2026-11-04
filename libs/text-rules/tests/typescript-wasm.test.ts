import type * as NodeModule from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { buildDescriptor } from '../lib/descriptor.js'
import { main } from '../lib/main.js'
import { typescriptStrings } from '../lib/plugins/typescript.js'

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
  it('解決はモジュールの読み込みでなく、最初の解析で行い、失敗は呼び出し側へ返す', async () => {
    await expect(typescriptStrings('typescript')('const a = 1\n')).rejects.toThrow('wasm の置き場を解決できません')
  })

  it('解決に失敗したら、違反ありの 1 ではなく実行失敗の 2 を返す', async () => {
    const stderr: string[] = []
    const code = await main(['a.ts'], {
      descriptor: buildDescriptor,
      readFile: () => Promise.resolve('const a = 1\n'),
      stdout: vi.fn(),
      stderr: (text) => {
        stderr.push(text)
      },
    })
    expect(code).toBe(2)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toMatch(/^pecot-text-lint: a\.ts: .*wasm の置き場を解決できません.*\n$/)
  })
})
