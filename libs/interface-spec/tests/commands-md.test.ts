import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { COMMANDS_MD_PATH, REGENERATE_COMMAND } from '../src/commands-md.js'
import { renderCommandsMd } from '../src/domain/commands-md.js'
import { generatedFileSchema } from '../src/domain/schema.js'
import type { GeneratedFile } from '../src/domain/schema.js'
import { materialize } from './helpers/repository.js'

const GENERATED = 'plugins/pecot-workflow/interface/generated.json'

async function call(...argv: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, {
    stdout: (text) => {
      stdout.push(text)
    },
    stderr: (text) => {
      stderr.push(text)
    },
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

async function fixtureFile(root: string): Promise<GeneratedFile> {
  const text = await readFile(path.join(root, GENERATED), 'utf8')
  return generatedFileSchema.parse(JSON.parse(text))
}

const STALE = `error: ${COMMANDS_MD_PATH} is stale\n  run: ${REGENERATE_COMMAND}\n`

const EXPECTED = [
  '<!-- このファイルは生成物です。手で直さず、`CMD` で作り直してください。 -->',
  '',
  '# コマンド一覧',
  '',
  '引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。',
  '',
  '## issue',
  '',
  '| コマンド | 説明 |',
  '| --- | --- |',
  '| `issue create` | Create an issue |',
  '| `issue old` | Old way to create an issue（非推奨） |',
  '| `issue quick` | Create an issue \\| open \\<branch> at once |',
  '',
  '## pr',
  '',
  '| コマンド | 説明 |',
  '| --- | --- |',
  '| `pr create` | Create a pull request |',
  '',
  '## その他',
  '',
  '| コマンド | 説明 |',
  '| --- | --- |',
  '| `add-to-project` | Add an issue to the board |',
  '| `create-branch` | Create a branch |',
  '',
].join('\n')

describe('commands-md', () => {
  it('グループを名前順に並べ、1 段のパスを最後のその他にまとめて描く', async () => {
    const file = await fixtureFile(await materialize('commands-md'))
    expect(renderCommandsMd(file, 'CMD')).toBe(EXPECTED)
  })

  it('hidden の項目と CLI の面を持たない項目を出さない', async () => {
    const file = await fixtureFile(await materialize('commands-md'))
    const text = renderCommandsMd(file, 'CMD')
    expect(text).not.toContain('internal')
    expect(text).not.toContain('mcp only')
  })

  it('生成物と一致していると、何も出さず 0 で終わる', async () => {
    const root = await materialize('commands-md')
    await call('commands-md', '--write', '--root', root)
    expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('説明を変えると、stale の 2 行を出して 1 で終わる', async () => {
    const root = await materialize('commands-md')
    await call('commands-md', '--write', '--root', root)
    const file = await fixtureFile(root)
    const [first] = file.entries
    if (first === undefined) throw new Error('fixture has no entries')
    first.description = 'Changed'
    await writeFile(path.join(root, GENERATED), JSON.stringify(file))
    expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 1, stdout: '', stderr: STALE })
  })

  it('commands.md が無いと、stale の 2 行を出して 1 で終わる', async () => {
    const root = await materialize('commands-md')
    await rm(path.join(root, COMMANDS_MD_PATH))
    expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 1, stdout: '', stderr: STALE })
  })

  it('--write は書き換えて updated を出し、変わらないときは何も出さず 0 で終わる', async () => {
    const root = await materialize('commands-md')
    await writeFile(path.join(root, COMMANDS_MD_PATH), 'stale\n')
    expect(await call('commands-md', '--write', '--root', root)).toEqual({ code: 0, stdout: `updated: ${COMMANDS_MD_PATH}\n`, stderr: '' })
    expect(await readFile(path.join(root, COMMANDS_MD_PATH), 'utf8')).toBe(EXPECTED.replace('CMD', () => REGENERATE_COMMAND))
    expect(await call('commands-md', '--write', '--root', root)).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it.for([
    { name: '--check と --write の両方', argv: ['commands-md', '--check', '--write'] },
    { name: 'どちらも', argv: ['commands-md'] },
    { name: '知らない引数', argv: ['commands-md', '--check', '--unknown'] },
    { name: '値の無い --root', argv: ['commands-md', '--check', '--root'] },
    { name: 'validate への余分な引数', argv: ['validate', '--check'] },
  ])('$name を渡すと、使い方を出して 2 で終わる', async ({ argv }) => {
    const result = await call(...argv)
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^usage: interface-spec validate .*\n {7}interface-spec links .*\n {7}interface-spec commands-md .*\n {7}interface-spec field-map\n$/u)
  })

  it.for([
    { name: 'generated.json が無い', prepare: async (root: string) => rm(path.join(root, GENERATED)), message: `${GENERATED}: ENOENT` },
    { name: 'generated.json が JSON でない', prepare: async (root: string) => writeFile(path.join(root, GENERATED), '{'), message: `${GENERATED}: is not valid JSON` },
    { name: 'generated.json が形式に合わない', prepare: async (root: string) => writeFile(path.join(root, GENERATED), '{}'), message: `${GENERATED}: does not match the generated file format` },
    {
      name: 'commands.md が読めない',
      prepare: async (root: string) => {
        await rm(path.join(root, COMMANDS_MD_PATH))
        await mkdir(path.join(root, COMMANDS_MD_PATH))
      },
      message: `${COMMANDS_MD_PATH}: EISDIR`,
    },
  ])('$name と、エラーを 1 行出して 2 で終わる', async ({ prepare, message }) => {
    const root = await materialize('commands-md')
    await prepare(root)
    const result = await call('commands-md', '--check', '--root', root)
    expect(result.code).toBe(2)
    expect(result.stderr.replace(root + path.sep, '')).toBe(`error: ${message}\n`)
  })
})
