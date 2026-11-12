// Issue の本文の `## Waits for merge` の節の読み書き（contracts/prerequisite-table.md の 3）。純関数だけを置く。

import { InvalidValueError } from './errors.js'
import { createIssueReference, issueReferenceKey, issueReferenceToString } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { ValidationFailure } from './python-format.js'
import { createRepositoryReference, isSameRepository } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

export const WAITS_FOR_MERGE_HEADING = '## Waits for merge'

export interface WaitsForMergeLine {
  readonly ref: IssueReference
  readonly reason: string
}

/**
absent は節が無いこと。malformed は節が読めないこと（呼ぶ側は前提をすべて merge として扱う）
*/
export type WaitsForMergeReadout
  = | { readonly kind: 'absent' }
    | { readonly kind: 'ok', readonly lines: readonly WaitsForMergeLine[] }
    | { readonly kind: 'malformed', readonly reason: string }

interface BodyLine {
  readonly text: string
  readonly eol: string
}

interface Section {
  /**
  見出しの行の位置
  */
  readonly start: number
  /**
  節の終わり（次の `## ` の行か本文の終わり）の位置。含まない
  */
  readonly end: number
}

const LINE_PATTERN = /([^\n]*)(\n|$)/gu
const SAME_REPOSITORY_REFERENCE = /^#(\d+)$/u
const QUALIFIED_REFERENCE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/u

function splitLines(body: string): BodyLine[] {
  const lines: BodyLine[] = []
  for (const match of body.matchAll(LINE_PATTERN)) {
    const [whole, content = '', newline = ''] = match
    if (whole === '') break
    const hasCarriageReturn = newline !== '' && content.endsWith('\r')
    lines.push({
      text: hasCarriageReturn ? content.slice(0, -1) : content,
      eol: hasCarriageReturn ? '\r\n' : newline,
    })
  }
  return lines
}

function joinLines(lines: readonly BodyLine[]): string {
  return lines.map(line => line.text + line.eol).join('')
}

function lineEnding(body: string): string {
  return body.includes('\r\n') ? '\r\n' : '\n'
}

function locateSections(lines: readonly BodyLine[]): readonly Section[] {
  const sections: Section[] = []
  for (const [index, line] of lines.entries()) {
    if (line.text !== WAITS_FOR_MERGE_HEADING) continue
    const next = lines.findIndex((candidate, position) => position > index && candidate.text.startsWith('## '))
    sections.push({ start: index, end: next === -1 ? lines.length : next })
  }
  return sections
}

function formatReference(repository: RepositoryReference, reference: IssueReference): string {
  return isSameRepository(repository, reference.repository) ? `#${String(reference.number)}` : issueReferenceToString(reference)
}

function createReference(repository: () => RepositoryReference, digits: string): IssueReference | undefined {
  const number = Number(digits)
  if (!Number.isSafeInteger(number)) return undefined
  try {
    return createIssueReference(repository(), number)
  }
  catch (error: unknown) {
    if (error instanceof ValidationFailure) return undefined
    throw error
  }
}

function parseReference(raw: string, repository: RepositoryReference): IssueReference | undefined {
  const sameRepositoryNumber = SAME_REPOSITORY_REFERENCE.exec(raw)?.[1]
  if (sameRepositoryNumber !== undefined) return createReference(() => repository, sameRepositoryNumber)
  const [, owner, name, qualifiedNumber] = QUALIFIED_REFERENCE.exec(raw) ?? []
  return owner === undefined || name === undefined || qualifiedNumber === undefined
    ? undefined
    : createReference(() => createRepositoryReference(owner, name), qualifiedNumber)
}

type ParsedLine = { readonly kind: 'blank' } | { readonly kind: 'entry', readonly entry: WaitsForMergeLine } | { readonly kind: 'invalid', readonly reason: string }

function parseLine(text: string, repository: RepositoryReference): ParsedLine {
  if (text.trim() === '') return { kind: 'blank' }
  if (!text.startsWith('- ')) return { kind: 'invalid', reason: `not a list item: ${text}` }
  const rest = text.slice(2)
  const separator = rest.indexOf(': ')
  if (separator === -1) return { kind: 'invalid', reason: `no ': ' separator: ${text}` }
  const reference = parseReference(rest.slice(0, separator), repository)
  if (reference === undefined) return { kind: 'invalid', reason: `invalid issue reference: ${text}` }
  const reason = rest.slice(separator + 2).trim()
  return reason === '' ? { kind: 'invalid', reason: `empty reason: ${text}` } : { kind: 'entry', entry: { ref: reference, reason } }
}

function readSection(lines: readonly BodyLine[], section: Section, repository: RepositoryReference): WaitsForMergeReadout {
  const entries: WaitsForMergeLine[] = []
  const seen = new Set<string>()
  const sectionLines = lines.slice(section.start + 1, section.end)
  for (const line of sectionLines) {
    const parsed = parseLine(line.text, repository)
    if (parsed.kind === 'blank') continue
    if (parsed.kind === 'invalid') return { kind: 'malformed', reason: parsed.reason }
    const key = issueReferenceKey(parsed.entry.ref)
    if (seen.has(key)) return { kind: 'malformed', reason: `duplicate reference: ${key}` }
    seen.add(key)
    entries.push(parsed.entry)
  }
  return { kind: 'ok', lines: entries }
}

function readBody(lines: readonly BodyLine[], repository: RepositoryReference): { readonly readout: WaitsForMergeReadout, readonly section: Section | undefined } {
  const sections = locateSections(lines)
  const [section] = sections
  if (section === undefined) return { readout: { kind: 'absent' }, section: undefined }
  if (sections.length > 1) return { readout: { kind: 'malformed', reason: `${WAITS_FOR_MERGE_HEADING} appears ${String(sections.length)} times` }, section }
  return { readout: readSection(lines, section, repository), section }
}

/**
本文から `## Waits for merge` の節を読む。repository は `#N` の参照が指すリポ（本文のある Issue のリポ）
*/
export function readWaitsForMerge(body: string, repository: RepositoryReference): WaitsForMergeReadout {
  return readBody(splitLines(body), repository).readout
}

interface Writable {
  readonly lines: readonly BodyLine[]
  readonly section: Section | undefined
  readonly entries: readonly WaitsForMergeLine[]
}

function requireWritable(body: string, repository: RepositoryReference): Writable {
  const lines = splitLines(body)
  const { readout, section } = readBody(lines, repository)
  if (readout.kind === 'malformed') throw new InvalidValueError(`${WAITS_FOR_MERGE_HEADING} section is malformed: ${readout.reason}`)
  return { lines, section, entries: readout.kind === 'ok' ? readout.lines : [] }
}

function sectionIndexes(section: Section): readonly number[] {
  return Array.from({ length: section.end - section.start - 1 }, (_, offset) => section.start + 1 + offset)
}

function entryIndex(lines: readonly BodyLine[], section: Section, repository: RepositoryReference, reference: IssueReference): number | undefined {
  const key = issueReferenceKey(reference)
  return sectionIndexes(section).find((index) => {
    const parsed = parseLine(lines.at(index)?.text ?? '', repository)
    return parsed.kind === 'entry' && issueReferenceKey(parsed.entry.ref) === key
  })
}

// 足す位置の行（無ければその手前の行）の改行に合わせる。末尾に改行の無い本文は、足した行も改行なしで終える
function insertAfter(lines: readonly BodyLine[], index: number, text: string, fallbackEol: string): readonly BodyLine[] {
  const previous = lines.at(index)
  const isAtEnd = previous?.eol === ''
  const eol = lines.slice(0, index + 1).findLast(line => line.eol !== '')?.eol ?? fallbackEol
  const kept = lines.with(index, { text: previous?.text ?? '', eol })
  return kept.toSpliced(index + 1, 0, { text, eol: isAtEnd ? '' : eol })
}

// 末尾の改行が無い本文へ足した節は、改行なしで終える。removeWaitsForMerge で外すと元の本文と同じになる
function appendSection(lines: readonly BodyLine[], text: string, eol: string): readonly BodyLine[] {
  const last = lines.at(-1)
  const isUnterminated = last?.eol === ''
  const terminated = isUnterminated ? lines.with(lines.length - 1, { text: last.text, eol }) : lines
  const separator = terminated.length === 0 || terminated.at(-1)?.text === '' ? [] : [{ text: '', eol }]
  return [...terminated, ...separator, { text: WAITS_FOR_MERGE_HEADING, eol }, { text: '', eol }, { text, eol: isUnterminated ? '' : eol }]
}

/**
前提の行を足す。同じ参照の行があれば理由を書き換える。節の外は変えない。節が読めないときは InvalidValueError
*/
export function upsertWaitsForMerge(body: string, repository: RepositoryReference, reference: IssueReference, reason: string): string {
  const trimmed = reason.trim()
  if (trimmed === '' || /[\r\n]/u.test(trimmed)) throw new InvalidValueError('reason must be a single non-empty line')
  const text = `- ${formatReference(repository, reference)}: ${trimmed}`
  const eol = lineEnding(body)
  const { lines, section } = requireWritable(body, repository)
  if (section === undefined) return joinLines(appendSection(lines, text, eol))

  const existing = entryIndex(lines, section, repository, reference)
  if (existing !== undefined) return joinLines(lines.with(existing, { text, eol: lines.at(existing)?.eol ?? eol }))

  const contentIndexes = sectionIndexes(section).filter(index => lines.at(index)?.text.trim() !== '')
  return joinLines(insertAfter(lines, contentIndexes.at(-1) ?? section.start, text, eol))
}

// 最後の行を消すときは、前の行の改行も落として末尾の形を保つ
function removeEntryLine(lines: readonly BodyLine[], index: number): readonly BodyLine[] {
  const isLast = lines.at(index)?.eol === ''
  const previous = lines.at(index - 1)
  const kept = isLast && previous !== undefined ? lines.with(index - 1, { text: previous.text, eol: '' }) : lines
  return kept.toSpliced(index, 1)
}

/**
前提の行を外す。参照が無ければ本文をそのまま返す。行が無くなれば節ごと消す。節が読めないときは InvalidValueError
*/
export function removeWaitsForMerge(body: string, repository: RepositoryReference, reference: IssueReference): string {
  const { lines, section, entries } = requireWritable(body, repository)
  if (section === undefined) return body
  const index = entryIndex(lines, section, repository, reference)
  if (index === undefined) return body
  if (entries.length > 1) return joinLines(removeEntryLine(lines, index))

  // 節が本文の末尾なら、手前の空行（節との区切り）も一緒に消し、節が改行なしで終わっていれば手前の行も改行なしにする
  const lastContent = lines.slice(0, section.start).findLastIndex(line => line.text.trim() !== '')
  if (section.end !== lines.length) return joinLines(lines.toSpliced(section.start, section.end - section.start))
  const before = lines.slice(0, lastContent + 1)
  const previous = before.at(-1)
  const isUnterminated = lines.at(-1)?.eol === ''
  return joinLines(previous !== undefined && isUnterminated ? [...before.slice(0, -1), { text: previous.text, eol: '' }] : before)
}
