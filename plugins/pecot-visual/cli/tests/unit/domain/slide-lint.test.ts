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
import { explains } from '../../_helpers/explains.js'

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
  it('違反がなければ、outcome を clean にして、lint した件数を返す', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の結果が、2 つのファイルでどちらもエラーと警告が 0 件の場合に、`outcome` が `clean` になり、`lintedFileCount` が 2、違反の一覧が空になることを確認します。')
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

  it('違反があれば、outcome を violations にして、talk-dir からの相対パスで違反の一覧を返す', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の結果にエラーと警告がある場合に、`outcome` が `violations` になり、違反が相対パスで返ることを確認します。')
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

  it('eslint の結果に件数の項目がなければ、0 件で違反なしとして扱う', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の結果が `[{}]` のように件数の項目を持たない場合に、`lintedFileCount` が 1、エラーと警告が 0 件、`outcome` が `clean` になることを確認します。')
    const summary = await runSlideLint(
      { directory: TALK_DIR },
      dependencies(spawnResult({ stdout: '[{}]' })),
    )
    expect(summary.lintedFileCount).toBe(1)
    expect(summary.errorCount).toBe(0)
    expect(summary.warningCount).toBe(0)
    expect(summary.outcome).toBe('clean')
  })

  it('lint の対象のファイルが 0 件なら、違反が 0 件の場合と区別して、outcome を no-target にする', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の結果が空の配列の場合に、`outcome` が `no-target` になり、`lintedFileCount` とエラーの件数が 0 になることを確認します。')
    const summary = await runSlideLint({ directory: TALK_DIR }, dependencies(spawnResult({ stdout: '[]' })))
    expect(summary.outcome).toBe('no-target')
    expect(summary.lintedFileCount).toBe(0)
    expect(summary.errorCount).toBe(0)
  })

  it('シンボリックリンクのディレクトリを見つけた場合は、結果に載せるが、outcome は変えない', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。シンボリックリンクの `pages/sub` がある場合に、結果の `skippedSymlinkDirectories` に載せることを確認します。')
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

  it('lint の対象のファイルが 0 件でも、見つけたシンボリックリンクのディレクトリを結果に載せる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の結果が空で `pages/sub` のシンボリックリンクがある場合に、`outcome` が `no-target` になることを確認します。')
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

  it('eslint の実行には、talk-dir・assets のディレクトリ・deck lint の設定・読み取った lint の設定を渡す', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の実行に渡す引数として、`talkDirectory`・`assetsDirectory`・`deckLintConfig`・`lint` を、指定した値で 1 回だけ渡すことを確認します。')
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
  it('eslint が時間切れになった場合は、終了コードが null でも、時間切れの例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。`timedOut` が `true` で終了コードが `null` の場合に、`SlideLintRuntimeError` が発生することを確認します。')
    // eslint-disable-next-line unicorn/no-null -- SIGTERM 終了時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, timedOut: true, stderr: '' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow(SlideLintRuntimeError)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow('(no stderr)')
  })

  it('eslint を起動できなかった場合は、理由が eslint-not-launched の例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。終了コードが `null` で、標準エラーに `spawn ENOENT` がある場合に、理由が `eslint-not-launched` の例外が発生することを確認します。')
    // eslint-disable-next-line unicorn/no-null -- 起動失敗時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, stderr: 'spawn ENOENT' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'eslint-not-launched' })
  })

  it('eslint が終了コード 2 で終了した場合は、使い方の誤りと区別して、理由が eslint-failed の例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の終了コードが 2 で、標準出力が空の場合に、理由が `eslint-failed` の例外が発生することを確認します。')
    const result = spawnResult({ exitCode: 2, stdout: '', stderr: 'Oops! Something went wrong!' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'eslint-failed' })
  })

  it('標準エラーが長い場合は、一部を抜粋してメッセージに載せる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。標準エラーが 1000 文字の `x` の場合に、発生する例外のメッセージに省略を表す `...` が含まれることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- 起動失敗時の SpawnResult 契約
    const result = spawnResult({ exitCode: null, stderr: 'x'.repeat(1000) })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toThrow('...')
  })

  it('標準出力が JSON として読み取れない場合は、理由が invalid-report の例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の標準出力が `not json` の場合に、理由が `invalid-report` の例外が発生することを確認します。')
    const result = spawnResult({ stdout: 'not json' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'invalid-report' })
  })

  it('標準出力が配列ではない JSON の場合も、理由が invalid-report の例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。eslint の標準出力が `{"a":1}` のように配列ではない JSON の場合に、理由が `invalid-report` の例外が発生することを確認します。')
    const result = spawnResult({ stdout: '{"a":1}' })
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies(result)))
      .rejects.toMatchObject({ reason: 'invalid-report' })
  })
})

describe('runSlideLint の talk-dir 検証', () => {
  it('talk-dir に相対パスを指定すると、使い方の誤りの例外が発生する', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。`directory` に `relative/talk` のような相対パスを渡した場合に、`SlideLintUsageError` が発生することを確認します。')
    const dependencies_ = dependencies(spawnResult({}))
    await expect(runSlideLint({ directory: 'relative/talk' }, dependencies_))
      .rejects.toThrow(SlideLintUsageError)
  })

  it('talk-dir が存在しない場合は、理由が dir-not-found の例外を発生させる', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。指定したディレクトリが存在しない場合に、理由が `dir-not-found` の例外が発生することを確認します。')
    // eslint-disable-next-line @typescript-eslint/require-await -- fake adapter は同期実装で十分
    const fs = fakeFs({ talkDirectoryExists: async () => ({ exists: false, isDirectory: false }) })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'dir-not-found' })
  })

  it('talk-dir にディレクトリではないパスを指定すると、理由が not-a-directory の例外が発生する', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。指定したパスが存在するがディレクトリではない場合に、理由が `not-a-directory` の例外が発生することを確認します。')
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    const fs = fakeFs({ talkDirectoryExists: async () => ({ exists: true, isDirectory: false }) })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'not-a-directory' })
  })

  it('slides.md が存在しないディレクトリを指定すると、理由が not-talk-dir の例外が発生する', async () => {
    await explains('スライドを lint する `runSlideLint` のテストです。`slides.md` が存在しないディレクトリを指定した場合に、理由が `not-talk-dir` の例外が発生することを確認します。')
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    const fs = fakeFs({ doesSlidesMdExist: async () => false })
    const dependencies_ = dependencies(spawnResult({}), fs)
    await expect(runSlideLint({ directory: TALK_DIR }, dependencies_))
      .rejects.toMatchObject({ reason: 'not-talk-dir' })
  })
})

describe('toRelativePath', () => {
  it('talk-dir の配下のパスは、talk-dir からの相対パスにして返す', async () => {
    await explains('`toRelativePath` のテストです。`/a/b` の配下の `/a/b/pages/x.md` を渡した場合に、`pages/x.md` を返すことを確認します。')
    expect(toRelativePath('/a/b', '/a/b/pages/x.md')).toBe('pages/x.md')
  })

  it('talk-dir の外のパスは、絶対パスのまま返す', async () => {
    await explains('`toRelativePath` のテストです。`/a/b` の外にある `/other/pages/x.md` を渡した場合に、変換せずにそのまま返すことを確認します。')
    expect(toRelativePath('/a/b', '/other/pages/x.md')).toBe('/other/pages/x.md')
  })

  it('talk-dir 自身を指すパスと空文字は、そのまま返す', async () => {
    await explains('`toRelativePath` のテストです。`/a/b` 自身と空文字を渡した場合に、どちらも変換せずにそのまま返すことを確認します。')
    expect(toRelativePath('/a/b', '/a/b')).toBe('/a/b')
    expect(toRelativePath('/a/b', '')).toBe('')
  })
})
