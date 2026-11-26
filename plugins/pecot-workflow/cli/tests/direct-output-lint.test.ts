// 共通の関数の外の直接の出力を、eslint.config.js が止めることを確かめる。出力の関数を持つ output.ts は lib にある。
// lintText に渡す filePath は実在するファイルにする（実在しないパスは typed lint が Parsing error にする）。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RESTRICTED_PATH = path.join(ROOT, 'src', 'cli.ts')
// 止める側のパスは、src/cli.ts のほかに infra と domain の実在のファイルでも確かめる
const RESTRICTED_PATHS: readonly (readonly [string, string])[] = [
  ['src/cli.ts', RESTRICTED_PATH],
  ['src/infra/worktree.ts', path.join(ROOT, 'src', 'infra', 'worktree.ts')],
  ['src/domain/issue-surface.ts', path.join(ROOT, 'src', 'domain', 'issue-surface.ts')],
]

// 最初の lintText はプロジェクト全体の読み込みで重い。src/tests/lint-rules.test.ts と同じく beforeAll の 1 回に寄せる
const WARM_UP_TIMEOUT_MS = 120_000
const eslint = new ESLint({ cwd: ROOT })

beforeAll(async () => {
  await eslint.lintText('export const warmUp = 1\n', { filePath: RESTRICTED_PATH })
}, WARM_UP_TIMEOUT_MS)

async function ruleIds(code: string, filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  // 構文の誤りや typed lint の失敗は規則の結果ではないので、先に落とす
  expect(messages.filter(message => message.fatal === true)).toEqual([])
  return messages.map(message => message.ruleId ?? '').filter(id => id === 'no-console' || id === 'no-restricted-syntax')
}

describe('直接の出力を止める lint', () => {
  describe.each(RESTRICTED_PATHS)('%s のパス', (name, filePath) => {
    it.each([
      ['console.log("x")', 'no-console'],
      ['process.stderr.write("x")', 'no-restricted-syntax'],
      ['process.stdout.write("x")', 'no-restricted-syntax'],
      ['declare const io: { stderr: { write: (text: string) => void } }\nio.stderr.write("x")', 'no-restricted-syntax'],
    ])('%s を書くと、期待したルールの違反が報告される', async (code, expected) => {
      await explains(`コンソールや標準出力への直接の出力を禁止する lint のテストです。\`${name}\` のファイルに直接の出力を書いたコードを渡した場合は、\`${expected}\` の違反が報告されることを確認します。`)
      expect(await ruleIds(`${code}\n`, filePath)).toContain(expected)
    })
  })

  it('共通の規則（enum 禁止）は src/cli.ts のパスでも止まる', async () => {
    await explains('直接の出力を禁止する lint のテストです。共通の規則である `enum` の禁止が、`src/cli.ts` のファイルでも `no-restricted-syntax` の違反として報告されることを確認します。')
    expect(await ruleIds('enum Color { Red }\n', RESTRICTED_PATH)).toContain('no-restricted-syntax')
  })
})
