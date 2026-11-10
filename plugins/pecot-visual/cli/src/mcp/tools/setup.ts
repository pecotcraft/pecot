// setup ツール。実行時依存 (永続層) と Playwright Chromium を明示的に取得する。
//
// `pecotv mcp` は MCP クライアントの接続タイムアウト (Claude Code の MCP_TIMEOUT は既定
// 30000ms) に収めるため、起動時に何も取得しない。また、モデルが呼ぶツールの側から 120MB 級の
// ダウンロードを通知なしに始めることも避けている。
// そのぶん「取得する」という操作を明示的に呼べる口として本ツールを置く。
//
// 取得対象は 2 つある。
// - 実行時依存 (@slidev/cli / dom-to-pptx / @slidev/parser と、実行時依存の manifest が
//   宣言するテーマの peer)。単体配布ルートでは npx が起動のたびに node_modules を作り直すため、
//   これらを起動層に載せられない。データ置き場の `mcp-dist/` へ置いて永続させる。
//   置き場は `PLUGIN_DATA` で選べる。
//   既定は `$XDG_DATA_HOME/pecot/pecot-visual/mcp-dist`、無ければ `~/.local/share/pecot/pecot-visual/mcp-dist`。
//   プラグインルートでは同梱されているので取得済み判定で通過する。
// - Playwright Chromium。従来どおり `~/.cache/ms-playwright` へ置く。
//   取得後に、起動に要る OS のライブラリを確かめ、足りなければ入れる。
//   参照: #1217、infra/playwright/host-dependencies.ts。bin/pecotv の bootstrap と同じルート。
//
// 実行時依存を先に取るのは、取得ロックの置き場所 (installLockPath) が依存ルートの
// node_modules だからで、先に作っておくと chromium 側もロック付きで走れる。
//
// 対応する CLI サブコマンドは持たない。
// CLI 側の chromium 取得ルートは bin/pecotv の bootstrap (`pecotv drawio url` 等の初回実行) と setup.sh にある。
// そちらは #543 の設計どおり、同期取得・失敗時 fatal のまま変えていない。
//
// 取得中の無音対策は不要。
// progress ハートビートは createMcpServer が全ツール一律で送っている (src/mcp/server.ts の startProgressHeartbeat)。
// そのため本ツールが長時間動いている間、クライアントの idle timer はリセットされ続ける。

import { z } from 'zod'

import type { CallToolResult } from '@modelcontextprotocol/server'

import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { LOCK_CONFLICT_EXIT_CODE, LOCK_WAIT_SECONDS } from '../../infra/_shared/flock.js'
import type { RuntimeInstallResult } from '../../infra/_shared/runtime-install.js'
import {
  ensureChromiumHostDependencies,
  hostDependenciesDefaultDependencies,
  type HostDependencies,
} from '../../infra/playwright/host-dependencies.js'
import { toCallToolResult, type ToolResult } from '../result.js'
import type { ToolDefinition, ToolCallContext } from '../server.js'
import {
  CHROMIUM_UNAVAILABLE_EXIT_CODE,
  chromiumDefaultDependencies,
  chromiumInstallFailureDetail,
  runtimeDefaultDependencies,
  RUNTIME_UNAVAILABLE_EXIT_CODE,
  spawnOutputPart,
  tlsCertificateHint,
  TOOL_OUTPUT_SCHEMA,
  type ChromiumDependencies,
  type RuntimeDependencies,
} from './_shared.js'

/**
取得 1 種類ぶんの結果。data / message の組み立てを 2 系統で共通化する。
*/
interface StageOutcome {
  readonly installed: boolean
  readonly downloaded: boolean
  readonly durationMs: number
  readonly location: string | undefined
  readonly detail: string | undefined
  readonly spawned: SpawnResult | undefined
}

/**
実行時依存を取得する。

chromium と違い、取得済みなら実行そのものを飛ばす。`playwright install` は取得済みなら
1 spawn で skip して返るが、npm install は 600MB 級の依存解決を毎回やり直すため、
呼ぶだけで数十秒かかる。取得済み判定は「必要なパッケージが全て解決できるか」で、
途中で失敗した中途半端な状態では false に倒れるので、再入すればやり直しになる。
*/
async function runRuntimeStage(
  dependencies: Readonly<RuntimeDependencies>,
  // AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  signal?: AbortSignal,
): Promise<StageOutcome> {
  const location = dependencies.root()
  if (dependencies.isInstalled()) {
    return { installed: true, downloaded: false, durationMs: 0, location, detail: undefined, spawned: undefined }
  }

  const startedAt = Date.now()
  const spawned = await dependencies.install(signal)
  const durationMs = Date.now() - startedAt

  // exit 0 でも実体が置かれたかは改めて確認する (解決できなければ取得できていない)。
  const isInstalled = spawned.exitCode === 0 && dependencies.isInstalled()
  const detail = isInstalled
    ? undefined
    : (spawned.exitCode === 0
        ? `download command succeeded, but runtime dependencies cannot be resolved from ${location ?? 'the persistent location'}`
        : runtimeInstallFailureDetail(spawned))
  return { installed: isInstalled, downloaded: isInstalled, durationMs, location, detail, spawned }
}

/**
実行時依存の取得が失敗したときに載せる理由 (chromiumInstallFailureDetail と同じ流儀)。
stderr が TLS の証明書検証の失敗を示すなら、chromium 側と同じ誘導を同じ条件で足す。
*/
function runtimeInstallFailureDetail(result: Readonly<RuntimeInstallResult>): string {
  return `${runtimeFailureReason(result)}${tlsCertificateHint(result)}`
}

/**
失敗の種類ごとの理由 (誘導を足す前の本文)。
*/
function runtimeFailureReason(result: Readonly<RuntimeInstallResult>): string {
  if (result.exitCode === LOCK_CONFLICT_EXIT_CODE) {
    return `another process is downloading runtime dependencies (lock wait exceeded ${String(LOCK_WAIT_SECONDS)} seconds)`
      + '; wait for it to finish, then run again'
  }
  if (result.timedOut) {
    return 'download timed out; check network reachability and the proxy settings, then run again'
  }
  if (result.exitCode === null) {
    return result.signal === null
      ? 'could not start npm (see stderr for the reason)'
      : `download command was interrupted by ${result.signal}; the download was cut off externally`
  }
  return `npm install exited with ${String(result.exitCode)} (see stderr for the reason)`
}

/**
Chromium を取得する。取得済みでも Playwright 側が冪等に skip するため常に実行する。
*/
async function runChromiumStage(
  dependencies: Readonly<ChromiumDependencies>,
  // AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  signal?: AbortSignal,
): Promise<StageOutcome> {
  const location = dependencies.browsersRoot()
  const isInstalledBefore = await dependencies.isInstalled()

  const startedAt = Date.now()
  // call.signal を接続する。クライアントがリクエストを打ち切ったら取得も止める
  // (接続しないと子プロセスが孤児として動き続け、取得ロックを保持したままになる)。
  const spawned = await dependencies.install(signal)
  const durationMs = Date.now() - startedAt

  // exit 0 でも実体が置かれたかは改めて確認する (skip を成功と取り違えないため)。
  const isInstalled = spawned.exitCode === 0 && await dependencies.isInstalled()
  const detail = isInstalled
    ? undefined
    : (spawned.exitCode === 0
        ? `download command succeeded, but chromium is not in ${location ?? 'the browsers directory'}`
        : chromiumInstallFailureDetail(spawned))
  return { installed: isInstalled, downloaded: isInstalled && !isInstalledBefore, durationMs, location, detail, spawned }
}

/**
Chromium が起動するのに要る OS のライブラリを確認し、足りなければ入れる (#1217)。

実行ファイルの取得 (runChromiumStage) では OS のライブラリは入らない。本体は
infra/playwright/host-dependencies.ts で、bin/pecotv の bootstrap と同じ判定・導入を通る。
結果は bootstrap と同じ印に記録する (失敗も期限付きで記録し、毎回の確認を避ける)。
MCP は stdout を JSON-RPC に使うため、apt-get 開始前の通知 (deps.notify) は既定のまま何も出さない。
*/
async function runHostDependenciesStage(
  dependencies: Readonly<HostDependencies>,
  // AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  signal?: AbortSignal,
): Promise<StageOutcome> {
  const startedAt = Date.now()
  const outcome = await ensureChromiumHostDependencies(dependencies, signal)
  const durationMs = Date.now() - startedAt
  const base = { durationMs, location: undefined, spawned: undefined }
  switch (outcome.status) {
    case 'ok': {
      dependencies.record('ok')
      return { ...base, installed: true, downloaded: false, detail: undefined }
    }
    case 'installed': {
      dependencies.record('ok')
      return { ...base, installed: true, downloaded: true, detail: `installed packages: ${outcome.packages.join(' ')}` }
    }
    case 'missing': {
      dependencies.record('missing')
      return { ...base, installed: false, downloaded: false, detail: outcome.detail }
    }
    case 'launch-failed': {
      // OS のライブラリ以外の原因 (実行ファイルの欠け等) は本段の担当外。
      // 実行ファイルは runChromiumStage が揃えており、起動の失敗は各ツールが案内付きで返す。
      // そのためここでは理由を残して通す (bin/pecotv の `pecotv chromium host-deps` と同じ扱い)。
      dependencies.record('launch-failed')
      return { ...base, installed: true, downloaded: false, detail: `could not launch Chromium (cause other than OS libraries): ${outcome.detail}` }
    }
  }
}

/**
ToolResult の data へ載せる 1 系統ぶんの要約。
*/
function stageData(outcome: Readonly<StageOutcome>): Record<string, unknown> {
  return {
    installed: outcome.installed,
    downloaded: outcome.downloaded,
    durationMs: outcome.durationMs,
    ...(outcome.location !== undefined && { location: outcome.location }),
    ...(outcome.detail !== undefined && { detail: outcome.detail }),
  }
}

/**
取得した実体の置き場所だけを artifacts に載せる。何も取得していなければ空。
*/
function artifactsOf(stages: readonly StageOutcome[]): string[] {
  return stages
    .filter(stage => stage.downloaded)
    .map(stage => stage.location)
    .filter((location): location is string => location !== undefined)
}

function successMessage(
  runtime: Readonly<StageOutcome>,
  chromium: Readonly<StageOutcome>,
  hostDependencies: Readonly<StageOutcome>,
): string {
  const parts = [
    runtime.downloaded
      ? `runtime dependencies downloaded (${String(Math.round(runtime.durationMs / 1000))}s)`
      : 'runtime dependencies already installed',
    chromium.downloaded
      ? `Playwright Chromium downloaded (${String(Math.round(chromium.durationMs / 1000))}s)`
      : 'Playwright Chromium already installed',
    ...(hostDependencies.downloaded ? [`OS libraries required to launch Chromium installed (${hostDependencies.detail ?? ''})`] : []),
    // 起動できなかったが OS のライブラリ以外が原因 (launch-failed)。成功のまま理由を伝える。
    ...(hostDependencies.downloaded || hostDependencies.detail === undefined ? [] : [hostDependencies.detail]),
  ]
  return parts.join(' / ')
}

/**
`setup` を公開する。

引数は取らない。chromium 側は取得済みかを見て早期 return はしない。
判定が「取得済み」になる状態でも、実体が欠けていることがある。
例はダウンロード途中、必要リビジョンの未取得、headless shell の欠落。
早期 return は、取得と案内のどちらも行われない行き止まりを作る。
`playwright install chromium` 自体が冪等で、取得済みなら Playwright 側が skip するので、
常に実行してよい (代償は 1 spawn)。`downloaded` は実行前後の判定差で決める。

実行時依存側は取得済みなら飛ばす (runRuntimeStage のコメントを参照)。

片方が失敗しても他方は実行する。npm が破損している環境で chromium の取得まで巻き添えに
しないため。ok は両方が揃ったときだけ true になる。
*/
export function setupTool(
  buildDependencies: () => ChromiumDependencies = chromiumDefaultDependencies,
  buildRuntimeDependencies: () => RuntimeDependencies = runtimeDefaultDependencies,
  buildHostDependencies: () => HostDependencies = hostDependenciesDefaultDependencies,
): ToolDefinition {
  const handler = async (
    _arguments: Readonly<Record<string, unknown>>,
    // ToolCallContext.signal (AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない)。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    call: ToolCallContext,
  ): Promise<CallToolResult> => {
    const runtime = await runRuntimeStage(buildRuntimeDependencies(), call.signal)
    const chromium = await runChromiumStage(buildDependencies(), call.signal)
    // OS のライブラリは実行ファイルが揃ってからでないと起動で確かめられない。
    const hostDependencies = chromium.installed ? await runHostDependenciesStage(buildHostDependencies(), call.signal) : undefined

    const artifacts = artifactsOf([runtime, chromium])
    const data = {
      runtime: stageData(runtime),
      chromium: stageData(chromium),
      ...(hostDependencies !== undefined && { hostDeps: stageData(hostDependencies) }),
    }

    if (runtime.installed && chromium.installed && hostDependencies?.installed === true) {
      const result: ToolResult = {
        ok: true,
        exitCode: 0,
        // ダウンロードした実体の置き場所を成果物として返す。取得済みなら何も置いていない。
        artifacts,
        data: {
          event: runtime.downloaded || chromium.downloaded || hostDependencies.downloaded ? 'setup.done' : 'setup.skipped',
          ...data,
        },
        message: successMessage(runtime, chromium, hostDependencies),
        ...spawnOutputPart(chromium.spawned ?? emptySpawn()),
      }
      return toCallToolResult(result)
    }

    // 両系統が失敗することもある (ネットワーク断・プロキシ誤設定では両方が落ちる)。
    // 片方だけを見ると、もう片方の理由が data.<系統>.detail にしか残らず message から
    // 消えるため、失敗した系統を全て畳んで載せる。
    const failures = [
      ...(runtime.installed ? [] : [{ label: 'runtime dependencies', reason: 'runtime-install-failed', stage: runtime }]),
      ...(chromium.installed ? [] : [{ label: 'Playwright Chromium', reason: 'chromium-install-failed', stage: chromium }]),
      ...(hostDependencies === undefined || hostDependencies.installed
        ? []
        : [{ label: 'Chromium OS libraries', reason: 'chromium-host-deps-missing', stage: hostDependencies }]),
    ]
    const detail = failures.map(failure => `${failure.label}: ${failure.stage.detail ?? ''}`).join(' / ')
    // OS ライブラリの失敗は「取得」ではなく「足りない」ことを案内するため、取得の失敗と分ける。
    // その detail は足りないライブラリと入れるコマンドまで書いた文なので、前置きを付けずに載せる。
    const acquisitionFailures = failures.filter(failure => failure.reason !== 'chromium-host-deps-missing')
    const hostDependenciesDetail = failures.find(failure => failure.reason === 'chromium-host-deps-missing')?.stage.detail
    const message = [
      ...(acquisitionFailures.length === 0
        ? []
        : [`download failed for ${acquisitionFailures.map(failure => failure.label).join(' / ')}: `
          + acquisitionFailures.map(failure => `${failure.label}: ${failure.stage.detail ?? ''}`).join(' / ')]),
      ...(hostDependenciesDetail === undefined ? [] : [hostDependenciesDetail]),
    ].join(' / ')
    const result: ToolResult = {
      ok: false,
      exitCode: runtime.installed ? CHROMIUM_UNAVAILABLE_EXIT_CODE : RUNTIME_UNAVAILABLE_EXIT_CODE,
      artifacts,
      data: {
        event: 'setup.error',
        reason: failures.map(failure => failure.reason).join(','),
        detail,
        ...data,
      },
      message,
      ...spawnOutputPart(mergeSpawned(failures.map(failure => failure.stage.spawned))),
    }
    return toCallToolResult(result)
  }

  return {
    name: 'setup',
    config: {
      title: 'Prepare the runtime (runtime dependencies / Chromium download and OS libraries)',
      description: 'Downloads the runtime dependencies pecotv uses (@slidev/cli / dom-to-pptx / @slidev/parser, etc.) and Playwright Chromium. '
        + 'Call it when slide_create / slide_convert / slide_sync fail with "runtime dependencies are not installed", '
        + 'or when drawio_export / slide_convert / drawio_create PNG output fails with "Playwright Chromium is not installed". '
        + 'The first run downloads about 600MB of runtime dependencies and about 120MB of Chromium, so it takes tens of seconds. '
        + 'If OS libraries needed to launch Chromium are missing, it installs them with apt-get where sudo is available, '
        + 'and otherwise returns the command to install them. '
        + 'It skips what is already installed, so it finishes quickly and is safe to call repeatedly.',
      // 引数を取らないツールは空の z.object を渡す (src/mcp/server.ts の ToolConfig)。
      inputSchema: z.object({}),
      outputSchema: TOOL_OUTPUT_SCHEMA,
      // Claude Code は annotations から自動承認の可否を組み立てるため、既定値と同じでも
      // 明示する。ダウンロードでファイルシステムを書き換え (destructive)、外部ホストへ
      // 到達する (openWorld)。読み取り専用ではないので readOnlyHint は立てない。
      // 取得済みなら skip するため、何度呼んでも状態は変わらない (idempotent)。
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler,
  }
}

/**
取得を飛ばした系統には子プロセスが無い。stdout / stderr のキーは契約どおり残す。
*/
function emptySpawn(): SpawnResult {
  // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動なしを exitCode: null で表す
  return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false }
}

/**
失敗した系統の出力を 1 つに畳む。

ToolResult の stdout / stderr は 1 組しか持てないため、両系統が失敗したときは
どちらの出力も落とさずに連結する (原因が stdout 側にあることもある)。
*/
function mergeSpawned(spawned: readonly (SpawnResult | undefined)[]): SpawnResult {
  const present = spawned.filter((result): result is SpawnResult => result !== undefined)
  if (present.length === 0) return emptySpawn()
  const first = present[0] ?? emptySpawn()
  if (present.length === 1) return first
  return {
    ...first,
    stdout: present.map(result => result.stdout).filter(text => text !== '').join('\n'),
    stderr: present.map(result => result.stderr).filter(text => text !== '').join('\n'),
  }
}
