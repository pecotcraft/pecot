// 実 CLI（`bin/pecotv`）を子プロセスで起動する e2e の共通基盤。
//
// 各 CUJ ファイルが持つべきなのは、「何を注入して何を主張するか」だけ。
// そのため起動条件（env / spawnSync timeout / maxBuffer）と `--json` 行の読み方はここへ集約する。
// timeout 階層の根拠は vitest.e2e.config.ts のコメントを基準とする。
// 階層は it 引数 = testTimeout 660_000 > ここの spawnSync 600_000 = cli 内部の SLIDEV_BUILD_TIMEOUT_MS。

/* eslint-disable security/detect-non-literal-fs-filename -- homedir 由来の Playwright cache を読むため */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
/**
実 CLI のエントリ。strace ルートなど runner を通さず直接起動する CUJ も参照する。
*/
export const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')

/**
build できる fixture テーマの指定を返す re-export。`slide create --theme` に渡す値。
`git+file://` の bare リポジトリを `workDirectory` 配下に作る（theme-repository.ts）。
*/
export { createFixtureThemeSpec, FIXTURE_THEME_NAME } from './theme-repository.js'

const CLI_TS_DIST = path.join(CLI_TS_ROOT, 'dist', 'cli.js')

/**
dist 未ビルドで回すと CLI 起動失敗が CUJ の失敗に化けるため、beforeAll で先に落とす。
*/
export function assertCliBuilt(): void {
  if (!existsSync(CLI_TS_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_TS_DIST}\n先に \`pnpm build\` を実行してください`)
  }
}

/**
Chromium cache 不在環境の skip 判定（cold ダウンロードの所要が読めず ceiling を引けない）。

`chromium-*` ディレクトリの前方一致だけでは、DL 途中の半端な状態を取得済みと誤判定する。
そのため Playwright が取得完了時に置く INSTALLATION_COMPLETE まで見る。
判定基準は、次の 2 つに揃える。
cli/src/infra/playwright/chromium.ts の isChromiumInstalled と、bin/pecotv の `_pecotv_has_chromium`。
*/
export function isChromiumCached(): boolean {
  const cacheRoot = path.join(homedir(), '.cache', 'ms-playwright')
  return existsSync(cacheRoot)
    && readdirSync(cacheRoot)
      .filter(entry => entry.startsWith('chromium-'))
      .some(entry => existsSync(path.join(cacheRoot, entry, 'INSTALLATION_COMPLETE')))
}

export interface PecotvRun {
  readonly status: number | null
  readonly stdout: string
}

export interface PecotvRunnerOptions {
  /**
  console 行の識別子（`[cache-warning/cleanup] warm: ...` の角括弧内）。ファイルごとに分ける。
  */
  readonly logPrefix: string
  /**
  stdout / stderr の tail を一次情報として残す終了コードの判定。exit 1 を期待する CUJ を含む
  ファイルは spawnSync timeout（status null）だけに絞る。
  */
  readonly isUnexpectedExit: (status: number | null) => boolean
}

/**
想定外終了時にログへ残す stdout / stderr の tail の枠（文字数）。省略の印は数えない。
*/
export const OUTPUT_TAIL_LIMIT = 2000

/**
想定外終了時にログへ残す stdout の末尾を切り出す。`--json` の失敗理由（`*.error` 行）は
stdout の最後に出るため、末尾の行から枠に収まるだけ採り、枠を超えた時点でそれより古い行を
丸ごと落とす。行の途中で切り詰めるのは、末尾の行（採用済みの行が無い状態）が単独で枠を
超える場合だけで、そのときは行頭側を残す（`event` / `reason` / `detail` が行頭に並ぶため）。

抜粋であることを読み手が区別できるよう、印を付ける。
古い行を落としたときは先頭に `(省略: 古い N 行)` を付ける。
末尾の行を切り詰めたときはその次の行に `(省略: 上の行の末尾 N 文字)` を付ける。
どちらも JSON 行と見分けが付くよう、丸括弧で始める。
どちらも起きなければ印は付けない。
*/
export function stdoutTail(stdout: string): string {
  const lines = stdout.trimEnd().split('\n')
  const kept: string[] = []
  let used = 0
  let truncatedChars = 0
  for (const line of lines.toReversed()) {
    const cost = line.length + (kept.length > 0 ? 1 : 0)
    if (used + cost > OUTPUT_TAIL_LIMIT) {
      if (kept.length === 0) {
        kept.push(line.slice(0, OUTPUT_TAIL_LIMIT))
        truncatedChars = line.length - OUTPUT_TAIL_LIMIT
      }
      break
    }
    kept.push(line)
    used += cost
  }
  const droppedLines = lines.length - kept.length
  return [
    ...(droppedLines > 0 ? [`(省略: 古い ${String(droppedLines)} 行)`] : []),
    ...kept.toReversed(),
    ...(truncatedChars > 0 ? [`(省略: 上の行の末尾 ${String(truncatedChars)} 文字)`] : []),
  ].join('\n')
}

/**
想定外終了時のログに足す `stdout tail:` / `stderr tail:` の節を組み立てる。stderr は
人間向けの log で行の構造を当てにできないため、末尾 OUTPUT_TAIL_LIMIT 文字を単純に切り出す。
*/
export function formatOutputTails(stdout: string, stderr: string): string {
  return `stdout tail:\n${stdoutTail(stdout)}\nstderr tail:\n${stderr.slice(-OUTPUT_TAIL_LIMIT)}`
}

/**
`bin/pecotv` を同期起動する runner を作る。stderr は runner 内の診断出力でだけ使い、
主張はすべて `--json` の stdout から立てるため戻り値には含めない。
*/
export function createPecotvRunner(
  options: Readonly<PecotvRunnerOptions>,
): (label: string, arguments_: readonly string[]) => PecotvRun {
  return (label, arguments_) => {
    const startedAt = performance.now()
    const result = spawnSync(BIN_PECOTV, [...arguments_], {
      // bin/pecotv の bootstrap は通過させ、本体ツリーの cli/dist を直接実行する。
      // bootstrap はデータ置き場の実行用ミラー（依存の複製と build）を作る。
      // そのため duration ceiling の計測区間に乗せず、bootstrap の CUJ（cli/tests/bootstrap/）に任せる（#753 の前例）。
      env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const elapsedMs = performance.now() - startedAt
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    console.info(`[${options.logPrefix}] ${label}: exit=${String(result.status)} ${(elapsedMs / 1000).toFixed(1)}s`)
    // spawnSync timeout（status null）と cli の想定外終了を分けるための一次情報を残す。
    if (options.isUnexpectedExit(result.status)) {
      console.error(
        `[${options.logPrefix}] ${label} が exit=${String(result.status)} で終了しました: ${arguments_.join(' ')}\n`
        + formatOutputTails(stdout, stderr),
      )
    }
    return { status: result.status, stdout }
  }
}

export interface ConvertEvent {
  readonly event?: string
  readonly reason?: string
  readonly warnings?: readonly string[]
  /**
  warnings と同型（常時掲載・不在＝旧版）で slide.convert.error（#945）と
  slide.convert.done（#949）の双方に載る。
  */
  readonly errors?: readonly {
    readonly level: string
    readonly slideNumber?: number
    readonly selector?: string
    readonly message: string
  }[]
  readonly cache?: {
    readonly enabled: boolean
    readonly hits: number
    readonly misses: number
    readonly invalidated: string
  }
  /**
  done イベントの出力パス（`--out` 省略時の既定パス決定を見る CUJ が参照する）。
  */
  readonly output?: string
  readonly timings?: {
    readonly perSlide?: readonly { readonly key: string, readonly cache?: string }[]
    /**
    1 パスのルートを試みた run だけ載る（#1147。形は single-pass-route.ts で確認する）
    */
    readonly singlePass?: unknown
  }
}

/**
stdout の JSON 行から、指定 event 名の最後の 1 件を取り出す。
*/
export function lastEvent(stdout: string, eventName: string): ConvertEvent | undefined {
  const lines = stdout.trim().split('\n').filter(line => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index--) {
    // index は ranged for loop の counter で OOB なし。
    // eslint-disable-next-line security/detect-object-injection
    const line = lines[index] ?? ''
    try {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(line) as ConvertEvent
      if (parsed.event === eventName) return parsed
    }
    catch {
      // JSON でない行（人間向け log）は読み飛ばす
    }
  }
  return undefined
}

/**
done イベントから miss だったステップの key 一覧を取り出す。差分変換のルートモード
（どのステップを実際に変換したか）を hits / misses の数だけでなく key で固定する。
*/
export function missKeysOf(done: Readonly<ConvertEvent> | undefined): readonly string[] {
  return (done?.timings?.perSlide ?? []).filter(entry => entry.cache === 'miss').map(entry => entry.key)
}

/**
接頭辞一致で警告を絞る（メッセージ末尾に errno 等の環境依存部が付くため）。
*/
export function warningsStartingWith(
  warnings: readonly string[] | undefined,
  prefix: string,
): readonly string[] {
  return (warnings ?? []).filter(warning => warning.startsWith(prefix))
}

/**
接尾辞一致で警告を絞る（先頭に件数が入る警告向け）。
*/
export function warningsEndingWith(
  warnings: readonly string[] | undefined,
  suffix: string,
): readonly string[] {
  return (warnings ?? []).filter(warning => warning.endsWith(suffix))
}
/* eslint-enable security/detect-non-literal-fs-filename */
