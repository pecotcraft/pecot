// `pecot mcp` の実装。cli.ts が dynamic import で読む。stdout は JSON-RPC 専用にし、stdin が閉じたら接続を閉じる。
// pecot-tools の serve.ts と骨格が同じ。SIGTERM・SIGINT の配線と子の kill は、子が短命で git が同期なので持たない（共有は別途）。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数は Node の stream。mutable な型でしか公開されていない */
import { Writable } from 'node:stream'
import type { Readable } from 'node:stream'

import type { McpServer, Transport } from '@modelcontextprotocol/server'
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { setChildStdin } from '../infra/child-stdin.js'
import { createOutput } from '../commands/output.js'
import { createMcpServer } from './server.js'
import type { McpServerOptions } from './server.js'

/**
process.stdout / process.stderr のうち、ガードが使う面
*/
export interface WritableTarget {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

// 二重に張ると、2 回目が転送用の write を元の write として束縛し、JSON-RPC が stderr へ回る。張り済みなら初回の Writable を返す
const installedGuards = new WeakMap<WritableTarget, Writable>()

// stdout の書き込み失敗は、ガードと SDK の onerror に同じ Error で届く。1 回だけ報告する
const reportedErrors = new WeakSet<Readonly<Error>>()

function discard(): void {
  // stdout には何も出さない
}

function reportTo(target: WritableTarget): (message: string) => void {
  const output = createOutput(false, {
    stdout: discard,
    stderr: (text) => {
      target.write(text)
    },
  })
  return (message) => {
    output.error(message)
  }
}

async function closeQuietly(handle: StdioServerHandle): Promise<void> {
  try {
    await handle.close()
  }
  catch {
    // 終了処理中の失敗は、報告先が無い
  }
}

/**
stdout を JSON-RPC 専用にする。返した Writable だけが本物の stdout へ届き、ほかの書き込みは stderr へ逃がす。同じ stdout に対しては冪等
*/
export function installStdoutGuard(stdout: WritableTarget, stderr: WritableTarget): Writable {
  const installed = installedGuards.get(stdout)
  if (installed !== undefined) return installed

  type WriteCallback = (error?: Error | null) => void
  const isOriginalWrite = stdout.write.bind(stdout)

  const isForwardToStderr = (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    // eslint-disable-next-line no-restricted-syntax -- stdout へ書かれた生の chunk を、行に整えず stderr へ逃がす
    const isWritten = stderr.write(chunk)
    done?.()
    return isWritten
  }
  Object.defineProperty(stdout, 'write', { value: isForwardToStderr, writable: true, configurable: true })

  const protocolStdout = new Writable({
    write(chunk: string | Uint8Array, _encoding: BufferEncoding, callback: WriteCallback): void {
      isOriginalWrite(chunk, callback)
    },
  })
  // EPIPE は error イベントで上がる。拾わないと uncaught 例外で落ちる
  protocolStdout.on('error', (error: Readonly<Error>) => {
    reportedErrors.add(error)
    reportTo(stderr)(`failed to write to stdout: ${error.message}`)
    process.exitCode = 1
  })
  installedGuards.set(stdout, protocolStdout)
  return protocolStdout
}

type McpReportUnexpected = NonNullable<McpServerOptions['reportUnexpected']>

export interface McpServeDependencies {
  readonly createServer: (reportUnexpected: McpReportUnexpected) => McpServer
  readonly createTransport: (stdin: Readable, stdout: Writable) => Transport
  /**
  stdout のガードを張り、JSON-RPC 専用の Writable を返す
  */
  readonly installStdoutGuard: () => Writable
  readonly stdin: Readable
  readonly stderr: WritableTarget
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
MCP サーバを stdio で待ち受ける。factory は 1 接続で複数回呼ばれうるので、createServer と onerror の設定以外の副作用を持たせない。
stdin が閉じたら接続を閉じる
*/
export function runMcpServe(dependencies: Readonly<McpServeDependencies>): StdioServerHandle {
  const protocolStdout = dependencies.installStdoutGuard()
  const transport = dependencies.createTransport(dependencies.stdin, protocolStdout)
  const reportError = reportTo(dependencies.stderr)

  // 接続とインスタンスの onerror に同じ Error が流れるので、1 回だけ報告する
  const report = (error: Readonly<Error>): void => {
    if (reportedErrors.has(error)) return
    reportedErrors.add(error)
    reportError(error.message)
  }
  const reportUnexpected: McpReportUnexpected = (error, collected) => {
    reportError(error instanceof Error ? (error.stack ?? error.message) : String(error))
    if (collected.stdout !== '') reportError(`stdout so far: ${collected.stdout}`)
    if (collected.stderr !== '') reportError(`stderr so far: ${collected.stderr}`)
  }

  const handle = serveStdio(
    () => {
      try {
        const server = dependencies.createServer(reportUnexpected)
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Protocol は onerror 経由で通知する
        server.server.onerror = report
        return server
      }
      catch (error: unknown) {
        // 起動に失敗したプロセスは待ち受けても役に立たない
        process.exitCode = 1
        void closeQuietly(handle)
        throw error
      }
    },
    { transport, onerror: report },
  )
  return handle
}

export function defaultDependencies(): McpServeDependencies {
  return {
    createServer: reportUnexpected => createMcpServer(undefined, { reportUnexpected }),
    createTransport: (stdin, stdout) => new StdioServerTransport(stdin, stdout),
    /* v8 ignore next -- 実 process.stdout を差し替えるので、単体テストからは起動しない（ガード本体は偽の stream で確かめる） */
    installStdoutGuard: () => installStdoutGuard(process.stdout, process.stderr),
    stdin: process.stdin,
    stderr: process.stderr,
  }
}

/**
`pecot mcp` の本体。子プロセスの stdin を切り離してから待ち受ける。起動できたら 0、同期の起動の失敗は stderr に出して 1 を返す
*/
export function executeMcpServe(buildDependencies: () => McpServeDependencies = defaultDependencies): number {
  const dependencies = buildDependencies()
  // 子が JSON-RPC のパイプ（fd 0）を読むと、メッセージを食う
  setChildStdin('ignore')
  try {
    runMcpServe(dependencies)
    return 0
  }
  catch (error: unknown) {
    reportTo(dependencies.stderr)(messageOf(error))
    return 1
  }
}
