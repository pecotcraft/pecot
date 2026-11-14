// `pecot <グループ> ...` の案内の文字列を、eslint.config.js が src で止めることを確かめる。
// lintText に渡す filePath は実在するファイルにする（実在しないパスは typed lint が Parsing error にする）。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { COMMAND_GROUPS } from '../src/commands/names.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const FIRST_PATH = path.join(ROOT, 'src', 'commands', 'project.ts')
const PATHS: readonly (readonly [string, string])[] = [
  ['src/commands/project.ts', FIRST_PATH],
  ['src/commands/output.ts', path.join(ROOT, 'src', 'commands', 'output.ts')],
  ['src/infra/worktree.ts', path.join(ROOT, 'src', 'infra', 'worktree.ts')],
  ['src/domain/work-start.ts', path.join(ROOT, 'src', 'domain', 'work-start.ts')],
]
const TEST_PATH = path.join(ROOT, 'src', 'commands', 'tests', 'command-hint.test.ts')

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
    ])('%s の案内は止まる', async (_kind, code) => {
      expect(await hintMessages(code, filePath)).toHaveLength(1)
    })
  })

  it.each(COMMAND_GROUPS.map(group => group.name))('グループ %s の案内は止まる', async (group) => {
    expect(await hintMessages(`export const text = 'pecot ${group} x'\n`, FIRST_PATH)).toHaveLength(1)
  })

  it.each([
    ['グループでない語', 'export const text = \'pecot projects are listed\'\n'],
    ['グループの語で終わる文', 'export const text = \'not registered in the active pecot project\\nto add it to the pecot project:\'\n'],
    ['コメントの中', '// pecot project init を案内する\nexport const text = 1\n'],
    ['.pecot のパス', 'export const text = \'.pecot/work\'\n'],
  ])('%s は止まらない', async (_kind, code) => {
    expect(await hintMessages(code, FIRST_PATH)).toEqual([])
  })

  it('テストのファイルでは止まらない', async () => {
    expect(await hintMessages('export const text = \'pecot project init\'\n', TEST_PATH)).toEqual([])
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
    ])('%s のフラグ名は止まる', async (_kind, code) => {
      expect(await flagMessages(code, filePath)).toHaveLength(1)
    })
  })

  it.each([
    ['.describe() の help の文', 'declare const schema: { describe: (text: string) => unknown }\nschema.describe(\'Reason (required with --wait merge)\')\n'],
    ['空白の無い git の引数', 'declare function git(...args: readonly string[]): void\ngit(\'--porcelain\')\n'],
    ['呼び出しの外の定数', 'export const text = \'pass --repo to fix\'\n'],
    ['短いオプション', 'declare function stop(text: string): void\nstop(\'check it with: git remote -v\')\n'],
    ['コメントの中', '// --repo を案内する\nexport const text = 1\n'],
  ])('%s は止まらない', async (_kind, code) => {
    expect(await flagMessages(code)).toEqual([])
  })
})
