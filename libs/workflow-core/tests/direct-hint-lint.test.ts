// `pecot <グループ> ...` の案内の文字列を、eslint.config.js が src で止めることを確かめる。
// lintText に渡す filePath は実在するファイルにする（実在しないパスは typed lint が Parsing error にする）。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { COMMAND_GROUPS } from '../src/commands-shared/names.js'
import { step } from './_helpers/step.js'
import { explains } from './_helpers/explains.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const FIRST_PATH = path.join(ROOT, 'src', 'commands-shared', 'board-view.ts')
const PATHS: readonly (readonly [string, string])[] = [
  ['src/commands-shared/board-view.ts', FIRST_PATH],
  ['src/commands-shared/output.ts', path.join(ROOT, 'src', 'commands-shared', 'output.ts')],
  ['src/infra/git.ts', path.join(ROOT, 'src', 'infra', 'git.ts')],
  ['src/domain/work-start.ts', path.join(ROOT, 'src', 'domain', 'work-start.ts')],
]
const TEST_PATH = path.join(ROOT, 'src', 'commands-shared', 'tests', 'command-hint.test.ts')

// 最初の lintText はプロジェクト全体の読み込みで重い。direct-output-lint.test.ts と同じく beforeAll の 1 回に寄せる
const WARM_UP_TIMEOUT_MS = 120_000
const eslint = new ESLint({ cwd: ROOT })

beforeAll(async () => {
  await eslint.lintText('export const warmUp = 1\n', { filePath: FIRST_PATH })
}, WARM_UP_TIMEOUT_MS)

async function hintMessages(code: string, filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  expect(messages.filter(message => message.fatal === true)).toEqual([])
  return messages.filter(message => message.ruleId === 'no-restricted-syntax' && message.message.startsWith('コマンドの案内を')).map(message => message.message)
}

async function flagMessages(code: string, filePath = FIRST_PATH): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  expect(messages.filter(message => message.fatal === true)).toEqual([])
  return messages.filter(message => message.ruleId === 'no-restricted-syntax' && message.message.startsWith('フラグ名を')).map(message => message.message)
}

describe('案内の文字列を止める lint', () => {
  describe.each(PATHS)('%s のパス', (_name, filePath) => {
    it.each([
      ['文字列', 'export const text = \'run: pecot project init\'\n'],
      ['テンプレートの固定部分', 'declare const name: string\nexport const text = `run pecot issue block ${name} to fix`\n'],
    ])('%s に pecot のコマンドの案内を書くと、lint の違反になる', async (_kind, code) => {
      await explains('コマンドの案内の文字列を止める lint のテストです。`src` の実在のファイルで、文字列とテンプレートの固定部分に `pecot project init` のような案内を書いた場合に、違反が 1 件検出されることを確認します。')
      await step('結果を確認する', async () => {
        expect(await hintMessages(code, filePath)).toHaveLength(1)
      })
    })
  })

  it.each(COMMAND_GROUPS.map(group => group.name))('グループ %s の案内を書くと、lint の違反になる', async (group) => {
    await explains('コマンドの案内の文字列を止める lint のテストです。`pecot` の後ろにコマンドのグループ名（`project` や `issue` など）を書いた場合に、グループごとに違反が 1 件検出されることを確認します。')
    await step('結果を確認する', async () => {
      expect(await hintMessages(`export const text = 'pecot ${group} x'\n`, FIRST_PATH)).toHaveLength(1)
    })
  })

  it.each([
    ['グループでない語', 'export const text = \'pecot projects are listed\'\n'],
    ['グループの語で終わる文', 'export const text = \'not registered in the active pecot project\\nto add it to the pecot project:\'\n'],
    ['コメントの中', '// pecot project init を案内する\nexport const text = 1\n'],
    ['.pecot のパス', 'export const text = \'.pecot/work\'\n'],
  ])('案内に当たらない書き方（%s）は、lint の違反にならない', async (_kind, code) => {
    await explains('コマンドの案内の文字列を止める lint のテストです。案内ではない文字列（`pecot projects are listed` や `.pecot/work` など）やコメントの中の記述の場合に、違反が検出されないことを確認します。')
    await step('結果を確認する', async () => {
      expect(await hintMessages(code, FIRST_PATH)).toEqual([])
    })
  })

  it('テストのファイルでは、案内を書いても lint の違反にならない', async () => {
    await explains('コマンドの案内の文字列を止める lint のテストです。テストのファイルに `pecot project init` を書いた場合に、違反が検出されないことを確認します。')
    await step('結果を確認する', async () => {
      expect(await hintMessages('export const text = \'pecot project init\'\n', TEST_PATH)).toEqual([])
    })
  })
})

describe('フラグ名の文字列を止める lint', () => {
  describe.each(PATHS)('%s のパス', (_name, filePath) => {
    it.each([
      ['呼び出しの引数の文字列', 'declare function stop(text: string): void\nstop(\'--reason is required with --wait merge\')\n'],
      ['new の引数の文字列', 'throw new Error(\'pass --repo to fix\')\n'],
      ['引数のテンプレートの固定部分', 'declare function stop(text: string): void\ndeclare const name: string\nstop(`invalid --repo format: ${name}`)\n'],
      ['引数の三項演算子の文字列', 'declare function stop(text: string): void\ndeclare const flag: boolean\nstop(flag ? \'pass --repo to fix\' : \'use the full form\')\n'],
      ['引数の連結の文字列', 'declare function stop(text: string): void\ndeclare const name: string\nstop(`branch ${name} exists: ` + \'pass --allow-existing-branch to reuse it\')\n'],
      ['引数の null 合体演算子の右側の文字列', 'declare function stop(text: string): void\ndeclare const text: string | undefined\nstop(text ?? \'pass --repo to fix\')\n'],
      ['引数の null 合体演算子の右側のテンプレート', 'declare function stop(text: string): void\ndeclare const text: string | undefined\ndeclare const name: string\nstop(text ?? `pass --repo ${name}`)\n'],
      ['テンプレートの中の三項演算子の文字列', 'declare function stop(text: string): void\ndeclare const flag: boolean\nstop(`run it again${flag ? \' with --force\' : \'\'}`)\n'],
      ['テンプレートの中の三項演算子のテンプレート', 'declare function stop(text: string): void\ndeclare const flag: boolean\ndeclare const name: string\nstop(`run it again${flag ? ` with --force ${name}` : \'\'}`)\n'],
    ])('%s にフラグ名を書くと、lint の違反になる', async (_kind, code) => {
      await explains('フラグ名の文字列を止める lint のテストです。関数の呼び出しの引数などに、`--repo` のようなフラグ名を含む案内を書いた場合に、違反が 1 件検出されることを確認します。')
      await step('結果を確認する', async () => {
        expect(await flagMessages(code, filePath)).toHaveLength(1)
      })
    })
  })

  it.each([
    ['.describe() の help の文', 'declare const schema: { describe: (text: string) => unknown }\nschema.describe(\'Reason (required with --wait merge)\')\n'],
    ['空白の無い git の引数', 'declare function git(...args: readonly string[]): void\ngit(\'--porcelain\')\n'],
    ['呼び出しの外の定数', 'export const text = \'pass --repo to fix\'\n'],
    ['null 合体演算子の左側の文字列', 'declare function stop(text: string | undefined): void\ndeclare const text: string\nstop(\'pass --repo to fix\' ?? text)\n'],
    ['return の文', 'export function text(): string {\n  return \'pass --repo to fix\'\n}\n'],
    ['短いオプション', 'declare function stop(text: string): void\nstop(\'check it with: git remote -v\')\n'],
    ['コメントの中', '// --repo を案内する\nexport const text = 1\n'],
  ])('フラグ名の検出に当たらない書き方（%s）は、lint の違反にならない', async (_kind, code) => {
    await explains('フラグ名の文字列を止める lint のテストです。`.describe()` の説明文や `return` の文など、止める対象ではない書き方の場合に、違反が検出されないことを確認します。')
    await step('結果を確認する', async () => {
      expect(await flagMessages(code)).toEqual([])
    })
  })
})
