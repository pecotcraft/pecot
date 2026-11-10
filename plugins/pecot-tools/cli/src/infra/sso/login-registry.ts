// `aws sso login` の子プロセスを預かるレジストリ（research R5 / FR-007 / data-model §SsoLoginSession）。
//
// `sso login` はデバイス認証が終わるまで戻らないため、close まで全量を溜める runAwscli では
// URL とコードを即時に返せない。ここでは自前で spawn し、stdout が届くたびに累積出力を
// parseSsoLoginOutput へ掛けて、URL とコードが揃った時点で start() を resolve する。
// 子はそのまま生かし、完了・失敗・時間切れは close とタイマで拾う。
//
// 子は spawn 直後に生存集合へ登録する。URL / コードの確定前も後始末の対象で、登録が遅れると
// サーバ終了時に PPID 1 へ再親付けされた子が最大 10 分動き続ける。
//
// 出力に対する加工の分担は「秘匿化はここ、応答の上限はツール層」。infra から mcp を import
// できないため、limitOutput は mcp/tools/sso.ts が掛ける。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- LoginProcess は mutable。
   Node 由来の型を抱える。中身は ChildProcess・出力 capture・タイマ配列。
   Readonly<T> では deep readonly の要求を満たせない。読み取りしかしない関数として扱う。 */

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
URL とコードが確定するまでの上限。

research R5 と契約書が定めるのは 10 分だけ。
だが `sso login` が何も出さずに生き続けると、呼び出し元の tools/call が 10 分ブロックする。
応答を返せない状態を早く畳むための上限で、契約書側には未反映の差分。

確定までの計測値は 0.65 秒。
この待ちは、mcp/executor.ts の createBoundedExecutor(4) の実行枠を占有し続ける。
そのため `aws --version` の待ち時間（infra/awscli.ts の PROBE_TIMEOUT_MS）と同じ上限に揃える。
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
  awscli の終了コード。子がまだ終わっていなければキーごと無い。

  応答の exitCode は許可リストの呼び出しと同じく、awscli の終了コードをそのまま返す規約。
  ここで持たないと、ツール層が値を作れない。シグナルで終わった子は null になる。
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
子プロセスの stdio が閉じた（close / error）ら呼ぶ。

sessions は終端状態のレコードを次の start か shutdown() まで保持し続ける。
capture（最大 CAPTURE_LIMIT_BYTES 分の Buffer）を持たせたままにすると、
常駐する profile 数に比例して解放されない領域が積み上がる。output を確定させた時点で capture を手放す。

Node は 'error' の後に 'close' も発火する（awscli.ts の finalize と同じ）。
そのため二重呼び出しは finalOutput の有無で防ぐ（2 回目は capture が既に無く output が痩せるため）。
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
ログインレジストリを作る。

MCP サーバは 1 プロセスなので実運用のインスタンスは 1 つ（loginRegistry）だが、
テストが状態を持ち越さずに検証できるようファクトリとして公開する。
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
  shutdown() 済みの印。

  startLogin は registry.start() の前に ensureAwscli()（最長 15 秒）を await する。
  その待ち中に stdin の EOF が来て runShutdown が先に実行されると、再開した start() が誰も回収しない子を spawn する。
  子の stdio パイプがイベントループを保持し、親は loginTimer が最長 10 分後に発火するまで終了できない。start() の冒頭でここを見て spawn 自体をしない。
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
        // 出力は chunk 単位で届く。累積した全文をそのつど掛け、URL とコードが揃った時点で応答する。
        // autofill URL はその後の行に届き得るので、揃うまでは再 parse を続けて prompt を差し替える
        // （確定そのものは遅らせない）。全部そろえば以後の chunk では何もしない。
        if (record.prompt?.verificationUrlComplete !== undefined) return
        // 基本の URL / コードが確定した後は、autofill 行を含む chunk が来たときだけ再 parse する。
        // 含まない awscli（確認結果: 2.36.40 は含む）では、以後の chunk を処理せず返す。
        // 累積全文（最大 CAPTURE_LIMIT_BYTES）の split と走査を、毎 chunk 実行しないため。
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
          // 確定前の exit 0 は「デバイスフローを経ず成功した」場合。
          // awscli 2.36.40 で確認したところ、--use-device-code を指定するとキャッシュトークンの有無に依らず
          // 毎回デバイスフローへ入る。そのため未観測で、ここは防御として completed に倒している。
          // research R5 の「抽出できずに終了 = failed」は、SSO 設定なし（exit ≠ 0）を想定した記述。
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
MCP サーバプロセスで共有するレジストリ。

ツール（mcp/tools/sso.ts）と終了配線（mcp/serve.ts）が同じインスタンスを見ないと、
開始したフローを status が引けず、終了時に子も落ちない。
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
