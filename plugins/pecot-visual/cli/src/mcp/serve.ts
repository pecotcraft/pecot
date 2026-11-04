// `pecotv mcp` — MCP サーバとして stdio で待ち受ける実装。
//
// 配置が src/commands/ ではなく src/mcp/ なのは ESLint の依存方向制約
// (commands → mcp の import 禁止) による。cli.ts はどの zone の target でもないため、
// ここから直接呼べる。cli.ts は薄い Command だけを持ち、本モジュールは action 内の
// dynamic import で初めて読み込まれる (MCP SDK の読み込みを mcp 実行時に限定するため)。
//
// exit code 規約:
//   0 = 正常終了 (クライアントが stdin を閉じるまで待ち受ける)
//   1 = 起動失敗 (transport 接続エラー等) / stdout への書き込み失敗

// 本ファイルの引数は Node stream (Readable / Writable) とその write シグネチャで占められる。
// いずれも上流が mutable 型でしか公開していない。
// readonly 化は呼び出し側の型を壊すため、境界としてそのまま受ける。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import type { Readable } from 'node:stream'
import { Writable } from 'node:stream'

import type { McpServer, Transport } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { devServerRegistry } from './dev-server-registry.js'
import { createMcpServer } from './server.js'
import { allTools } from './tools/index.js'
import { ignoreRejection } from '../domain/_shared/ignore-rejection.js'

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

// 同じ stdout に二重でガードを張ると、2 回目が「1 回目の転送用 write」を元の write として
// 束縛してしまい、JSON-RPC が stderr へ回る。張り済みの stdout には最初に作った Writable を
// そのまま返す。キーが stream オブジェクトなので、テストごとに別のフェイクを使っても混在しない。
const installedGuards = new WeakMap<WritableTarget, Writable>()

/**
stdio ルートの stdout を JSON-RPC 専有にするガードを張る。

返した Writable だけが本物の stdout へ届き、それ以外の stdout 書き込み
(console.log・依存ライブラリの進捗表示など) は stderr へ逃がす。

「process.stdout.write を差し替えるだけ」では transport 自身の JSON-RPC 応答まで
stderr に流れてクライアントが無応答になる。
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
    // process.stdout.write(chunk, encoding, callback) の両シグネチャを受ける (encoding と callback は省略できる)。
    // encoding は意図的に捨てる: 逃がす先の stderr は既定の utf8 で解釈すればよく、
    // ここで扱うのは console 系が書く utf8 文字列か Buffer に限られる。encoding を
    // 引き回すと BufferEncoding への narrowing のために型アサーションが必要になる。
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    const isWritten = stderr.write(chunk)
    done?.()
    return isWritten
  }

  // 代入ではなく defineProperty を使うのは、オーバーロード付きの write に単一シグネチャの
  // 関数を代入する際の `as` キャストを避けるため。
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
    stderr.write(`pecotv mcp: stdout への書き込みに失敗しました: ${error.message}\n`)
    process.exitCode = 1
  })

  installedGuards.set(stdout, protocolStdout)
  return protocolStdout
}

/**
SIGTERM / SIGINT / 'exit' の接続先。既定は process 本体で、テストはフェイクを渡す。
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
  起動中の Slidev dev サーバ (slide_dev) を全て停止する。
  */
  readonly shutdownDevServers: () => void
  readonly signals: ProcessSignals
}

/**
dev サーバの後始末を終了ルートへ接続する。

子を kill しない限り親は終了できない。stdio パイプを持つ子プロセスハンドルが Node の
イベントループを保持するため、stdin の EOF で server.close() を呼んでも `pecotv mcp` が
残り続ける。接続は「孤児を残さないため」だけでなく「親が終われるようにするため」にも要る。

SIGTERM / SIGINT はハンドラを登録した時点で既定の即終了が無効になるので、明示的に exit する。
'exit' は最後の網で、同期処理しか動かないため kill だけを撃つ。

どのルートでも撃てるのは SIGTERM までで、レジストリが持つ SIGKILL エスカレーション
(dev-server-registry.ts の kill) は届かない。親が先に exit すると保留中のタイマは
実行されないためで、エスカレーションが働くのは MCP サーバが生き続ける `stop` 呼び出しに限る。
*/
function installShutdownHandlers(dependencies: Readonly<McpServeDependencies>): void {
  dependencies.signals.on('SIGTERM', () => {
    dependencies.shutdownDevServers()
    dependencies.signals.exit(SIGTERM_EXIT_CODE)
  })
  dependencies.signals.on('SIGINT', () => {
    dependencies.shutdownDevServers()
    dependencies.signals.exit(SIGINT_EXIT_CODE)
  })
  dependencies.signals.on('exit', () => {
    dependencies.shutdownDevServers()
  })
}

/**
MCP サーバを stdio transport で公開する。

serveStdio は 2025 系と 2026-07-28 系の両方に応答する。接続ごとに factory から
インスタンスを作り、最初のメッセージで版を決める (factory は 1 接続で 2 回呼ばれ得る)。
transport は従来どおり stdout ガード越しに作って渡すため、JSON-RPC 以外は stdout に載らない。

クライアントが stdin を閉じたら dev サーバを止め、接続を閉じて自力で終了できるようにする。
v2 の StdioServerTransport は EOF で自分も閉じるが、dev サーバの後始末は本層の責務。
*/
export function runMcpServe(dependencies: Readonly<McpServeDependencies>): StdioServerHandle {
  const protocolStdout = dependencies.installStdoutGuard()
  const transport = dependencies.createTransport(dependencies.stdin, protocolStdout)

  installShutdownHandlers(dependencies)

  // 不正な JSON-RPC やハンドラ不在など、リクエスト単位の応答にならない異常は onerror にしか
  // 出てこない。stdout は JSON-RPC 専有なので stderr へ 1 行流す。エントリ・transport の異常
  // (serveStdio の onerror) とインスタンス内部の異常 (server.server.onerror) に同じ報告を張る。
  // serveStdio は接続確定後の異常を options.onerror とインスタンスの onerror の両方へ流すため、
  // 同じ Error を 2 回報告しないよう報告済みを覚えておく。
  const reported = new WeakSet<Error>()
  const report = (error: Readonly<Error>): void => {
    if (reported.has(error)) return
    reported.add(error)
    dependencies.stderr.write(`pecotv mcp: ${error.message}\n`)
  }

  const handle: StdioServerHandle = serveStdio(() => {
    // factory に持たせる副作用は、インスタンスの生成と onerror の設定だけにする。
    try {
      const server = dependencies.createServer()
      // SDK の Protocol は EventTarget ではなく onerror プロパティで通知する。
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      server.server.onerror = report
      return server
    }
    catch (error: unknown) {
      // 起動失敗は exit 1 の契約。報告は serveStdio が onerror へ流すので、ここでは終了コードと後始末だけ行う。
      process.exitCode = 1
      // 終了処理中の close 失敗は報告先が無いため捨てる。
      void ignoreRejection(handle.close())
      throw error
    }
  }, { transport, onerror: report })

  dependencies.stdin.once('end', () => {
    // dev サーバを先に落とす。子の stdio パイプがイベントループを保持するため、
    // 残したままだと接続を閉じるだけでは自力終了できない。
    dependencies.shutdownDevServers()
    /* c8 ignore next 3 -- close() が reject するルートは StdioServerTransport には無く、防御網のみ */
    // 終了処理中の close 失敗は報告先が無いため握り潰す。
    void ignoreRejection(handle.close())
  })

  return handle
}

/**
`pecotv mcp` の action 本体。

program.parse は action の Promise を await しない。
そのため例外はここで捕まえて process.exitCode へ載せる (unhandled rejection にしない)。
*/
export function executeMcpServe(buildDependencies: () => McpServeDependencies): void {
  const dependencies = buildDependencies()
  try {
    runMcpServe(dependencies)
  }
  catch (error: unknown) {
    dependencies.stderr.write(`pecotv mcp: ${formatError(error)}\n`)
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
    shutdownDevServers: () => {
      devServerRegistry().shutdown()
    },
    signals: process,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
