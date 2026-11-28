// CHANGELOG.md の検証ロジック。Keep a Changelog 形式とセマンティックバージョニングに準拠する。
// ファイルは読まない。内容（文字列）を受けて値を返す。ファイルを読む側は infra/changelog-file.ts にある。
// Python の re と同じ判定にする（\d は Unicode の 10 進数字、\s は str.isspace、$ は末尾の改行 1 つの前でも合う）。

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

import { PecotError } from './errors.js'
import { PYTHON_LINE_BREAK, pythonStrip, splitCodePoints } from './python-format.js'

export class ChangelogError extends PecotError {}

/**
セマンティックバージョニング形式（X.Y.Z）に準拠していない
*/
export class InvalidVersionError extends ChangelogError {}

/**
CHANGELOG.md にバージョン情報が存在しない
*/
export class VersionNotFoundError extends ChangelogError {}

export const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md'
export const CHANGELOG_FALLBACK_FILES: readonly string[] = ['CHANGELOG.md', 'AIST-CHANGELOG.md']

// X.Y.Z 形式。先頭に `v` は付けない
const SEMVER_PATTERN = /^\p{Nd}+\.\p{Nd}+\.\p{Nd}+\n?$/u

// バージョン行の見出し記号と空白より後ろを見る。行の形は `## [X.Y.Z] - YYYY-MM-DD`。
const VERSION_PATTERN = /^\[(\p{Nd}+\.\p{Nd}+\.\p{Nd}+)\]/u

function splitLines(content: string): readonly string[] {
  const lines = content.split(PYTHON_LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
`##` + 空白 1 つ以上で始まる行の、空白の後ろを返す。そうでなければ undefined。
空白は Python の `\s`（str.isspace）と同じ。pythonStrip で先頭の空白を落として確かめる
*/
function headingRest(line: string): string | undefined {
  if (!line.startsWith('##')) return undefined
  const body = line.slice(2)
  return body === '' || pythonStrip(splitCodePoints(body)[0] ?? '') !== '' ? undefined : pythonStrip(body)
}

/**
パス末尾のファイル名。エラー文に、実際に探したファイルの名前を出すために使う
*/
export function changelogFileName(changelogPath: string): string {
  return changelogPath.slice(changelogPath.lastIndexOf('/') + 1)
}

/**
CHANGELOG が無いときの文
*/
export function changelogNotFoundMessage(changelogPath: string): string {
  return `${changelogFileName(changelogPath)} not found: ${changelogPath}`
}

/**
セマンティックバージョニング形式を検証する。形式違反は InvalidVersionError
*/
export function validateSemver(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new InvalidVersionError(
      `invalid version format: ${version}\n`
      + 'use semantic versioning (X.Y.Z)',
    )
  }
}

/**
## [X.Y.Z] 形式の最初のバージョンを返す。Unreleased は飛ばす。無ければ VersionNotFoundError。
fileName は、エラー文に出す CHANGELOG のファイル名
*/
export function getLatestVersion(content: string, fileName = DEFAULT_CHANGELOG_FILE): string {
  for (const line of splitLines(content)) {
    const version = VERSION_PATTERN.exec(headingRest(line) ?? '')?.[1]
    if (version !== undefined) return version
  }
  throw new VersionNotFoundError(
    `no version found in ${fileName}\n`
    + 'for a first release, specify the version manually',
  )
}

/**
リンク定義（`[x]: url`）と脚注の定義（`[^x]: text`）。参照との対応は、組（link・footnote）と正規化したラベルの `key` で取る
*/
interface MarkdownDefinition {
  readonly key: string
  readonly kind: 'link' | 'footnote'
  // 行の配列の番号（0 始まり）。終わりの行も含む
  readonly startLine: number
  readonly endLine: number
  readonly source: string
  // root の直下にあるか。リストや引用の中の定義は、行を除くと印まで消えるので、除かない
  readonly topLevel: boolean
  // 脚注の定義の中にある参照の key
  readonly references: ReadonlySet<string>
}

interface MarkdownReference {
  readonly key: string
  readonly line: number
}

interface MarkdownLinks {
  // ファイルでの順
  readonly definitions: readonly MarkdownDefinition[]
  // 定義の外にある参照
  readonly references: readonly MarkdownReference[]
}

function lineIndexOf(point: { readonly line: number }): number {
  return point.line - 1
}

/**
GitHub が描く形（CommonMark と GFM）で読み、定義と参照を集める。定義の判定（字下げ・段落の途中・コードの中・ラベルの正規化）はパーサに任せる
*/
function collectMarkdownLinks(text: string): MarkdownLinks {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  type MarkdownNode = typeof tree | (typeof tree)['children'][number]
  const definitions: MarkdownDefinition[] = []
  const references: MarkdownReference[] = []

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- mdast の型は可変
  const visit = (node: MarkdownNode, depth: number, owner: Set<string> | undefined): void => {
    const position = node.position
    if (position === undefined) return
    if (node.type === 'linkReference' || node.type === 'imageReference' || node.type === 'footnoteReference') {
      const key = `${node.type === 'footnoteReference' ? 'footnote' : 'link'}:${node.identifier}`
      if (owner === undefined) references.push({ key, line: lineIndexOf(position.start) })
      else owner.add(key)
    }
    let inner = owner
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const kind = node.type === 'definition' ? 'link' : 'footnote'
      const ownReferences = new Set<string>()
      definitions.push({
        key: `${kind}:${node.identifier}`,
        kind,
        startLine: lineIndexOf(position.start),
        endLine: lineIndexOf(position.end),
        source: text.slice(position.start.offset, position.end.offset),
        topLevel: depth === 1,
        references: ownReferences,
      })
      inner = ownReferences
    }
    if ('children' in node) {
      for (const child of node.children) visit(child, depth + 1, inner)
    }
  }
  visit(tree, 0, undefined)
  return { definitions, references }
}

/**
## [X.Y.Z] の次の行から次の `## ` セクションまでの内容を返す。無ければ VersionNotFoundError。
節の本文が使わないリンク・脚注の定義（版の見出しのための `[X.Y.Z]: url` など）は除く。
節の外にある、本文の使う定義は、本文の末尾に空行を挟んでファイルでの順に足す。
同じラベルの定義が複数あれば、CommonMark と同じく、ファイルで最初の定義を使う。
fileName は、エラー文に出す CHANGELOG のファイル名
*/
export function extractVersionReleaseNotes(content: string, version: string, fileName = DEFAULT_CHANGELOG_FILE): string {
  const heading = `[${version}]`
  const lines = splitLines(content)
  const headingIndex = lines.findIndex(line => headingRest(line)?.startsWith(heading) === true)
  if (headingIndex === -1) throw new VersionNotFoundError(`version not found in ${fileName}: ${version}`)
  // 次の ## セクションの手前まで
  const nextIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith('## '))
  const endIndex = nextIndex === -1 ? lines.length : nextIndex
  const isInSection = (line: number): boolean => line > headingIndex && line < endIndex

  const { definitions, references } = collectMarkdownLinks(lines.join('\n'))
  const effective = new Map<string, MarkdownDefinition>()
  for (const definition of definitions) {
    if (!effective.has(definition.key)) effective.set(definition.key, definition)
  }

  // 本文が使う key。入れ子で残る定義の中の参照と、残す・足す定義の中の参照も、増えなくなるまで数える
  const used = new Set(references.filter(reference => isInSection(reference.line)).map(reference => reference.key))
  for (const definition of definitions) {
    if (!definition.topLevel && isInSection(definition.startLine)) {
      for (const key of definition.references) used.add(key)
    }
  }
  const pending = [...used]
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const innerKeys = effective.get(key)?.references ?? []
    for (const inner of innerKeys) {
      if (used.has(inner)) continue
      used.add(inner)
      pending.push(inner)
    }
  }
  const isKept = (definition: MarkdownDefinition): boolean => used.has(definition.key) && effective.get(definition.key) === definition

  const removedLines = new Set<number>()
  for (const definition of definitions) {
    if (!definition.topLevel || !isInSection(definition.startLine) || isKept(definition)) continue
    for (let line = definition.startLine; line <= definition.endLine; line += 1) removedLines.add(line)
  }
  const body = pythonStrip(lines.slice(headingIndex + 1, endIndex).filter((_line, offset) => !removedLines.has(headingIndex + 1 + offset)).join('\n'))

  const appended = definitions.filter(definition => isKept(definition) && !isInSection(definition.startLine))
  // 脚注の定義の後ろの行は、段落の続きとして読まれるので、脚注の前後は空行で分ける
  let notes = body
  let previous: MarkdownDefinition | undefined
  for (const definition of appended) {
    const separator = previous === undefined || definition.kind === 'footnote' || previous.kind === 'footnote' ? '\n\n' : '\n'
    notes += `${separator}${definition.source}`
    previous = definition
  }
  return notes
}
