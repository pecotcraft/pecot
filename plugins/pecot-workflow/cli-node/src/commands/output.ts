// CLI の出力の行をそろえる共通の関数。
//
// 行の形は specs/021-cli-output-functions/contracts/output-lines.md が決める。
// コマンドは操作（動詞と対象）を 1 つ作り、実行の前に planned を、実行の後に done を呼ぶ。
// 期待の行は tests/output/cases.json に置き、Python の側と同じ値を共有する。
import { z } from 'zod'

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
  readonly warning: (message: string) => void
  readonly error: (message: string) => void
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
      io.stderr(formatMessage('warning', message))
    },
    error: (message) => {
      io.stderr(formatMessage('error', message))
    },
    count: (label, value) => {
      io.stderr(`count: ${label}: ${value === undefined ? 'unknown' : String(value)}\n`)
    },
    data: (text) => {
      io.stdout(text.endsWith('\n') ? text : `${text}\n`)
    },
  }
}
