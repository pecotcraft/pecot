// Issue / PR 参照のパーサー。
//
// `owner/repo/N` 形式を IssueReference にする。短縮形 `N` は基準リポ（baseRepository）で補う。
// 参照の形式が不正なときの文は、Python の CLI が出していた文に揃える。

import { PecotError, InvalidValueError } from './errors.js'
import { parsePythonInteger, ValidationFailure } from './python-format.js'
import { createRepositoryReference, parseOwnerRepository, repositoryFullName } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

/**
参照のパースエラー。CLI 層で引数の誤りに変換する。元の入力を持つ
*/
export class ReferenceParseError extends PecotError {
  readonly reference: string

  constructor(message: string, reference: string, options?: Readonly<ErrorOptions>) {
    super(message, options)
    this.reference = reference
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
形式が不正・短縮形で基準リポが無いときは ReferenceParseError
*/
export function parseIssueReference(raw: string, baseRepository?: RepositoryReference): IssueReference {
  if (/^\d+$/u.test(raw)) {
    if (baseRepository === undefined) {
      throw new ReferenceParseError(
        'the short form \'N\' needs a base_repo: pass --repo <owner/repo> or use the full form \'owner/repo/N\'',
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
export function parsePullRequestReference(raw: string, baseRepository?: RepositoryReference): IssueReference {
  return parseIssueReference(raw, baseRepository)
}

/**
`owner/repo` 形式の文字列を RepositoryReference にする。不正なら ReferenceParseError
*/
export function parseRepositoryReference(raw: string): RepositoryReference {
  try {
    return parseOwnerRepository(raw)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) throw new ReferenceParseError(error.message, raw, { cause: error })
    throw error
  }
}

const REFS_PATTERN = /(?:^|\s)Refs?:?\s+(?:#(?<number>\p{Nd}+)|(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)[#/](?<qualifiedNumber>\p{Nd}+))/gimu

/**
PR 本文の Refs で参照された Issue 番号を集める。
受理形式は `Refs #N`・`Refs owner/repo#N`・`Refs owner/repo/N`（`Ref` も可、コロンは任意、大文字小文字は区別しない）。
owner/repo 付きの参照は、repository と一致（大文字小文字を区別しない）するものだけ採る
*/
export function extractReferencesIssueNumbers(body: string | undefined, repository: RepositoryReference): ReadonlySet<number> {
  const numbers = new Set<number>()
  if (body === undefined || body === '') return numbers
  const ownerKey = repository.owner.toLowerCase()
  const repositoryKey = repository.repository.toLowerCase()
  for (const match of body.matchAll(REFS_PATTERN)) {
    const { number, owner, repository: matchedRepository, qualifiedNumber } = match.groups ?? {}
    if (number !== undefined) {
      numbers.add(integerOf(number))
    }
    else if (qualifiedNumber !== undefined && owner?.toLowerCase() === ownerKey && matchedRepository?.toLowerCase() === repositoryKey) {
      numbers.add(integerOf(qualifiedNumber))
    }
  }
  return numbers
}
