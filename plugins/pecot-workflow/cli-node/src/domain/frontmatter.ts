// YAML フロントマター付き Markdown のパーサー。文字列を受けて、検証済みのフロントマターと本文を返す。
// ファイルを読む関数は infra/frontmatter-file.ts が持つ。
//
// 検証のエラー文は、Python の CLI が出していた書式（`  - 項目: 本文`）に合わせる。
// 型の変換（"2" → 2、"yes" → true、空文字列 → 未指定）も Python の CLI と同じ。
// 値が無いこと（null・未指定・空文字列）は、読んだ後はどれも undefined になる。

import { z } from 'zod'

import { convertToInteger, PRIORITIES, SIZES, WORKFLOW_STATUSES } from './config.js'
import { PecotError } from './errors.js'
import { normalizeNewlines, parsePythonInteger, pythonStrip, pythonStringRepr } from './python-format.js'
import { parseYamlDocument } from './yaml-document.js'

export class FrontmatterError extends PecotError {}

// 検証のエラー文

const REQUIRED_MESSAGE = 'Field required'
const STRING_MESSAGE = 'Input should be a valid string'
const LIST_MESSAGE = 'Input should be a valid list'

/**
zod が渡す issue のうち、文を作るのに使う項目
*/
interface RawIssueView {
  readonly input?: unknown
  readonly values?: readonly unknown[]
}

function quotedChoices(values: readonly unknown[]): string {
  const quoted = values.map(value => pythonStringRepr(String(value)))
  const last = quoted.at(-1)
  return last === undefined || quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${last}`
}

function choiceMessage(issue: RawIssueView): string {
  return issue.input === undefined ? REQUIRED_MESSAGE : `Input should be ${quotedChoices(issue.values ?? [])}`
}

function stringMessage(issue: RawIssueView): string {
  return issue.input === undefined ? REQUIRED_MESSAGE : STRING_MESSAGE
}

function listMessage(issue: RawIssueView): string {
  return issue.input === undefined ? REQUIRED_MESSAGE : LIST_MESSAGE
}

function integerMessage(input: unknown): string {
  if (typeof input === 'string') return 'Input should be a valid integer, unable to parse string as an integer'
  if (typeof input !== 'number') return 'Input should be a valid integer'
  if (!Number.isFinite(input)) return 'Input should be a finite number'
  return 'Input should be a valid integer, got a number with a fractional part'
}

// 2 の 63 乗。これ以上の数は、真偽値の変換で整数として扱われない
const INTEGER_LIMIT = 2 ** 63

function booleanMessage(input: unknown): string {
  const isParsable = typeof input === 'string' || (typeof input === 'number' && Number.isSafeInteger(input) && Math.abs(input) < INTEGER_LIMIT)
  return isParsable ? 'Input should be a valid boolean, unable to interpret input' : 'Input should be a valid boolean'
}

// 型の変換

function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value
}

const TRUE_STRINGS: ReadonlySet<string> = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const FALSE_STRINGS: ReadonlySet<string> = new Set(['0', 'off', 'f', 'false', 'n', 'no'])

// bool の lax な変換。文字列は大文字小文字を区別せず（前後の空白は落とさない）、数は 0 と 1 だけを受ける
function convertToBoolean(value: unknown): unknown {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase()
    if (TRUE_STRINGS.has(lowered)) return true
    if (FALSE_STRINGS.has(lowered)) return false
    return value
  }
  if (value === 1) return true
  if (value === 0) return false
  return value
}

// parent_epic の入力の正規化。未指定・空文字 → 未指定、数字だけの文字列 → 整数、それ以外の文字列 → 前後の空白を落とした文字列
function normalizeParentEpic(value: unknown): unknown {
  if (value === null || emptyStringToUndefined(value) === undefined) return undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return value
  const stripped = pythonStrip(value)
  return /^\p{Nd}+$/u.test(stripped) ? parsePythonInteger(stripped) : stripped
}

// スキーマ

const IntegerSchema = z.number({ error: issue => integerMessage(issue.input) }).refine(Number.isSafeInteger, { error: issue => integerMessage(issue.input) })

const IssueTypeSchema = z.enum(['task', 'bug', 'epic'], { error: choiceMessage })
const WorkflowStatusSchema = z.enum(WORKFLOW_STATUSES, { error: choiceMessage })

const IssueFrontmatterSchema = z.object({
  title: z.string({ error: stringMessage }),
  type: IssueTypeSchema,
  template: z.preprocess(emptyStringToUndefined, z.enum(['task', 'bug', 'epic', 'task-implement'], { error: choiceMessage }).nullish().transform(value => value ?? undefined)),
  repository: z.string({ error: stringMessage }),
  status: WorkflowStatusSchema,
  priority: z.preprocess(emptyStringToUndefined, z.enum(PRIORITIES, { error: choiceMessage }).nullish().transform(value => value ?? undefined)),
  size: z.preprocess(emptyStringToUndefined, z.enum(SIZES, { error: choiceMessage }).nullish().transform(value => value ?? undefined)),
  labels: z.array(z.string({ error: STRING_MESSAGE }), { error: listMessage }).readonly().prefault([]),
  parent_epic: z.preprocess(normalizeParentEpic, z.unknown().transform((value, context) => {
    // 「整数 | 文字列」のどちらでもない値は、枝ごとの誤り（`parent_epic.int`・`parent_epic.str`）を 2 行で返す
    if (value === undefined || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) return value
    context.issues.push(
      { code: 'custom', message: integerMessage(value), input: value, path: ['int'] },
      { code: 'custom', message: STRING_MESSAGE, input: value, path: ['str'] },
    )
    return z.NEVER
  })),
  order: z.preprocess(value => convertToInteger(emptyStringToUndefined(value)), IntegerSchema.nullish().transform(value => value ?? undefined)),
}).readonly()

const CommentFrontmatterSchema = z.object({
  issue_ref: z.string({ error: stringMessage }),
  template: z.enum(['plan', 'merge-diff', 'review-findings', 'review-resolution', 'precede-notify'], { error: choiceMessage }).nullish().transform(value => value ?? undefined),
}).readonly()

const PullRequestFrontmatterSchema = z.object({
  title: z.string({ error: stringMessage }),
  repository: z.string({ error: stringMessage }),
  base: z.string({ error: stringMessage }),
  head: z.string({ error: STRING_MESSAGE }).nullish().transform(value => value ?? undefined),
  draft: z.preprocess(convertToBoolean, z.boolean({ error: issue => booleanMessage(issue.input) })).prefault(false),
}).readonly()

// 種別などの列挙は IssueFrontmatter['type'] のように項目の型から取る
export type IssueFrontmatter = z.infer<typeof IssueFrontmatterSchema>
export type CommentFrontmatter = z.infer<typeof CommentFrontmatterSchema>
export type PullRequestFrontmatter = z.infer<typeof PullRequestFrontmatterSchema>

export interface ParsedIssue {
  readonly frontmatter: IssueFrontmatter
  readonly body: string
}

export interface ParsedComment {
  readonly frontmatter: CommentFrontmatter
  readonly body: string
}

export interface ParsedPullRequest {
  readonly frontmatter: PullRequestFrontmatter
  readonly body: string
}

// 検証

/**
zod の issue のうち、エラー文に使う項目
*/
interface ValidationIssueView {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

function issueLine(issue: ValidationIssueView): string {
  return `  - ${issue.path.map(String).join('.')}: ${issue.message}`
}

function validationError(lines: readonly string[]): FrontmatterError {
  return new FrontmatterError(`バリデーションエラー:\n${lines.join('\n')}`)
}

function fieldErrors(issues: readonly ValidationIssueView[]): FrontmatterError {
  return validationError(issues.map(issue => issueLine(issue)))
}

// parent_epic と order の相互検証。項目の誤りが無いときだけ行う
function checkOrderWithParentEpic(frontmatter: IssueFrontmatter): void {
  const { parent_epic: parentEpic, order } = frontmatter
  let message: string | undefined
  if (parentEpic !== undefined && order === undefined) message = 'parent_epicが指定されている場合、orderは必須です'
  else if (parentEpic === undefined && order !== undefined) message = 'orderを指定する場合、parent_epicも指定してください'
  else if (order !== undefined && order <= 0) message = `orderは1以上の整数である必要があります（現在: ${String(order)}）`
  if (message !== undefined) throw validationError([`  - : Value error, ${message}`])
}

/**
値から Issue のフロントマターを作る。不正なら FrontmatterError
*/
export function validateIssueFrontmatter(data: unknown): IssueFrontmatter {
  const result = IssueFrontmatterSchema.safeParse(data)
  if (!result.success) throw fieldErrors(result.error.issues)
  checkOrderWithParentEpic(result.data)
  return result.data
}

/**
値からコメントのフロントマターを作る。不正なら FrontmatterError
*/
export function validateCommentFrontmatter(data: unknown): CommentFrontmatter {
  const result = CommentFrontmatterSchema.safeParse(data)
  if (!result.success) throw fieldErrors(result.error.issues)
  return result.data
}

/**
値から PR のフロントマターを作る。不正なら FrontmatterError
*/
export function validatePullRequestFrontmatter(data: unknown): PullRequestFrontmatter {
  const result = PullRequestFrontmatterSchema.safeParse(data)
  if (!result.success) throw fieldErrors(result.error.issues)
  return result.data
}

// パーサー関数

// ^---\n で始まり、\n---\n で終わる
// 先頭の空白の連続と、本文の最短一致が、空白を取り合う。入力はフロントマター付きの Markdown 1 ファイルで、
// Python の同名の正規表現と同じ範囲を取るため、この形を保つ。
// eslint-disable-next-line regexp/no-super-linear-backtracking -- 空白の連続が長い入力でだけ遅くなる。取る範囲を Python と揃えるため書き換えない
const FRONTMATTER_PATTERN = /^---\s*\n(.*?)\n---\s*/su

// 本文先頭のガイドコメント（`--prepare` 雛形の「読者:／書き方:／フィールド:」ブロック）。
// 前後の空白・空行ごと 1 ブロックだけ食う。本文途中のコメントは対象外。
const LEADING_HTML_COMMENT_PATTERN = /^\s*<!--.*?-->\s*/su

/**
本文先頭の HTML コメントブロックを 1 つだけ除去する。
`--prepare` が配る雛形は、冒頭に書き方ガイドの HTML コメントを持つ。
利用者が消し忘れたまま投稿しても GitHub 本文に残らないよう、パース時に取り除く（#958 F-02）。
本文途中の `<details>` 等の HTML には触れない
*/
export function stripLeadingHtmlComment(body: string): string {
  return body.replace(LEADING_HTML_COMMENT_PATTERN, '')
}

/**
フロントマターを落とした本文を返す（不正・不在なら原文をそのまま返す）。
パース前の素朴な走査（プレースホルダ検証など）で本文だけを対象にするための寛容なヘルパで、検証はしない
*/
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER_PATTERN.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

function isMapping(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Object.getPrototypeOf(data) === Object.prototype
}

interface FrontmatterDocument {
  readonly data: unknown
  readonly body: string
}

// フロントマターの YAML を読み、本文と分ける。フロントマターの検証はしない
function splitFrontmatter(content: string): FrontmatterDocument {
  if (!content.startsWith('---')) throw new FrontmatterError('フロントマターが見つかりません（---で始まっていない）')

  const match = FRONTMATTER_PATTERN.exec(content)
  if (match === null) throw new FrontmatterError('フロントマターが閉じられていません（終端の---がない）')

  const rest = pythonStrip(content.slice(match[0].length))
  const body = pythonStrip(stripLeadingHtmlComment(rest))

  let data: unknown
  try {
    // 改行は \r\n・\r も \n と同じ行区切りとして読む（YAML ライブラリは末尾の \r を値に含める）
    data = parseYamlDocument(normalizeNewlines(match[1] ?? ''))
  }
  catch (error: unknown) {
    throw new FrontmatterError(`YAMLのパースに失敗しました: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!isMapping(data)) throw new FrontmatterError('フロントマターはマッピング（key: value）形式である必要があります')
  return { data, body }
}

/**
文字列から Issue のフロントマターをパースする。不正なら FrontmatterError
*/
export function parseFrontmatter(content: string): ParsedIssue {
  const { data, body } = splitFrontmatter(content)
  return { frontmatter: validateIssueFrontmatter(data), body }
}

/**
文字列からコメントのフロントマターをパースする。不正なら FrontmatterError
*/
export function parseCommentContent(content: string): ParsedComment {
  const { data, body } = splitFrontmatter(content)
  return { frontmatter: validateCommentFrontmatter(data), body }
}

/**
文字列から PR のフロントマターをパースする。不正なら FrontmatterError
*/
export function parsePullRequestContent(content: string): ParsedPullRequest {
  const { data, body } = splitFrontmatter(content)
  return { frontmatter: validatePullRequestFrontmatter(data), body }
}
