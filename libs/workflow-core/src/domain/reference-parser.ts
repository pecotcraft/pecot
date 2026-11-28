// Issue / PR 参照のパーサー。
//
// `owner/repo/N` 形式を IssueReference にする。短縮形 `N` は基準リポ（baseRepository）で補う。
// 参照の形式が不正なときの文は、Python の CLI が出していた文に揃える。

import { formatHinted, globalRepositoryHint, hinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { PecotError, InvalidValueError } from './errors.js'
import { parsePythonInteger, ValidationFailure } from './python-format.js'
import { createRepositoryReference, repositoryFullName } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

/**
参照のパースエラー。CLI 層で引数の誤りに変換する。元の入力を持つ
*/
export class ReferenceParseError extends PecotError {
  readonly reference: string
  readonly hintedText: HintedText | undefined

  // message は描いた文。hintedText は、案内を他の文へ埋め込む用途で持つ
  constructor(message: string | HintedText, reference: string, options?: Readonly<ErrorOptions>) {
    super(formatHinted(message), options)
    this.reference = reference
    this.hintedText = typeof message === 'string' ? undefined : message
  }
}

export interface IssueReference {
  readonly repository: RepositoryReference
  readonly number: number
}

/**
番号が正の整数であることを検証して作る。Issue と PR は番号空間を共有する
*/
export function createIssueReference(repository: RepositoryReference, number: number): IssueReference {
  if (number <= 0) {
    throw new ValidationFailure('IssueRef', [{ type: 'greater_than', location: ['number'], message: 'Input should be greater than 0', input: number }])
  }
  return Object.freeze({ repository, number })
}

export function issueReferenceToString(reference: IssueReference): string {
  return `${repositoryFullName(reference.repository)}#${String(reference.number)}`
}

/**
リポ名の大文字小文字を区別しない、Issue / PR の同一判定用のキー
*/
export function issueReferenceKey(reference: IssueReference): string {
  return issueReferenceToString(reference).toLowerCase()
}

export function issueReferenceToCliReference(reference: IssueReference): string {
  return `${repositoryFullName(reference.repository)}/${String(reference.number)}`
}

// Python の `$` は末尾の改行の手前にも一致する。`\d` は Unicode の 10 進数字に一致する
const FULL_REFERENCE_PATTERN = /^([^/]+)\/([^/]+)\/(\p{Nd}+)\n?$/u

function integerOf(digits: string): number {
  const value = parsePythonInteger(digits)
  if (value === undefined) throw new InvalidValueError(`invalid literal for int() with base 10: ${digits}`)
  return value
}

function invalidFormat(raw: string): ReferenceParseError {
  return new ReferenceParseError(
    `invalid reference: ${raw}\naccepted forms:\n  - full: 'owner/repo/N'\n  - short: 'N' (with a base repository)`,
    raw,
  )
}

/**
Issue 参照を IssueReference にする。
`owner/repo/N` は主軸形式。`N` は短縮形で、baseRepository が要る。
形式が不正・短縮形で基準リポが無いときは ReferenceParseError。
repositoryFlag は入力 repo で短縮形を解決するツールか。true のときだけ error で repo を案内する
*/
export function parseIssueReference(raw: string, baseRepository?: RepositoryReference, { repositoryFlag = false }: { readonly repositoryFlag?: boolean } = {}): IssueReference {
  if (/^\d+$/u.test(raw)) {
    if (baseRepository === undefined) {
      throw new ReferenceParseError(
        repositoryFlag
          ? hinted`the short form 'N' needs a base_repo: pass ${globalRepositoryHint(placeholder('owner/repo'))} or use the full form 'owner/repo/N'`
          : 'the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'',
        raw,
      )
    }
    return createIssueReference(baseRepository, integerOf(raw))
  }

  const [, owner, repository, digits] = FULL_REFERENCE_PATTERN.exec(raw) ?? []
  if (owner === undefined || repository === undefined || digits === undefined) throw invalidFormat(raw)
  try {
    return createIssueReference(createRepositoryReference(owner, repository), integerOf(digits))
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) throw new ReferenceParseError(error.message, raw, { cause: error })
    throw error
  }
}

/**
PR 参照を IssueReference にする。Issue と番号空間を共有するので parseIssueReference に委ねる
*/
export function parsePullRequestReference(raw: string, baseRepository?: RepositoryReference, options: { readonly repositoryFlag?: boolean } = {}): IssueReference {
  return parseIssueReference(raw, baseRepository, options)
}
