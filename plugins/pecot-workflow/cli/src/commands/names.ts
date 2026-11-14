// コマンドの名前まわりの小さな関数。help・バインド・定義書の書き出しが同じものを使う。

/**
入力名を長いオプションの形にする。`force_overwrite_active` は `--force-overwrite-active`
*/
export function flagOf(name: string): string {
  return `--${name.replaceAll('_', '-')}`
}

/**
文字列を名前の順（コードユニットの順）に並べる比較関数
*/
export function byName(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

const COMMAND_WORD_PATTERN = /^[a-z]+$/u
const COMMAND_WORD_COUNT = 2

/**
コマンド名の決まりに合わない path と、その理由
*/
export interface CommandNameViolation {
  readonly path: string
  readonly reason: string
}

/**
コマンド名の決まり（`<対象> <動詞>` の 2 語で、どちらの語も英小文字だけ）に合わない path を、渡された順で返す。全部が合えば空
*/
export function commandNameViolations(paths: readonly (readonly string[])[]): readonly CommandNameViolation[] {
  return paths
    .map(path => ({
      path: path.join(' '),
      reason: [
        ...path.length === COMMAND_WORD_COUNT ? [] : [`has ${String(path.length)} word(s); a command name is '<object> <verb>' (2 words)`],
        ...path.filter(word => !COMMAND_WORD_PATTERN.test(word)).map(word => `'${word}' is not lowercase letters only (^[a-z]+$)`),
      ].join('; '),
    }))
    .filter(violation => violation.reason !== '')
}
