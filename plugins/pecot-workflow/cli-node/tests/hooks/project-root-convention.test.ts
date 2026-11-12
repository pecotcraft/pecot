/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下のみ */
// hooks の基準ディレクトリ（CLAUDE_PROJECT_DIR）の解決の規約の静的な確認。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { hooksDirectory, pluginRoot } from './_helpers/paths.js'
import { resolveDirectoryVariables } from './_helpers/script-references.js'
import { splitLines } from './_helpers/text.js'

// Python の Path の並びに合わせる。パスを構成要素ごとに比べる。
function comparePathParts(left: string, right: string): number {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const firstDifference = leftParts.map((part, index) => compareStrings(part, rightParts.at(index) ?? '')).find(order => order !== 0)
  return firstDifference ?? leftParts.length - rightParts.length
}

const entryPoints = globSync('*.sh', { cwd: hooksDirectory }).toSorted(comparePathParts)
const libraryScripts = globSync('lib/**/*.sh', { cwd: hooksDirectory })
  .filter(relative => !relative.split('/').includes('tests'))
  .toSorted(comparePathParts)

const INPUT_LINE = 'INPUT=$(cat)'
// lib/core を指す変数。CORE_DIR を定義するエントリポイントは $CORE_DIR 経由に限る。
const SOURCE_PATTERN = /^source "\$(?<variable>[A-Z_]+)(?<core>\/lib\/core)?\/project-root\.sh" "\$INPUT"$/u
const FALLBACK_PATTERN = /\$\{CLAUDE_PROJECT_DIR:?-[^}]/u
// `git` の直後（大域オプションを挟んでも）に `-C` が無いまま rev-parse --show-toplevel を呼ぶ形。

const CWD_TOPLEVEL_PATTERN = /\bgit\b(?:(?!\s-C\b)[^|;&])+?\brev-parse\s+--show-toplevel\b/u

const LAZY_VARIABLE = 'PECOT_PROJECT_ROOT_LAZY'
// toplevel の解決を遅らせてよいエントリは PostToolUse(Bash) の 1 本だけ。
const LAZY_ENTRIES: ReadonlySet<string> = new Set(['post-tool-use-bash.sh'])

function readLines(relative: string): string[] {
  return splitLines(readFileSync(path.join(hooksDirectory, relative), 'utf8'))
}

function offendingLines(relative: string, pattern: Readonly<RegExp>): string[] {
  return readLines(relative)
    .filter(line => !line.trimStart().startsWith('#') && pattern.test(line))
    .map(line => line.trim())
}

describe('hooks の基準ディレクトリの規約', () => {
  it('エントリポイントと lib のスクリプトを下限以上の数で列挙できる', () => {
    expect(entryPoints.length).toBeGreaterThanOrEqual(14)
    expect(libraryScripts.length).toBeGreaterThanOrEqual(40)
  })

  it.for(entryPoints.map(label => ({ label })))('$label は、INPUT=$(cat) の直後に入力 JSON を引数にして project-root.sh を source する', (row) => {
    const text = readFileSync(path.join(hooksDirectory, row.label), 'utf8')
    const lines = splitLines(text).map(line => line.trim())
    expect(lines.filter(line => line === INPUT_LINE), `${row.label}: \`${INPUT_LINE}\` が 1 行ではありません`).toHaveLength(1)
    const sources = lines
      .map((line, index) => ({ index, groups: SOURCE_PATTERN.exec(line)?.groups }))
      .filter(candidate => candidate.groups !== undefined)
    expect(sources, `${row.label}: project-root.sh の source が 1 行ではありません`).toHaveLength(1)
    const source = sources[0]
    expect(source?.index, `${row.label}: project-root.sh の source は \`${INPUT_LINE}\` の直後に置いてください`).toBe(lines.indexOf(INPUT_LINE) + 1)
    const directoryVariables = resolveDirectoryVariables(text, hooksDirectory, pluginRoot)
    const base = directoryVariables.get(source?.groups?.['variable'] ?? '')
    expect(base, `${row.label}: 変数を解決できません`).toBeDefined()
    const core = (source?.groups?.['core'] ?? '').replace(/^\/+/u, '')
    expect(path.join(base ?? '', core, 'project-root.sh')).toBe(path.join(hooksDirectory, 'lib', 'core', 'project-root.sh'))
  })

  it.for(libraryScripts.map(label => ({ label })))('$label に CLAUDE_PROJECT_DIR の独自の fallback は無い', (row) => {
    const offending = offendingLines(row.label, FALLBACK_PATTERN)
    expect(offending, `${row.label}: CLAUDE_PROJECT_DIR の独自 fallback があります。基準ディレクトリはエントリポイントの project-root.sh が決めます`).toEqual([])
  })

  it('fallback の検出パターンは既知の形を検出し、空の既定値の形は検出しない', () => {
    expect(FALLBACK_PATTERN.test('PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"')).toBe(true)
    expect(FALLBACK_PATTERN.test('X="${CLAUDE_PROJECT_DIR-/tmp}"')).toBe(true)
    expect(FALLBACK_PATTERN.test('[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0')).toBe(false)
    expect(FALLBACK_PATTERN.test('STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"')).toBe(false)
  })

  it.for(libraryScripts.map(label => ({ label })))('$label はプロセスの cwd を基準にした git rev-parse --show-toplevel を呼ばない', (row) => {
    const offending = offendingLines(row.label, CWD_TOPLEVEL_PATTERN)
    expect(offending, `${row.label}: プロセス cwd 基準の \`git rev-parse --show-toplevel\` があります。別ディレクトリを調べるときは \`git -C <dir>\` で対象を明示してください`).toEqual([])
  })

  it('cwd 基準の toplevel の検出パターンは既知の形を検出し、-C 付きの形は検出しない', () => {
    expect(CWD_TOPLEVEL_PATTERN.test('REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)')).toBe(true)
    expect(CWD_TOPLEVEL_PATTERN.test('if ! t=$(git rev-parse --show-toplevel 2>/dev/null); then')).toBe(true)
    expect(CWD_TOPLEVEL_PATTERN.test('P=$(git rev-parse --show-toplevel 2>/dev/null || pwd)')).toBe(true)
    expect(CWD_TOPLEVEL_PATTERN.test('X=$(git --no-pager rev-parse --show-toplevel)')).toBe(true)
    expect(CWD_TOPLEVEL_PATTERN.test('git -C "$dir" rev-parse --show-toplevel 2>/dev/null')).toBe(false)
    expect(CWD_TOPLEVEL_PATTERN.test('cd "$d" && git -C . rev-parse --show-toplevel')).toBe(false)
    expect(CWD_TOPLEVEL_PATTERN.test('git rev-parse --git-dir')).toBe(false)
  })

  it.for(entryPoints.map(label => ({ label })))('$label は、project-root の解決を遅らせてよいエントリである場合に限り、遅らせる', (row) => {
    const isUsesLazy = readLines(row.label).some(line => line.trimStart().startsWith(`${LAZY_VARIABLE}=`))
    expect(isUsesLazy, `${row.label}: ${LAZY_VARIABLE} で project-root の解決を遅らせてよいのは ${JSON.stringify([...LAZY_ENTRIES])} だけです`).toBe(LAZY_ENTRIES.has(row.label))
  })

  it('post-tool-use-bash.sh は、一致の判定の後で、一致しなければ exit する', () => {
    const lines = readLines('post-tool-use-bash.sh').map(line => line.trim())
    const match = lines.findIndex(line => line.includes('bash-post-match.sh') && line.includes('source'))
    const guard = lines.indexOf('[ -z "$PECOT_POST_MATCHED" ] && exit 0')
    expect(match).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(match, '一致判定の後で、一致しなければ exit する形にしてください').toBeLessThan(guard)
  })
})
