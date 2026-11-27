// 共通の関数の外の直接の出力を、eslint.config.js が止めることを確かめる。
// lintText に渡す filePath は実在するファイルにする（実在しないパスは typed lint が Parsing error にする）。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { explains } from './_helpers/explains.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RESTRICTED_PATH = path.join(ROOT, 'src', 'commands-shared', 'board-view.ts')
// 止める側のパスは、commands-shared のほかに infra と domain の実在のファイルでも確かめる
const RESTRICTED_PATHS: readonly (readonly [string, string])[] = [
  ['src/commands-shared/board-view.ts', RESTRICTED_PATH],
  ['src/infra/git.ts', path.join(ROOT, 'src', 'infra', 'git.ts')],
  ['src/domain/format.ts', path.join(ROOT, 'src', 'domain', 'format.ts')],
]
const OUTPUT_PATH = path.join(ROOT, 'src', 'commands-shared', 'output.ts')

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
  describe.each(RESTRICTED_PATHS)('%s のパス', (_name, filePath) => {
    it.each([
      ['console.log("x")', 'no-console'],
      ['process.stderr.write("x")', 'no-restricted-syntax'],
      ['process.stdout.write("x")', 'no-restricted-syntax'],
      ['declare const io: { stderr: { write: (text: string) => void } }\nio.stderr.write("x")', 'no-restricted-syntax'],
    ])('ファイルに %s を書くと、lint の違反になる', async (code, expected) => {
      await explains(`直接の出力を止める lint のテストです。\`console.log\` や \`process.stderr.write\` などで直接出力するコードを書いた場合に、\`${expected}\` の違反が検出されることを確認します。`)
      expect(await ruleIds(`${code}\n`, filePath)).toContain(expected)
    })
  })

  it.each([
    'console.log("x")',
    'process.stderr.write("x")',
    'declare const io: { stderr: { write: (text: string) => void } }\nio.stderr.write("x")',
  ])('%s を書いても、src/commands-shared/output.ts では lint の違反にならない', async (code) => {
    await explains('直接の出力を止める lint のテストです。共通の出力関数を置く `src/commands-shared/output.ts` では、直接出力しても違反が検出されないことを確認します。')
    expect(await ruleIds(`${code}\n`, OUTPUT_PATH)).toEqual([])
  })

  it('enum を書くと、commands-shared のファイルでも共通の規則で lint の違反になる', async () => {
    await explains('共通の規則のテストです。`commands-shared` のファイルで `enum` を宣言した場合に、`no-restricted-syntax` の違反が検出されることを確認します。')
    expect(await ruleIds('enum Color { Red }\n', RESTRICTED_PATH)).toContain('no-restricted-syntax')
  })
})
