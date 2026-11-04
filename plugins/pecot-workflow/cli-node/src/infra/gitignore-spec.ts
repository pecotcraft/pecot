// gitignore 形式のパターンでパスを判定する。Python の pathspec の GitIgnoreSpec（1.1.1）を写したもの。
//
// 写したものは次の 2 つ。
//   - GitIgnoreSpecPattern.pattern_to_regex（パターンから正規表現への変換）。
//   - 簡易 backend の match_file（dir の印の優先規則）。
// `ignore` パッケージは使わない。
// 否定パターンを組んだ `.nx/` などで、pathspec と判定が分かれるため。
//
// 正規表現の差は次のように吸収する。
//   - 名前付きグループは、Python の書式から JS の書式に直す。
//   - Python の `.` は \n 以外すべてに当たるので、`[^\n]` と書く。
//   - 文字クラスの先頭の `]` は `\]` にする。そのままだと JS では空の文字クラスになる。
//   - 正規表現は `u` フラグで作る。
//
// 範囲が逆（`[z-a]` など）のパターンは、Python では re.error、ここでは SyntaxError を投げる。

import { InvalidValueError } from '../domain/errors.js'
import { pythonRightStrip, pythonStringRepr, splitCodePoints } from '../domain/python-format.js'

const DIRECTORY_MARK = 'ps_d'
const DIRECTORY_MARK_GROUP = `(?<${DIRECTORY_MARK}>/)`
const DIRECTORY_MARK_OPTIONAL = `(?:${DIRECTORY_MARK_GROUP}|$)`
const ANY_CHARACTER = '[^\\n]'

/**
パターンが不正（Python の GitIgnorePatternError に当たる）
*/
export class GitIgnorePatternError extends InvalidValueError {}

// 範囲の記法が不正なパターンは、git が捨てるので、パターンごと無効にする
class RangeNotationError extends GitIgnorePatternError {}

// glob のワイルドカードに当たる式（アスタリスクは `/` 以外の 0 文字以上、疑問符は `/` 以外の 1 文字）
const GLOB_WILDCARDS: ReadonlyMap<string, string> = new Map([['*', '[^/]*'], ['?', '[^/]']])

const REGEX_SYNTAX_CHARACTERS = new Set('\\^$.*+?()[]{}|')

function escapeCharacter(character: string): string {
  return REGEX_SYNTAX_CHARACTERS.has(character) ? `\\${character}` : character
}

// 括弧式の中身は正規表現にそのまま入れる。先頭の `]` は文字なので、JS で空の文字クラスにならないよう escape する
function bracketBody(body: string): string {
  return body.startsWith(']') ? `\\${body}` : body
}

interface BracketExpression {
  readonly expression: string
  /**
  括弧式の次の位置
  */
  readonly next: number
}

// `[` の次の位置から括弧式を読む。感嘆符かキャレットで始まれば否定。
// 閉じる `]` が無ければ RangeNotationError
function translateBracketExpression(characters: readonly string[], start: number, pattern: string): BracketExpression {
  const end = characters.length
  let close = start
  if (close < end && ['!', '^'].includes(characters.at(close) ?? '')) close += 1
  if (close < end && characters.at(close) === ']') close += 1
  while (close < end && characters.at(close) !== ']') close += 1
  if (close >= end) {
    throw new RangeNotationError(`Invalid range notation=${pythonStringRepr(characters.slice(start, close).join(''))} found in pattern=${pythonStringRepr(pattern)}.`)
  }
  // キャレットによる否定は POSIX では未定義だが、git に合わせて感嘆符と同じく否定にする
  const isNegated = ['!', '^'].includes(characters.at(start) ?? '')
  const bodyStart = isNegated ? start + 1 : start
  const body = characters.slice(bodyStart, close + 1).join('').replaceAll('\\', '\\\\')
  return { expression: `[${isNegated ? '^' : ''}${bracketBody(body)}`, next: close + 1 }
}

// fnmatch.translate を元にした、1 セグメントの glob → 正規表現（FNM_PATHNAME 相当）
function translateSegmentGlob(pattern: string): string {
  const characters = splitCodePoints(pattern)
  let regex = ''
  let index = 0
  while (index < characters.length) {
    const character = characters.at(index) ?? ''
    if (character === '\\') {
      const escaped = characters.at(index + 1)
      if (escaped === undefined) throw new InvalidValueError(`Escape character found with no next character to escape: ${pythonStringRepr(pattern)}`)
      regex += escapeCharacter(escaped)
      index += 2
    }
    else if (character === '[') {
      const bracket = translateBracketExpression(characters, index + 1, pattern)
      regex += bracket.expression
      index = bracket.next
    }
    else {
      regex += GLOB_WILDCARDS.get(character) ?? escapeCharacter(character)
      index += 1
    }
  }
  return regex
}

type NormalizedSegments = { readonly kind: 'segments', readonly segments: readonly string[] } | { readonly kind: 'override', readonly source: string }

// `**` や `*` など、特別扱いして式を直接返すパターンがある
function normalizeSegments(isDirectoryPattern: boolean, original: readonly string[]): NormalizedSegments {
  const segments = [...original]
  if (segments.at(0) === '') {
    // 先頭が `/` のパターンは root 基準。空の先頭を除く
    segments.shift()
  }
  else if ((segments.length === 1 || (segments.length === 2 && segments.at(1) === '')) && segments.at(0) !== '**') {
    // セグメントが 1 つのパターンは、`**/` を前に足したものと同じ
    segments.unshift('**')
  }
  if (segments.length === 0) throw new InvalidValueError('Pattern normalized to nothing.')
  // 末尾が `/` のパターンは、配下のすべてに当たる（`{pattern}/**`）
  if (segments.at(-1) === '') segments[segments.length - 1] = '**'
  // `**/**` を 1 つにする
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (segments.at(index - 1) === '**' && segments.at(index) === '**') segments.splice(index, 1)
  }
  const [first, second, third] = segments
  if (first === '**' && segments.length === 1) return { kind: 'override', source: isDirectoryPattern ? DIRECTORY_MARK_GROUP : '.' }
  if (first === '**' && second === '*' && segments.length === 2) return { kind: 'override', source: '.' }
  if (first === '**' && second === '*' && third === '**' && segments.length === 3) return { kind: 'override', source: isDirectoryPattern ? DIRECTORY_MARK_GROUP : '/' }
  return { kind: 'segments', segments }
}

function translateSegments(isDirectoryPattern: boolean, segments: readonly string[]): string {
  const parts: string[] = []
  let isNeedsSlash = false
  const last = segments.length - 1
  for (const [index, segment] of segments.entries()) {
    if (segment === '**') {
      if (index === 0) {
        parts.push(`^(?:${ANY_CHARACTER}+/)?`)
      }
      else if (index < last) {
        parts.push(`(?:/${ANY_CHARACTER}+)?`)
        isNeedsSlash = true
      }
      else {
        parts.push(isDirectoryPattern ? DIRECTORY_MARK_GROUP : '/')
      }
    }
    else {
      if (index === 0) parts.push('^')
      if (isNeedsSlash) parts.push('/')
      parts.push(segment === '*' ? '[^/]+' : translateSegmentGlob(segment))
      if (index === last) parts.push(DIRECTORY_MARK_OPTIONAL)
      isNeedsSlash = true
    }
  }
  return parts.join('')
}

export interface PatternRegex {
  /**
  JS の正規表現の source（`u` フラグで使う）
  */
  readonly source: string
  /**
  マッチしたパスを除外するなら true、否定パターンなら false
  */
  readonly include: boolean
}

/**
パターン 1 行を正規表現にする。何にも当たらないパターン（空行・コメント・`/` 単体・範囲の記法が不正）は undefined。
感嘆符だけのパターンと、末尾が `\` のパターンは GitIgnorePatternError
*/
export function patternToRegex(line: string): PatternRegex | undefined {
  // 末尾の `\ ` は、空白を escape したもの。それ以外は末尾の空白を落とす（先頭の空白は残す）
  const pattern = line.endsWith('\\ ') ? line : pythonRightStrip(line)
  if (pattern === '' || pattern === '/' || pattern.startsWith('#')) return undefined

  const isInclude = !pattern.startsWith('!')
  const body = isInclude ? pattern : pattern.slice(1)
  const originalSegments = body.split('/')
  const isDirectoryPattern = originalSegments.at(-1) === ''
  const invalid = (cause: unknown): GitIgnorePatternError => new GitIgnorePatternError(`Invalid git pattern: ${pythonStringRepr(line)}`, { cause })

  let normalized: NormalizedSegments
  try {
    normalized = normalizeSegments(isDirectoryPattern, originalSegments)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) throw invalid(error)
    throw error
  }
  if (normalized.kind === 'override') return { source: normalized.source, include: isInclude }

  try {
    return { source: translateSegments(isDirectoryPattern, normalized.segments), include: isInclude }
  }
  catch (error: unknown) {
    // 範囲の記法が不正なパターンは、git が捨てるので無効にする
    if (error instanceof RangeNotationError) return undefined
    if (error instanceof InvalidValueError) throw invalid(error)
    throw error
  }
}

// match は、当たらなければ 'none'。当たったら、dir の印で当たったか（'directory'）、ファイルとして当たったか（'file'）
interface CompiledPattern {
  readonly include: boolean
  readonly match: (file: string) => 'directory' | 'file' | 'none'
}

export interface GitIgnoreSpec {
  /**
  何かに当たりうるパターンの数。0 なら、どのパスにも当たらない
  */
  readonly matchablePatternCount: number
  /**
  パスが除外対象か。先頭の `/`・`./` は落として判定する
  */
  readonly matchFile: (file: string) => boolean
}

function normalizeFile(file: string): string {
  if (file.startsWith('/')) return file.slice(1)
  return file.startsWith('./') ? file.slice(2) : file
}

function buildPattern(compiled: Readonly<PatternRegex>): CompiledPattern {
  // eslint-disable-next-line security/detect-non-literal-regexp -- gitignore のパターンを正規表現にするのがこのモジュールの目的。source は patternToRegex が組む
  const regex = new RegExp(compiled.source, 'u')
  return {
    include: compiled.include,
    match: (file) => {
      const found = regex.exec(file)
      if (found === null) return 'none'
      return found.groups?.['ps_d'] ? 'directory' : 'file'
    },
  }
}

// 後ろのパターンから見る。dir の印で当たったもの（優先度 1）より、ファイルとして当たったもの（優先度 2）が勝つ。
// 優先度 2 の最初の一致で止める
function isExcluded(reversedPatterns: readonly CompiledPattern[], file: string): boolean {
  let isIncluded = false
  let bestPriority = 0
  for (const pattern of reversedPatterns) {
    const kind = pattern.match(file)
    if (kind === 'none') continue
    const priority = kind === 'directory' ? 1 : 2
    if (priority > bestPriority) {
      isIncluded = pattern.include
      bestPriority = priority
    }
    if (priority === 2) return isIncluded
  }
  return isIncluded
}

function compilePattern(line: string): CompiledPattern | undefined {
  const compiled = patternToRegex(line)
  return compiled === undefined ? undefined : buildPattern(compiled)
}

/**
パターンの行からコンパイルする。空の行は読み飛ばす（空白だけの行は、何にも当たらないパターンとして数える）
*/
export function compileGitIgnoreSpec(lines: readonly string[]): GitIgnoreSpec {
  const matchable = lines.filter(line => line !== '').map(line => compilePattern(line)).filter(pattern => pattern !== undefined)
  const reversed = matchable.toReversed()
  return {
    matchablePatternCount: matchable.length,
    matchFile: file => isExcluded(reversed, normalizeFile(file)),
  }
}
