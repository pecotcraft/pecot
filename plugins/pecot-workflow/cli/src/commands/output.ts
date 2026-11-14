// CLI の出力の行をそろえる共通の関数。
//
// 行の形は specs/021-cli-output-functions/contracts/output-lines.md が決める。
// コマンドは操作（動詞と対象）を 1 つ作り、実行の前に planned を、実行の後に done を呼ぶ。
// 期待の行は tests/output/cases.json に置き、Python の側と同じ値を共有する。
import { readSync } from 'node:fs'

import { z } from 'zod'

import { formatHinted } from '../domain/command-hint.js'
import type { HintedText } from '../domain/command-hint.js'
import { hasErrorCode } from '../infra/os-error.js'

import type { CommandIo } from './registry.js'

/**
操作の動詞。自由な文字列を受け取らない
*/
export const VerbSchema = z.enum(['create', 'update', 'delete', 'add', 'remove', 'close', 'reopen', 'merge', 'move', 'set', 'skip', 'unchanged'])

export type Verb = z.infer<typeof VerbSchema>

/**
動詞の過去分詞。done の前置きになる
*/
function pastOf(verb: Verb): string {
  switch (verb) {
    case 'create': { return 'created' }
    case 'update': { return 'updated' }
    case 'delete': { return 'deleted' }
    case 'add': { return 'added' }
    case 'remove': { return 'removed' }
    case 'close': { return 'closed' }
    case 'reopen': { return 'reopened' }
    case 'merge': { return 'merged' }
    case 'move': { return 'moved' }
    case 'set': { return 'set' }
    case 'skip': { return 'skipped' }
    case 'unchanged': { return 'unchanged' }
  }
}

/**
plan と result の元になる操作
*/
export interface Operation {
  readonly verb: Verb
  readonly target: string
}

export interface Output {
  /**
  dry-run のときだけ、実行する操作を stderr に出す
  */
  readonly planned: (operation: Operation) => void
  /**
  dry-run でないときだけ、実行した操作を stderr に出す
  */
  readonly done: (operation: Operation) => void
  /**
  案内（HintedText）は io の出し先の形にする
  */
  readonly warning: (message: string | HintedText) => void
  readonly error: (message: string | HintedText) => void
  /**
  value が未設定なら `unknown` と出す
  */
  readonly count: (label: string, value: number | undefined) => void
  /**
  結果の本体を stdout にそのまま出す。末尾に改行が無ければ 1 つ足す
  */
  readonly data: (text: string) => void
}

/**
末尾の改行を取り除き、2 行目以降の先頭に空白 2 つを付け、末尾に改行を 1 つ付ける
*/
function formatMessage(prefix: string, message: string): string {
  const lines = message.replace(/\n+$/, '').split('\n')
  return `${prefix}: ${lines.join('\n  ')}\n`
}

export function createOutput(isDryRun: boolean, io: CommandIo): Output {
  const render = (message: string | HintedText): string => formatHinted(message, io.surface ?? 'cli')
  return {
    planned: ({ verb, target }) => {
      if (!isDryRun) return
      // unchanged に現在形は無いので、文を変える
      io.stderr(verb === 'unchanged' ? `dry-run: would leave ${target} unchanged\n` : `dry-run: would ${verb} ${target}\n`)
    },
    done: ({ verb, target }) => {
      if (isDryRun) return
      io.stderr(`${pastOf(verb)}: ${target}\n`)
    },
    warning: (message) => {
      io.stderr(formatMessage('warning', render(message)))
    },
    error: (message) => {
      io.stderr(formatMessage('error', render(message)))
    },
    count: (label, value) => {
      io.stderr(`count: ${label}: ${value === undefined ? 'unknown' : String(value)}\n`)
    },
    data: (text) => {
      io.stdout(text.endsWith('\n') ? text : `${text}\n`)
    },
  }
}

/**
fd から buffer へ読んだバイト数。0 は終端
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- buffer は書き込み先
export type ReadBytes = (fd: number, buffer: Uint8Array) => number

const RETRY_WAIT_MILLISECONDS = 10

/**
非ブロッキングの入力が空のとき、読み直す前に待つ
*/
/* v8 ignore next 3 -- 本物の EAGAIN は再現できないので、テストは wait を差し替える */
function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MILLISECONDS)
}

/**
1 バイトずつ読むのは、次の行を先読みして取りこぼさず、process.stdin に触れないため。read と wait はテスト用の差し替え口
*/
export function createLineReader(
  fd: number,
  read: ReadBytes = (source, buffer) => readSync(source, buffer),
  wait: () => void = sleepBriefly,
): () => string | undefined {
  const NEWLINE = 10
  return () => {
    const bytes: number[] = []
    const buffer = new Uint8Array(1)
    for (;;) {
      let count: number
      try {
        count = read(fd, buffer)
      }
      catch (error: unknown) {
        // 非ブロッキングの入力が空のとき。process.stdin に触ると入力が非ブロッキングになる環境がある
        if (hasErrorCode(error) && error.code === 'EAGAIN') {
          wait()
          continue
        }
        throw error
      }
      if (count === 0) return bytes.length === 0 ? undefined : Buffer.from(bytes).toString('utf8')
      const byte = buffer[0] ?? NEWLINE
      if (byte === NEWLINE) return Buffer.from(bytes).toString('utf8')
      bytes.push(byte)
    }
  }
}

/**
process.stdout・process.stderr に書き、fd（既定は標準入力）から読む CommandIo。src/cli.ts の main が使う
*/
export function createProcessIo(fd = 0): CommandIo {
  return {
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
    readLine: createLineReader(fd),
  }
}

/**
確認の途中で入力が終わった（Python の click の Abort）。
code を持たせない（link の処理は code を持つ例外を握るため、これは握られずに最上位まで届く）
*/
export class AbortedError extends Error {
  constructor() {
    super('Aborted.')
    this.name = 'AbortedError'
  }
}

export const ABORTED_EXIT_CODE = 1

/**
中止を stderr に出して、終了コードを返す。`Aborted.` の前に改行は入らない
*/
export function reportAborted(io: CommandIo): number {
  io.stderr('Aborted.\n')
  return ABORTED_EXIT_CODE
}

/**
末尾の空白 1 つを stdout に出すのは、既存の CLI の出力（問いは stderr、空白だけ stdout）を変えないため。
readLine が無い（MCP）か入力が終わると AbortedError を投げる
*/
export function isConfirmed(io: CommandIo, text: string): boolean {
  for (;;) {
    io.stderr(`${text} [y/N]:`)
    io.stdout(' ')
    const line = io.readLine?.()
    if (line === undefined) throw new AbortedError()
    switch (line.trim().toLowerCase()) {
      case 'y':
      case 'yes': { return true }
      case 'n':
      case 'no':
      case '': { return false }
      default: { io.stderr('Error: invalid input\n') }
    }
  }
}
