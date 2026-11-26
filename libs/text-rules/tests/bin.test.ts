import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TextlintPluginProcessor } from '@textlint/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TextlintKernelDescriptor } from '@textlint/kernel'
import { attachOutput } from '../../interface-spec/src/vitest/attach.js'
import { buildDescriptor } from '../lib/descriptor.js'
import { formatMessage, main, parseArgv, REAL_DEPS, relativeToCwd, stripCommitComments } from '../lib/main.js'
import type { IgnoreCheck, MainDependencies } from '../lib/main.js'
import { buildRules } from '../lib/rules.js'
import { pickWord } from './helpers/dictionary.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

const word = pickWord()
const sentence = `${word}を使う。`
// 感嘆符の literal は日本語の文字列で no-exclamation-question-mark に止められるので、入力例は日本語を含まない定数に置く。
const BREAKING = 'feat!:'
const BREAKING_SCOPED = 'feat(x)!:'
const SCISSORS = '# ------------------------ >8 ------------------------'
const descriptor = buildDescriptor()

// 除外の判定のスタブ。既定はどのファイルも除外しない。
function ignoring(check: IgnoreCheck): MainDependencies['ignoreCheck'] {
  return vi.fn<MainDependencies['ignoreCheck']>().mockResolvedValue(check)
}
const ignoreNothing = ignoring(vi.fn<IgnoreCheck>().mockResolvedValue(false))
const ignoreSpecs = ignoring(vi.fn<IgnoreCheck>().mockImplementation(file => Promise.resolve(file.startsWith('specs/'))))
const ignoreCheckFailing = ignoring(vi.fn<IgnoreCheck>().mockRejectedValue(new Error('Failed to read ignore file: .textlintignore')))

interface Run {
  readonly code: number
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

// I/O 境界（ファイル読み込みと出力）だけを差し替え、kernel と規則は実物を使う。
async function run(argv: readonly string[], files: Readonly<Record<string, string>>, overrides: Partial<MainDependencies> = {}): Promise<Run> {
  const stdout: string[] = []
  const stderr: string[] = []
  const contents = new Map(Object.entries(files))
  const code = await main(argv, {
    descriptor: () => descriptor,
    readFile: (file) => {
      const text = contents.get(file)
      return text === undefined ? Promise.reject(new Error(`ENOENT: ${file}`)) : Promise.resolve(text)
    },
    stdout: (text) => {
      stdout.push(text)
    },
    stderr: (text) => {
      stderr.push(text)
    },
    ignoreCheck: ignoreNothing,
    ...overrides,
  })
  return { code, stdout, stderr }
}

function wordLines(result: Run): string[] {
  return result.stdout.filter(line => line.includes(' no-ai-words '))
}

describe('main', () => {
  it('違反のある .py ファイルを渡すと、違反ごとに「パス:行:桁 規則 ID メッセージ」の 1 行を出力し、終了コード 1 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。違反を含む `.py` ファイルを渡した場合に、違反ごとに 1 行を標準出力へ出力し、指摘の位置が `sample.py` の 1 行目 6 桁になり、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['sample.py'], { 'sample.py': `x = "${sentence}"\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toEqual([])
      expect(result.stdout.length).toBeGreaterThan(0)
      for (const line of result.stdout) {
        expect(line).toMatch(/^sample\.py:\d+:\d+ \S+ [^\n]+\n$/)
      }
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^sample\.py:1:6 no-ai-words /)
    })
  })

  it('違反のない .md ファイルを渡すと、何も出力せず、終了コード 0 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。違反を含まない `.md` ファイルを渡した場合に、標準出力と標準エラーのどちらへも何も出力せず、終了コードが 0 になることを確認します。')
    const result = await step('規則にかける', () => run(['sample.md'], { 'sample.md': '短い文です。\n' }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
    })
  })

  it('.go ファイルのコメントに違反があると、その位置を指摘として返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。`.go` ファイルのコメントに違反がある場合に、コメントの 1 行目 4 桁の `no-ai-words` の指摘を返し、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['main.go'], { 'main.go': `// ${sentence}\npackage main\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)[0]).toMatch(/^main\.go:1:4 no-ai-words /)
    })
  })

  it.each([
    ['a.ts', `export const a = '${sentence}'\n`, /^a\.ts:1:19 no-ai-words /],
    ['App.vue', `<template>\n  <p>${sentence}</p>\n</template>\n`, /^App\.vue:2:6 no-ai-words /],
  ])('%s の文字列に違反があると、その位置を指摘として返す', async (file, content, expected) => {
    await explains(`文章の規則違反を 1 行ずつ出力するコマンド \`pecot-text-lint\` の \`main\` のテストです。\`${file}\` の文字列に違反がある場合に、文字列の位置の \`no-ai-words\` の指摘を返し、終了コードが 1 になることを確認します。`)
    const result = await step('規則にかける', () => run([file], { [file]: content }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)[0]).toMatch(expected)
    })
  })

  it('対応する plugin が存在しない拡張子のファイルは、読み込まずに飛ばし、終了コード 0 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。`.png` や `README` のように対応する plugin が存在しないファイルを渡した場合に、何も読み込まず、何も出力せず、終了コードが 0 になることを確認します。')
    const readFile = vi.fn<MainDependencies['readFile']>()
    const result = await step('規則にかける', () => run(['logo.png', 'notes.txt', 'README'], {}, { readFile }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
      expect(readFile).not.toHaveBeenCalled()
    })
  })

  it('複数の指摘をまとめる message は出力せず、個別の指摘だけを 1 行ずつ出力する', async () => {
    // 同じ接続詞で始まる文を続け、ai-tech-writing-guideline の【構造化】（文の始まりの単調さ）を狙う。
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。同じ接続詞で始まる文が続く文章を渡した場合に、【構造化】の個別の指摘は出力され、まとめの message は出力されず、各行が 1 行で終わることを確認します。')
    const result = await step('規則にかける', () => run(['sample.md'], { 'sample.md': 'また、短い文です。'.repeat(2) }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(result.stdout.some(line => line.includes('【構造化】'))).toBe(true)
      expect(result.stdout.some(line => line.includes('【テクニカルライティング品質分析】'))).toBe(false)
      for (const line of result.stdout) {
        expect(line.indexOf('\n')).toBe(line.length - 1)
      }
    })
  })

  it('複数のファイルを渡し、1 つでも違反があると、終了コード 1 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。違反のない `a.md` と違反のある `b.sh` を渡した場合に、`b.sh` の指摘だけが 1 件出力され、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['a.md', 'b.sh'], { 'a.md': '短い文です。\n', 'b.sh': `echo "${sentence}"\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^b\.sh:1:7 /)
    })
  })

  it('存在しないファイルを渡すと、理由を標準エラーへ出力し、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。存在しないファイルを渡した場合に、ファイルを読めなかった理由を標準エラーへ 1 行出力し、標準出力には何も出力せず、終了コードが 2 になることを確認します。')
    const result = await step('規則にかける', () => run(['missing-file.md'], {}, { readFile: REAL_DEPS.readFile }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(2)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toHaveLength(1)
      expect(result.stderr[0]).toMatch(/^pecot-text-lint: missing-file\.md: ENOENT: no such file or directory.*missing-file\.md.*\n$/)
    })
  })

  it('読み込みに失敗したファイルの名前を、標準エラーの出力に含めて、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。読めるファイルと存在しないファイルを渡した場合に、標準エラーの出力に存在しないファイルの名前が含まれ、終了コードが 2 になることを確認します。')
    const result = await step('規則にかける', () => run(['a.md', 'missing.md'], { 'a.md': '短い文です。\n' }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: missing.md: ENOENT: missing.md\n'] })
    })
  })

  it('plugin が例外を投げると、違反としてではなく実行の失敗として標準エラーへ出力し、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。解析の途中で例外を投げる plugin を使った場合に、標準出力には何も出力せず、ファイル名と例外のメッセージを標準エラーへ 1 行出力し、終了コードが 2 になることを確認します。')
    class ThrowingProcessor {
      availableExtensions(): string[] {
        return ['.boom']
      }

      processor(): ReturnType<TextlintPluginProcessor['processor']> {
        return {
          preProcess() {
            throw new Error('解析できません')
          },
          postProcess(messages, filePath = '') {
            return { messages, filePath }
          },
        }
      }
    }
    const throwing = new TextlintKernelDescriptor({
      rules: buildRules(),
      filterRules: [],
      plugins: [{ pluginId: 'boom', plugin: { Processor: ThrowingProcessor } }],
    })
    const result = await step('規則にかける', () => run(['x.boom'], { 'x.boom': 'text\n' }, { descriptor: () => throwing }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(2)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toHaveLength(1)
      expect(result.stderr[0]).toMatch(/^pecot-text-lint: x\.boom: .*解析できません.*\n$/)
    })
  })

  it('先頭に BOM がある .ts ファイルでも、BOM が無い場合と同じ位置にコメントの違反を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。先頭に BOM がある `.ts` ファイルを渡した場合に、BOM が無いファイルと同じ出力になることを確認します。')
    const plain = await step('BOM 無しの入力を規則にかける', () => run(['a.ts'], { 'a.ts': `// ${sentence}\n` }))
    const withBom = await step('BOM 付きの入力を規則にかける', () => run(['a.ts'], { 'a.ts': `\u{FEFF}// ${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(wordLines(plain)).toHaveLength(1)
      expect(withBom).toEqual(plain)
    })
  })

  it('規則の読み込みに失敗すると、理由を標準エラーへ出力し、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。規則の一式（descriptor）の生成が例外で失敗した場合に、その理由を標準エラーへ 1 行出力し、終了コードが 2 になることを確認します。')
    const result = await step('規則にかける', () => run(['sample.md'], {}, {
      descriptor: () => {
        throw new Error('規則を読み込めません')
      },
    }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: 規則を読み込めません\n'] })
    })
  })

  it('Error ではない値で失敗しても、その理由を文字列にして標準エラーへ出力し、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。ファイルの読み込みが Error ではなく文字列で失敗した場合に、ファイル名と文字列を標準エラーへ出力し、終了コードが 2 になることを確認します。')
    const result = await step('規則にかける', () => run(['sample.md'], {}, { readFile: vi.fn<MainDependencies['readFile']>().mockRejectedValue('文字列の失敗') }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: sample.md: 文字列の失敗\n'] })
    })
  })
})

describe('main の除外', () => {
  it('除外の対象のファイルは、読み込まずに飛ばし、終了コード 0 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。`.textlintignore` の除外の対象になるファイルを渡した場合に、ファイルを読み込まず、何も出力せず、終了コードが 0 になることを確認します。')
    const readFile = vi.fn<MainDependencies['readFile']>()
    const result = await step('規則にかける', () => run(['specs/a.md'], {}, { ignoreCheck: ignoreSpecs, readFile }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
      expect(readFile).not.toHaveBeenCalled()
    })
  })

  it('除外の対象ではないファイルは、除外の対象のファイルと一緒に渡しても、違反を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。除外の対象のファイルと対象ではないファイルを一緒に渡した場合、`docs/a.md` の指摘だけが 1 件出力され、終了コード 1 を返すことを確認します。')
    const result = await step('規則にかける', () => run(['specs/a.md', 'docs/a.md'], { 'docs/a.md': `${sentence}\n` }, { ignoreCheck: ignoreSpecs }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^docs\/a\.md:1:1 /)
    })
  })

  it('--commit-msg を付けると、除外の判定を作らずに、メッセージのファイルを調べる', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`specs/` の下のファイルを渡した場合に、除外の判定が 1 回も呼ばれず、違反が無いので終了コードが 0 になることを確認します。')
    const ignoreCheck = vi.fn<MainDependencies['ignoreCheck']>()
    const result = await step('規則にかける', () => run(['--commit-msg', 'specs/MSG'], { 'specs/MSG': '短い文です。\n' }, { ignoreCheck }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(0)
      expect(ignoreCheck).not.toHaveBeenCalled()
    })
  })

  it('除外の判定に失敗すると、ファイル名と理由を標準エラーへ出力し、終了コード 2 を返す', async () => {
    await explains('文章の規則違反を 1 行ずつ出力するコマンド `pecot-text-lint` の `main` のテストです。除外の判定が例外で失敗した場合に、ファイル名と例外のメッセージを標準エラーへ 1 行出力し、終了コードが 2 になることを確認します。')
    const result = await step('規則にかける', () => run(['a.md'], { 'a.md': '短い文です。\n' }, { ignoreCheck: ignoreCheckFailing }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: a.md: Failed to read ignore file: .textlintignore\n'] })
    })
  })
})

describe('relativeToCwd', () => {
  let directory = ''

  beforeAll(async () => {
    const created = await mkdtemp(path.join(tmpdir(), 'pecot-text-lint-relative-'))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
    directory = await realpath(created)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    await mkdir(path.join(directory, 'repo/specs'), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    await symlink(path.join(directory, 'repo'), path.join(directory, 'link'))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    await mkdir(path.join(directory, 'outside'))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    await symlink(path.join(directory, 'outside'), path.join(directory, 'repo/vendor'))
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('作業ディレクトリの下の絶対パスを、/ 区切りの相対パスにして返す', async () => {
    await explains('絶対パスを作業ディレクトリからの相対パスにする `relativeToCwd` のテストです。作業ディレクトリの下のファイルの絶対パスを渡した場合に、`specs/a.md` のような / 区切りの相対パスを返すことを確認します。')
    const cwd = path.join(directory, 'repo')
    await step('相対パスを求めて比べる', async () => {
      await expect(relativeToCwd(path.join(cwd, 'specs/a.md'), cwd)).resolves.toBe('specs/a.md')
    })
  })

  it('作業ディレクトリがシンボリックリンクでも、実体のパスで渡したときと同じ相対パスを返す', async () => {
    await explains('絶対パスを作業ディレクトリからの相対パスにする `relativeToCwd` のテストです。作業ディレクトリがシンボリックリンクの場合に、リンクのパスで渡しても実体のパスで渡しても、同じ相対パスを返すことを確認します。')
    const cwd = path.join(directory, 'link')
    await step('リンク経由の相対パスを求めて比べる', async () => {
      await expect(relativeToCwd(path.join(cwd, 'specs/a.md'), cwd)).resolves.toBe('specs/a.md')
      await expect(relativeToCwd(path.join(directory, 'repo/specs/a.md'), cwd)).resolves.toBe('specs/a.md')
    })
  })

  it('作業ディレクトリの中のリンクの下のファイルは、リンク先が外にあっても、リンクを通った相対パスを返す', async () => {
    await explains('絶対パスを作業ディレクトリからの相対パスにする `relativeToCwd` のテストです。作業ディレクトリの中のリンクが、外のディレクトリを指している場合に、リンクを通ったままの相対パスを返すことを確認します。')
    const cwd = path.join(directory, 'repo')
    await step('相対パスを求めて比べる', async () => {
      await expect(relativeToCwd(path.join(cwd, 'vendor/a.md'), cwd)).resolves.toBe('vendor/a.md')
    })
  })

  it('名前が .. で始まるファイルは、親ディレクトリではなく、作業ディレクトリの中のファイルとして扱う', async () => {
    await explains('絶対パスを作業ディレクトリからの相対パスにする `relativeToCwd` のテストです。`..notes.md` のように名前が `..` で始まるファイルを渡した場合に、その名前のままの相対パスを返すことを確認します。')
    const cwd = path.join(directory, 'repo')
    await step('相対パスを求めて比べる', async () => {
      await expect(relativeToCwd(path.join(cwd, '..notes.md'), cwd)).resolves.toBe('..notes.md')
    })
  })

  it('作業ディレクトリの外のパスを渡すと、undefined を返す', async () => {
    await explains('絶対パスを作業ディレクトリからの相対パスにする `relativeToCwd` のテストです。作業ディレクトリの外のファイルを渡した場合に、相対パスを求められないので `undefined` を返すことを確認します。')
    await step('作業ディレクトリの外のパスの相対パスを求めて比べる', async () => {
      await expect(relativeToCwd(path.join(directory, 'repo/a.md'), path.join(directory, 'repo/specs'))).resolves.toBeUndefined()
    })
  })
})

describe('main --commit-msg の type(scope)', () => {
  const file = 'COMMIT_EDITMSG'
  const scoped = 'fix(pecot-tools,pecot-visual,pecot-workflow,text-rules,repo):'

  it('scope にカンマで区切った複数の値があっても、件名の先頭の type(scope): を外して、違反なしで通す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`fix(a,b):` のように scope を複数持つ件名を渡した場合に、先頭の `type(scope):` を調べず、何も出力せず、終了コードが 0 になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${scoped} #1297 レビュー指摘に対応する\n` }))
    stepSync('結果を比べる', () => {
      expect(result.stdout).toEqual([])
      expect(result.code).toBe(0)
    })
  })

  it.each(['feat!:', 'feat(x)!:'])('件名の先頭が %s の形でも、先頭の type と印を外して、違反なしで通す', async (prefix) => {
    await explains(`\`--commit-msg\` を付けて、コミットメッセージを調べる \`main\` のテストです。件名の先頭が \`${prefix}\` の形の場合に、その部分を調べる対象から外し、何も出力せず、終了コードが 0 になることを確認します。`)
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${prefix} 対応する\n` }))
    stepSync('結果を比べる', () => {
      expect(result.stdout).toEqual([])
      expect(result.code).toBe(0)
    })
  })

  it('件名の type(scope): より後ろに違反があると、終了コード 1 を返す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`type(scope):` の後ろの件名に違反がある場合に、指摘を出力し、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${scoped} ${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result).length).toBeGreaterThan(0)
    })
  })

  it('本文の段落に違反があると、その行番号を付けて、終了コード 1 を返す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。件名の後ろの本文の段落に違反がある場合に、3 行目の指摘を出力し、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${scoped} 対応する\n\n${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)[0]).toContain(`${file}:3:`)
    })
  })

  it.each([
    ['scope のある件名', 'fix(a,b): '],
    ['scope の無い件名', ''],
    ['破壊的変更の印のある件名', 'feat(x)!:  '],
  ])('%s の違反の桁は、先頭の type(scope): を含めた、ファイル上の桁と一致する', async (name, prefix) => {
    await explains(`\`--commit-msg\` を付けて、コミットメッセージを調べる \`main\` のテストです。件名の先頭が \`${name}\` の場合に、違反の桁が、先頭の部分の長さに 1 を加えた、ファイル上の桁と一致することを確認します。`)
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${prefix}${sentence}\n` }))
    const columns = stepSync('桁を取り出す', () => wordLines(result).map(line => Number(/^\S+:1:(\d+) /.exec(line)?.[1])))
    stepSync('結果を比べる', () => {
      expect(columns).toEqual([prefix.length + 1])
    })
  })

  it('type(scope): が付いていない件名は、全体を調べて、違反があると終了コード 1 を返す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`type(scope):` が付いていない件名に違反がある場合に、件名の全体が調べられ、指摘を出力し、終了コードが 1 になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result).length).toBeGreaterThan(0)
    })
  })
})

describe('main --commit-msg', () => {
  const file = '.git/COMMIT_EDITMSG'

  it('# で始まる行だけのメッセージは、何も出力せず、終了コード 0 を返す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`#` で始まるコメントの行だけのメッセージを渡した場合に、コメントの行が調べられず、何も出力せず、終了コードが 0 になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `# ${sentence}\n# ${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
    })
  })

  it('scissors の行より後ろの diff を調べず、違反の行番号は、元のファイルの行番号のまま返す', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。scissors の行より後ろに diff が付いている場合に、diff の中の違反は出力されず、本文の違反が元のファイルと同じ 3 行目で出力されることを確認します。')
    const text = `件名です\n\n${sentence}\n${SCISSORS}\ndiff --git a/${sentence} b/x\n`
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: text }))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
    })
  })

  it('scissors の行が存在しなくても、# の行を空行として扱い、元のファイルの行番号を保つ', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。`#` の行の次に違反の行がある場合に、違反の行番号が元のファイルと同じ 3 行目になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `件名です\n# ${sentence}\n${sentence}\n` }))
    stepSync('結果を比べる', () => {
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
    })
  })

  it('改行が CRLF のメッセージでも、違反の行番号が、元のファイルの行番号と一致する', async () => {
    await explains('`--commit-msg` を付けて、コミットメッセージを調べる `main` のテストです。改行が CRLF で、コメントの行と scissors の行を含むメッセージを渡した場合に、違反の行番号が元のファイルと同じ 3 行目になることを確認します。')
    const result = await step('規則にかける', () => run(['--commit-msg', file], { [file]: `件名です\r\n\r\n${sentence}\r\n# ${sentence}\r\n${SCISSORS}\r\n${sentence}\r\n` }))
    stepSync('結果を比べる', () => {
      expect(wordLines(result)).toHaveLength(1)
      expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
    })
  })
})

describe('parseArgv', () => {
  it.each([
    [[], { commitMsg: false, files: [] }],
    [['a.md', 'b.py'], { commitMsg: false, files: ['a.md', 'b.py'] }],
    [['--commit-msg', '.git/COMMIT_EDITMSG'], { commitMsg: true, files: ['.git/COMMIT_EDITMSG'] }],
    [['a.md', '--commit-msg'], { commitMsg: true, files: ['a.md'] }],
  ])('引数が %j のとき、%j を返す', async (argv, expected) => {
    await explains('`pecot-text-lint` のコマンドの引数を読み取る `parseArgv` のテストです。引数の配列を渡した場合に、`--commit-msg` の有無と、ファイルの一覧を、位置によらず返すことを確認します。')
    stepSync('引数を解釈して比べる', () => {
      expect(parseArgv(argv)).toEqual(expected)
    })
  })
})

describe('stripCommitComments', () => {
  it.each([
    ['本文はそのまま', 'a\nb\n', 'a\nb\n'],
    ['# 行を空行にする', 'a\n# b\nc', 'a\n\nc'],
    ['scissors 行以降を捨てる', `a\n${SCISSORS}\nb\n`, 'a'],
    ['CRLF の scissors 行も見つける', `a\r\n${SCISSORS}\r\nb`, 'a\r'],
    ['行頭以外の # は残す', 'a # b', 'a # b'],
    ['type(scope): を外す', 'fix(a,b): c\nfix(a,b): d', 'c\nfix(a,b): d'],
    ['type: を外す', 'fix: c', 'c'],
    [`${BREAKING} の type と印を外す`, `${BREAKING} c`, 'c'],
    [`${BREAKING_SCOPED} の type・scope・印を外す`, `${BREAKING_SCOPED} c`, 'c'],
    ['コメント行の次の行を件名とする', '# x\nfix(a): c', '\nc'],
    ['type(scope): の無い件名はそのまま', 'Fix(a): c', 'Fix(a): c'],
  ])('コミットメッセージを整えるとき、%s', async (_name, input, expected) => {
    await explains('コミットメッセージから、調べる対象にならない部分を取り除く `stripCommitComments` のテストです。メッセージの種類ごとに、コメントの行・scissors の行より後ろ・先頭の `type(scope):` が取り除かれ、本文が残ることを確認します。')
    stepSync('コミットメッセージのコメントを除いて比べる', () => {
      expect(stripCommitComments(input)).toBe(expected)
    })
  })
})

describe('formatMessage', () => {
  it('指摘を「パス:行:桁 規則 ID メッセージ」の 1 行にし、メッセージの改行と前後の空白を 1 つの空白にする', async () => {
    await explains('指摘を出力用の 1 行にする `formatMessage` のテストです。改行と前後の空白を含むメッセージを渡した場合に、改行が 1 つの空白になり、前後の空白が取り除かれた 1 行を返すことを確認します。')
    const message = { ruleId: 'rule-a', message: '1 行目\n  2 行目 ', loc: { start: { line: 3, column: 5 } } }
    stepSync('出力の 1 行を作って比べる', () => {
      expect(formatMessage('dir/a.py', message)).toBe('dir/a.py:3:5 rule-a 1 行目 2 行目')
    })
  })
})

interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function isExecFailure(value: unknown): value is ExecResult {
  return typeof value === 'object' && value !== null
    && 'code' in value && typeof value.code === 'number'
    && 'stdout' in value && typeof value.stdout === 'string'
    && 'stderr' in value && typeof value.stderr === 'string'
}

// node は NO_COLOR と FORCE_COLOR の両方がある環境で、警告を stderr に出す（nx の pre-push で起きる）。
// bin 自身の失敗行（`pecot-text-lint:` 始まり）だけを見る。
function failureLines(stderr: string): string[] {
  return stderr.split('\n').filter(line => line.startsWith('pecot-text-lint:'))
}

describe('コマンドの実体', () => {
  const execFileAsync = promisify(execFile)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let directory = ''

  // dist の bin を子プロセスで動かし、終了コードと出力を返す。
  async function runBin(file: string, cwd = root): Promise<ExecResult> {
    const command = `node dist/bin/pecot-text-lint.js ${file}`
    try {
      const { stdout, stderr } = await execFileAsync('node', [path.join(root, 'dist/bin/pecot-text-lint.js'), file], { cwd })
      attachOutput(command, 0, stdout, stderr)
      return { code: 0, stdout, stderr }
    }
    catch (error) {
      if (isExecFailure(error)) {
        attachOutput(command, error.code, error.stdout, error.stderr)
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
      throw error
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'pecot-text-lint-'))
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('ビルドした bin を実行し、違反のあるファイルを渡すと、終了コード 1 と、違反ごとの 1 行を出力する', async () => {
    await explains('ビルドした `dist/bin/pecot-text-lint.js` を子プロセスで実行するテストです。違反のあるファイルを渡した場合に、終了コードが 1 になり、違反の 1 行が標準出力へ出力され、実行の失敗の行が標準エラーに無いことを確認します。')
    const file = path.join(directory, 'sample.sh')
    await step('規則にかけるファイルを書く', async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await writeFile(file, `echo "${sentence}"\n`)
    })
    const result = await step('dist の bin を動かす', () => runBin(file))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(1)
      expect(failureLines(result.stderr)).toEqual([])
      expect(result.stdout).toContain(`${file}:1:7 no-ai-words `)
    })
  })

  it('ビルドした bin を実行し、違反のないファイルを渡すと、何も出力せず、終了コード 0 を返す', async () => {
    await explains('ビルドした `dist/bin/pecot-text-lint.js` を子プロセスで実行するテストです。違反のないファイルを渡した場合に、終了コードが 0 になり、標準出力に何も出力せず、実行の失敗の行が標準エラーに無いことを確認します。')
    const file = path.join(directory, 'clean.md')
    await step('規則にかけるファイルを書く', async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await writeFile(file, '短い文です。\n')
    })
    const result = await step('dist の bin を動かす', () => runBin(file))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
      expect(failureLines(result.stderr)).toEqual([])
    })
  })

  describe('.textlintignore', () => {
    let repository = ''

    beforeAll(async () => {
      repository = path.join(directory, 'repository')
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await mkdir(path.join(repository, 'specs/[id]'), { recursive: true })
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await mkdir(path.join(repository, 'docs'), { recursive: true })
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await writeFile(path.join(repository, '.textlintignore'), 'specs/**\n')
      for (const file of ['specs/a.md', 'specs/[id]/a.md', 'docs/a.md']) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
        await writeFile(path.join(repository, file), `${sentence}\n`)
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
      await symlink(repository, path.join(directory, 'link'))
    })

    it.for([
      { name: '相対パス', file: 'specs/a.md', cwd: 'repository' },
      { name: '絶対パス', file: 'repository/specs/a.md', cwd: 'repository' },
      { name: 'リンクを通った作業ディレクトリの絶対パス', file: 'link/specs/a.md', cwd: 'link' },
    ])('除外に当たるファイルを $name で渡すと、終了コード 0 を返す', async ({ name, file, cwd }) => {
      await explains(`ビルドした \`dist/bin/pecot-text-lint.js\` を、\`.textlintignore\` のあるディレクトリで実行するテストです。除外の対象のファイルを \`${name}\` で渡した場合に、違反があっても何も出力せず、終了コードが 0 になることを確認します。`)
      const target = file.startsWith('specs/') ? file : path.join(directory, file)
      const result = await step('dist の bin を動かす', () => runBin(target, path.join(directory, cwd)))
      stepSync('結果を比べる', () => {
        expect(result).toMatchObject({ code: 0, stdout: '' })
        expect(failureLines(result.stderr)).toEqual([])
      })
    })

    it('除外の対象ではないファイルを渡すと、違反を返す', async () => {
      await explains('ビルドした `dist/bin/pecot-text-lint.js` を、`.textlintignore` のあるディレクトリで実行するテストです。除外の対象ではない `docs/a.md` を渡した場合に、違反が出力され、終了コードが 1 になることを確認します。')
      const result = await step('dist の bin を動かす', () => runBin(path.join(repository, 'docs/a.md'), repository))
      stepSync('結果を比べる', () => {
        expect(result.code).toBe(1)
        expect(result.stdout).toContain('docs/a.md:1:1 no-ai-words ')
      })
    })

    it('作業ディレクトリの外のファイルを渡すと、除外の型に一致しても、違反を返す', async () => {
      await explains('ビルドした `dist/bin/pecot-text-lint.js` を、`.textlintignore` のあるディレクトリの中の別のディレクトリで実行するテストです。作業ディレクトリの外のファイルが除外の型に一致しても、除外されず、終了コードが 1 になることを確認します。')
      const result = await step('dist の bin を動かす', () => runBin(path.join(repository, 'specs/a.md'), path.join(repository, 'docs')))
      stepSync('結果を比べる', () => {
        expect(result.code).toBe(1)
      })
    })

    // textlint の scanFilePath はパスを glob の型として扱うので、[ ] を含むパスは除外と照らせない（CLI と同じ）。
    it('パスに glob の記号が含まれるファイルを渡すと、除外の対象の下にあっても、違反を返す', async () => {
      await explains('ビルドした `dist/bin/pecot-text-lint.js` を、`.textlintignore` のあるディレクトリで実行するテストです。`specs/[id]/a.md` のように、パスに glob の記号 `[` と `]` が含まれる場合に、除外の型に一致するか判定できず、終了コードが 1 になることを確認します。')
      const result = await step('dist の bin を動かす', () => runBin('specs/[id]/a.md', repository))
      stepSync('結果を比べる', () => {
        expect(result.code).toBe(1)
      })
    })
  })
})
