// Athena に投げるクエリが参照専用かの判定（FR-008 / research R6）。
//
// 完全な SQL パーサは持たない。目的は「変更系と複文を awscli 起動前に落とす」ことなので、
// 判定できない入力（未終端の引用符・コメント）は許可側ではなく拒否側へ倒す。
// 判定は Trino 構文を前提にする。Athena では `WITH` で始まる文は必ず問い合わせで、
// `INSERT INTO … WITH` / `CREATE TABLE … AS WITH` の `WITH` は先頭に来ない。
// STG1 での確認（2026-09-07）: `WITH … INSERT` は StartQueryExecution 自体が失敗する。
// 失敗の内容は InvalidRequestException / MALFORMED_QUERY で、実行に至らない。
// 例外は内側の文を実際に実行する `EXPLAIN ANALYZE` だけで、これは `EXPLAIN` を剥がす反復で塞ぐ。

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
拒否理由。message は呼び出し元エージェントへそのまま返す。

`unterminated`（引用符・コメントが閉じていない）を `not-read-only` と分けるのは、reason だけを
見る呼び出し元が「変更系だから拒否」と誤読しないようにするため。倒す先はどちらも拒否で同じ。
*/
export type AthenaQueryRejectionReason = 'empty' | 'multi-statement' | 'not-read-only' | 'unterminated'

const REJECTION_MESSAGES: Record<AthenaQueryRejectionReason, string> = {
  'empty': 'query_string が空です。参照クエリを指定してください',
  'multi-statement': '複数の文は実行できません。; の後ろに文を続けず 1 文だけ指定してください',
  'not-read-only': '参照クエリ（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN）だけを実行できます',
  'unterminated': '引用符またはコメントが閉じていないため、参照クエリだと判定できません',
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
引用の終端（閉じ引用符の次）。start は開き引用符の次を指す。

`'…'` 文字列リテラルと `"…"` 引用識別子のエスケープは、同じ引用符の 2 重化だけ。
Trino では `\` は文字列リテラル中でも普通の文字なので、`'\'` は「閉じていない」ではなく
「バックスラッシュ 1 文字のリテラル」になる。
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
コメントを空白へ、引用の中身を空の引用へ均す。

中身を捨てるのは、後段が見るのは「リテラル外の `;`」と「先頭キーワード」だけだから。
リテラルの内容は判定材料にならない。均しておけばリテラル内の `;` や `--` が
後段の単純な文字列走査に引っ掛からない。
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
先頭が `(` ならその対応括弧までを剥がす（`EXPLAIN (TYPE DISTRIBUTED) SELECT …`）。

対応する `)` が無い場合は剥がさずに返す。剥がせないと、後段の語判定は左括弧を見て
語を取れず、拒否側へ倒れる。
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
1 文が参照専用か。

`EXPLAIN` は修飾語とオプション群を剥がして内側を見直す。1 周ごとに必ず `EXPLAIN` の 1 語を
消費するので停止する。再帰ではなくループにするのは、`EXPLAIN` を数万段重ねた入力で
コールスタックを溢れさせないため（溢れると失敗種別の外の例外になる）。
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
クエリを参照専用 / 拒否に分類する。

判定順は 未終端 → 複文 → 空 → 先頭キーワード。複文を空より先に見るのは、
`; SELECT 1` のように 1 文目が空の入力を「空」ではなく「複文」と伝えるため。
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
