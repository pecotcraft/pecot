import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { attachOutput } from '../src/vitest/attach.js'
import { defaultRoot, run } from '../src/cli.js'
import { BORROWED_MAP, POSIX_MAP } from '../src/domain/field-map.js'
import process from 'node:process'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const exec = promisify(execFile)
const PROJECT = path.join(import.meta.dirname, '..')
// nx が入れる FORCE_COLOR が子プロセスの stderr に色や警告を混ぜないようにする。
const CHILD_ENV = { ...process.env, FORCE_COLOR: undefined }

// 子プロセスの失敗（終了コード 1）を値で受け、出力を添付してから確かめられるようにする。
async function failureOf(child: Promise<unknown>): Promise<unknown> {
  try {
    await child
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && 'stdout' in error && 'stderr' in error && typeof error.stdout === 'string' && typeof error.stderr === 'string') {
      attachOutput('pnpm exec tsx src/cli.ts validate', typeof error.code === 'number' ? error.code : undefined, error.stdout, error.stderr)
    }
    return error
  }
  return undefined
}

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

describe('validate', () => {
  it('定義書が正しいリポジトリを validate すると、何も出力せず 0 で終了する', async () => {
    await explains('`interface-spec validate` コマンドのテストです。定義書が正しいリポジトリを指定した場合に、標準出力と標準エラーのどちらにも何も出力せず、終了コード 0 で終了することを確認します。')
    await step('正しいリポジトリを検証し、出力を比べる', async () => {
      expect(await call('validate', '--root', await materialize('valid'))).toEqual({ code: 0, stdout: '', stderr: '' })
    })
  })

  it('検証エラーがあると、1 件ごとに 1 行を標準エラーに出力し、1 で終了する', async () => {
    await explains('`interface-spec validate` コマンドのテストです。定義書に検証エラーが 2 件ある場合に、エラーを 1 件ごとに 1 行で標準エラーへ出力し、終了コード 1 で終了することを確認します。')
    await step('失敗のあるリポジトリを検証し、出力を比べる', async () => {
      expect(await call('validate', '--root', await materialize('language'))).toEqual({
        code: 1,
        stdout: '',
        stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)\n'
          + 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)\n',
      })
    })
  })

  it('--root を省略すると、既定の root がこのリポジトリの root になる', async () => {
    await explains('`defaultRoot` が返す、`--root` を省略したときの root のテストです。返された root の下に `libs/interface-spec/targets.json` が存在することを確認します。')
    const targets = stepSync('既定の root から targets.json の場所を求める', () => path.join(defaultRoot(), 'libs/interface-spec/targets.json'))
    stepSync('ファイルの有無を比べる', () => {
      expect(existsSync(targets)).toBe(true)
    })
  })

  it('root が git リポジトリでないと、エラーを 1 行出力し、2 で終了する', async () => {
    await explains('`interface-spec validate` コマンドのテストです。`--root` に git リポジトリでないディレクトリを指定した場合に、`git ls-files` の失敗を示すエラーを 1 行出力し、終了コード 2 で終了することを確認します。')
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    const fixture = path.join(PROJECT, 'tests', 'fixtures', 'valid')
    await step('git でない root を検証し、出力を比べる', async () => {
      try {
        await cp(fixture, root, { recursive: true })
        expect(await call('validate', '--root', root)).toEqual({
          code: 2,
          stdout: '',
          stderr: `error: ${root}: git ls-files failed (is it a git repository?)\n`,
        })
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  it('定義書がディレクトリで読み取れないと、エラーを 1 行出力し、2 で終了する', async () => {
    await explains('`interface-spec validate` コマンドのテストです。`authored.yaml` がファイルでなくディレクトリになっている場合に、`EISDIR` のエラーを 1 行出力し、終了コード 2 で終了することを確認します。')
    const root = await materialize('valid')
    const authored = path.join(root, 'plugins/pecot-workflow/interface/authored.yaml')
    await step('authored.yaml をディレクトリに置き換える', async () => {
      await rm(authored)
      await mkdir(authored)
    })
    await step('検証を動かし、出力を比べる', async () => {
      expect(await call('validate', '--root', root)).toEqual({ code: 2, stdout: '', stderr: `error: ${authored}: EISDIR\n` })
    })
  })

  it.each([
    [[]],
    [['other']],
    [['validate', '--root']],
    [['validate', '--bogus', 'x']],
    [['validate', '--root', 'a', 'b']],
    [['field-map', 'x']],
  ])('引数 %j を渡すと、使い方を出力し、2 で終了する', async (argv) => {
    await explains(`\`interface-spec\` コマンドの引数の検証のテストです。引数が \`${JSON.stringify(argv)}\` の場合に、使い方を標準エラーへ出力し、終了コード 2 で終了することを確認します。`)
    await step('使い方を出すコマンドを動かし、出力を比べる', async () => {
      expect(await call(...argv)).toEqual({ code: 2, stdout: '', stderr: 'usage: interface-spec validate [--root <dir>]\n       interface-spec links [--root <dir>]\n       interface-spec commands-md (--check | --write) [--root <dir>]\n       interface-spec field-map\n' })
    })
  })
})

describe('field-map', () => {
  it('field-map を実行すると、欄の対応の 2 つの表を JSON で標準出力に出力し、0 で終了する', async () => {
    await explains('`interface-spec field-map` コマンドのテストです。実行した場合に、`posix` と `borrowed` の 2 つの表を JSON で標準出力へ出力し、終了コード 0 で終了することを確認します。')
    const result = await step('field-map を動かす', () => call('field-map'))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ posix: POSIX_MAP, borrowed: BORROWED_MAP })
    })
  })
})

describe('the command line', () => {
  it('tsx で src/cli.ts を直接起動して validate すると、欠けている欄のエラーを 1 行出力し、1 で終了する', async () => {
    await explains('`lint-defs` の target と同じ形で、`tsx` から `src/cli.ts` を起動するテストです。必須の欄が存在しない定義書を検証した場合に、その欄のエラーを標準エラーへ 1 行出力し、終了コード 1 で終了することを確認します。')
    const root = await materialize('field-missing')
    const failure = await step('tsx から検証を動かす', () => failureOf(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'validate', '--root', root], { cwd: PROJECT, env: CHILD_ENV })))
    stepSync('出力を比べる', () => {
      expect(failure).toMatchObject({
        code: 1,
        stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)\n',
      })
    })
  })
})
