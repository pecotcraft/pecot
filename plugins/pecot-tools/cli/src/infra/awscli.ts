// awscli の子プロセス実行。
//
// shell:false で起動するため、引数配列の要素はそのまま 1 値として awscli に渡る
// （連結や特殊文字による別コマンド委譲が構造的に起きない）。timeout / AbortSignal は
// SIGTERM で子を落とし、起動失敗（ENOENT 等）は reject せず spawnErrorCode に詰める。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
起動するコマンド。PATH 解決に委ねる（絶対パス指定はしない）。

SSO のログインレジストリ（infra/sso/login-registry.ts）も同じコマンドで spawn するため
export する。片方だけ絶対パス化するような差が入らないようにしておく。
*/
export const AWSCLI_COMMAND = 'aws'

/**
`aws --version` の待ち時間。実処理の timeout とは別枠。
*/
const PROBE_TIMEOUT_MS = 15_000

/**
要求する最低版 [major, minor, patch]（research R5: `--use-device-code` は awscli 2.22 以降）。
*/
const MINIMUM_VERSION: readonly [number, number, number] = [2, 22, 0]

/**
message に載せる最低版の表記。
*/
const MINIMUM_VERSION_TEXT = MINIMUM_VERSION.join('.')

const VERSION_PATTERN = /aws-cli\/(\d+)\.(\d+)\.(\d+)/

/**
awscli 出力の上限（バイト、research R8）。

応答へ載せる際の切り詰め（mcp/result.ts の limitOutput）と、本モジュールの捕捉上限が
同じ値を基準にする。依存方向が infra → mcp を許さないため、定義は infra に置く。
*/
export const OUTPUT_LIMIT_BYTES = 256 * 1024

/**
子プロセスの stdout / stderr を捕捉する上限（バイト）。超過分は捨てる。

research R8 の `filter-log-events` は既定 10,000 件で数 MiB になり得る。全件を溜めると
同時実行数（4）と掛かってサーバの常駐メモリに直結するため、応答上限の 4 倍で打ち切る
（切り詰め後の応答に必要な分は必ず残る）。
*/
export const CAPTURE_LIMIT_BYTES = OUTPUT_LIMIT_BYTES * 4

/**
生存中の awscli 子プロセス。

runAwscli が spawn 直後に足し、finalize（close / error のどちらか先）で外す。
サーバが SIGTERM で畳まれるときは親が先に消える。
そのため、ここを辿って子へも SIGTERM を送らないと、子が PPID 1 へ再親付けされて動き続ける。
timeout を張っていた親が居なくなるので、打ち切りも働かない。
*/
const runningChildren = new Set<ChildProcess>()

/**
生存中の awscli 子プロセス全てへ SIGTERM を送る。

終了処理（mcp/serve.ts の onShutdown）から呼ぶ。既に終了した子への kill は no-op で、
finalize 側が Set から外すため二重送出にはならない。
*/
export function killRunningAwscli(): void {
  for (const child of runningChildren) child.kill('SIGTERM')
}

/**
子プロセスの実行結果。
*/
export interface SpawnResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /**
  spawn 自体が失敗したときの errno（ENOENT 等）。成功時はキーごと無い。
  */
  readonly spawnErrorCode?: string
}

export interface RunAwscliOptions {
  readonly timeoutMs: number
  /**
  呼び出し元がキャンセルされたら子プロセスへ SIGTERM を送る（任意）。

  MCP の tools/call は ToolCallContext.signal でキャンセルされる。配線しないと、クライアントが
  諦めたあとも awscli が孤児として動き続ける。
  */
  readonly signal?: AbortSignal | undefined
}

function errorCodeOf(error: Readonly<Error>): string | undefined {
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
捕捉した stderr と、spawn の error から得た追加行を 1 本に束ねる。
*/
export function mergeStderr(captured: string, extra: string): string {
  if (extra === '') return captured
  if (captured === '') return extra
  return `${captured}\n${extra}`
}

/**
上限まで chunk を溜める入れ物。
*/
export interface OutputCapture {
  push(chunk: Readonly<Buffer>): void
  text(): string
}

/**
CAPTURE_LIMIT_BYTES まで溜め、超過分は捨てる capture を作る。

SSO のログインレジストリ（infra/sso/login-registry.ts）も同じ上限で子プロセスの出力を
溜めるため export する。上限が呼び出し元ごとに割れると、常駐メモリの見積もりが立たなくなる。
*/
export function createCapture(): OutputCapture {
  const chunks: Buffer[] = []
  let captured = 0

  return {
    push(chunk: Readonly<Buffer>): void {
      const room = CAPTURE_LIMIT_BYTES - captured
      if (room <= 0) return
      const copied = Buffer.from(chunk.subarray(0, Math.min(room, chunk.length)))
      captured += copied.length
      chunks.push(copied)
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

/**
`aws <args>` を起動し、CAPTURE_LIMIT_BYTES まで capture した stdout / stderr を返す。

timeout 到達・abort では SIGTERM を送り、`timedOut` / signal を結果へ載せる。
起動 error は reject せず `exitCode: null` + `spawnErrorCode` に詰める。
そのため呼び出し側は、失敗種別の判定を 1 か所（classifyFailure）に集約できる。
*/
export async function runAwscli(
  arguments_: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は内部状態を持つ
  options: Readonly<RunAwscliOptions>,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const stdoutCapture = createCapture()
    const stderrCapture = createCapture()
    let isTimedOut = false
    let isSettled = false

    const child = spawn(AWSCLI_COMMAND, [...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    runningChildren.add(child)

    const timer = setTimeout(() => {
      isTimedOut = true
      child.kill('SIGTERM')
    }, options.timeoutMs)
    timer.unref()

    // abort 済みの signal に後からリスナを足しても発火しないため、現在値を先に見てから購読する。
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Readonly<Buffer>) => {
      stdoutCapture.push(chunk)
    })
    child.stderr.on('data', (chunk: Readonly<Buffer>) => {
      stderrCapture.push(chunk)
    })

    const finalize = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      extraStderr: string,
      spawnErrorCode?: string,
    ): void => {
      if (isSettled) return
      isSettled = true
      runningChildren.delete(child)
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // ENOENT 等で 'error' の直後に 'close' も発火する Node の仕様に対し、二重 finalize は
      // settled で抑止している。稀に child が生存したまま残る場合への防御で kill しておく。
      // 通常の close 後もここを通る（Node 24 の確認で child.killed は false のまま）。
      // ただし _handle が既に null で kill() は no-op のため無害。
      // catch は防御網で、通常は到達しない。
      /* c8 ignore start -- catch 節（既に終了済みの kill が throw する場合）は観測されない防御網 */
      if (!child.killed) {
        try {
          child.kill()
        }
        catch {
          // 既に終了済みの場合の防御。SpawnResult には影響しないので握り潰す。
        }
      }
      /* c8 ignore stop */
      resolve({
        exitCode,
        signal,
        stdout: stdoutCapture.text(),
        stderr: mergeStderr(stderrCapture.text(), extraStderr),
        timedOut: isTimedOut,
        ...(spawnErrorCode !== undefined && { spawnErrorCode }),
      })
    }

    child.on('error', (error: Readonly<Error>) => {
      // eslint-disable-next-line unicorn/no-null -- exitCode / signal は SpawnResult 契約で null
      finalize(null, null, error.message, errorCodeOf(error))
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finalize(code, signal, '')
    })
  })
}

/**
awscli の存在と版の確認結果。
*/
export type AwscliProbe
  = | { readonly ok: true, readonly version: string }
    | { readonly ok: false, readonly category: 'awscli-missing', readonly message: string }

/**
確認結果の memo。外から差し替えられるよう、プロパティを持つ入れ物にしている。
*/
const probeCache: { pending: Promise<AwscliProbe> | undefined } = { pending: undefined }

/**
検出した版が最低版以上か。

major / minor / patch を 1 つの数へ畳む比較は minor / patch が 1000 以上で桁が衝突するため、
上位から順に見るタプル比較にする。
*/
function isAtLeastMinimum(major: number, minor: number, patch: number): boolean {
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_VERSION
  if (major !== minimumMajor) return major > minimumMajor
  if (minor !== minimumMinor) return minor > minimumMinor
  return patch >= minimumPatch
}

async function probeAwscli(): Promise<AwscliProbe> {
  const result = await runAwscli(['--version'], { timeoutMs: PROBE_TIMEOUT_MS })

  if (result.spawnErrorCode === 'ENOENT') {
    return {
      ok: false,
      category: 'awscli-missing',
      message: `awscli not found. Install awscli v2 (${MINIMUM_VERSION_TEXT} or later) and add it to PATH`,
    }
  }

  const matched = VERSION_PATTERN.exec(`${result.stdout}\n${result.stderr}`) ?? undefined
  if (matched === undefined) {
    return {
      ok: false,
      category: 'awscli-missing',
      message: `Could not determine the awscli version: ${result.stdout.trim()}`,
    }
  }

  const major = Number(matched[1])
  const minor = Number(matched[2])
  const patch = Number(matched[3])
  const version = `${String(major)}.${String(minor)}.${String(patch)}`

  return isAtLeastMinimum(major, minor, patch)
    ? { ok: true, version }
    : {
        ok: false,
        category: 'awscli-missing',
        message: `awscli ${MINIMUM_VERSION_TEXT} or later is required (detected: ${version})`,
      }
}

/**
awscli の存在と版を確認し、成功結果だけをプロセス内に記憶する。

毎回 `aws --version` を起こすとツール 1 件あたりの子プロセスが 2 本になるため、
Promise 自体を memo する（並行呼び出しでも実行は 1 回）。
ただし失敗（未導入・版不足）を memo すると、利用者が awscli を導入してもサーバ再起動まで全ツールが awscli-missing を返し続ける。
そのため失敗時は memo を捨てて、次の呼び出しで再判定する。
*/
export async function ensureAwscli(): Promise<AwscliProbe> {
  const pending = probeCache.pending ?? probeAwscli()
  probeCache.pending = pending

  const resolved = await pending
  if (!resolved.ok && probeCache.pending === pending) probeCache.pending = undefined
  return resolved
}

/**
memo を捨てる。テストが版・PATH を差し替えるときに使う。
*/
export function resetAwscliProbe(): void {
  probeCache.pending = undefined
}
