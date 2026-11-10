// Athena に投げるクエリが参照専用かの判定（FR-008 / research R6）。
// 判定できない入力は拒否側へ倒す。`EXPLAIN ANALYZE` は内側の文を実行するので、`EXPLAIN` を剥がす反復で塞ぐ。

/**
参照専用として受け付ける先頭キーワード。判定は大小文字を区別しない。
*/
const READ_ONLY_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC'])

/**
`EXPLAIN` の直後に任意個・任意順で並べられる修飾語。
*/
const EXPLAIN_MODIFIERS: ReadonlySet<string> = new Set(['ANALYZE', 'VERBOSE'])

/**
先頭の空白を読み飛ばして最初の語（英字列）を取る。
*/
const LEADING_WORD = /^\s*[A-Z]+/i

/**
拒否理由。message は呼び出し元へそのまま返す。unterminated を分けるのは、変更系と誤読させないため。
*/
export type AthenaQueryRejectionReason = 'empty' | 'multi-statement' | 'not-read-only' | 'unterminated'

const REJECTION_MESSAGES: Record<AthenaQueryRejectionReason, string> = {
  'empty': 'query_string is empty. Specify a read-only query',
  'multi-statement': 'Multiple statements are not allowed. Specify a single statement with nothing after the ;',
  'not-read-only': 'Only read-only queries (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) can be executed',
  'unterminated': 'Cannot confirm the query is read-only because a quote or comment is not closed',
}

export type AthenaQueryClassification
  = | { readonly allowed: true }
    | {
      readonly allowed: false
      readonly reason: AthenaQueryRejectionReason
      readonly message: string
    }

/**
リテラル・コメントを均した本文と、未終端があったかどうか。
*/
interface ScanResult {
  readonly code: string
  readonly unterminated: boolean
}

function reject(reason: AthenaQueryRejectionReason, message: string): AthenaQueryClassification {
  return { allowed: false, reason, message }
}

/**
`--` 行コメントの終端（改行の次）。改行が無ければ末尾。
*/
function skipLineComment(query: string, start: number): number {
  const end = query.indexOf('\n', start)
  return end === -1 ? query.length : end + 1
}

/**
ブロックコメントの終端。非入れ子なので最初の閉じ記号で終わる。未終端なら undefined。
*/
function skipBlockComment(query: string, start: number): number | undefined {
  const end = query.indexOf('*/', start)
  return end === -1 ? undefined : end + 2
}

/**
引用の終端（閉じ引用符の次）。エスケープは引用符の 2 重化だけで、Trino では `\` は普通の文字。
*/
function skipQuoted(query: string, start: number, quote: string): number | undefined {
  let index = start
  while (index < query.length) {
    if (query.charAt(index) !== quote) {
      index += 1
      continue
    }
    if (query.charAt(index + 1) === quote) {
      index += 2
      continue
    }
    return index + 1
  }
  return undefined
}

/**
コメントを空白へ、引用の中身を空の引用へ均す。リテラル内の `;` や `--` を後段の走査に拾わせないため。
*/
function scan(query: string): ScanResult {
  let code = ''
  let index = 0

  while (index < query.length) {
    const char = query.charAt(index)
    const next = query.charAt(index + 1)

    if (char === '-' && next === '-') {
      index = skipLineComment(query, index + 2)
      code += ' '
      continue
    }
    if (char === '/' && next === '*') {
      const end = skipBlockComment(query, index + 2)
      if (end === undefined) return { code, unterminated: true }
      index = end
      code += ' '
      continue
    }
    if (char === '\'' || char === '"') {
      const end = skipQuoted(query, index + 1, char)
      if (end === undefined) return { code, unterminated: true }
      index = end
      code += char + char
      continue
    }

    code += char
    index += 1
  }

  return { code, unterminated: false }
}

/**
最初の `;` より前（= 1 文目）。`;` が無ければ全体。
*/
function firstStatement(code: string): string {
  const semicolon = code.indexOf(';')
  return semicolon === -1 ? code : code.slice(0, semicolon)
}

/**
最初の `;` の後ろに文が続くか。末尾の `;` だけなら続かない。
*/
function hasFollowingStatement(code: string): boolean {
  const semicolon = code.indexOf(';')
  return semicolon !== -1 && code.slice(semicolon + 1).trim() !== ''
}

function leadingWord(text: string): string {
  const matched = LEADING_WORD.exec(text) ?? undefined
  return matched === undefined ? '' : matched[0].trimStart().toUpperCase()
}

function afterLeadingWord(text: string): string {
  const matched = LEADING_WORD.exec(text) ?? undefined
  return matched === undefined ? text : text.slice(matched[0].length)
}

/**
先頭が `(` ならその対応括弧までを剥がす。対応する `)` が無ければ剥がさず、拒否側へ倒す。
*/
function afterOptionGroup(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('(')) return text

  let depth = 0
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed.charAt(index)
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return trimmed.slice(index + 1)
    }
  }
  return trimmed
}

/**
1 文が参照専用か。再帰でなくループなのは、`EXPLAIN` を重ねた入力でコールスタックを溢れさせないため。
*/
function isReadOnlyStatement(statement: string): boolean {
  let current = statement
  let word = leadingWord(current)

  while (word === 'EXPLAIN') {
    let rest = afterLeadingWord(current)
    while (EXPLAIN_MODIFIERS.has(leadingWord(rest))) {
      rest = afterLeadingWord(rest)
    }
    current = afterOptionGroup(rest)
    word = leadingWord(current)
  }

  return READ_ONLY_KEYWORDS.has(word)
}

/**
クエリを参照専用 / 拒否に分類する。複文を空より先に見るのは、`; SELECT 1` を「複文」と伝えるため。
*/
export function classifyAthenaQuery(query: string): AthenaQueryClassification {
  const scanned = scan(query)
  if (scanned.unterminated) return reject('unterminated', REJECTION_MESSAGES.unterminated)

  if (hasFollowingStatement(scanned.code)) {
    return reject('multi-statement', REJECTION_MESSAGES['multi-statement'])
  }

  const statement = firstStatement(scanned.code)
  if (statement.trim() === '') return reject('empty', REJECTION_MESSAGES.empty)

  return isReadOnlyStatement(statement)
    ? { allowed: true }
    : reject('not-read-only', REJECTION_MESSAGES['not-read-only'])
}
