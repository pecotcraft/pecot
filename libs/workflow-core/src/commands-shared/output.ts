// ツールの出力の行をそろえる共通の関数。
//
// 行の形は specs/021-cli-output-functions/contracts/output-lines.md が決める。
// コマンドは操作（動詞と対象）を 1 つ作り、実行の前に planned を、実行の後に done を呼ぶ。
// 期待の行は tests/output/cases.json に置き、Python の側と同じ値を共有する。

import { z } from 'zod'

import { formatHinted } from '../domain/command-hint.js'
import type { HintedText } from '../domain/command-hint.js'

import type { CommandIo } from './command-definition.js'

/**
操作の動詞。自由な文字列を受け取らない
*/
export const VerbSchema = z.enum(['create', 'update', 'delete', 'add', 'remove', 'close', 'reopen', 'merge', 'move', 'rename', 'set', 'skip', 'unchanged'])

export type Verb = z.infer<typeof VerbSchema>

/**
動詞の過去分詞。done の前置きになる
*/
export function pastOf(verb: Verb): string {
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
    case 'rename': { return 'renamed' }
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
  /**
  本題でない片付けの操作。行は同じに出し、MCP の結果の message には選ばない
  */
  readonly aside?: boolean
}

/**
D は MCP の成功の data の型（ツールの output の z.input）。actions/ では result は何も出さない
*/
export interface Output<D extends object = Record<string, unknown>> {
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
  標準エラーに書かず、MCP の失敗の detail にだけ文を渡す。error の行を出さずに止まるコマンドが使う
  */
  readonly detail: (message: string | HintedText) => void
  /**
  子プロセスの生の出力を、MCP の失敗の log にだけ渡す
  */
  readonly log: (text: string) => void
  /**
  value が未設定なら `unknown` と出す
  */
  readonly count: (label: string, value: number | undefined) => void
  /**
  結果の本体を stdout にそのまま出す。末尾に改行が無ければ 1 つ足す
  */
  readonly data: (text: string) => void
  /**
  MCP の成功の data に項目を渡す。何度も呼べば浅く重なる（後の値が勝つ）ので、配列は組み終えてから 1 回だけ渡す
  */
  // 補助の関数が Output（既定の D）で受け取れるよう、メソッドの形で書く（引数の型の比べ方が双変になる）
  result(fields: Readonly<Partial<D>>): void
  /**
  io の signal（MCP の要求の取り消し）。actions/ では undefined
  */
  readonly signal: Readonly<AbortSignal> | undefined
}

/**
API を呼ばない操作の行を出す。dry-run では計画、実行では結果になる
*/
export function settle(out: Output, operation: Operation): void {
  out.planned(operation)
  out.done(operation)
}

/**
warning の行の前置き。MCP の側はこれで stderr から warning の文を拾う
*/
export const WARNING_PREFIX = 'warning: '

export const ERROR_PREFIX = 'error: '

/**
末尾の改行を取り除き、2 行目以降の先頭に空白 2 つを付け、末尾に改行を 1 つ付ける
*/
function formatMessage(prefix: string, message: string): string {
  const lines = message.replace(/\n+$/, '').split('\n')
  return `${prefix}${lines.join('\n  ')}\n`
}

function render(message: string | HintedText): string {
  return formatHinted(message)
}

export function createOutput<D extends object = Record<string, unknown>>(isDryRun: boolean, io: CommandIo): Output<D> {
  const writeResult = (line: string, aside: boolean | undefined): void => {
    io.stderr(`${line}\n`)
    if (aside !== true) io.resultLine?.(line)
  }
  return {
    planned: ({ verb, target, aside }) => {
      if (!isDryRun) return
      // unchanged に現在形は無いので、文を変える
      writeResult(verb === 'unchanged' ? `dry-run: would leave ${target} unchanged` : `dry-run: would ${verb} ${target}`, aside)
    },
    done: ({ verb, target, aside }) => {
      if (isDryRun) return
      writeResult(`${pastOf(verb)}: ${target}`, aside)
    },
    warning: (message) => {
      const text = render(message)
      io.stderr(formatMessage(WARNING_PREFIX, text))
      io.warning?.(formatMessage('', text).trimEnd())
    },
    error: (message) => {
      const text = render(message)
      io.stderr(formatMessage(ERROR_PREFIX, text))
      io.error?.(formatMessage('', text).trimEnd())
    },
    detail: (message) => {
      const text = formatMessage('', render(message)).trimEnd()
      if (text !== '') io.error?.(text)
    },
    log: (text) => {
      if (text.trim() !== '') io.log?.(text)
    },
    count: (label, value) => {
      io.stderr(`count: ${label}: ${value === undefined ? 'unknown' : String(value)}\n`)
    },
    data: (text) => {
      io.stdout(text.endsWith('\n') ? text : `${text}\n`)
    },
    result(fields) {
      io.data?.(fields)
    },
    signal: io.signal,
  }
}

/**
確認が要る所で止めた（Python の click の Abort）。
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
  io.error?.('Aborted.')
  return ABORTED_EXIT_CODE
}

/**
上書きなどの確認が要る所で、問わずに止める。MCP には利用者に問う手段が無いので、続けるかはツールの入力（force など）で決める
*/
export function abortUnconfirmed(io: CommandIo, text: string): never {
  io.error?.(text)
  throw new AbortedError()
}
