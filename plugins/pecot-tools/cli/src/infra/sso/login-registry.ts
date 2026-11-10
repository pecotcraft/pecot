// `aws sso login` の子プロセスを預かるレジストリ（research R5 / FR-007）。
// URL とコードが揃った時点で start() を resolve し、子は生かしたまま close とタイマで拾う。
// 秘匿化はここで、応答の上限はツール層で掛ける（infra から mcp は import できない）。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- LoginProcess は mutable */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import type { FailureCategory } from '../../domain/allowlist.js'
import { classifyFailure } from '../../domain/failure.js'
import { redactSecrets } from '../../domain/redact.js'
import { AUTOFILL_MARKER, parseSsoLoginOutput, type SsoLoginPrompt } from '../../domain/sso-output.js'
import { AWSCLI_COMMAND, createCapture, mergeStderr, type OutputCapture } from '../awscli.js'

/**
開始から時間切れ（`timed-out`）にするまでの上限。値の出所は research R5 の 10 分。
*/
export const SSO_LOGIN_TIMEOUT_MS = 600_000

/**
URL とコードが確定するまでの上限。実行枠を占有し続けないよう、`aws --version` の PROBE_TIMEOUT_MS と揃える。
*/
export const SSO_PROMPT_TIMEOUT_MS = 15_000

/**
セッションの状態（data-model §SsoLoginSession）。
*/
export type SsoLoginState = 'pending' | 'completed' | 'failed' | 'timed-out'

/**
レジストリが外へ出すセッション 1 件のスナップショット。start() の戻り値も同じ形。
*/
export interface SsoLoginSession {
  /**
  対象プロファイル。空文字は awscli の既定解決に委ねた場合。
  */
  readonly profile: string
  readonly state: SsoLoginState
  readonly verificationUrl?: string
  /**
  コードを自動入力する認証 URL。これを開けば利用者はコード入力が要らない。
  */
  readonly verificationUrlComplete?: string
  readonly userCode?: string
  /**
  開始時刻（epoch ms）。
  */
  readonly startedAt: number
  /**
  子プロセスの stdout + stderr（秘匿化済み）。
  */
  readonly output: string
  /**
  `failed` のときの失敗種別。
  */
  readonly category?: FailureCategory
  /**
  awscli の終了コード。子がまだ終わっていなければキーごと無い。シグナルで終わった子は null。
  */
  readonly exitCode?: number | null
}

export interface LoginRegistryOptions {
  /**
  既定は SSO_LOGIN_TIMEOUT_MS。
  */
  readonly timeoutMs?: number
  /**
  既定は SSO_PROMPT_TIMEOUT_MS。
  */
  readonly promptTimeoutMs?: number
}

export interface LoginRegistry {
  /**
  ログインを開始し、URL / コードの確定か終端状態のどちらかまで待って返す。
  */
  start(profile?: string): Promise<SsoLoginSession>
  /**
  開始済みセッションの現在値。無ければ undefined。
  */
  get(profile?: string): SsoLoginSession | undefined
  /**
  生存中の子へ SIGTERM を送り、預かりを空にする。process の 'exit' からも呼ぶため同期で完結する。
  */
  shutdown(): void
}

/**
レジストリ内部で持つ 1 件。state / prompt / category は遷移で書き換わる。
*/
interface LoginProcess {
  readonly profile: string
  readonly startedAt: number
  readonly child: ChildProcess
  /**
  子プロセスの stdio が閉じたら finalizeOutput が undefined に落とし、capture を手放す。
  */
  stdout: OutputCapture | undefined
  stderr: OutputCapture | undefined
  readonly timers: NodeJS.Timeout[]
  state: SsoLoginState
  prompt: SsoLoginPrompt | undefined
  category: FailureCategory | undefined
  /**
  close で受けた終了コード。未終了は undefined、シグナル終了は null。
  */
  exitCode: number | null | undefined
  /**
  spawn 自体が失敗したときの errno と message（stderr には流れてこない）。
  */
  spawnErrorCode: string | undefined
  spawnErrorMessage: string
  /**
  finalizeOutput が確定させた output（秘匿化済み）。確定前は undefined。
  */
  finalOutput: string | undefined
}

function isTerminal(state: SsoLoginState): boolean {
  return state !== 'pending'
}

/**
pipe の読み出し側で上がる 'error' の受け皿。張らないと未処理の 'error' がサーバごと落とす。
*/
function ignoreStreamError(): void {
  // 何もしない。リスナを張ること自体が目的。
}

function clearTimers(record: Readonly<LoginProcess>): void {
  for (const timer of record.timers) clearTimeout(timer)
}

/**
capture から output を組み立てる。stdout に stderr（spawn の error 行を含む）を継いで秘匿化する。
*/
function computeOutput(record: Readonly<LoginProcess>): string {
  const stderr = mergeStderr(record.stderr?.text() ?? '', record.spawnErrorMessage)
  return redactSecrets(mergeStderr(record.stdout?.text() ?? '', stderr))
}

/**
応答へ出す output。確定済みなら finalOutput を、未確定なら capture から都度組み立てる。
*/
function outputOf(record: Readonly<LoginProcess>): string {
  return record.finalOutput ?? computeOutput(record)
}

/**
子の stdio が閉じた（close / error）ら呼ぶ。output を確定させた時点で capture を手放し、二重呼び出しは finalOutput の有無で防ぐ。
*/
function finalizeOutput(record: LoginProcess): void {
  if (record.finalOutput !== undefined) return
  record.finalOutput = computeOutput(record)
  record.stdout = undefined
  record.stderr = undefined
}

function snapshotOf(record: Readonly<LoginProcess>): SsoLoginSession {
  return {
    profile: record.profile,
    state: record.state,
    ...(record.prompt !== undefined && {
      verificationUrl: record.prompt.verificationUrl,
      userCode: record.prompt.userCode,
      ...(record.prompt.verificationUrlComplete !== undefined && { verificationUrlComplete: record.prompt.verificationUrlComplete }),
    }),
    startedAt: record.startedAt,
    output: outputOf(record),
    ...(record.category !== undefined && { category: record.category }),
    ...(record.exitCode !== undefined && { exitCode: record.exitCode }),
  }
}

/**
ログインレジストリを作る。実運用は loginRegistry の 1 つだが、テストが状態を持ち越さないようファクトリで公開する。
*/
export function createLoginRegistry(options: Readonly<LoginRegistryOptions> = {}): LoginRegistry {
  const timeoutMs = options.timeoutMs ?? SSO_LOGIN_TIMEOUT_MS
  const promptTimeoutMs = options.promptTimeoutMs ?? SSO_PROMPT_TIMEOUT_MS

  /**
  キー（`profile ?? ''`）ごとの最新セッション。終端状態のものは次の start で置き換える。
  */
  const sessions = new Map<string, LoginProcess>()
  /**
  確定前の start。同一キーの 2 回目はこれを await して二重起動を避ける。
  */
  const starting = new Map<string, Promise<SsoLoginSession>>()
  /**
  生存中の子。spawn 直後に足し、close で外す。shutdown はここを辿る。
  */
  const running = new Set<LoginProcess>()
  /**
  shutdown() 済みの印。ensureAwscli() の待ち中に終了処理が先に動くと、start() が回収されない子を spawn するため、冒頭で見る。
  */
  let isStopped = false

  const beginLogin = (key: string, profile: string | undefined): Promise<SsoLoginSession> =>
    new Promise<SsoLoginSession>((resolve) => {
      // `--profile=<value>` の 1 トークンにする。許可リストの組み立てと同じ形。
      // 分離して渡すと、先頭ハイフンを含む値の扱いが 2 か所で割れる。
      const arguments_ = [
        'sso',
        'login',
        ...(profile === undefined ? [] : [`--profile=${profile}`]),
        '--no-browser',
        '--use-device-code',
      ]

      const child = spawn(AWSCLI_COMMAND, arguments_, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })

      const record: LoginProcess = {
        profile: key,
        startedAt: Date.now(),
        child,
        stdout: createCapture(),
        stderr: createCapture(),
        timers: [],
        state: 'pending',
        prompt: undefined,
        category: undefined,
        exitCode: undefined,
        spawnErrorCode: undefined,
        spawnErrorMessage: '',
        finalOutput: undefined,
      }
      running.add(record)
      sessions.set(key, record)

      let isSettled = false
      const settle = (): void => {
        if (isSettled) return
        isSettled = true
        resolve(snapshotOf(record))
      }

      /**
      close が受けた終了コードをそのまま渡す（record.child.exitCode を別の定義元として持たない）。
      */
      const fail = (exitCode: number | null): void => {
        record.state = 'failed'
        record.category = classifyFailure({
          exitCode,
          stderr: mergeStderr(record.stderr?.text() ?? '', record.spawnErrorMessage),
          timedOut: false,
          ...(record.spawnErrorCode !== undefined && { spawnErrorCode: record.spawnErrorCode }),
        })
      }

      child.stdout.on('error', ignoreStreamError)
      child.stderr.on('error', ignoreStreamError)

      child.stdout.on('data', (chunk: Readonly<Buffer>) => {
        record.stdout?.push(chunk)
        // 累積全文をそのつど掛ける。autofill URL は後の行に届き得るので、揃うまで再 parse して prompt を差し替える。
        if (record.prompt?.verificationUrlComplete !== undefined) return
        // URL / コード確定後は、autofill 行を含む chunk だけ再 parse する。毎 chunk の split と走査を避けるため。
        if (record.prompt !== undefined && !chunk.toString('utf8').includes(AUTOFILL_MARKER)) return
        const prompt = parseSsoLoginOutput(record.stdout?.text() ?? '')
        if (prompt === undefined) return
        record.prompt = prompt
        // 確定した promptTimer はここで役目を終える。settled のみを見ていると、close/error が
        // 遅れて届くまでの最長 promptTimeoutMs をタイマが無駄に生かし続ける。
        clearTimeout(promptTimer)
        settle()
      })

      child.stderr.on('data', (chunk: Readonly<Buffer>) => {
        record.stderr?.push(chunk)
      })

      child.on('error', (error: Readonly<Error>) => {
        // 既に終端状態（時間切れ・prompt 待ちの打ち切り）なら、遅れて届いた 'error' で
        // spawnErrorMessage を上書きしない（outputOf の結果が確定後に変わってしまう）。
        if (!isTerminal(record.state)) {
          record.spawnErrorMessage = error.message
          record.spawnErrorCode
            = 'code' in error && typeof error.code === 'string' ? error.code : undefined
          fail(record.child.exitCode)
        }
        // kill() の失敗で出る 'error' には後続の close が無い。ここでも running から外さないと
        // shutdown() の対象に残り続ける。
        running.delete(record)
        clearTimers(record)
        finalizeOutput(record)
        settle()
      })

      child.on('close', (code: number | null) => {
        running.delete(record)
        clearTimers(record)
        record.exitCode = code
        // 時間切れ・prompt 待ちの打ち切りで既に終端なら、その理由を SIGTERM 由来の失敗で
        // 上書きしない。
        if (!isTerminal(record.state)) {
          // 確定前の exit 0 は防御として completed に倒す。2.36.40 は --use-device-code で毎回デバイスフローに入り、未観測。
          if (code === 0) record.state = 'completed'
          else fail(code)
        }
        finalizeOutput(record)
        settle()
      })

      const promptTimer = setTimeout(() => {
        if (isSettled) return
        record.state = 'failed'
        record.category = 'timeout'
        child.kill('SIGTERM')
        settle()
      }, promptTimeoutMs)
      promptTimer.unref()

      const loginTimer = setTimeout(() => {
        if (isTerminal(record.state)) return
        record.state = 'timed-out'
        child.kill('SIGTERM')
        settle()
      }, timeoutMs)
      loginTimer.unref()

      record.timers.push(promptTimer, loginTimer)
    })

  const start = async (profile?: string): Promise<SsoLoginSession> => {
    const key = profile ?? ''

    if (isStopped) {
      return {
        profile: key,
        state: 'failed',
        startedAt: Date.now(),
        output: 'Cannot start a new login because the server is shutting down',
        category: 'other',
      }
    }

    const inFlight = starting.get(key)
    if (inFlight !== undefined) return inFlight

    // 同じキーで pending のフローがあれば新規起動せず既存の URL / コードを返す（R5）。
    const existing = sessions.get(key)
    if (existing !== undefined && !isTerminal(existing.state)) return snapshotOf(existing)

    const pending = beginLogin(key, profile)
    starting.set(key, pending)
    try {
      return await pending
    }
    finally {
      starting.delete(key)
    }
  }

  const get = (profile = ''): SsoLoginSession | undefined => {
    const record = sessions.get(profile)
    return record === undefined ? undefined : snapshotOf(record)
  }

  const shutdown = (): void => {
    isStopped = true
    for (const record of running) {
      clearTimers(record)
      record.child.kill('SIGTERM')
    }
    running.clear()
    sessions.clear()
    starting.clear()
  }

  return { start, get, shutdown }
}

const sharedRegistry: { current?: LoginRegistry } = {}

/**
MCP サーバプロセスで共有するレジストリ。ツールと終了配線が同じインスタンスを見ないと、status が引けず子も落ちない。
*/
export function loginRegistry(): LoginRegistry {
  sharedRegistry.current ??= createLoginRegistry()
  return sharedRegistry.current
}

/**
serve.ts の onShutdown へ登録する後始末。1 度も開始していなければ何もしない。
*/
export function shutdownLoginRegistry(): void {
  sharedRegistry.current?.shutdown()
}
