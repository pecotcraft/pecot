// 共通の関数の外の直接の出力を、eslint.config.js が止めることを確かめる。
// lintText に渡す filePath は実在するファイルにする（実在しないパスは typed lint が Parsing error にする）。
import path from 'node:path'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const RESTRICTED_PATH = path.join(ROOT, 'src', 'cli.ts')
// 止める側のパスは、src/cli.ts のほかに infra と domain の実在のファイルでも確かめる
const RESTRICTED_PATHS: readonly (readonly [string, string])[] = [
  ['src/cli.ts', RESTRICTED_PATH],
  ['src/infra/worktree.ts', path.join(ROOT, 'src', 'infra', 'worktree.ts')],
  ['src/domain/format.ts', path.join(ROOT, 'src', 'domain', 'format.ts')],
]
const OUTPUT_PATH = path.join(ROOT, 'src', 'commands', 'output.ts')

async function ruleIds(code: string, filePath: string): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: ROOT })
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  // 構文の誤りや typed lint の失敗は規則の結果ではないので、先に落とす
  expect(messages.filter(message => message.fatal === true)).toEqual([])
  return messages.map(message => message.ruleId ?? '').filter(id => id === 'no-console' || id === 'no-restricted-syntax')
}

describe('直接の出力を止める lint', () => {
  describe.each(RESTRICTED_PATHS)('%s のパス', (_name, filePath) => {
    it.each([
      ['console.log("x")', 'no-console'],
      ['process.stderr.write("x")', 'no-restricted-syntax'],
      ['process.stdout.write("x")', 'no-restricted-syntax'],
      ['declare const io: { stderr: { write: (text: string) => void } }\nio.stderr.write("x")', 'no-restricted-syntax'],
    ])('%s は止まる', async (code, expected) => {
      expect(await ruleIds(`${code}\n`, filePath)).toContain(expected)
    })
  })

  it.each([
    'console.log("x")',
    'process.stderr.write("x")',
    'declare const io: { stderr: { write: (text: string) => void } }\nio.stderr.write("x")',
  ])('%s は src/commands/output.ts のパスでは止まらない', async (code) => {
    expect(await ruleIds(`${code}\n`, OUTPUT_PATH)).toEqual([])
  })

  it('共通の規則（enum 禁止）は src/cli.ts のパスでも止まる', async () => {
    expect(await ruleIds('enum Color { Red }\n', RESTRICTED_PATH)).toContain('no-restricted-syntax')
  })
})
