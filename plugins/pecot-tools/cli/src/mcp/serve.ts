// `pecot-tools mcp` の実装。cli.ts の dynamic import で読む。exit code は 0=正常 / 1=起動失敗・stdout 書き込み失敗。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数は Node stream。上流が mutable 型でしか公開していない */

import type { Readable } from 'node:stream'
import { Writable } from 'node:stream'

import type { McpServer, Transport } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { createDiagnostics } from '../diagnostics.js'
import { killRunningAwscli } from '../infra/awscli.js'
import { shutdownLoginRegistry } from '../infra/sso/login-registry.js'
import { createMcpServer } from './server.js'
import { allTools } from './tools/index.js'
import { ignoreRejection } from '../infra/ignore-rejection.js'

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

// 二重に張ると 2 回目が転送用 write を元の write として束縛し、JSON-RPC が stderr へ回る。張り済みなら初回の Writable を返す。
const installedGuards = new WeakMap<WritableTarget, Writable>()

/**
stdout を JSON-RPC 専有にする。返した Writable だけが本物の stdout へ届き、ほかの書き込みは stderr へ逃がす。
同じ stdout に対しては冪等。
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
    // encoding は捨てる。逃がす先の stderr は既定の utf8 で足りる。
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    // eslint-disable-next-line no-restricted-syntax -- stdout へ書かれた生の chunk を、行に整えず stderr へ逃がす
    const isWritten = stderr.write(chunk)
    done?.()
    return isWritten
  }

  // 代入だと、オーバーロード付きの write への型アサーションが要る。
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

  // EPIPE は 'error' として上がる。拾わないと uncaught 例外で落ちる。
  protocolStdout.on('error', (error: Readonly<Error>) => {
    createDiagnostics(stderr).error(`failed to write to stdout: ${error.message}`)
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
  終了時の後始末。子の stdio パイプがイベントループを保持するため、子を kill しないと親は終了できない
  */
  readonly onShutdown: readonly (() => void)[]
  readonly signals: ProcessSignals
}

function runShutdown(dependencies: Readonly<McpServeDependencies>): void {
  for (const hook of dependencies.onShutdown) hook()
}

/**
後始末を終了処理へ配線する。SIGTERM / SIGINT は既定の即終了が無効になるので、明示的に exit する
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
MCP サーバを stdio で待ち受ける。factory は 1 接続で複数回呼ばれ得るため、createServer() と onerror 以外の副作用を持たせない。
stdin が閉じたら子プロセスを落として接続を閉じる
*/
export function runMcpServe(dependencies: Readonly<McpServeDependencies>): StdioServerHandle {
  const protocolStdout = dependencies.installStdoutGuard()
  const transport = dependencies.createTransport(dependencies.stdin, protocolStdout)

  installShutdownHandlers(dependencies)

  // 接続側とインスタンスの両方の onerror に同じ Error が流れるので、1 回だけ報告する。
  const reported = new WeakSet<Readonly<Error>>()
  const report = (error: Readonly<Error>): void => {
    if (reported.has(error)) return
    reported.add(error)
    createDiagnostics(dependencies.stderr).error(error.message)
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
        // 起動に失敗したプロセスは待ち受けても役に立たないため、終了コードを立てて閉じる。
        process.exitCode = 1
        // 終了処理中の close 失敗は報告先が無いため握り潰す。
        void ignoreRejection(handle.close())
        throw error
      }
    },
    { transport, onerror: report },
  )

  dependencies.stdin.once('end', () => {
    // 子を先に落とさないと、接続を閉じても自力終了できない。
    runShutdown(dependencies)
    // 終了処理中の close 失敗は報告先が無いため握り潰す。
    void ignoreRejection(handle.close())
  })

  return handle
}

/**
`pecot-tools mcp` の action 本体。program.parse は Promise を await しないので、例外はここで process.exitCode へ反映する
*/
export function executeMcpServe(buildDependencies: () => McpServeDependencies): void {
  const dependencies = buildDependencies()
  try {
    runMcpServe(dependencies)
  }
  catch (error: unknown) {
    createDiagnostics(dependencies.stderr).error(formatError(error))
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
    // 親が先に消えると子が残り、timeout も働かない（SSO は最長 10 分待つ）。
    onShutdown: [killRunningAwscli, shutdownLoginRegistry],
    signals: process,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
