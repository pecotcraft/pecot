import type { Finding } from './finding.js'

export interface SourceFile {
  // リポジトリの root からの相対パス。区切りは /
  readonly path: string
  readonly text: string
}

export interface EnvironmentRead {
  readonly name: string
  readonly path: string
  readonly line: number
}

export interface UnresolvedRead {
  readonly path: string
  readonly line: number
}

export interface ScanResult {
  readonly reads: readonly EnvironmentRead[]
  readonly unresolved: readonly UnresolvedRead[]
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/u
// 名前が文字列で書かれた読み方。1 つ目の group が引用符、2 つ目が名前。
const GETENV_LITERAL = /^\s*\(\s*(["'])([A-Za-z_]\w*)\1/u
const INDEX_LITERAL = /^\s*(["'])([A-Za-z_]\w*)\1\s*$/u
const SCRIPT_INDEX_LITERAL = /^\s*(["'`])([A-Za-z_]\w*)\1\s*$/u
const METHOD_LITERAL = /^\s*\.\s*\w+\s*\(\s*(["'])([A-Za-z_]\w*)\1/u
const MEMBERSHIP_LITERAL = /(["'])([A-Za-z_]\w*)\1 (?:not )?in$/u
// 代入は読みに数えない。== と => は代入ではない。
const ASSIGNMENT = /^\s*[-+*/%|&^]?=(?![=>])/u
const MARKER = 'interface-env:'

function lineOf(text: string, index: number): number {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line++
  return line
}

// コメントだけの行を空白にする。文字の位置と行数は変えない。
function maskComments(text: string, marks: readonly string[]): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trimStart()
    return marks.some(mark => trimmed.startsWith(mark)) ? ' '.repeat(line.length) : line
  }).join('\n')
}

// interface-env コメントが付いた名前。none か、コメントが無ければ undefined。
function declaredNames(lines: readonly string[], line: number): string[] | undefined {
  const comment = lines[line - 2] ?? ''
  const at = comment.indexOf(MARKER)
  return at === -1 ? undefined : comment.slice(at + MARKER.length).replace('*/', '').split(/[\s,]+/u).filter(name => name !== '' && name !== 'none')
}

interface Collector {
  readonly addName: (name: string, line: number) => void
  readonly addUnresolved: (line: number) => void
  readonly result: () => ScanResult
}

function createCollector(path: string, text: string): Collector {
  const reads: EnvironmentRead[] = []
  const unresolved: UnresolvedRead[] = []
  const lines = text.split('\n')
  const addName = (name: string, line: number): void => {
    reads.push({ name, path, line })
  }
  return {
    addName,
    addUnresolved: (line) => {
      const names = declaredNames(lines, line)
      if (names === undefined) unresolved.push({ path, line })
      else {
        for (const name of names) addName(name, line)
      }
    },
    result: () => ({ reads, unresolved }),
  }
}

function scanPython(path: string, text: string): ScanResult {
  const masked = maskComments(text, ['#'])
  const { addName, addUnresolved, result } = createCollector(path, text)
  for (const match of masked.matchAll(/\bos\.(environ|getenv)\b/gu)) {
    const line = lineOf(masked, match.index)
    const after = masked.slice(match.index + match[0].length)
    const before = masked.slice(Math.max(0, match.index - 80), match.index)
    const literal = (found: RegExpExecArray | null): void => {
      if (found?.[2] === undefined) addUnresolved(line)
      else addName(found[2], line)
    }
    if (match[1] === 'getenv') {
      literal(GETENV_LITERAL.exec(after))
      continue
    }
    const index = /^\s*\[([^\]\n]*)\]/u.exec(after)
    if (index?.[1] !== undefined) {
      if (!ASSIGNMENT.test(after.slice(index[0].length)) && !/\bdel\s+$/u.test(before)) literal(INDEX_LITERAL.exec(index[1]))
      continue
    }
    const method = /^\s*\.\s*(\w+)/u.exec(after)?.[1]
    if (method === 'update' || method === 'clear') continue
    const squeezed = before.replaceAll(/\s+/gu, ' ').trimEnd()
    literal(['get', 'setdefault', 'pop'].includes(method ?? '') ? METHOD_LITERAL.exec(after) : MEMBERSHIP_LITERAL.exec(squeezed))
  }
  for (const match of masked.matchAll(/^[ \t]*from[ \t]+os[ \t]+import\b[ \t]*(\([^)]*\)|[^\n]*)/gmu)) {
    if (/\b(?:environ|getenv)\b/u.test(match[1] ?? '')) addUnresolved(lineOf(masked, match.index))
  }
  return result()
}

function scanScript(path: string, text: string): ScanResult {
  const masked = maskComments(text, ['//', '*', '/*'])
  const { addName, addUnresolved, result } = createCollector(path, text)
  for (const match of masked.matchAll(/\bprocess\.env\b/gu)) {
    const line = lineOf(masked, match.index)
    const after = masked.slice(match.index + match[0].length)
    const before = masked.slice(Math.max(0, match.index - 200), match.index)
    const property = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/u.exec(after)
    if (property?.[1] !== undefined) {
      if (!ASSIGNMENT.test(after.slice(property[0].length)) && !/\bdelete\s+$/u.test(before)) addName(property[1], line)
      continue
    }
    const index = /^\s*(?:\?\.)?\[([^\]\n]*)\]/u.exec(after)
    if (index?.[1] !== undefined) {
      if (ASSIGNMENT.test(after.slice(index[0].length))) continue
      const literal = SCRIPT_INDEX_LITERAL.exec(index[1])
      if (literal?.[2] === undefined) addUnresolved(line)
      else addName(literal[2], line)
      continue
    }
    const destructuring = /\{([^{}]*)\}\s*=\s*$/u.exec(before)
    if (destructuring?.[1] === undefined) addUnresolved(line)
    const parts = (destructuring?.[1] ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
    for (const part of parts) {
      const key = /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])/u.exec(part)
      if (key === null || part.startsWith('...')) addUnresolved(line)
      else addName(key[1] ?? key[2] ?? '', line)
    }
  }
  for (const match of masked.matchAll(/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/gu)) {
    addUnresolved(lineOf(masked, match.index))
  }
  return result()
}

// ソース 1 つから、環境変数を読む箇所を集める。Python と TypeScript・JavaScript 以外は読まない。
export function scanEnvironmentReads(file: SourceFile): ScanResult {
  if (file.path.endsWith('.py')) return scanPython(file.path, file.text)
  if (SCRIPT.test(file.path)) return scanScript(file.path, file.text)
  return { reads: [], unresolved: [] }
}

// 定義書の name に書いた * は、前後に固定の文字がある 1 つの [A-Z0-9_]+ に当たる。
export function isListedName(listed: string, read: string): boolean {
  if (listed === read) return true
  const star = listed.indexOf('*')
  if (star === -1) return false
  const prefix = listed.slice(0, star)
  const suffix = listed.slice(star + 1)
  const middle = read.slice(prefix.length, read.length - suffix.length)
  return read.startsWith(prefix) && read.endsWith(suffix) && /^[A-Z0-9_]+$/u.test(middle)
}

export function isValidEnvironmentName(name: string): boolean {
  return /^[A-Za-z_]\w*$/u.test(name) || /^[A-Z0-9_]+\*[A-Z0-9_]+$/u.test(name)
}

export interface EnvironmentCheck {
  // プラグインのディレクトリ（plugins/<name>）。読んだソースの表示はここからの相対にする。
  readonly pluginDir: string
  readonly authoredPath: string
  readonly sources: readonly SourceFile[]
  // 定義書の environment に書いた名前（ファイルの先頭と各項目の合計）。
  readonly listed: readonly string[]
}

export function checkEnvironment(check: EnvironmentCheck): Finding[] {
  const findings: Finding[] = []
  const firstReader = new Map<string, string>()
  const sources = check.sources.toSorted((left, right) => left.path.localeCompare(right.path, 'en'))
  for (const source of sources) {
    const { reads, unresolved } = scanEnvironmentReads(source)
    for (const read of reads) {
      if (!firstReader.has(read.name)) firstReader.set(read.name, source.path.slice(check.pluginDir.length + 1))
    }
    for (const read of unresolved) {
      findings.push({
        file: read.path,
        line: read.line,
        field: 'environment',
        reason: 'reads an environment variable by a name that is not a literal; write "interface-env: NAME" on the line before it, or "interface-env: none" if it reads no name',
      })
    }
  }
  for (const [name, reader] of firstReader) {
    if (check.listed.every(listed => !isListedName(listed, name))) {
      findings.push({ file: check.authoredPath, field: 'environment', reason: `${name} is read by ${reader} but not listed` })
    }
  }
  return findings
}
