import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { COMMANDS_MD_PATH, REGENERATE_COMMAND } from '../src/commands-md.js'
import { renderCommandsMd } from '../src/domain/commands-md.js'
import { generatedFileSchema } from '../src/domain/schema.js'
import type { GeneratedFile } from '../src/domain/schema.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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
  it('コマンドをグループの名前順に並べ、パスが 1 段のものを最後の「その他」にまとめて出力する', async () => {
    await explains('定義書から `commands.md` の本文を作成する `renderCommandsMd` のテストです。コマンドがグループの名前順に並び、パスが 1 段のコマンドが最後の「その他」の表にまとまることを確認します。')
    const file = await step('定義を読み込む', async () => await fixtureFile(await materialize('commands-md')))
    stepSync('描いた文書を比べる', () => {
      expect(renderCommandsMd(file, 'CMD')).toBe(EXPECTED)
    })
  })

  it('非表示にした項目と CLI を持たない項目を、commands.md に出力しない', async () => {
    await explains('定義書から `commands.md` の本文を作成する `renderCommandsMd` のテストです。`hidden` の項目と、CLI の面を持たず MCP だけの項目が、出力に含まれないことを確認します。')
    const file = await step('定義を読み込む', async () => await fixtureFile(await materialize('commands-md')))
    const text = stepSync('文書を描く', () => renderCommandsMd(file, 'CMD'))
    stepSync('文書を比べる', () => {
      expect(text).not.toContain('internal')
      expect(text).not.toContain('mcp only')
    })
  })

  it('commands.md が定義書から作成した内容と一致していると、何も出力せず 0 で終了する', async () => {
    await explains('`interface-spec commands-md --check` コマンドのテストです。`--write` で作成した `commands.md` に対して `--check` を実行した場合、何も出力せず、終了コード 0 で終了することを確認します。')
    const root = await materialize('commands-md')
    await step('commands.md を書く', async () => {
      await call('commands-md', '--write', '--root', root)
    })
    await step('確認を動かし、出力を比べる', async () => {
      expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 0, stdout: '', stderr: '' })
    })
  })

  it('定義書の説明を変えると、stale の 2 行を出力し、1 で終了する', async () => {
    await explains('`interface-spec commands-md --check` コマンドのテストです。`generated.json` の説明を変更した場合に、`commands.md` が古いことを示す 2 行を標準エラーへ出力し、終了コード 1 で終了することを確認します。')
    const root = await materialize('commands-md')
    await step('commands.md を書く', async () => {
      await call('commands-md', '--write', '--root', root)
    })
    const file = await step('定義を読み込む', () => fixtureFile(root))
    const [first] = file.entries
    if (first === undefined) throw new Error('fixture has no entries')
    first.description = 'Changed'
    await step('説明を変えた定義を書く', async () => {
      await writeFile(path.join(root, GENERATED), JSON.stringify(file))
    })
    await step('確認を動かし、出力を比べる', async () => {
      expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 1, stdout: '', stderr: STALE })
    })
  })

  it('commands.md が存在しないと、stale の 2 行を出力し、1 で終了する', async () => {
    await explains('`interface-spec commands-md --check` コマンドのテストです。`commands.md` を削除した場合に、`commands.md` が古いことを示す 2 行を標準エラーへ出力し、終了コード 1 で終了することを確認します。')
    const root = await materialize('commands-md')
    await step('commands.md を消す', async () => {
      await rm(path.join(root, COMMANDS_MD_PATH))
    })
    await step('確認を動かし、出力を比べる', async () => {
      expect(await call('commands-md', '--check', '--root', root)).toEqual({ code: 1, stdout: '', stderr: STALE })
    })
  })

  it('commands-md --write は、内容が変わると updated を出力し、変わらないと何も出力せず 0 で終了する', async () => {
    await explains('`interface-spec commands-md --write` コマンドのテストです。古い内容の `commands.md` を更新した場合に `updated:` の行を出力し、2 回目の実行では何も出力せず、どちらも終了コード 0 で終了することを確認します。')
    const root = await materialize('commands-md')
    await step('古い commands.md を置く', async () => {
      await writeFile(path.join(root, COMMANDS_MD_PATH), 'stale\n')
    })
    await step('--write を動かし、出力を比べる', async () => {
      expect(await call('commands-md', '--write', '--root', root)).toEqual({ code: 0, stdout: `updated: ${COMMANDS_MD_PATH}\n`, stderr: '' })
    })
    await step('書いた内容を比べる', async () => {
      expect(await readFile(path.join(root, COMMANDS_MD_PATH), 'utf8')).toBe(EXPECTED.replace('CMD', () => REGENERATE_COMMAND))
    })
    await step('--write をもう一度動かし、出力を比べる', async () => {
      expect(await call('commands-md', '--write', '--root', root)).toEqual({ code: 0, stdout: '', stderr: '' })
    })
  })

  it.for([
    { name: '--check と --write の両方', argv: ['commands-md', '--check', '--write'] },
    { name: 'どちらも', argv: ['commands-md'] },
    { name: '知らない引数', argv: ['commands-md', '--check', '--unknown'] },
    { name: '値の無い --root', argv: ['commands-md', '--check', '--root'] },
    { name: 'validate への余分な引数', argv: ['validate', '--check'] },
  ])('commands-md に $name を渡すと、使い方を出力し、2 で終了する', async ({ name, argv }) => {
    await explains(`\`interface-spec commands-md\` コマンドの引数の検証のテストです。\`${name}\` を渡した場合に、使い方を標準エラーへ出力し、終了コード 2 で終了することを確認します。`)
    const result = await step('CLI を動かす', () => call(...argv))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/^usage: interface-spec validate .*\n {7}interface-spec links .*\n {7}interface-spec commands-md .*\n {7}interface-spec field-map\n$/u)
    })
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
  ])('$name と、エラーを 1 行出力し、2 で終了する', async ({ name, prepare, message }) => {
    await explains(`\`interface-spec commands-md --check\` コマンドのテストです。入力のファイルが「${name}」状態の場合に、原因を示すエラーを標準エラーへ 1 行出力し、終了コード 2 で終了することを確認します。`)
    const root = await materialize('commands-md')
    await step('失敗する状態を用意する', async () => {
      await prepare(root)
    })
    const result = await step('確認を動かす', () => call('commands-md', '--check', '--root', root))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(2)
      expect(result.stderr.replace(root + path.sep, '')).toBe(`error: ${message}\n`)
    })
  })
})
