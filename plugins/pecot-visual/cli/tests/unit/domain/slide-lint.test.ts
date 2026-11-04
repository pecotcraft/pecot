// domain/slidev-project/lint.ts の unit test。
// eslint は fake EslintRunner で差し替える。
// 検証するのは、SpawnResult → SlideLintSummary の整形と例外変換のみ。
// 実 eslint 起動は integration/commands/slide-lint.test.ts が見る。

import { describe, expect, it } from 'vitest'

import type { SpawnResult } from '../../../src/domain/_shared/spawn-result.js'
import type { DeckLintInput } from '../../../src/domain/slidev-theme/deck-lint-input.js'
import type {
  EslintRunArguments,
  SlideLintDependencies,
  SlideLintFsAdapter,
} from '../../../src/domain/slidev-project/lint.js'
import {
  SlideLintRuntimeError,
  SlideLintUsageError,
  runSlideLint,
  toRelativePath,
} from '../../../src/domain/slidev-project/lint.js'

const TALK_DIR = '/tmp/talk'
const ASSETS_DIR = '/plugin/assets/slidev'
const DECK_LINT_CONFIG = '/plugin/assets/slidev/deck-lint.env.config.js'
const LINT: DeckLintInput = {
  referencesDirectories: ['/tmp/talk/references', '/theme/references'],
  panels: {},
  markerLayouts: [],
  rules: { 'slidev-pages-lint/no-missing-page': 'error' },
}

function spawnResult(overrides: Readonly<Partial<SpawnResult>>): SpawnResult {
  return {
    exitCode: 0,
    // eslint-disable-next-line unicorn/no-null -- SpawnResult の signal は null が既定
    signal: null,
    stdout: '[]',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

function fakeFs(overrides: Readonly<Partial<SlideLintFsAdapter>> = {}): SlideLintFsAdapter {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- fake adapter は同期実装で十分
    talkDirectoryExists: async () => ({ exists: true, isDirectory: true }),
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    doesSlidesMdExist: async () => true,
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    listSkippedSymlinkPageDirectories: async () => [],
    ...overrides,
  }
}

function dependencies(
  result: Readonly<SpawnResult>,
  fs: Readonly<SlideLintFsAdapter> = fakeFs(),
): SlideLintDependencies {
  return {
    assetsDirectory: ASSETS_DIR,
    deckLintConfig: DECK_LINT_CONFIG,
    // eslint-disable-next-line @typescript-eslint/require-await -- fake port は同期実装で十分
    readLint: async () => LINT,
    fs,
    // eslint-disable-next-line @typescript-eslint/require-await -- fake port は同期実装で十分
    eslint: { run: async () => result },
  }
}

describe('runSlideLint 集計', () => {
  it('違反なしは outcome=clean で lint 対象件数を返す', async () => {
    const stdout = JSON.stringify([
      { filePath: `${TALK_DIR}/pages/cover.md`, errorCount: 0, warningCount: 0, messages: [] },
      { filePath: `${TALK_DIR}/slides.md`, errorCount: 0, warningCount: 0, messages: [] },
    ])
    const summary = await runSlideLint({ directory: TALK_DIR }, dependencies(spawnResult({ stdout })))
    expect(summary.outcome).toBe('clean')
    expect(summary.lintedFileCount).toBe(2)
    expect(summary.errorCount).toBe(0)
    expect(summary.violations).toStrictEqual([])
  })

  it('違反ありは outcome=violations で talk-dir 相対パスの一覧を返す', async () => {
    const stdout = JSON.stringify([
      {
        filePath: `${TALK_DIR}/pages/01-intro.md`,
        errorCount: 2,
        warningCount: 1,
        messages: [
          {
            ruleId: 'slidev-pages-lint/no-numeric-filename-prefix',
            message: '数字プレフィックス禁止',
            line: 1,
            column: 0,
          },
          // ruleId / message / line / column 欠落時の既定値。eslint は parse error 等で
          // ruleId: null を返すため、null 自体が検証対象の実データ。
          // eslint-disable-next-line unicorn/no-null -- eslint の JSON 出力を再現する
          { ruleId: null },
        ],
      },
    ])
    const summary = await runSlideLint({ directory: TALK_DIR }, dependencies(spawnResult({ exitCode: 1, stdout })))
    expect(summary.outcome).toBe('violations')
    expect(summary.errorCount).toBe(2)
    expect(summary.warningCount).toBe(1)
    expect(summary.violations).toStrictEqual([
      {
        file: 'pages/01-intro.md',
        line: 1,
        column: 0,
        rule: 'slidev-pages-lint/no-numeric-filename-prefix',
        message: '数字プレフィックス禁止',
      },
      { file: 'pages/01-intro.md', line: 0, column: 0, rule: '(unknown rule)', message: '' },
    ])
  })

  it('件数フィールドを欠く report entry は 0 件 / 違反なしとして扱う', async () => {
    const summary = await runSlideLint(
      { directory: TALK_DIR },
      dependencies(spawnResult({ stdout: '[{}]' })),
    )
    expect(summary.lintedFileCount).toBe(1)
    expect(summary.errorCount).toBe(0)
    expect(summary.warningCount).toBe(0)
    expect(summary.outcome).toBe('clean')
  })

  it('lint 対象 0 件は違反 0 件と区別して outcome=no-target を返す', async () => {
    const summary = await runSlideLint({ directory: TALK_DIR }, dependencies(spawnResult({ stdout: '[]' })))
    expect(summary.outcome).toBe('no-target')
    expect(summary.lintedFileCount).toBe(0)
    expect(summary.errorCount).toBe(0)
  })

  it('symlink dir の検出結果は summary に載るが outcome を動かさない', async () => {
    const fs = fakeFs({
      // eslint-disable-next-line @typescript-eslint/require-await -- fake adapter は同期実装で十分
      listSkippedSymlinkPageDirectories: async () => ['pages/sub'],
    })
    const stdout = JSON.stringify([
      { filePath: `${TALK_DIR}/slides.md`, errorCount: 0, warningCount: 0, messages: [] },
    ])
    const summary = await runSlideLint(
      { directory: TALK_DIR },
      dependencies(spawnResult({ stdout }), fs),
    )
    expect(summary.skippedSymlinkDirectories).toStrictEqual(['pages/sub'])
    expect(summary.outcome).toBe('clean')
  })

  it('lint 対象 0 件でも symlink dir の検出結果は保持する', async () => {
    const fs = fakeFs({
      // eslint-disable-next-line @typescript-eslint/require-await -- 同上
      listSkippedSymlinkPageDirectories: async () => ['pages/sub'],
    })
    const summary = await runSlideLint(
      { directory: TALK_DIR },
      dependencies(spawnResult({ stdout: '[]' }), fs),
    )
    expect(summary.outcome).toBe('no-target')
    expect(summary.skippedSymlinkDirectories).toStrictEqual(['pages/sub'])
  })

  it('EslintRunner に talk-dir・assets dir・deck lint 設定・解釈済みの lint を渡す', async () => {
    const seen: EslintRunArguments[] = []
    await runSlideLint({ directory: TALK_DIR }, {
      assetsDirectory: ASSETS_DIR,
      deckLintConfig: DECK_LINT_CONFIG,
      // eslint-disable-next-line @typescript-eslint/require-await -- fake port は同期実装で十分
      readLint: async () => LINT,
      fs: fakeFs(),
      eslint: {
        // eslint-disable-next-line @typescript-eslint/require-await -- fake port は同期実装で十分
        run: async (arguments_: Readonly<EslintRunArguments>) => {
          seen.push(arguments_)
          return spawnResult({})
        },
      },
    })
    expect(seen).toStrictEqual([
      { talkDirectory: TALK_DIR, assetsDirectory: ASSETS_DIR, deckLintConfig: DECK_LINT_CONFIG, lint: LINT },
    ])
  })
})

describe('runSlideLint の eslint 実行失敗の分岐', () => {
  it('timeout は eslint-timeout（exitCode:null より先に判定する）', async () => {
    // eslint-disable-next-line unicorn/no-null -- SIGTERM 終了時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, timedOut: true, stderr: '' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow(SlideLintRuntimeError)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow('(stderr なし)')
  })

  it('起動失敗 (exitCode:null) は eslint-not-launched', async () => {
    // eslint-disable-next-line unicorn/no-null -- 起動失敗時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, stderr: 'spawn ENOENT' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'eslint-not-launched' })
  })

  it('eslint の exit 2 は eslint-failed に変換し usage error (exit 2) と衝突させない', async () => {
    const result = spawnResult({ exitCode: 2, stdout: '', stderr: 'Oops! Something went wrong!' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'eslint-failed' })
  })

  it('長い stderr は抜粋して報告する', async () => {
    // eslint-disable-next-line unicorn/no-null -- 起動失敗時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, stderr: 'x'.repeat(1000) })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow('...')
  })

  it('JSON として解析できない stdout は invalid-report', async () => {
    const result = spawnResult({ stdout: 'not json' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'invalid-report' })
  })

  it('配列でない JSON は invalid-report', async () => {
    const result = spawnResult({ stdout: '{"a":1}' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'invalid-report' })
  })
})

describe('runSlideLint の talk-dir 検証', () => {
  it('相対パスは usage error (relative-dir)', async () => {
    const dependencies_ = dependencies(spawnResult({}))
    await expect(runSlideLint({ directory: 'relative/talk' }, dependencies_))
      .rejects.toThrow(SlideLintUsageError)
  })

  it('存在しない dir は dir-not-found', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- fake adapter は同期実装で十分
    const fs = fakeFs({ talkDirectoryExists: async () => ({ exists: false, isDirectory: false }) })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'dir-not-found' })
  })

  it('ディレクトリでない path は not-a-directory', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    const fs = fakeFs({ talkDirectoryExists: async () => ({ exists: true, isDirectory: false }) })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'not-a-directory' })
  })

  it('slides.md が無い dir は not-talk-dir', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    const fs = fakeFs({ doesSlidesMdExist: async () => false })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'not-talk-dir' })
  })
})

describe('toRelativePath', () => {
  it('talk-dir 配下は相対パスに畳む', () => {
    expect(toRelativePath('/a/b', '/a/b/pages/x.md')).toBe('pages/x.md')
  })

  it('talk-dir 外 (realpath 解決差) は絶対パスのまま返す', () => {
    expect(toRelativePath('/a/b', '/other/pages/x.md')).toBe('/other/pages/x.md')
  })

  it('talk-dir 自身と空文字はそのまま返す', () => {
    expect(toRelativePath('/a/b', '/a/b')).toBe('/a/b')
    expect(toRelativePath('/a/b', '')).toBe('')
  })
})
