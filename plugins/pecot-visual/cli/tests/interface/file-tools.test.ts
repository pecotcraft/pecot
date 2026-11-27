// フックが呼ぶ file_lint・file_validate・file_brief の応答。hooks/tests/post-tool-use/*.test.sh のケースを写した。
// eslint・validator・pecot-text-lint は実物を動かす。時間切れ・異常終了・例外だけ spawnPromise で作る。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てだけ */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { SpawnResult } from '../../src/domain/_shared/spawn-result.js'
import type * as Process from '../../src/infra/_shared/process.js'
import { spawnPromise } from '../../src/infra/_shared/process.js'
import { resetPluginRoot, stubPluginRoot } from '../_helpers/plugin-root-stub.js'
import { assertTemplatePluginsBuilt, createTalkDirectory } from '../_helpers/talk-directory.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import type { ToolDefinition } from '../../src/mcp/server.js'
import { fileBriefTool, fileLintTool, fileValidateTool } from '../../src/mcp/tools/file.js'
import { closeMcp, connectMcp, type ConnectedMcp } from '../../src/mcp/tests/_client.js'

vi.mock('../../src/infra/_shared/plugin-root.js', async (importOriginal) => {
  const { pluginRootMock } = await import('../_helpers/plugin-root-stub.js')
  return await pluginRootMock(importOriginal)
})

vi.mock('../../src/infra/_shared/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Process>()
  return { ...actual, spawnPromise: vi.fn(actual.spawnPromise) }
})

const { spawnPromise: realSpawn } = await vi.importActual<typeof Process>('../../src/infra/_shared/process.js')

const THEME_PACKAGE = 'slidev-theme-pecotv-test-declared'
const LONG_HEADING = 'これはとても長い見出しで二十文字を超えてしまう例です'
// 違反文は literal で持たず、語を分けて組み立てる（text-violation.test.ts と同じ）。
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')
const RUNTIME_SETUP_LINE = 'To restore it, call the `runtime_setup` tool (it fetches the runtime dependencies).'
const SLIDE_SYNC_LINE = 'Relinking node_modules with slide_sync (node_modules_only: true) restores it.'

const HookOutputSchema = z.strictObject({
  hookSpecificOutput: z.strictObject({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string(),
  }).optional(),
})

const FILE_TOOLS: readonly ToolDefinition[] = [fileLintTool, fileValidateTool, fileBriefTool]

const workDirectory = useTemporaryDirectory('pecotv-test-file-tools-', { hook: 'all', resolveRealPath: true })

interface Shared {
  connected?: ConnectedMcp
  // 多くのケースが共用する talk-dir
  talk: string
}

const shared: Shared = { talk: '' }

beforeAll(async () => {
  assertTemplatePluginsBuilt()
  shared.connected = await connectMcp(FILE_TOOLS)
  shared.talk = await createTalkDirectory(workDirectory(), 'talk')
})

afterEach(() => {
  vi.mocked(spawnPromise).mockImplementation(realSpawn)
  resetPluginRoot()
})

afterAll(async () => {
  if (shared.connected !== undefined) await closeMcp(shared.connected)
  rmSync(workDirectory(), { recursive: true, force: true })
})

/**
ツールを呼び、応答の形を確かめてから additionalContext を返す。知らせが無ければ undefined。
*/
async function callHook(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<string | undefined> {
  if (shared.connected === undefined) throw new Error('サーバへ接続できていません')
  const result = await shared.connected.client.callTool({ name, arguments: { ...arguments_ } })
  expect(result.isError ?? false).toBe(false)
  expect(result.content).toHaveLength(1)
  const [block] = result.content
  expect(block?.type).toBe('text')
  expect(JSON.parse(block?.type === 'text' ? block.text : '')).toEqual(result.structuredContent)
  return HookOutputSchema.parse(result.structuredContent).hookSpecificOutput?.additionalContext
}

function writePage(talkDirectory: string, name: string, frontmatter: readonly string[]): string {
  const page = path.join(talkDirectory, 'pages', name)
  mkdirSync(path.dirname(page), { recursive: true })
  writeFileSync(page, ['---', ...frontmatter, '---', ''].join('\n'))
  return page
}

function writeFile(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

/**
command の引数のどれかが suffix で終わる起動だけ answer に差し替える。ほかは実物を起動する。
*/
function interceptSpawn(suffix: string, answer: () => Promise<SpawnResult>): void {
  vi.mocked(spawnPromise).mockImplementation(async (command, arguments_, options) =>
    arguments_.some(argument => argument.endsWith(suffix)) ? answer() : realSpawn(command, arguments_, options))
}

function spawnResult(fields: Partial<SpawnResult>): SpawnResult {
  // eslint-disable-next-line unicorn/no-null -- SpawnResult の signal は、シグナルで終わらなければ null
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...fields }
}

// eslint-disable-next-line unicorn/no-null -- 時間切れの SpawnResult は exitCode が null
const TIMED_OUT: Partial<SpawnResult> = { exitCode: null, signal: 'SIGTERM', timedOut: true }

function referencesDirectory(talkDirectory: string): string {
  return path.join(talkDirectory, 'node_modules', THEME_PACKAGE, 'references')
}

interface EslintEnding {
  readonly name: string
  readonly result: Partial<SpawnResult>
  readonly expected: string
}

const ESLINT_ENDINGS: readonly EslintEnding[] = [
  { name: '時間切れ', result: TIMED_OUT, expected: '  eslint timed out (over 30 seconds).' },
  {
    name: 'クラッシュの見出し',
    result: { exitCode: 2, stdout: 'Oops! Something went wrong! :(' },
    expected: '  eslint crashed (exit 2 / config resolution failure, plugin load failure, etc.).',
  },
  {
    name: '致命的なエラー',
    result: { exitCode: 2, stderr: 'boom' },
    expected: '  eslint exited with a fatal error (exit 2 / config resolution failure, etc.).',
  },
  { name: '違反の無い exit 1', result: { exitCode: 1 }, expected: '  eslint exited abnormally (exit 1).' },
]

/**
pecot-text-lint の代わりの bin を持つプラグインルートを作り、resolvePluginRoot をそこへ向ける。
*/
function stubTextLintBin(script: string): void {
  const root = workDirectory('stub-root', String(Math.random()).slice(2))
  writeFile(path.join(root, 'vendor', 'text-rules', 'dist', 'bin', 'pecot-text-lint.js'), script)
  stubPluginRoot(root)
}

function gitRepository(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const result = spawnSync('git', ['init', '-q', directory], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git init に失敗しました: ${result.stderr}`)
  return directory
}

describe('file_lint', () => {
  it('talk-dir のページに違反があると、eslint の違反を知らせる', async (context) => {
    await verifies(context, 'PV-FILE-LINT-01')
    await explains('フックが呼ぶ `file_lint` の、talk-dir のページの lint のテストです。見出しが長すぎるページを渡した場合に、`eslint` の違反（`text-constraints/max-chars`）を通知することを確認します。')
    const page = writePage(shared.talk, 'long.md', ['layout: plain', `heading: ${LONG_HEADING}`])

    const notice = await callHook('file_lint', { file_path: page })

    const lines = notice?.split('\n') ?? []
    expect(lines[0]).toBe(`warning: eslint violations: ${page}`)
    expect(notice).toContain('text-constraints/max-chars')
    expect(lines.at(-1)).toBe('  The output above lists the eslint violations in this file.')
  })

  it('違反の無いページを渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-03')
    await explains('フックが呼ぶ `file_lint` の、talk-dir のページの lint のテストです。違反のないページを渡した場合に、通知を返さないことを確認します。')
    const page = writePage(shared.talk, 'clean.md', ['layout: plain', 'heading: 短い見出し'])

    expect(await callHook('file_lint', { file_path: page })).toBeUndefined()
  })

  it.for([
    { name: 'pages 自体が talk-dir の外へのリンク', kind: 'pages' },
    { name: 'pages の下のディレクトリがリンク', kind: 'sub' },
    { name: '祖先のディレクトリがリンク', kind: 'ancestor' },
    { name: '編集したファイル自体がリンク', kind: 'file' },
  ])('$name のときも、違反を知らせる', async ({ kind }, context) => {
    await verifies(context, 'PV-FILE-LINT-01')
    await explains('フックが呼ぶ `file_lint` の、シンボリックリンクを含む配置のテストです。`pages` や祖先のディレクトリ、ファイル自体がリンクの場合も、違反のあるページに対して `eslint` の違反を通知することを確認します。')
    const root = workDirectory('topology', kind)
    const real = await createTalkDirectory(root, 'talk')
    const outside = path.join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    const violation = ['---', 'layout: plain', `heading: ${LONG_HEADING}`, '---', ''].join('\n')
    const arrange = (): string => {
      switch (kind) {
        case 'pages': {
          rmSync(path.join(real, 'pages'), { recursive: true, force: true })
          writeFile(path.join(outside, 'violation.md'), violation)
          symlinkSync(outside, path.join(real, 'pages'))
          return path.join(real, 'pages', 'violation.md')
        }
        case 'sub': {
          writeFile(path.join(outside, 'violation.md'), violation)
          symlinkSync(outside, path.join(real, 'pages', 'shared'))
          return path.join(real, 'pages', 'shared', 'violation.md')
        }
        case 'ancestor': {
          writePage(real, 'violation.md', ['layout: plain', `heading: ${LONG_HEADING}`])
          symlinkSync(root, workDirectory('topology', 'ancestor-link'))
          return workDirectory('topology', 'ancestor-link', 'talk', 'pages', 'violation.md')
        }
        default: {
          writeFile(path.join(outside, 'violation.md'), violation)
          symlinkSync(path.join(outside, 'violation.md'), path.join(real, 'pages', 'violation.md'))
          return path.join(real, 'pages', 'violation.md')
        }
      }
    }
    const edited = arrange()

    const notice = await callHook('file_lint', { file_path: edited })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: eslint violations: ${edited}`)
    expect(notice).toContain('text-constraints/max-chars')
  })

  it('テーマが node_modules に張られていないと、lint しなかったことと slide_sync の案内を返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、テーマが未リンクの場合のテストです。`node_modules` にテーマが存在しないときに、`eslint` を実行しなかったことと `slide_sync` の案内を通知することを確認します。')
    const unlinked = await createTalkDirectory(workDirectory('unlinked'), 'talk')
    rmSync(path.join(unlinked, 'node_modules', THEME_PACKAGE), { force: true })
    const page = writePage(unlinked, 'cover.md', ['layout: plain', 'heading: 見出し'])

    const notice = await callHook('file_lint', { file_path: page })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: eslint not run: ${page}`)
    expect(notice).toContain('(reason: theme-unlinked)')
    expect(notice).toContain(SLIDE_SYNC_LINE)
    expect(notice?.split('\n').at(-1)).toBe('  No eslint result exists for this file, so violations have not been detected.')
  })

  it('eslint と設定が無いと、lint しなかったことと runtime_setup の案内を返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、実行環境が不完全な場合のテストです。`eslint` と設定が存在しないときに、`eslint` を実行しなかったことと `runtime_setup` の案内を通知することを確認します。')
    stubPluginRoot(workDirectory('empty-root'))
    const page = writePage(shared.talk, 'cover.md', ['layout: plain', 'heading: 見出し'])

    const notice = await callHook('file_lint', { file_path: page })

    expect(notice).toContain('The lint environment is incomplete (missing: node_modules/eslint, deck-lint.env.config.js / theme: ')
    expect(notice).toContain(RUNTIME_SETUP_LINE)
  })

  it.for(ESLINT_ENDINGS)('eslint の終わり方が $name なら、違反と言わずに lint しなかったことを返す', async ({ result, expected }, context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、`eslint` が異常終了した場合のテストです。時間切れやクラッシュなどで終了したときに、違反とは通知せず、実行しなかったことと終わり方に応じた理由を通知することを確認します。')
    interceptSpawn('eslint.js', () => Promise.resolve(spawnResult(result)))
    const page = writePage(shared.talk, 'cover.md', ['layout: plain', 'heading: 見出し'])

    const notice = await callHook('file_lint', { file_path: page })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: eslint not run: ${page}`)
    expect(notice?.split('\n')).toContain(expected)
  })

  it('eslint が base path の外と判定すると、lint を飛ばしたことを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、`eslint` が対象をlint しなかった場合のテストです。`eslint` が基準のパスの外と判定したときに、lint を省略したことを通知することを確認します。')
    interceptSpawn('eslint.js', () => Promise.resolve(spawnResult({ stdout: 'File ignored because outside of base path.' })))
    const page = writePage(shared.talk, 'cover.md', ['layout: plain', 'heading: 見出し'])

    const notice = await callHook('file_lint', { file_path: page })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: eslint skipped: ${page}`)
    expect(notice).toContain('No lint ran, so violations in this file have not been detected.')
  })

  it('違反の文が上限を超えると、3500 バイトで切って残りの件数を書く', async (context) => {
    await verifies(context, 'PV-FILE-LINT-05')
    await explains('フックが呼ぶ `file_lint` の、通知の長さの上限のテストです。`eslint` の違反が多数ある場合に、通知を 3500 バイトで切り、表示しなかった違反の件数を末尾に書くことを確認します。')
    const violations = Array.from({ length: 120 }, (_, index) => `  ${String(index + 1)}:1  error  too long  text-constraints/max-chars`)
    interceptSpawn('eslint.js', () => Promise.resolve(spawnResult({ exitCode: 1, stdout: ['', '/talk/pages/x.md', ...violations].join('\n') })))
    const page = writePage(shared.talk, 'cover.md', ['layout: plain', 'heading: 見出し'])

    const notice = await callHook('file_lint', { file_path: page })

    expect(notice?.split('\n').at(-1)).toMatch(/^ {2}Truncated at 3500 bytes: \d+ more violations not shown\.$/)
  })

  it('git のリポジトリの中のファイルに文章の違反があると、pecot-text-lint の違反を知らせる', async (context) => {
    await verifies(context, 'PV-FILE-LINT-02')
    await explains('フックが呼ぶ `file_lint` の、git のリポジトリ内のファイルの lint のテストです。文章の規則に違反するファイルを渡した場合に、`pecot-text-lint` の違反（`no-ai-hype-expressions`）を通知することを確認します。')
    const repository = gitRepository(workDirectory('repository'))
    const note = writeFile(path.join(repository, 'docs', 'note.md'), `# 見出し\n\n${HYPE}\n`)

    const notice = await callHook('file_lint', { file_path: note })

    const lines = notice?.split('\n') ?? []
    expect(lines[0]).toBe(`warning: text lint violations: ${note}`)
    expect(notice).toContain('no-ai-hype-expressions')
    expect(lines.at(-1)).toBe('  The text above does not satisfy the writing rules. The rules stay enabled.')
  })

  it('talk-dir の README は、eslint でなく文章の規則で調べる', async (context) => {
    await verifies(context, 'PV-FILE-LINT-02')
    await explains('フックが呼ぶ `file_lint` の、talk-dir の `README.md` の lint のテストです。`eslint` ではなく文章の規則で lint し、違反を `pecot-text-lint` の違反として通知することを確認します。')
    const readme = writeFile(path.join(shared.talk, 'README.md'), `# 見出し\n\n${HYPE}\n`)

    const notice = await callHook('file_lint', { file_path: readme })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: text lint violations: ${readme}`)
  })

  it('リポのルートの .textlintignore で外したファイルは、cwd がサブディレクトリでも空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-02')
    await explains('フックが呼ぶ `file_lint` の、`.textlintignore` の扱いのテストです。リポジトリのルートの `.textlintignore` で除外したファイルは、`cwd` がサブディレクトリでもlint せず、通知を返さないことを確認します。')
    const repository = gitRepository(workDirectory('ignored-repository'))
    writeFile(path.join(repository, '.textlintignore'), 'specs/**\n')
    const spec = writeFile(path.join(repository, 'specs', '001', 'spec.md'), `# 見出し\n\n${HYPE}\n`)

    expect(await callHook('file_lint', { file_path: spec, cwd: path.join(repository, 'specs') })).toBeUndefined()
  })

  it('git の外のファイルは、cwd の .textlintignore を読む', async (context) => {
    await verifies(context, 'PV-FILE-LINT-02')
    await explains('フックが呼ぶ `file_lint` の、`.textlintignore` の扱いのテストです。git のリポジトリの外のファイルを渡した場合に、`cwd` の `.textlintignore` で除外されたファイルをlint せず、通知を返さないことを確認します。')
    const plain = workDirectory('plain')
    writeFile(path.join(plain, '.textlintignore'), 'specs/**\n')
    const spec = writeFile(path.join(plain, 'specs', 'spec.md'), `# 見出し\n\n${HYPE}\n`)

    expect(await callHook('file_lint', { file_path: spec, cwd: plain })).toBeUndefined()
  })

  it('文章の違反の無いファイルを渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-03')
    await explains('フックが呼ぶ `file_lint` の、文章の規則の lint のテストです。違反のないファイルを渡した場合に、通知を返さないことを確認します。')
    const note = writeFile(workDirectory('clean', 'note.md'), '# 見出し\n\n処理の流れを説明します。\n')

    expect(await callHook('file_lint', { file_path: note })).toBeUndefined()
  })

  it('pecot-text-lint が無いと、調べなかったことと runtime_setup の案内を返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、`pecot-text-lint` が存在しない場合のテストです。実行ファイルが見つからないときに、lint を実行しなかったことと `runtime_setup` の案内を通知することを確認します。')
    stubPluginRoot(workDirectory('empty-root'))
    const note = writeFile(workDirectory('missing-bin', 'note.md'), '# 見出し\n')

    const notice = await callHook('file_lint', { file_path: note })

    const lines = notice?.split('\n') ?? []
    expect(lines[0]).toBe(`warning: text lint not run: ${note}`)
    expect(notice).toContain('pecot-text-lint is missing (')
    expect(notice).toContain(RUNTIME_SETUP_LINE)
    expect(lines.at(-1)).toBe('  The writing rules were not applied to this file, so no violations were detected.')
  })

  it.for([
    { name: 'exit 2', script: 'process.stderr.write("boom: 設定を読めない\\n"); process.exit(2)\n', expected: ['  pecot-text-lint failed (exit 2):', '  boom: 設定を読めない'] },
    { name: '出力の無い exit 1', script: 'process.exit(1)\n', expected: ['  pecot-text-lint failed (exit 1):'] },
  ])('pecot-text-lint が $name で終わると、違反と言わずに調べなかったことを返す', async ({ script, expected }, context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、`pecot-text-lint` が異常終了した場合のテストです。終了コードが 2 の場合と、出力のない終了コード 1 の場合に、違反とは通知せず、実行しなかったことと終了コードを通知することを確認します。')
    stubTextLintBin(script)
    const note = writeFile(workDirectory('stub-exit', 'note.md'), '# 見出し\n')

    const notice = await callHook('file_lint', { file_path: note })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: text lint not run: ${note}`)
    expect(notice?.split('\n')).toEqual(expect.arrayContaining(expected))
  })

  it('pecot-text-lint が時間切れになると、20 秒を超えたことを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-04')
    await explains('フックが呼ぶ `file_lint` の、`pecot-text-lint` の時間切れのテストです。実行が時間切れとなった場合に、20 秒を超えたことを通知することを確認します。')
    interceptSpawn('pecot-text-lint.js', () => Promise.resolve(spawnResult(TIMED_OUT)))
    const note = writeFile(workDirectory('timeout', 'note.md'), '# 見出し\n')

    const notice = await callHook('file_lint', { file_path: note })

    expect(notice?.split('\n')).toContain('  pecot-text-lint timed out (over 20 seconds).')
  })

  it('文章の違反が上限を超えると、3000 バイトで切って残りの件数を書く', async (context) => {
    await verifies(context, 'PV-FILE-LINT-05')
    await explains('フックが呼ぶ `file_lint` の、通知の長さの上限のテストです。文章の違反が多数ある場合に、通知を 3000 バイトで切り、表示しなかった違反の件数を末尾に書くことを確認します。')
    stubTextLintBin('for (let i = 1; i <= 200; i++) console.log(`  note.md:${i}:1 no-ai-words 違反の例です`)\nprocess.exit(1)\n')
    const note = writeFile(workDirectory('many', 'note.md'), '# 見出し\n')

    const notice = await callHook('file_lint', { file_path: note })

    expect(notice?.split('\n').at(-1)).toMatch(/^ {2}Truncated at 3000 bytes: \d+ more violations not shown\.$/)
  })

  it('調べる途中で例外が起きても、失敗にせず調べなかったことを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-06')
    await explains('フックが呼ぶ `file_lint` の、lint の途中で例外が発生した場合のテストです。失敗として返さず、lint を実行しなかったことと例外の内容を通知することを確認します。')
    interceptSpawn('pecot-text-lint.js', () => Promise.reject(new Error('spawn exploded')))
    const note = writeFile(workDirectory('exception', 'note.md'), '# 見出し\n')

    const notice = await callHook('file_lint', { file_path: note })

    expect(notice?.split('\n', 1)[0]).toBe(`warning: text lint not run: ${note}`)
    expect(notice).toContain('An unexpected error stopped the check: spawn exploded')
  })

  it('調べても、ファイルを書き換えない', async (context) => {
    await verifies(context, 'PV-FILE-LINT-06')
    await explains('フックが呼ぶ `file_lint` の、ファイルの保全のテストです。違反のあるページをlint した後も、ページの内容がlint の前と変わらないことを確認します。')
    const page = writePage(shared.talk, 'untouched.md', ['layout: plain', `heading: ${LONG_HEADING}`])
    const before = readFileSync(page, 'utf8')

    await callHook('file_lint', { file_path: page })

    expect(readFileSync(page, 'utf8')).toBe(before)
  })

  it('ほかのツールの実行中に呼ぶと、キューで待たずに返る', async (context) => {
    await verifies(context, 'PV-FILE-LINT-07')
    await explains('フックが呼ぶ `file_lint` の、並行して実行する場合のテストです。ほかのツールの実行中に呼んだ場合は、キューで待たずに応答を返すことを確認します。')
    expect(await callWhileAnotherToolRuns(fileLintTool.name)).toEqual({})
  })

  it('空の file_path を渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-LINT-03')
    await explains('フックが呼ぶ `file_lint` の、入力の検証のテストです。`file_path` に空の文字列を渡した場合に、通知を返さないことを確認します。')

    expect(await callHook('file_lint', { file_path: '' })).toBeUndefined()
  })
})

describe('file_validate', () => {
  it('参照の yaml に違反があると、参照の dir 全体の検証の結果を知らせる', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-01')
    await explains('フックが呼ぶ `file_validate` の、参照の yaml の検証のテストです。違反のある yaml を渡した場合に、参照のディレクトリ全体の検証の結果と、違反の内容を通知することを確認します。')
    const violated = await createTalkDirectory(workDirectory('violated'), 'talk')
    const yaml = writeFile(path.join(referencesDirectory(violated), 'plain.yaml'), '- title: x\n  bogus_key: 1\n')

    const notice = await callHook('file_validate', { file_path: yaml })

    const lines = notice?.split('\n') ?? []
    expect(lines[0]).toMatch(/^warning: references schema violations: \d+ files checked, \d+ error\(s\) found\.$/)
    expect(notice).toContain(`validation result for the whole references directory (edited file: ${yaml})`)
    expect(notice).toContain('must be object')
    expect(notice).not.toContain('layout_categories')
  })

  it('category の無い yaml には、語彙の元と slide_sync の案内を添える', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-01')
    await explains('フックが呼ぶ `file_validate` の、`category` が存在しない yaml のテストです。必須の項目が不足している違反とともに、`layout_categories` の参照元と `slide_sync` の案内を通知することを確認します。')
    const noCategory = await createTalkDirectory(workDirectory('no-category'), 'talk')
    const yaml = path.join(referencesDirectory(noCategory), 'plain.yaml')
    writeFile(yaml, readFileSync(yaml, 'utf8').split('\n').filter(line => !line.startsWith('category:')).join('\n'))

    const notice = await callHook('file_validate', { file_path: yaml })

    expect(notice).toContain('required property \'category\'')
    expect(notice).toContain('layout_categories')
    expect(notice).toContain('relinking node_modules with slide_sync (node_modules_only: true)')
  })

  it('正しい参照の yaml を渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-01')
    await explains('フックが呼ぶ `file_validate` の、参照の yaml の検証のテストです。正しい yaml を渡した場合に、通知を返さないことを確認します。')
    const yaml = path.join(referencesDirectory(shared.talk), 'plain.yaml')

    expect(await callHook('file_validate', { file_path: yaml })).toBeUndefined()
  })

  it.for([
    { name: '_template.yaml', file: 'node_modules/slidev-theme-pecotv-test-declared/references/_template.yaml' },
    { name: '参照の dir の外の yaml', file: 'refs/plain.yaml' },
    { name: 'yaml でないファイル', file: 'node_modules/slidev-theme-pecotv-test-declared/references/notes.md' },
  ])('$name を渡すと、検証せずに空のオブジェクトを返す', async ({ file }, context) => {
    await verifies(context, 'PV-FILE-VALIDATE-02')
    await explains('フックが呼ぶ `file_validate` の、検証の対象外のファイルのテストです。`_template.yaml`、参照のディレクトリの外の yaml、yaml でないファイルを渡した場合に、検証せず、通知を返さないことを確認します。')
    const target = writeFile(path.join(shared.talk, file), '- title: x\n')

    expect(await callHook('file_validate', { file_path: target })).toBeUndefined()
  })

  it('テーマが node_modules に張られていないと、検証しなかったことと slide_sync の案内を返す', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-03')
    await explains('フックが呼ぶ `file_validate` の、テーマが未リンクの場合のテストです。`node_modules` にテーマが存在しないときに、検証しなかったことと `slide_sync` の案内を通知することを確認します。')
    const unlinked = await createTalkDirectory(workDirectory('validate-unlinked'), 'talk')
    rmSync(path.join(unlinked, 'node_modules', THEME_PACKAGE), { force: true })
    const yaml = writeFile(path.join(unlinked, 'references', 'plain.yaml'), 'layout: plain\n')

    const notice = await callHook('file_validate', { file_path: yaml })

    const lines = notice?.split('\n') ?? []
    expect(lines[0]).toBe(`warning: references validation not run: ${yaml}`)
    expect(notice).toContain('(reason: theme-unlinked)')
    expect(notice).toContain(SLIDE_SYNC_LINE)
    expect(lines.at(-1)).toBe('  No validation ran for this file, so violations have not been detected.')
  })

  it('validator が無いと、検証しなかったことと runtime_setup の案内を返す', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-03')
    await explains('フックが呼ぶ `file_validate` の、実行環境が不完全な場合のテストです。検証用のスクリプトが存在しないときに、検証しなかったことと `runtime_setup` の案内を通知することを確認します。')
    stubPluginRoot(workDirectory('empty-root'))
    const yaml = path.join(referencesDirectory(shared.talk), 'plain.yaml')

    const notice = await callHook('file_validate', { file_path: yaml })

    expect(notice).toContain('The validation environment is incomplete (missing: assets/slidev/scripts/eslint/validate-references/dist/index.js')
    expect(notice).toContain(RUNTIME_SETUP_LINE)
  })

  it('validator が時間切れになると、30 秒を超えたことを返す', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-03')
    await explains('フックが呼ぶ `file_validate` の、時間切れのテストです。検証が時間切れとなった場合に、30 秒を超えたことを通知することを確認します。')
    interceptSpawn('index.js', () => Promise.resolve(spawnResult(TIMED_OUT)))
    const yaml = path.join(referencesDirectory(shared.talk), 'plain.yaml')

    const notice = await callHook('file_validate', { file_path: yaml })

    expect(notice?.split('\n')).toContain('  The validator timed out (over 30 seconds).')
  })

  it('検証しても、参照の yaml を書き換えない', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-04')
    await explains('フックが呼ぶ `file_validate` の、ファイルの保全のテストです。違反のある yaml を検証した後も、yaml の内容が検証の前と変わらないことを確認します。')
    const untouched = await createTalkDirectory(workDirectory('validate-untouched'), 'talk')
    const yaml = writeFile(path.join(referencesDirectory(untouched), 'plain.yaml'), '- title: x\n  bogus_key: 1\n')

    await callHook('file_validate', { file_path: yaml })

    expect(readFileSync(yaml, 'utf8')).toBe('- title: x\n  bogus_key: 1\n')
  })

  it('ほかのツールの実行中に呼ぶと、キューで待たずに返る', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-05')
    await explains('フックが呼ぶ `file_validate` の、並行して実行する場合のテストです。ほかのツールの実行中に呼んだ場合は、キューで待たずに応答を返すことを確認します。')
    expect(await callWhileAnotherToolRuns(fileValidateTool.name)).toEqual({})
  })

  it('空の file_path を渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-VALIDATE-02')
    await explains('フックが呼ぶ `file_validate` の、入力の検証のテストです。`file_path` に空の文字列を渡した場合に、通知を返さないことを確認します。')

    expect(await callHook('file_validate', { file_path: '' })).toBeUndefined()
  })
})

describe('file_brief', () => {
  it('ページの layout の参照の yaml から、規約の節を原文のまま返す', async (context) => {
    await verifies(context, 'PV-FILE-BRIEF-01')
    await explains('フックが呼ぶ `file_brief` の、規約の通知のテストです。ページの `layout` に対応する参照の yaml がある場合に、`best_practices` と `anti_patterns` の節を原文のまま通知することを確認します。')
    const page = writePage(shared.talk, 'brief.md', ['layout: plain', 'heading: 見出し'])
    const yaml = path.join(shared.talk, 'node_modules', THEME_PACKAGE, 'references', 'plain.yaml')

    const notice = await callHook('file_brief', { file_path: page })

    expect(notice).toBe([
      `${yaml}:`,
      '',
      'best_practices:',
      '  - \'1 枚で伝える内容を 1 つに絞る\'',
      '',
      'anti_patterns:',
      '  - \'見出しに文章を書く\'',
    ].join('\n'))
  })

  it.for([
    { name: 'layout の無いページ', file: 'no-layout.md', frontmatter: ['heading: 見出し'] },
    { name: '参照の yaml の無い layout', file: 'unknown-layout.md', frontmatter: ['layout: no-such-layout'] },
    { name: 'パスを含む layout', file: 'path-layout.md', frontmatter: ['layout: ../plain'] },
  ])('$name を渡すと、空のオブジェクトを返す', async ({ file, frontmatter }, context) => {
    await verifies(context, 'PV-FILE-BRIEF-02')
    await explains('フックが呼ぶ `file_brief` の、規約を通知しない場合のテストです。`layout` がないページ、参照の yaml がない `layout`、パスを含む `layout` の場合に、通知を返さないことを確認します。')
    const page = writePage(shared.talk, file, frontmatter)

    expect(await callHook('file_brief', { file_path: page })).toBeUndefined()
  })

  it('テーマが node_modules に張られていないと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-BRIEF-02')
    await explains('フックが呼ぶ `file_brief` の、テーマが未リンクの場合のテストです。`node_modules` にテーマが存在しないときに、通知を返さないことを確認します。')
    const unlinked = await createTalkDirectory(workDirectory('brief-unlinked'), 'talk')
    rmSync(path.join(unlinked, 'node_modules', THEME_PACKAGE), { force: true })
    const page = writePage(unlinked, 'cover.md', ['layout: plain'])

    expect(await callHook('file_brief', { file_path: page })).toBeUndefined()
  })

  it.for([
    { name: 'slides.md', file: 'slides.md' },
    { name: 'talk-dir の README', file: 'README.md' },
  ])('$name を渡すと、空のオブジェクトを返す', async ({ file }, context) => {
    await verifies(context, 'PV-FILE-BRIEF-03')
    await explains('フックが呼ぶ `file_brief` の、規約を通知しない場合のテストです。`slides.md` と talk-dir の `README.md` を渡した場合に、通知を返さないことを確認します。')

    expect(await callHook('file_brief', { file_path: path.join(shared.talk, file) })).toBeUndefined()
  })

  it('規約を返しても、ページを書き換えない', async (context) => {
    await verifies(context, 'PV-FILE-BRIEF-04')
    await explains('フックが呼ぶ `file_brief` の、ファイルの保全のテストです。規約を通知した後も、ページの内容が呼び出しの前と変わらないことを確認します。')
    const page = writePage(shared.talk, 'brief-untouched.md', ['layout: plain', 'heading: 見出し'])
    const before = readFileSync(page, 'utf8')

    await callHook('file_brief', { file_path: page })

    expect(readFileSync(page, 'utf8')).toBe(before)
  })

  it('ほかのツールの実行中に呼ぶと、キューで待たずに返る', async (context) => {
    await verifies(context, 'PV-FILE-BRIEF-05')
    await explains('フックが呼ぶ `file_brief` の、並行して実行する場合のテストです。ほかのツールの実行中に呼んだ場合は、キューで待たずに応答を返すことを確認します。')
    expect(await callWhileAnotherToolRuns(fileBriefTool.name)).toEqual({})
  })

  it('空の file_path を渡すと、空のオブジェクトを返す', async (context) => {
    await verifies(context, 'PV-FILE-BRIEF-03')
    await explains('フックが呼ぶ `file_brief` の、入力の検証のテストです。`file_path` に空の文字列を渡した場合に、通知を返さないことを確認します。')

    expect(await callHook('file_brief', { file_path: '' })).toBeUndefined()
  })
})

async function callWhileAnotherToolRuns(name: string): Promise<unknown> {
  const tool = FILE_TOOLS.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`unknown tool: ${name}`)
  const gate = Promise.withResolvers<undefined>()
  const slow: ToolDefinition = {
    name: 'slow',
    config: { title: 'Test tool', inputSchema: z.object({}) },
    handler: async () => {
      await gate.promise
      return { content: [{ type: 'text', text: 'slow' }] }
    },
  }
  const parallel = await connectMcp([slow, tool])
  try {
    const slowCall = parallel.client.callTool({ name: 'slow', arguments: {} })
    const hook = await parallel.client.callTool({ name: tool.name, arguments: { file_path: workDirectory('no-such-file.txt') } })
    gate.resolve(undefined)
    await slowCall

    return hook.structuredContent
  }
  finally {
    await closeMcp(parallel)
  }
}
