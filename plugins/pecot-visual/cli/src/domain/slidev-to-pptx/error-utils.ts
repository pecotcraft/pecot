/* eslint-disable unicorn/name-replacements -- ファイル名 (utils) と引数名 (e) は既存 lib/ 由来の踏襲 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// CSI シーケンス。Playwright は call log の各行を dim (`ESC[2m … ESC[22m`) で囲む。
// eslint-disable-next-line no-control-regex -- ANSI 制御文字そのものが除去対象
const ANSI_CSI_PATTERN = /\u{1B}\[[\d;]*[a-z]/giu

/**
Playwright が Error.message の 2 行目以降にぶら下げる call log の開始行。
*/
const CALL_LOG_HEADING_PATTERN = /^[^\S\n]*Call log:/m

/**
Error.message を、機械可読な payload に載せられる 1 行へ整える。

Playwright の timeout error は、message に ANSI 装飾つきの call log を数百字ぶら下げる。
そのまま errors[].message へ入れると、JSON の値が制御文字と再試行ログで埋まる。
そこで装飾を落とし、call log 以降を切る。
判別に要る情報（API 名・timeout 値）は call log より前に載るため、失われない。
*/
export function sanitizeErrorMessage(e: unknown): string {
  const plain = errorMessage(e).replaceAll(ANSI_CSI_PATTERN, '')
  const callLogAt = plain.search(CALL_LOG_HEADING_PATTERN)
  return (callLogAt === -1 ? plain : plain.slice(0, callLogAt)).trimEnd()
}
/* eslint-enable unicorn/name-replacements */
