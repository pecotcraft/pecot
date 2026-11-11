// talk-dir ごとの Slidev dev サーバを預かるレジストリ (`slide_dev` ツールの実体)。
//
// 子プロセスの起動形態には計測で決めた制約が 3 つある。
// - `npx slidev` は 3 段のプロセスツリーになり、直接の子への SIGTERM では孫 (実 vite) が
//   残ってポートを掴み続ける。`process.execPath` で slidev bin を直接起動すれば単一プロセスに
//   なり、SIGTERM から約 100ms で reap されてポートも解放される。
// - stdio は pipe して常時 drain する。`inherit` は JSON-RPC 専有の stdout (serve.ts の
//   installStdoutGuard) を壊す。drain しないと OS のパイプバッファ (64KB) が埋まった時点で
//   dev サーバが止まる。dev サーバは HMR のたびに書くので長時間の放置で必ず到達する。
// - `child.on('error')` は必須。未処理の 'error' (cwd 不在の ENOENT 等) は MCP サーバごと落とす。
//
// 子は detach しない。MCP サーバが終わればプレビューも切れるが、孤児を残さないことと
// 引き換えの意図した挙動である (異常終了時の回収の逃がし先として、応答に pid を載せる)。
//
// ポートは自前で決めて `--port` で渡す。指定が無ければ DEFAULT_PORTS を小さい順に試し、指定が
// あればそのポートだけを試す。slidev は `--port` 明示時に strictPort で動くため、塞がっていれば
// 自動採番せず約 870ms で exit 1 する。空きの確認と bind の間に他プロセスがポートを取る TOCTOU
// レースは、この即死を検知して次の候補へ進む (指定時は候補が 1 本なので失敗を返す)。
// ready 判定を「子が生きている」と「GET 200」の組にすると、ポートを掴んでいた別プロセスの応答を
// 掴む誤検知が strictPort の性質によって構造的に排除できる。

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { mergeStderr } from '../infra/_shared/process.js'
import { resolveSlidevBin } from '../infra/_shared/slidev-bin.js'
import { createOutputCapture } from './result.js'
import { memoize } from '../domain/_shared/memoize.js'

/**
ready を待つ上限 (ms)。待っている間は直列キューを占有するため短くする (計測の ready は約 1 秒)。

反復回数ではなく経過時刻でも打ち切る。1 回のプローブが長引くと「回数 × 間隔」は実時間の
上限にならず、この宣言が担保されない (プローブ自身の上限は PROBE_TIMEOUT_MS)。
*/
const READY_TIMEOUT_MS = 15_000

/**
ready 判定のポーリング間隔 (ms)。
*/
const READY_POLL_INTERVAL_MS = 100

/**
ready プローブ 1 回の上限 (ms)。

undici の既定 (headersTimeout / bodyTimeout = 300 秒) のままだと、
無応答の相手を掴んだとき、プローブ 1 回が数分ブロックする。
ポーリング間隔まで詰めないのは、cold な vite が依存の事前バンドル中に最初のリクエストを保留するため。
短すぎると毎回中断して ready を観測できない。
*/
const PROBE_TIMEOUT_MS = 2000

/**
ポートの指定が無いときに小さい順で試すポート。起点は Slidev の既定 (3030)。

範囲を狭く固定するのは、コンテナからホストへ転送するポートを、利用者が事前に決めるため。
OS 任せの ephemeral ポートは転送対象外で、返した URL をホストで開けない。
*/
const DEFAULT_PORTS: readonly number[] = [3030, 3031, 3032, 3033, 3034]

/**
SIGTERM を送ってから SIGKILL へ上げるまでの猶予 (ms)。計測では 100ms で reap される。
*/
const KILL_ESCALATION_MS = 3000

/**
slidev の strictPort が「ポートが塞がっている」ときに stderr へ出す文言。
*/
const PORT_IN_USE_MARKER = 'is already in use'

/**
レジストリが子プロセスへ求める最小の面 (node:child_process の ChildProcess がそのまま満たす)。
*/
export interface DevServerChild {
  /**
  起動に失敗した子には pid が付かない (ChildProcess と同じく任意)。
  */
  readonly pid?: number | undefined
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'error', listener: (error: Readonly<Error>) => void): void
  on(event: 'exit', listener: () => void): void
}

export interface DevServerSpawnOptions {
  /**
  起動する talk-dir の絶対パス (子プロセスの cwd)。
  */
  readonly directory: string
  /**
  `--port` へ渡すポート。
  */
  readonly port: number
}

/**
レジストリが外部へ出す依存。既定は実 spawn / 実 HTTP で、テストはここを差し替える。

実プロセスを起こさずに ready 待ち・ポート再試行・タイムアウトの分岐を検証できる形にしている。
待ち時間は「経過時刻」ではなく `readyTimeoutMs / pollIntervalMs` から決まる試行回数で扱う。
*/
export interface DevServerDependencies {
  readonly spawn: (options: Readonly<DevServerSpawnOptions>) => DevServerChild
  /**
  ポートが空いている (bind できる) 状態かどうか。
  */
  readonly isPortFree: (port: number) => Promise<boolean>
  /**
  ポートの指定が無いときに小さい順で試すポート。
  */
  readonly defaultPorts: readonly number[]
  /**
  ready 判定の HTTP プローブ。GET が 200 を返したら true。
  */
  readonly probe: (url: string) => Promise<boolean>
  readonly delay: (ms: number) => Promise<void>
  readonly readyTimeoutMs: number
  readonly pollIntervalMs: number
  readonly killEscalationMs: number
}

export type DevServerFailureReason
  = 'dev-server-spawn-failed'
    | 'dev-server-exited'
    | 'dev-server-timeout'
    | 'dev-server-cancelled'
    | 'dev-server-port-in-use'

export interface DevServerStartOptions {
  /**
  起動するポート。省略時は既定のポートを小さい順に試す。
  */
  readonly port?: number | undefined
  readonly signal?: AbortSignal | undefined
}

export interface DevServerStarted {
  readonly ok: true
  /**
  利用者がブラウザで開く URL。
  */
  readonly url: string
  readonly port: number
  readonly pid: number | undefined
  /**
  既に動いていたサーバをそのまま返したか。
  */
  readonly reused: boolean
}

export interface DevServerStartFailure {
  readonly ok: false
  readonly reason: DevServerFailureReason
  readonly detail: string
  readonly stdout: string
  readonly stderr: string
}

export type DevServerStartResult = DevServerStarted | DevServerStartFailure

export interface DevServerStopResult {
  /**
  動いていたサーバを止めたか (動いていなければ false)。
  */
  readonly stopped: boolean
  /**
  止めたサーバのポート。動いていなければ undefined。
  */
  readonly port: number | undefined
}

export interface DevServerRegistry {
  start(
    directory: string,
    // AbortSignal は EventTarget で readonly 化できない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    options?: DevServerStartOptions,
  ): Promise<DevServerStartResult>
  stop(directory: string): DevServerStopResult
  /**
  `stop` に加え、止めたサーバのプロセスが終わる (ポートを手放す) まで待つ。
  SIGTERM を無視する子は SIGKILL へ上げる時間 (killEscalationMs) まで待ち、それでも生きていれば戻る。
  同じポートで直ちに起動し直す呼び出し (テーマの張り直し後など) が、旧プロセスの解放前に「使用中」で失敗しないようにする。
  */
  stopAndWait(directory: string): Promise<DevServerStopResult>
  /**
  預かっている全てのサーバを停止する。process の 'exit' からも呼ぶため同期で完結する。
  */
  shutdown(): void
}

/**
起動済みの 1 件。生存判定と出力の取り出しをここに閉じる。
*/
interface DevServerHandle {
  readonly port: number
  readonly url: string
  readonly pid: number | undefined
  readonly isAlive: () => boolean
  readonly kill: () => void
  readonly stdout: () => string
  readonly stderr: () => string
}

/**
ready 待ちの結末。'ready' 以外は子を残さず畳む。
*/
type ReadyOutcome = 'ready' | 'exited' | 'timeout' | 'cancelled'

/**
子プロセスを追跡する handle を組み立てる。

生存は 'exit' / 'error' の受信で判定する (`exitCode === null` はシグナルで終わった子でも
null のままなので生存判定に使えない)。'error' のリスナは必須で、張らないと ENOENT で
MCP サーバごと落ちる。
*/
// 子プロセスの stdout / stderr は Node の Readable で readonly 化できない。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function trackChild(child: DevServerChild, port: number, killEscalationMs: number): DevServerHandle {
  const stdoutCapture = createOutputCapture()
  const stderrCapture = createOutputCapture()
  // pipe が 'error' を張るのは転送先だけで、読み出し側は素通しになる。子プロセス本体と
  // 同じ理由 (未処理の 'error' は MCP サーバごと落とす) で、読み出し側にも受け皿を置く。
  child.stdout?.on('error', ignoreStreamError)
  child.stderr?.on('error', ignoreStreamError)
  child.stdout?.pipe(stdoutCapture.stream)
  child.stderr?.pipe(stderrCapture.stream)

  let isAlive = true
  let spawnError = ''
  child.on('error', (error: Readonly<Error>) => {
    isAlive = false
    spawnError = error.message
  })
  child.on('exit', () => {
    isAlive = false
  })

  const send = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal)
    }
    catch {
      // 既に終了済みの子への kill。停止という目的は達成されているので握り潰す。
    }
  }

  return {
    port,
    url: `http://localhost:${String(port)}`,
    pid: child.pid,
    isAlive: () => isAlive,
    kill: () => {
      if (!isAlive) return
      send('SIGTERM')
      // SIGTERM を無視する子を残さないための保険。
      // 働くのは MCP サーバが生き続ける `stop` ルートだけ。
      // シャットダウンルート (serve.ts の SIGTERM / SIGINT / 'exit') では親が先に exit するため発火しない。
      // unref も同じ向きの割り切りで、この timer が MCP サーバの終了を引き延ばさないようにしている。
      const timer = setTimeout(() => {
        if (isAlive) send('SIGKILL')
      }, killEscalationMs)
      timer.unref()
    },
    stdout: () => stdoutCapture.text(),
    stderr: () => mergeStderr(stderrCapture.text(), spawnError),
  }
}

/**
pipe の読み出し側で上がった 'error' の受け皿。捕捉できる出力が減るだけで、起動の成否は子の生存で見る。
*/
function ignoreStreamError(): void {
  // 何もしない。ここでリスナを張ること自体が目的 (未処理の 'error' はプロセスごと落とす)。
}

/**
talk-dir をレジストリのキーへ正規化する。

`parsePathArguments` が見るのは絶対パスかどうかだけ。
そのため `/a/talk`、`/a/talk/`、`/a/./talk` は別キーになる。
引数を組み立てるのはエージェントで、表記は揺れる。
正規化しないと同じデッキに dev サーバが二重に立ち、片方の表記では停止もできなくなる。
ツール側ではなくレジストリのエントリで通すのは、レジストリを直接使うルートも守るため。
*/
function normalizeKey(directory: string): string {
  return path.resolve(directory)
}

/**
dev サーバのレジストリを作る。

MCP サーバは 1 プロセスなので実運用のインスタンスは 1 つ (devServerRegistry) だが、
テストが状態を持ち越さずに検証できるようファクトリとして公開する。
*/
export function createDevServerRegistry(
  dependencies: Readonly<DevServerDependencies> = devServerDefaultDependencies(),
): DevServerRegistry {
  const running = new Map<string, DevServerHandle>()

  const waitReady = async (
    handle: Readonly<DevServerHandle>,
    probeUrl: string,
    // AbortSignal は EventTarget で readonly 化できない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    signal?: AbortSignal,
  ): Promise<ReadyOutcome> => {
    // 回数と経過時刻の両方で打ち切る。回数だけだと 1 回のプローブが長引いたときに
    // readyTimeoutMs が実時間の上限にならず、その間 直列キューが空かない。
    const attempts = Math.max(1, Math.ceil(dependencies.readyTimeoutMs / dependencies.pollIntervalMs))
    const deadline = Date.now() + dependencies.readyTimeoutMs
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted === true) return 'cancelled'
      if (attempt > 0 && Date.now() >= deadline) return 'timeout'
      if (!handle.isAlive()) return 'exited'
      if (await dependencies.probe(probeUrl)) {
        // 200 を返したのが自分の子であることまで見る。strictPort により「ポートが他人のもの
        // なら子は必ず死ぬ」ので、この組で他人のサーバの URL を返す誤りがなくなる。
        return handle.isAlive() ? 'ready' : 'exited'
      }
      await dependencies.delay(dependencies.pollIntervalMs)
    }
    return 'timeout'
  }

  /**
  1 回ぶんの起動試行の結末。retryable はポートを奪われた場合だけ true になる。
  */
  type AttemptOutcome
    = { readonly ok: true, readonly handle: DevServerHandle }
      | { readonly ok: false, readonly retryable: boolean, readonly failure: DevServerStartFailure }

  const attemptStart = async (
    directory: string,
    port: number,
    // AbortSignal は EventTarget で readonly 化できない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    signal?: AbortSignal,
  ): Promise<AttemptOutcome> => {
    let handle: DevServerHandle
    try {
      handle = trackChild(dependencies.spawn({ directory, port }), port, dependencies.killEscalationMs)
    }
    catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        retryable: false,
        failure: {
          ok: false,
          reason: 'dev-server-spawn-failed',
          detail: `could not start the Slidev dev server: ${detail}`,
          stdout: '',
          stderr: '',
        },
      }
    }

    const outcome = await waitReady(handle, `http://127.0.0.1:${String(handle.port)}/`, signal)
    if (outcome === 'ready') return { ok: true, handle }

    handle.kill()
    const stderr = handle.stderr()
    return {
      ok: false,
      // ポートを奪われたときだけ次の候補へ進む。デッキ側の不備で落ちた子はポートを変えても同じ結果になる。
      retryable: outcome === 'exited' && stderr.includes(PORT_IN_USE_MARKER),
      failure: {
        ok: false,
        reason: failureReasonOf(outcome),
        detail: failureDetailOf(outcome, handle.port, dependencies.readyTimeoutMs),
        stdout: handle.stdout(),
        stderr,
      },
    }
  }

  const start = async (
    directory: string,
    options: DevServerStartOptions = {},
  ): Promise<DevServerStartResult> => {
    const { port, signal } = options
    const key = normalizeKey(directory)
    const existing = running.get(key)
    if (existing?.isAlive() === true) {
      if (port === undefined || port === existing.port) {
        return { ok: true, url: existing.url, port: existing.port, pid: existing.pid, reused: true }
      }
      // 別のポートで開き直す。指定先が空いていると確認した後で止める。
      // 止めた後で起動が失敗すると、プレビューが無くなるため。
      // 中断済みなら、動いている既存へ触れずに打ち切る。
      if (signal?.aborted === true) return cancelledFailure()
      if (!(await dependencies.isPortFree(port))) return portInUseFailure(port, dependencies.defaultPorts)
      existing.kill()
    }
    // 死んだ子・開き直しで止めた子の記録は捨てる。
    running.delete(key)

    let raced: DevServerStartFailure | undefined
    const candidatePorts = port === undefined ? dependencies.defaultPorts : [port]
    for (const candidate of candidatePorts) {
      // 候補の先頭で中断を見る。
      // ここで見ないと、既定ポートが全て使用中のときは isPortFree が毎回 continue するだけになる。
      // attemptStart (中断を見る場所) に一度も到達せず、中断を無視したまま dev-server-port-in-use を返してしまう。
      if (signal?.aborted === true) return cancelledFailure()
      if (!(await dependencies.isPortFree(candidate))) continue
      const outcome = await attemptStart(key, candidate, signal)
      if (outcome.ok) {
        running.set(key, outcome.handle)
        return {
          ok: true,
          url: outcome.handle.url,
          port: outcome.handle.port,
          pid: outcome.handle.pid,
          reused: false,
        }
      }
      if (!outcome.retryable) return outcome.failure
      raced = outcome.failure
    }
    return portInUseFailure(port, dependencies.defaultPorts, raced)
  }

  const stop = (directory: string): DevServerStopResult => {
    const key = normalizeKey(directory)
    const handle = running.get(key)
    if (handle === undefined) return { stopped: false, port: undefined }
    running.delete(key)
    // 記録は残っていたが既に死んでいた場合も「止めなかった」に畳む。port を載せると
    // 「起動中のサーバはありません」という応答にポート番号が付いて読み取りにくくなる。
    if (!handle.isAlive()) return { stopped: false, port: undefined }
    handle.kill()
    return { stopped: true, port: handle.port }
  }

  const stopAndWait = async (directory: string): Promise<DevServerStopResult> => {
    const handle = running.get(normalizeKey(directory))
    const result = stop(directory)
    if (handle === undefined || !result.stopped) return result
    // SIGKILL へ上げる時間に、終了の受信を待つ余裕を足した時刻まで待つ。
    const deadline = Date.now() + dependencies.killEscalationMs + dependencies.pollIntervalMs * 10
    while (handle.isAlive() && Date.now() < deadline) {
      await dependencies.delay(dependencies.pollIntervalMs)
    }
    return result
  }

  const shutdown = (): void => {
    for (const handle of running.values()) handle.kill()
    running.clear()
  }

  return { start, stop, stopAndWait, shutdown }
}

/**
試せるポートが残っていないときの失敗。

raced は空きを確認した後に他プロセスへポートを奪われて落ちた子の失敗で、あれば捕捉した出力を引き継ぐ。
*/
function portInUseFailure(
  port: number | undefined,
  defaultPorts: readonly number[],
  raced?: Readonly<DevServerStartFailure>,
): DevServerStartFailure {
  // 案内の宛先はこの detail を読むエージェントで、そのまま従うと利用者が見ているプレビューを
  // 無断で止めたり、ホストへ転送していないポートを自分で選んで開けない URL を返したりし得る。
  // どのポートが使用中かという事実だけ述べ、判断は利用者に確認してから動くよう案内する。
  const detail = port === undefined
    ? `cannot start the Slidev dev server: ports ${defaultPorts.join(' / ')} are all in use`
    + '; ask the user whether any preview may be stopped, or which port to use, then call again'
    : `cannot start the Slidev dev server: port ${String(port)} is in use`
      + `; tell the user that port ${String(port)} is in use, ask which port to use, then call again`
  return {
    ok: false,
    reason: 'dev-server-port-in-use',
    detail,
    stdout: raced?.stdout ?? '',
    stderr: raced?.stderr ?? '',
  }
}

/**
中断済みの呼び出しを打ち切るときの detail 文言。

attemptStart 経由 (子を起こした後に signal を見る failureDetailOf) と、start が子を起こす前に signal を見るルートがある。
両方から使うため、文言をここで 1 箇所にまとめる。
*/
const CANCELLED_DETAIL = 'Slidev dev server start aborted because the call was cancelled'

/**
spawn する前に中断済みと分かったときの失敗。子を起こしていないので stdout / stderr は空。
*/
function cancelledFailure(): DevServerStartFailure {
  return {
    ok: false,
    reason: 'dev-server-cancelled',
    detail: CANCELLED_DETAIL,
    stdout: '',
    stderr: '',
  }
}

function failureReasonOf(outcome: Exclude<ReadyOutcome, 'ready'>): DevServerFailureReason {
  switch (outcome) {
    case 'exited': {
      return 'dev-server-exited'
    }
    case 'timeout': {
      return 'dev-server-timeout'
    }
    case 'cancelled': {
      return 'dev-server-cancelled'
    }
  }
}

function failureDetailOf(outcome: Exclude<ReadyOutcome, 'ready'>, port: number, timeoutMs: number): string {
  switch (outcome) {
    case 'exited': {
      return `Slidev dev server on port ${String(port)} exited right after starting (see stderr for the reason)`
    }
    case 'timeout': {
      return `Slidev dev server on port ${String(port)} did not become reachable within `
        + `${String(timeoutMs)}ms`
    }
    case 'cancelled': {
      return CANCELLED_DETAIL
    }
  }
}

/**
MCP サーバプロセスで共有するレジストリ。

`slide_dev` ツールと serve.ts の終了接続が同じインスタンスを見る必要があるため、ここで 1 つに固定する。
プロセスをまたいだ停止・一覧はできない。その代わりに応答の pid を使う。
*/
export const devServerRegistry: () => DevServerRegistry = memoize(() => createDevServerRegistry())

/* c8 ignore start -- 実プロセス / 実ポート / 実 HTTP を使う既定実装。unit test は deps 差し替えで到達しない (ルートは tests/e2e/mcp-tools.test.ts が実プロセスで通す)。 */
export function devServerDefaultDependencies(): DevServerDependencies {
  return {
    spawn: (options: Readonly<DevServerSpawnOptions>) => {
      const spawnOptions: Parameters<typeof spawn>[2] = {
        cwd: options.directory,
        // interface-env: none
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }
      // `--remote` は必須。付けないと slidev は [::1] だけにバインドし、127.0.0.1 からも
      // devcontainer 外のブラウザからも到達できない (start.mjs も同じ理由で付けている)。
      return spawn(
        process.execPath,
        [resolveSlidevBin(), '--remote', '--port', String(options.port)],
        spawnOptions,
      )
    },
    isPortFree,
    defaultPorts: DEFAULT_PORTS,
    probe: isHttpReachable,
    delay,
    readyTimeoutMs: READY_TIMEOUT_MS,
    pollIntervalMs: READY_POLL_INTERVAL_MS,
    killEscalationMs: KILL_ESCALATION_MS,
  }
}

/**
bind を試すホスト。vite (slidev が使う dev サーバ) の `isPortAvailable` と同じ判定にそろえる。
vite の `wildcardHosts` はこの 2 つに `::` の 10 進表記 (`0000:...:0000`) を加えた 3 つ。
表記が違うだけで実体は `::` と同じ bind になるため、判定にはこの 2 つで足りる。
*/
const WILDCARD_HOSTS: readonly string[] = ['0.0.0.0', '::']

/**
bind できるかでポートの空きを確かめる。確認と slidev の起動の間のレースは呼び出し側が吸収する。

`0.0.0.0` と `::` の両方を試し、どちらかが使用中なら使用中とする。slidev が張る `0.0.0.0`
だけを見ると、`::1` や `::` (ipv6Only) だけで listen している先行プロセスを取りこぼす。その
ポートでも slidev 自身は起動できるが、返す URL の `localhost` は `::1` を先に引くクライアント
では先行プロセスへつながり、利用者は別のサーバを開くことになる。
*/
async function isPortFree(port: number): Promise<boolean> {
  // 2 つの bind を同時に持たない。:: の dual-stack bind は自分が張った 0.0.0.0 の bind と
  // 衝突するため、片方を close してから次を試す (順に await する意図的な直列実行)。
  for (const host of WILDCARD_HOSTS) {
    if (!(await canBind(port, host))) return false
  }
  return true
}

/**
指定ホストへの bind を試す。使用中と扱うのは EADDRINUSE のときだけ。
*/
async function canBind(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.on('error', (error: Readonly<NodeJS.ErrnoException>) => {
      // EADDRINUSE 以外 (権限不足の EACCES、IPv6 無効環境での `::` bind の
      // EAFNOSUPPORT / EADDRNOTAVAIL 等) は「使用中」ではない。ここで使用中と誤判定すると、
      // 空いているポートを候補から外してしまう。実際に bind できない場合は slidev 自身が
      // 起動に失敗し、dev-server-exited と stderr で利用者に届く。
      resolve(error.code !== 'EADDRINUSE')
    })
    server.listen(port, host, () => {
      // close のエラーは判定に使わない。listen のコールバックに来た時点で bind は成功しており、
      // close の失敗で「空いていた」という判定は変わらない。
      server.close(() => {
        resolve(true)
      })
    })
  })
}

async function isHttpReachable(url: string): Promise<boolean> {
  try {
    // signal を付けないと undici の既定 (300 秒) まで待ち、readyTimeoutMs が実時間の
    // 上限として働かなくなる。中断は「まだ ready でない」と同じ扱いで次の反復へ回る。
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    // 本文は読まない。捨てないと undici がソケットを保持し続ける。
    await response.body?.cancel()
    return response.status === 200
  }
  catch {
    // 起動途中は ECONNREFUSED になる。到達できない = まだ ready でない、というだけ。
    return false
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
/* c8 ignore stop */
