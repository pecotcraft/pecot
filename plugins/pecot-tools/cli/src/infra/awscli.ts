// awscli の子プロセス実行。shell:false で起動し、起動失敗は reject せず spawnErrorCode に詰める。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
起動するコマンド。PATH 解決に委ねる。SSO のログインレジストリも同じコマンドで spawn するので export する。
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
awscli 出力の上限（バイト、research R8）。依存方向が infra → mcp を許さないため、定義は infra に置く。
*/
export const OUTPUT_LIMIT_BYTES = 256 * 1024

/**
子プロセスの stdout / stderr を捕捉する上限（バイト）。超過分は捨てる。常駐メモリを抑えるため、応答上限の 4 倍で打ち切る。
*/
export const CAPTURE_LIMIT_BYTES = OUTPUT_LIMIT_BYTES * 4

/**
生存中の awscli 子プロセス。サーバが SIGTERM で畳まれるとき、ここを辿って子へも送らないと PPID 1 で動き続ける。
*/
const runningChildren = new Set<ChildProcess>()

/**
生存中の awscli 子プロセス全てへ SIGTERM を送る。終了済みの子への kill は no-op なので二重送出にならない。
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
  呼び出し元がキャンセルされたら子プロセスへ SIGTERM を送る。配線しないと awscli が孤児として動き続ける。
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
CAPTURE_LIMIT_BYTES まで溜め、超過分は捨てる capture を作る。SSO のログインレジストリも同じ上限を使うので export する。
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
`aws <args>` を起動し、capture した stdout / stderr を返す。起動 error は reject せず spawnErrorCode に詰める。
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
      // 'error' の直後に 'close' も発火するため、二重 finalize は settled で抑止する。
      // child が生存したまま残る稀な場合に備えて kill する。_handle が null なら no-op で無害。
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
    | { readonly ok: false, readonly kind: 'awscli-missing', readonly message: string }

/**
確認結果の memo。外から差し替えられるよう、プロパティを持つ入れ物にしている。
*/
const probeCache: { pending: Promise<AwscliProbe> | undefined } = { pending: undefined }

/**
検出した版が最低版以上か。minor / patch が 1000 以上で桁が衝突しないよう、上位から順に比べる。
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
      kind: 'awscli-missing',
      message: `awscli not found. Install awscli v2 (${MINIMUM_VERSION_TEXT} or later) and add it to PATH`,
    }
  }

  const matched = VERSION_PATTERN.exec(`${result.stdout}\n${result.stderr}`) ?? undefined
  if (matched === undefined) {
    return {
      ok: false,
      kind: 'awscli-missing',
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
        kind: 'awscli-missing',
        message: `awscli ${MINIMUM_VERSION_TEXT} or later is required (detected: ${version})`,
      }
}

/**
awscli の存在と版を確認し、成功結果だけを memo する。失敗を memo すると導入後も再起動まで awscli-missing が続くため捨てる。
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
