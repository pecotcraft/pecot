// stderr の診断行と stdout のデータを書く、唯一の場所。
// 行の形は specs/021-cli-output-functions/contracts/output-lines.md が決める。
// 期待の行は tests/diagnostics-cases.json に置く。
import { z } from 'zod'

export interface DiagnosticStream {
  write(text: string): unknown
}

/**
done の動詞。自由な文字列を受け取らない
*/
export const DiagnosticVerbSchema = z.enum(['create', 'add'])

export type DiagnosticVerb = z.infer<typeof DiagnosticVerbSchema>

export interface DiagnosticOperation {
  readonly verb: DiagnosticVerb
  readonly target: string
}

export interface Diagnostics {
  readonly error: (message: string) => void
  readonly warning: (message: string) => void
  /**
  情報の診断だけに使う。進捗の行には使わない
  */
  readonly note: (message: string) => void
  /**
  実行した操作を `<過去分詞>: <target>` で出す
  */
  readonly done: (operation: DiagnosticOperation) => void
}

function pastOf(verb: DiagnosticVerb): string {
  switch (verb) {
    case 'create': { return 'created' }
    case 'add': { return 'added' }
  }
}

/**
末尾の改行を取り除き、2 行目以降の先頭に空白 2 つを付け、末尾に改行を 1 つ付ける
*/
function formatMessage(prefix: string, message: string): string {
  const lines = message.replace(/\n+$/, '').split('\n')
  return `${prefix}: ${lines.join('\n  ')}\n`
}

export function createDiagnostics(stderr: DiagnosticStream): Diagnostics {
  return {
    error: (message) => { stderr.write(formatMessage('error', message)) },
    warning: (message) => { stderr.write(formatMessage('warning', message)) },
    note: (message) => { stderr.write(formatMessage('note', message)) },
    done: ({ verb, target }) => { stderr.write(`${pastOf(verb)}: ${target}\n`) },
  }
}

/**
結果の本体を stdout にそのまま出す。末尾に改行が無ければ 1 つ足す
*/
export function writeData(stdout: DiagnosticStream, text: string): void {
  stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

/**
commander が組み立てた使い方エラー・ヘルプの枠を、手を加えずに書く。commander が `error: ` を付ける
*/
export function passthrough(stream: DiagnosticStream, text: string): void {
  stream.write(text)
}
