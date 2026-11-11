import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TextlintPluginProcessor } from '@textlint/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TextlintKernelDescriptor } from '@textlint/kernel'
import { buildDescriptor } from '../lib/descriptor.js'
import { formatMessage, main, parseArgv, REAL_DEPS, stripCommitComments } from '../lib/main.js'
import type { MainDependencies } from '../lib/main.js'
import { buildRules } from '../lib/rules.js'
import { pickWord } from './helpers/dictionary.js'

const word = pickWord()
const sentence = `${word}を使う。`
// 感嘆符の literal は日本語の文字列で no-exclamation-question-mark に止められるので、入力例は日本語を含まない定数に置く。
const BREAKING = 'feat!:'
const BREAKING_SCOPED = 'feat(x)!:'
const SCISSORS = '# ------------------------ >8 ------------------------'
const descriptor = buildDescriptor()

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
    ...overrides,
  })
  return { code, stdout, stderr }
}

function wordLines(result: Run): string[] {
  return result.stdout.filter(line => line.includes(' no-ai-words '))
}

describe('main', () => {
  it('違反のある .py を path:line:col ruleId message の 1 行で出し、終了コード 1 を返す', async () => {
    const result = await run(['sample.py'], { 'sample.py': `x = "${sentence}"\n` })
    expect(result.code).toBe(1)
    expect(result.stderr).toEqual([])
    expect(result.stdout.length).toBeGreaterThan(0)
    for (const line of result.stdout) {
      expect(line).toMatch(/^sample\.py:\d+:\d+ \S+ [^\n]+\n$/)
    }
    expect(wordLines(result)).toHaveLength(1)
    expect(wordLines(result)[0]).toMatch(/^sample\.py:1:6 no-ai-words /)
  })

  it('違反のない .md は終了コード 0 で何も出さない', async () => {
    const result = await run(['sample.md'], { 'sample.md': '短い文です。\n' })
    expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
  })

  it('.go のコメントの違反を返す', async () => {
    const result = await run(['main.go'], { 'main.go': `// ${sentence}\npackage main\n` })
    expect(result.code).toBe(1)
    expect(wordLines(result)[0]).toMatch(/^main\.go:1:4 no-ai-words /)
  })

  it.each([
    ['a.ts', `export const a = '${sentence}'\n`, /^a\.ts:1:19 no-ai-words /],
    ['App.vue', `<template>\n  <p>${sentence}</p>\n</template>\n`, /^App\.vue:2:6 no-ai-words /],
  ])('%s の文字列の違反を返す', async (file, content, expected) => {
    const result = await run([file], { [file]: content })
    expect(result.code).toBe(1)
    expect(wordLines(result)[0]).toMatch(expected)
  })

  it('担当 plugin の無い拡張子は読まずに飛ばし、終了コード 0 を返す', async () => {
    const readFile = vi.fn<MainDependencies['readFile']>()
    const result = await run(['logo.png', 'notes.txt', 'README'], {}, { readFile })
    expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('個別の指摘は残し、要約の message は出さず、message の改行を 1 行にする', async () => {
    // 同じ接続詞で始まる文を続け、ai-tech-writing-guideline の【構造化】（文の始まりの単調さ）を狙う。
    const result = await run(['sample.md'], { 'sample.md': 'また、短い文です。'.repeat(2) })
    expect(result.code).toBe(1)
    expect(result.stdout.some(line => line.includes('【構造化】'))).toBe(true)
    expect(result.stdout.some(line => line.includes('【テクニカルライティング品質分析】'))).toBe(false)
    for (const line of result.stdout) {
      expect(line.indexOf('\n')).toBe(line.length - 1)
    }
  })

  it('複数のファイルを順に読み、1 つでも違反があれば終了コード 1 を返す', async () => {
    const result = await run(['a.md', 'b.sh'], { 'a.md': '短い文です。\n', 'b.sh': `echo "${sentence}"\n` })
    expect(result.code).toBe(1)
    expect(wordLines(result)).toHaveLength(1)
    expect(wordLines(result)[0]).toMatch(/^b\.sh:1:7 /)
  })

  it('存在しないファイルは理由を stderr に出し、終了コード 2 を返す', async () => {
    const result = await run(['missing-file.md'], {}, { readFile: REAL_DEPS.readFile })
    expect(result.code).toBe(2)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toMatch(/^pecot-text-lint: missing-file\.md: ENOENT: no such file or directory.*missing-file\.md.*\n$/)
  })

  it('どのファイルで失敗したか分かるよう、ファイル名を付けて終了コード 2 を返す', async () => {
    const result = await run(['a.md', 'missing.md'], { 'a.md': '短い文です。\n' })
    expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: missing.md: ENOENT: missing.md\n'] })
  })

  it('plugin が例外を投げたら、違反ではなく実行失敗として stderr に出し、終了コード 2 を返す', async () => {
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
    const result = await run(['x.boom'], { 'x.boom': 'text\n' }, { descriptor: () => throwing })
    expect(result.code).toBe(2)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toMatch(/^pecot-text-lint: x\.boom: .*解析できません.*\n$/)
  })

  it('BOM 付きの .ts でも、コメントの違反を BOM 無しと同じ位置で返す', async () => {
    const plain = await run(['a.ts'], { 'a.ts': `// ${sentence}\n` })
    const withBom = await run(['a.ts'], { 'a.ts': `\u{FEFF}// ${sentence}\n` })
    expect(wordLines(plain)).toHaveLength(1)
    expect(withBom).toEqual(plain)
  })

  it('descriptor の生成が失敗したら理由を stderr に出し、終了コード 2 を返す', async () => {
    const result = await run(['sample.md'], {}, {
      descriptor: () => {
        throw new Error('規則を読み込めません')
      },
    })
    expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: 規則を読み込めません\n'] })
  })

  it('Error でない失敗も理由を文字列にして終了コード 2 を返す', async () => {
    const result = await run(['sample.md'], {}, { readFile: vi.fn<MainDependencies['readFile']>().mockRejectedValue('文字列の失敗') })
    expect(result).toEqual({ code: 2, stdout: [], stderr: ['pecot-text-lint: sample.md: 文字列の失敗\n'] })
  })
})

describe('main --commit-msg の type(scope)', () => {
  const file = 'COMMIT_EDITMSG'
  const scoped = 'fix(pecot-tools,pecot-visual,pecot-workflow,text-rules,repo):'

  it('scope の , 区切りを数えず、違反なしで通す', async () => {
    const result = await run(['--commit-msg', file], { [file]: `${scoped} #1297 レビュー指摘に対応する\n` })
    expect(result.stdout).toEqual([])
    expect(result.code).toBe(0)
  })

  it.each(['feat!:', 'feat(x)!:'])('%s の形も外す', async (prefix) => {
    const result = await run(['--commit-msg', file], { [file]: `${prefix} 対応する\n` })
    expect(result.stdout).toEqual([])
    expect(result.code).toBe(0)
  })

  it('件名の本文の違反は止める', async () => {
    const result = await run(['--commit-msg', file], { [file]: `${scoped} ${sentence}\n` })
    expect(result.code).toBe(1)
    expect(wordLines(result).length).toBeGreaterThan(0)
  })

  it('本文の段落の違反は止める', async () => {
    const result = await run(['--commit-msg', file], { [file]: `${scoped} 対応する\n\n${sentence}\n` })
    expect(result.code).toBe(1)
    expect(wordLines(result)[0]).toContain(`${file}:3:`)
  })

  it.each([
    ['scope のある件名', 'fix(a,b): '],
    ['scope の無い件名', ''],
    ['破壊的変更の印のある件名', 'feat(x)!:  '],
  ])('%s の本文の違反の列は、ファイル上の位置と一致する', async (_name, prefix) => {
    const result = await run(['--commit-msg', file], { [file]: `${prefix}${sentence}\n` })
    const columns = wordLines(result).map(line => Number(/^\S+:1:(\d+) /.exec(line)?.[1]))
    expect(columns).toEqual([prefix.length + 1])
  })

  it('type(scope): の無い件名は今までどおり全体を確認する', async () => {
    const result = await run(['--commit-msg', file], { [file]: `${sentence}\n` })
    expect(result.code).toBe(1)
    expect(wordLines(result).length).toBeGreaterThan(0)
  })
})

describe('main --commit-msg', () => {
  const file = '.git/COMMIT_EDITMSG'

  it('# 行だけのメッセージは終了コード 0 で何も出さない', async () => {
    const result = await run(['--commit-msg', file], { [file]: `# ${sentence}\n# ${sentence}\n` })
    expect(result).toEqual({ code: 0, stdout: [], stderr: [] })
  })

  it('scissors 行以降の diff を読まず、違反の行番号を元ファイルのまま返す', async () => {
    const text = `件名です\n\n${sentence}\n${SCISSORS}\ndiff --git a/${sentence} b/x\n`
    const result = await run(['--commit-msg', file], { [file]: text })
    expect(result.code).toBe(1)
    expect(wordLines(result)).toHaveLength(1)
    expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
  })

  it('scissors 行が無くても # 行を空行にして行番号を保つ', async () => {
    const result = await run(['--commit-msg', file], { [file]: `件名です\n# ${sentence}\n${sentence}\n` })
    expect(wordLines(result)).toHaveLength(1)
    expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
  })

  it('CRLF でも行番号が元ファイルと一致する', async () => {
    const result = await run(['--commit-msg', file], { [file]: `件名です\r\n\r\n${sentence}\r\n# ${sentence}\r\n${SCISSORS}\r\n${sentence}\r\n` })
    expect(wordLines(result)).toHaveLength(1)
    expect(wordLines(result)[0]).toMatch(/^\.git\/COMMIT_EDITMSG:3:1 no-ai-words /)
  })
})

describe('parseArgv', () => {
  it.each([
    [[], { commitMsg: false, files: [] }],
    [['a.md', 'b.py'], { commitMsg: false, files: ['a.md', 'b.py'] }],
    [['--commit-msg', '.git/COMMIT_EDITMSG'], { commitMsg: true, files: ['.git/COMMIT_EDITMSG'] }],
    [['a.md', '--commit-msg'], { commitMsg: true, files: ['a.md'] }],
  ])('引数が %j のとき、期待の解析結果を返す', (argv, expected) => {
    expect(parseArgv(argv)).toEqual(expected)
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
  ])('%s のとき、期待の文字列を返す', (_name, input, expected) => {
    expect(stripCommitComments(input)).toBe(expected)
  })
})

describe('formatMessage', () => {
  it('path:line:col ruleId message を作り、message の改行と前後の空白を 1 つの空白にする', () => {
    const message = { ruleId: 'rule-a', message: '1 行目\n  2 行目 ', loc: { start: { line: 3, column: 5 } } }
    expect(formatMessage('dir/a.py', message)).toBe('dir/a.py:3:5 rule-a 1 行目 2 行目')
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
  async function runBin(file: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('node', ['dist/bin/pecot-text-lint.js', file], { cwd: root })
      return { code: 0, stdout, stderr }
    }
    catch (error) {
      if (isExecFailure(error)) {
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

  it('dist の bin は違反のあるファイルで終了コード 1 と 1 行形式の出力を返す', async () => {
    const file = path.join(directory, 'sample.sh')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
    await writeFile(file, `echo "${sentence}"\n`)
    const result = await runBin(file)
    expect(result.code).toBe(1)
    expect(failureLines(result.stderr)).toEqual([])
    expect(result.stdout).toContain(`${file}:1:7 no-ai-words `)
  })

  it('dist の bin は違反のないファイルで終了コード 0 を返す', async () => {
    const file = path.join(directory, 'clean.md')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- テスト用に作った一時ディレクトリの中のパス
    await writeFile(file, '短い文です。\n')
    const result = await runBin(file)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(failureLines(result.stderr)).toEqual([])
  })
})
