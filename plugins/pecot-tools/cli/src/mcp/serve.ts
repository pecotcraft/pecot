// `pecot-tools mcp` — MCP サーバとして stdio で待ち受ける実装。
//
// cli.ts は薄い Command だけを持つ。
// 本モジュールは action 内の dynamic import で初めて読み込まれる (MCP SDK の読み込みを mcp 実行時に限定するため)。
//
// exit code 規約:
//   0 = 正常終了 (クライアントが stdin を閉じるまで待ち受ける)
//   1 = 起動失敗 (transport 接続エラー等) / stdout への書き込み失敗

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 本ファイルの引数は Node stream。
   具体的には Readable / Writable と write (`chunk: Uint8Array` / `callback: (error?: Error | null) => void`)。
   いずれも上流が mutable 型でしか公開していない。
   readonly 化は呼び出し側の型を壊すため、境界としてそのまま受ける。 */

import type { Readable } from 'node:stream'
import { Writable } from 'node:stream'

import type { McpServer, Transport } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { killRunningAwscli } from '../infra/awscli.js'
import { shutdownLoginRegistry } from '../infra/sso/login-registry.js'
import { createMcpServer } from './server.js'
import { allTools } from './tools/index.js'
import { ignoreRejection } from '../infra/ignore-rejection.js'

/**
診断行の接頭辞。stdout は JSON-RPC 専有なので、報告先は stderr のみ。
*/
const LOG_PREFIX = 'pecot-tools mcp:'

/**
SIGTERM / SIGINT を受けたときの終了コード (シェルの慣習どおり 128 + シグナル番号)。
*/
const SIGTERM_EXIT_CODE = 143
const SIGINT_EXIT_CODE = 130

/**
process.stdout / process.stderr のうち、ガードが必要とする最小の書き込み面。
*/
export interface WritableTarget {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

// 同じ stdout に二重でガードを張ると、2 回目が「1 回目の転送用 write」を元の write として束縛する。
// すると JSON-RPC が stderr へ回る。張り済みの stdout には、最初に作った Writable をそのまま返す。
// キーが stream オブジェクトなので、テストごとに別のフェイクを使っても混入しない。
const installedGuards = new WeakMap<WritableTarget, Writable>()

/**
stdio の stdout を JSON-RPC 専有にするガードを張る。

返した Writable だけが本物の stdout へ届き、それ以外の stdout 書き込み
(console.log・依存ライブラリの進捗表示など) は stderr へ逃がす。

「process.stdout.write を差し替えるだけ」では、transport 自身の JSON-RPC 応答まで stderr に流れる。
するとクライアントが無応答になる。
そのため、差し替え前に束縛した元の write を使う専用 Writable を transport へ渡す、という二段構えが必須になる。

同じ stdout に対しては冪等で、2 回目以降は初回に作った Writable を返す。
*/
export function installStdoutGuard(stdout: WritableTarget, stderr: WritableTarget): Writable {
  const installed = installedGuards.get(stdout)
  if (installed !== undefined) return installed

  type StderrWriteCallback = (error?: Error | null) => void

  const isOriginalWrite = stdout.write.bind(stdout)

  const isForwardToStderr = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | StderrWriteCallback,
    callback?: StderrWriteCallback,
  ): boolean => {
    // `process.stdout.write(chunk, encoding?, callback?)` の両シグネチャを受ける。
    // encoding は意図的に捨てる: 逃がす先の stderr は既定の utf8 で解釈すればよく、
    // ここで扱うのは console 系が書く utf8 文字列か Buffer に限られる。
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    const isWritten = stderr.write(chunk)
    done?.()
    return isWritten
  }

  // 代入ではなく defineProperty を使うのは、オーバーロード付きの write に単一シグネチャの
  // 関数を代入する際の型アサーションを避けるため。
  Object.defineProperty(stdout, 'write', {
    value: isForwardToStderr,
    writable: true,
    configurable: true,
  })

  const protocolStdout = new Writable({
    write(chunk: string | Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      isOriginalWrite(chunk, callback)
    },
  })

  // stdout の相手が消えた後の書き込み (EPIPE) は Writable の 'error' として上がる。
  // 拾わないと uncaught 例外でスタックトレースごと落ちるため、1 行報告して終了コードを立てる。
  protocolStdout.on('error', (error: Readonly<Error>) => {
    stderr.write(`${LOG_PREFIX} stdout への書き込みに失敗しました: ${error.message}\n`)
    process.exitCode = 1
  })

  installedGuards.set(stdout, protocolStdout)
  return protocolStdout
}

/**
SIGTERM / SIGINT / 'exit' の配線先。既定は process 本体で、テストはフェイクを渡す。
*/
export interface ProcessSignals {
  on(event: 'SIGTERM' | 'SIGINT' | 'exit', listener: () => void): void
  exit(code: number): void
}

export interface McpServeDependencies {
  readonly createServer: () => McpServer
  readonly createTransport: (stdin: Readable, stdout: Writable) => Transport
  /**
  stdout ガードを張り、JSON-RPC 専用の Writable を返す。
  */
  readonly installStdoutGuard: () => Writable
  readonly stdin: Readable
  readonly stderr: WritableTarget
  /**
  終了時に呼ぶ後始末。

  実行中の awscli 子プロセスのように「子プロセスを持つ機能」がここへ登録する。
  子を kill しない限り親は終了できない (子の stdio パイプが Node のイベントループを
  保持するため、stdin の EOF で server.close() を呼んでも待ち続ける)。
  */
  readonly onShutdown: readonly (() => void)[]
  readonly signals: ProcessSignals
}

function runShutdown(dependencies: Readonly<McpServeDependencies>): void {
  for (const hook of dependencies.onShutdown) hook()
}

/**
後始末を終了処理へ配線する。

SIGTERM / SIGINT はハンドラを登録した時点で既定の即終了が無効になるので、明示的に exit する。
'exit' は最後の網で、同期処理しか実行されないため後始末だけを呼ぶ。
*/
function installShutdownHandlers(dependencies: Readonly<McpServeDependencies>): void {
  dependencies.signals.on('SIGTERM', () => {
    runShutdown(dependencies)
    dependencies.signals.exit(SIGTERM_EXIT_CODE)
  })
  dependencies.signals.on('SIGINT', () => {
    runShutdown(dependencies)
    dependencies.signals.exit(SIGINT_EXIT_CODE)
  })
  dependencies.signals.on('exit', () => {
    runShutdown(dependencies)
  })
}

/**
MCP サーバを stdio で待ち受ける。

serveStdio が接続ごとに 2025 系と 2026-07-28 系のどちらかを選び、factory のインスタンスを
1 つ固定して配る。factory は 1 接続で複数回呼ばれ得る (2026-07-28 は探査用インスタンスを捨てることがある)。
そのため createServer() と onerror の設定以外の副作用は持たせない。
後始末の配線 (signals / stdin) は factory の外で 1 回だけ行う。

接続が完了しても待ち受けは続く。クライアントが stdin を閉じたら子プロセスを落として
接続を閉じ、SIGTERM を待たずにプロセスが自力で終了できるようにする。
*/
export function runMcpServe(dependencies: Readonly<McpServeDependencies>): StdioServerHandle {
  const protocolStdout = dependencies.installStdoutGuard()
  const transport = dependencies.createTransport(dependencies.stdin, protocolStdout)

  installShutdownHandlers(dependencies)

  // 不正な JSON-RPC やハンドラ不在など、リクエスト単位の応答にならない異常は onerror にしか出てこない。
  // stdout は JSON-RPC 専有なので stderr へ 1 行流す。
  // 接続側 (options.onerror) とインスタンス内部 (server.server.onerror) は通知元が別なので、同じ報告関数を両方に渡す。
  // serveStdio は接続確定後の異常を、接続側とインスタンスの両方へ流す。
  // そのため同じ Error は 1 回だけ報告する。
  const reported = new WeakSet<Readonly<Error>>()
  const report = (error: Readonly<Error>): void => {
    if (reported.has(error)) return
    reported.add(error)
    dependencies.stderr.write(`${LOG_PREFIX} ${error.message}\n`)
  }

  const handle = serveStdio(
    () => {
      try {
        const server = dependencies.createServer()
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Protocol は onerror 経由で通知
        server.server.onerror = report
        return server
      }
      catch (error: unknown) {
        // factory の失敗は serveStdio が onerror (report) へ流して接続側へ内部エラーを返す。
        // 起動に失敗したプロセスは待ち受けを続けても役に立たないため、終了コードを立てて閉じる。
        process.exitCode = 1
        // 終了処理中の close 失敗は報告先が無いため握り潰す。
        void ignoreRejection(handle.close())
        throw error
      }
    },
    { transport, onerror: report },
  )

  dependencies.stdin.once('end', () => {
    // 子プロセスを先に落とす。子の stdio パイプがイベントループを保持するため、
    // 残したままだと接続を閉じるだけでは自力終了できない。
    runShutdown(dependencies)
    // 終了処理中の close 失敗は報告先が無いため握り潰す。
    void ignoreRejection(handle.close())
  })

  return handle
}

/**
`pecot-tools mcp` の action 本体。

program.parse は action の Promise を await しない。
そのため例外はここで捕まえて、process.exitCode へ反映する (unhandled rejection にしない)。
*/
export function executeMcpServe(buildDependencies: () => McpServeDependencies): void {
  const dependencies = buildDependencies()
  try {
    runMcpServe(dependencies)
  }
  catch (error: unknown) {
    dependencies.stderr.write(`${LOG_PREFIX} ${formatError(error)}\n`)
    process.exitCode = 1
  }
}

export function mcpServeDefaultDependencies(): McpServeDependencies {
  return {
    createServer: () => createMcpServer(allTools()),
    createTransport: (stdin: Readable, stdout: Writable) => new StdioServerTransport(stdin, stdout),
    /* c8 ignore next 2 -- 実 process.stdout を差し替えるため単体テストからは起動できない (installStdoutGuard 本体はフェイク stream で検証) */
    installStdoutGuard: () => installStdoutGuard(process.stdout, process.stderr),
    stdin: process.stdin,
    stderr: process.stderr,
    // tools/call 実行中の awscli 子プロセスと、SSO ログインで待機中の子プロセスを落とす。
    // 親が先に消えると、子は PPID 1 へ再親付けされる。
    // timeout を張っていた親が居なくなるので、打ち切りも働かなくなる（SSO は最長 10 分待つ）。
    onShutdown: [killRunningAwscli, shutdownLoginRegistry],
    signals: process,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
