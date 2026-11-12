/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下のみ */
// README「フック実行フロー」の表と hooks.json とエントリスクリプト実体の、三者の突合の静的な確認。
// 突合相手は Claude 側の hooks.json で、com.github.copilot/hooks/hooks.json からは Copilot 専用のエントリだけを補う。
// lib は basename でしか一致を見ず、コアガード群の内訳と中継先の呼び出し順は対象外。
import { existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { toArray, toRecord } from './_helpers/json.js'
import { hooksDirectory } from './_helpers/paths.js'
import { parseJson, splitLines } from './_helpers/text.js'

// 表の「lib ディスパッチ」列に現れる総称表記。lib 名の突合の対象から外す。ここに無い非 lib 名のトークンは落とす。
const GENERIC_LIB_LABELS: ReadonlySet<string> = new Set(['コアガード群'])

// 実体側で呼ばれるが、表の「lib ディスパッチ」に載せない lib。除外の理由は 1 件ずつ明示する。
const EXCLUDED_LIBS: ReadonlySet<string> = new Set([
  // 複数 hook の出力を単一 JSON に合成するユーティリティ
  'merge-hook-outputs',
  // .pecot ディレクトリの初期化ユーティリティ
  'pecot-dir-init',
  // .pecot 既存リポの .gitignore を単一出所から再生成するユーティリティ。設定キーを持たない。
  'pecot-gitignore-ensure',
])

// 列 3 の「→」を、別ディスパッチャへの中継と読む lib。新しい中継ディスパッチャの明示登録を強制する。
const RELAY_DISPATCHERS: ReadonlySet<string> = new Set(['session-start-common', 'mcp-dispatcher'])

// com.github.copilot/hooks/hooks.json にだけ配線され、表に Copilot 用の行として載るエントリ。
const COPILOT_ONLY_SCRIPTS: ReadonlySet<string> = new Set(['stop-copilot.sh'])

// 表の第 1 列で、matcher の指定なし（全ツールが対象）を表すラベル。
const NO_MATCHER_LABEL = '全ツール'

const README_SECTION_HEADING = '## フック実行フロー'
// 見出しは行単位の完全一致で探す。部分一致だと、接頭辞を保った改名を取り逃がす。
const README_SECTION_PATTERN = /^## フック実行フロー$/mu

// 第 1 列は `Event` か `Event (matcher)`。
// eslint-disable-next-line security/detect-unsafe-regex -- 入力は README の表の 1 セル。量指定子は固定の区切りで終わる
const TRIGGER_PATTERN = /^(?<event>[A-Za-z]+)(?:\s*\((?<matcher>[^)]*)\))?$/u
// 第 3 列の括弧注記。半角と全角の両方を落とす。
const PAREN_NOTE_PATTERN = /[(（][^)）]*[)）]/gu
// lib 名として妥当なトークン。
const LIB_NAME_PATTERN = /^[a-z0-9-]+$/u
// 実体側の冒頭の変数代入。変数名は決め打ちせず、汎用のパターンで拾う。
const VARIABLE_ASSIGN_PATTERN = /^\s*(?<name>[A-Za-z_]\w*)=(?<value>"[^"]*"|\S+)\s*$/u
// 実体側の `"$LIB_DIR/x.sh"` 形の呼び出し。1 行に複数並ぶので全件拾う。
const QUOTED_SH_PATTERN = /"(?<script>[^"]*\.sh)"/gu
// 変数参照 `$VAR` と `${VAR}`。`$0` や `$(...)` には意図的に合わせない。
const VARIABLE_REFERENCE_PATTERN = /\$\{?([A-Za-z_]\w*)\}?/gu
// `source` と `.` による読み込み行。サブプロセスの lib ディスパッチではないので、抽出の対象から外す。
const SOURCE_LINE_PATTERN = /^\s*(?:source|\.)\s/u

interface FlowRow {
  readonly event: string
  readonly matchers: readonly (string | undefined)[]
  readonly scriptPattern: string
  readonly libs: ReadonlySet<string>
  readonly relayVia: string | undefined
  readonly relayLibs: ReadonlySet<string>
  readonly raw: string
}

interface ConfigEntry {
  readonly event: string
  readonly matcher: string | undefined
  readonly name: string
}

function readText(relative: string): string {
  return readFileSync(path.join(hooksDirectory, relative), 'utf8')
}

function sorted(items: Iterable<string>): string[] {
  return [...items].toSorted(compareStrings)
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return sorted([...left].filter(item => !right.has(item)))
}

// 行末のコメントを落とす。コメント内に merge-hook-outputs.sh などが裸で現れるので、.sh の抽出の前段に要る。
function stripComment(line: string): string {
  return line.split('#', 1)[0] ?? ''
}

// 組を比較用の文字列キーにする。matcher なしは null として入る。
function tripleKey(event: string, matcher: string | undefined, script: string): string {
  return JSON.stringify([event, matcher, script])
}

// README の表のパース。

// 「フック実行フロー」の節の、コードフェンス内の行を返す。
function flowTableLines(): string[] {
  const text = readText('README.md')
  const heading = README_SECTION_PATTERN.exec(text)
  expect(heading, `README に見出し \`${README_SECTION_HEADING}\` がありません。見出しを改名した場合は本テストの見出しの定数も更新すること`).not.toBeNull()
  const headingStart = heading?.index ?? 0
  const end = text.indexOf('\n## ', headingStart + (heading?.[0].length ?? 0))
  const section = end === -1 ? text.slice(headingStart) : text.slice(headingStart, end)
  const sectionLines = splitLines(section)
  const fenceIndices = sectionLines.map((line, index) => (line.startsWith('```') ? index : -1)).filter(index => index >= 0)
  expect(fenceIndices, `\`${README_SECTION_HEADING}\` 節のコードフェンスがちょうど 1 組ではありません。フロー表を複数のフェンスに分割した場合は本テストのパーサも更新すること`).toHaveLength(2)
  return sectionLines.slice((fenceIndices[0] ?? 0) + 1, fenceIndices[1])
}

// ヘッダー行と罫線行の形を確かめて消費し、データ行だけを返す。
function flowTableBody(): string[] {
  const lines = flowTableLines()
  expect(lines.length, 'フロー表にヘッダー行・罫線行がありません').toBeGreaterThanOrEqual(2)
  const [header = '', rule = '', ...body] = lines
  expect(header.startsWith('settings.json') && header.split('→').length - 1 === 2, `フロー表のヘッダー行が想定の形ではありません: ${JSON.stringify(header)}`).toBe(true)
  expect(rule.trim() !== '' && rule.trim().replaceAll('─', '') === '', `フロー表の罫線行が罫線のみで構成されていません: ${JSON.stringify(rule)}`).toBe(true)
  return body
}

// 空白で始まる行は、直前のエントリの継続として結合する。
function joinContinuations(body: readonly string[]): string[] {
  const entries: string[] = []
  for (const line of body) {
    if (line.trim() === '') continue
    if (/^\s/u.test(line)) {
      const last = entries.at(-1)
      if (last === undefined) throw new Error(`継続行が先頭に現れました（対応する行がありません）: ${JSON.stringify(line)}`)
      entries[entries.length - 1] = `${last} ${line.trim()}`
    }
    else {
      entries.push(line.trimEnd())
    }
  }
  return entries
}

// 第 1 列を event と matcher の群に分ける。matcher の指定なしは undefined で表す。
function parseTrigger(cell: string, raw: string): { event: string, matchers: (string | undefined)[] } {
  const groups = TRIGGER_PATTERN.exec(cell)?.groups
  if (groups?.['event'] === undefined) throw new Error(`フロー表の第 1 列が \`Event\` / \`Event (matcher)\` の形ではありません: ${JSON.stringify(raw)}`)
  const matcher = groups['matcher']
  return matcher === undefined || matcher.trim() === NO_MATCHER_LABEL ? { event: groups['event'], matchers: [undefined] } : { event: groups['event'], matchers: matcher.split('/').map(part => part.trim()) }
}

// 第 3 列の 1 セグメントを lib 名のトークンに分ける。総称表記は結果から除く。
function libraryTokens(segment: string, raw: string): string[] {
  const tokens = segment.split(/[,/]/u).map(token => token.trim())
  for (const token of tokens) {
    if (token !== '' && !LIB_NAME_PATTERN.test(token) && !GENERIC_LIB_LABELS.has(token)) {
      throw new Error(`フロー表の lib ディスパッチ列に、lib 名とも総称表記とも読めないトークン \`${token}\` があります（行: ${JSON.stringify(raw)}）。総称表記を足した場合は本テストの GENERIC_LIB_LABELS にも理由つきで追記すること`)
    }
  }
  return tokens.filter(token => token !== '' && LIB_NAME_PATTERN.test(token))
}

// 第 3 列を、エントリが呼ぶ lib、中継元の lib、中継先の lib に分ける。括弧注記は「→」の分割より先に落とす。
function parseLibs(cell: string, raw: string): { libs: Set<string>, relayVia: string | undefined, relayLibs: Set<string> } {
  const segments = cell.replaceAll(PAREN_NOTE_PATTERN, ' ').split('→')
  const tokensPerSegment = segments.map(segment => libraryTokens(segment, raw))
  const head = tokensPerSegment[0] ?? []
  const relays = head.filter(token => RELAY_DISPATCHERS.has(token))
  return tokensPerSegment.length > 1 && relays.length === 1 ? { libs: new Set(head), relayVia: relays[0], relayLibs: new Set(tokensPerSegment.slice(1).flat()) } : { libs: new Set(tokensPerSegment.flat()), relayVia: undefined, relayLibs: new Set() }
}

// 表の全データ行を構造化して返す。
function flowRows(): FlowRow[] {
  return joinContinuations(flowTableBody()).map((raw) => {
    // 列 3 の内部にも「→」が現れるので、先頭の 2 個だけで 3 分割する。
    const firstArrow = raw.indexOf('→')
    const secondArrow = firstArrow === -1 ? -1 : raw.indexOf('→', firstArrow + 1)
    if (secondArrow === -1) throw new Error(`フロー表のデータ行を「→」で 3 列に分割できません（「→」が不足）: ${JSON.stringify(raw)}`)
    const triggerCell = raw.slice(0, firstArrow).trim()
    const scriptCell = raw.slice(firstArrow + 1, secondArrow).trim()
    const libraryCell = raw.slice(secondArrow + 1).trim()
    expect(scriptCell.endsWith('.sh'), `フロー表の第 2 列が .sh で終わっていません: ${JSON.stringify(scriptCell)}（行: ${JSON.stringify(raw)}）`).toBe(true)
    const { event, matchers } = parseTrigger(triggerCell, raw)
    const { libs, relayVia, relayLibs } = parseLibs(libraryCell, raw)
    return { event, matchers, scriptPattern: scriptCell, libs, relayVia, relayLibs, raw }
  })
}

// 第 2 列のスクリプト名（session-start-*.sh のような glob を含む）を実体名に展開する。
function expandPattern(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern]
  const matched = globSync('*.sh', { cwd: hooksDirectory }).filter(name => path.matchesGlob(name, pattern)).toSorted(compareStrings)
  expect(matched, `フロー表の \`${pattern}\` に一致するスクリプトが hooks/ 直下にありません`).not.toHaveLength(0)
  return matched
}

// hooks.json 側の抽出。

// 設定の全エントリを、event・matcher・command の basename の組にする。
function configEntries(filename: string): ConfigEntry[] {
  const parsed = parseJson(readText(filename))
  const events = toRecord(toRecord(parsed, filename)['hooks'], 'hooks')
  return Object.entries(events).flatMap(([event, blocks]) => toArray(blocks, event).flatMap((block) => {
    const record = toRecord(block, 'エントリ')
    const matcher = typeof record['matcher'] === 'string' ? record['matcher'] : undefined
    return toArray(record['hooks'], 'エントリの hooks').map((hook) => {
      const command = toRecord(hook, 'hook')['command']
      if (typeof command !== 'string') throw new TypeError('command が文字列ではありません')
      return { event, matcher, name: path.posix.basename(command) }
    })
  }))
}

// hooks.json の全エントリと、com.github.copilot/hooks/hooks.json の Copilot 専用のエントリ。
function hooksJsonEntries(): ConfigEntry[] {
  return [
    ...configEntries('hooks.json'),
    ...configEntries('../com.github.copilot/hooks/hooks.json').filter(entry => COPILOT_ONLY_SCRIPTS.has(entry.name)),
  ]
}

// basename が表の glob に合うものを、そのパターンの表記に寄せる。
function normalizeToPatterns(entries: readonly ConfigEntry[], patterns: readonly string[]): Set<string> {
  const globs = patterns.filter(pattern => pattern.includes('*'))
  return new Set(entries.map((entry) => {
    const replaced = globs.find(glob => path.matchesGlob(entry.name, glob)) ?? entry.name
    return tripleKey(entry.event, entry.matcher, replaced)
  }))
}

// エントリスクリプト実体側の抽出。

// 冒頭の変数代入を集め、既知の基点変数で展開する。
function expandVariables(value: string, variables: ReadonlyMap<string, string>): string | undefined {
  const expanded = value.replaceAll(VARIABLE_REFERENCE_PATTERN, (whole: string, name: string) => variables.get(name) ?? whole)
  return expanded.includes('$') ? undefined : expanded
}

function resolveVariables(scriptDirectory: string, lines: readonly string[]): Map<string, string> {
  const variables = new Map<string, string>([
    // 各スクリプトの `$(cd "$(dirname "$0")" && pwd)` に当たる。
    ['SCRIPT_DIR', scriptDirectory],
    // `${CLAUDE_PLUGIN_ROOT}/hooks/...` の呼び出し用。スクリプトの位置に依存しない。
    ['CLAUDE_PLUGIN_ROOT', path.dirname(hooksDirectory)],
  ])
  for (const line of lines) {
    const groups = VARIABLE_ASSIGN_PATTERN.exec(line)?.groups
    if (groups?.['name'] === undefined || groups['value'] === undefined) continue
    const expanded = expandVariables(groups['value'].replaceAll(/^"+|"+$/gu, ''), variables)
    // 未解決の参照が残る代入は採らない。seed の値を守る。
    if (expanded !== undefined) variables.set(groups['name'], expanded)
  }
  return variables
}

// スクリプトが呼ぶ lib の、名前から解決済みのパスへの写像。除外 lib と source 行は落とす。
function dispatchedPaths(script: string): Map<string, string> {
  const lines = splitLines(readFileSync(script, 'utf8')).map(line => stripComment(line))
  const variables = resolveVariables(path.dirname(script), lines)
  const dispatched = new Map<string, string>()
  for (const [offset, line] of lines.entries()) {
    if (SOURCE_LINE_PATTERN.test(line)) continue
    const location = `${path.basename(script)}:${String(offset + 1)}`
    for (const match of line.matchAll(QUOTED_SH_PATTERN)) {
      const rawPath = match.groups?.['script'] ?? ''
      const resolved = expandVariables(rawPath, variables)
      expect(resolved, `${location}: .sh 呼び出しのパス \`${rawPath}\` に未解決の変数参照が残ります。新しい基点変数を導入した場合は本テストの resolveVariables も更新すること`).toBeDefined()
      expect(existsSync(resolved ?? ''), `${location}: 呼び出し先 \`${resolved ?? ''}\` が存在しません`).toBe(true)
      dispatched.set(path.basename(resolved ?? '', '.sh'), resolved ?? '')
    }
    // クォートされていない .sh を取りこぼさないためのガード。
    expect(line.replaceAll(QUOTED_SH_PATTERN, ' ').includes('.sh'), `${location}: クォートで囲まれていない .sh 参照があります: ${JSON.stringify(line.trim())}。抽出抜けになるため本テストの QUOTED_SH_PATTERN を拡張すること`).toBe(false)
  }
  return new Map([...dispatched].filter(([name]) => !EXCLUDED_LIBS.has(name)))
}

function dispatchedLibs(script: string): Set<string> {
  return new Set(dispatchedPaths(script).keys())
}

function formatSets(value: unknown): string {
  return JSON.stringify(value)
}

function libsOf(libsByScript: ReadonlyMap<string, ReadonlySet<string>>, name: string): ReadonlySet<string> {
  return libsByScript.get(name) ?? new Set()
}

describe('README のフロー表', () => {
  it('表の第 2 列のスクリプトは、hooks.json の command の basename と集合として一致する', () => {
    const table = new Set(flowRows().flatMap(row => expandPattern(row.scriptPattern)))
    const configured = new Set(hooksJsonEntries().map(entry => entry.name))
    expect(difference(table, configured), 'README フロー表にあるが hooks.json に登録されていないスクリプト（表の削除抜け、または hooks.json への追記抜け）').toEqual([])
    expect(difference(configured, table), 'hooks.json に登録されているが README フロー表に無いスクリプト（表への追記抜け）').toEqual([])
  })

  it('表の (トリガー, スクリプト) の対応は、hooks.json の対応と 3 要素の組で一致する', () => {
    const rows = flowRows()
    const patterns = rows.map(row => row.scriptPattern)
    const table = new Set(rows.flatMap(row => row.matchers.map(matcher => tripleKey(row.event, matcher, row.scriptPattern))))
    const configured = normalizeToPatterns(hooksJsonEntries(), patterns)
    expect(difference(table, configured), 'README フロー表にあるが hooks.json に無い (イベント, matcher, スクリプト) の対応').toEqual([])
    expect(difference(configured, table), 'hooks.json にあるが README フロー表に無い (イベント, matcher, スクリプト) の対応').toEqual([])
  })

  it('表の lib ディスパッチ列は、エントリスクリプトの実呼び出しと行単位で一致する', () => {
    const expected = new Map<string, ReadonlySet<string>>()
    for (const row of flowRows()) {
      for (const name of expandPattern(row.scriptPattern)) expected.set(name, row.libs)
    }
    const actual = new Map(globSync('*.sh', { cwd: hooksDirectory }).toSorted(compareStrings).map(name => [name, dispatchedLibs(path.join(hooksDirectory, name))]))

    const expectedNames = new Set(expected.keys())
    const actualNames = new Set(actual.keys())
    expect(difference(expectedNames, actualNames), 'README フロー表に載っているが hooks/ 直下に実体が無いスクリプト').toEqual([])
    expect(difference(actualNames, expectedNames), 'hooks/ 直下に実体があるが README フロー表に載っていないスクリプト').toEqual([])

    const mismatches: [string, string[], string[]][] = []
    for (const name of sorted(expected.keys())) {
      const tableSide = libsOf(expected, name)
      const scriptSide = libsOf(actual, name)
      const missing = difference(tableSide, scriptSide)
      const extra = difference(scriptSide, tableSide)
      if (missing.length > 0 || extra.length > 0) mismatches.push([name, missing, extra])
    }
    expect(mismatches, 'README フロー表の lib ディスパッチとスクリプト実体の不一致（スクリプト、表側の差分、実体側の差分）').toEqual([])
  })

  it('表の中継先 lib は、中継元ディスパッチャの実呼び出しと一致する', () => {
    const relayRows: { row: FlowRow, relayVia: string }[] = []
    for (const row of flowRows()) {
      if (row.relayVia !== undefined) relayRows.push({ row, relayVia: row.relayVia })
    }
    expect(relayRows.length, 'フロー表に中継記述（`<ディスパッチャ> → <中継先>`）が 1 行もありません。中継を廃止した場合は本テストの RELAY_DISPATCHERS も更新すること').toBeGreaterThan(0)
    for (const { row, relayVia } of relayRows) {
      for (const name of expandPattern(row.scriptPattern)) {
        const entryDispatch = dispatchedPaths(path.join(hooksDirectory, name))
        // 表が中継元とする lib が、実際にそのエントリから呼ばれていることも確かめる。
        const called = formatSets(sorted(entryDispatch.keys()))
        expect(entryDispatch.has(relayVia), `${name} は表が中継元とする \`${relayVia}\` を呼んでいません（実呼び出し: ${called}、行: ${JSON.stringify(row.raw)}）`).toBe(true)
        const actual = new Set(dispatchedPaths(entryDispatch.get(relayVia) ?? '').keys())
        expect(difference(row.relayLibs, actual), `README フロー表にあるが \`${relayVia}\` から呼ばれていない中継先（表の削除抜け）`).toEqual([])
        expect(difference(actual, row.relayLibs), `\`${relayVia}\` から呼ばれているが README フロー表に無い中継先（表への追記抜け）`).toEqual([])
      }
    }
  })

  it('Copilot 専用のエントリは com.github.copilot/hooks/hooks.json にだけ配線され、hooks.json には無い', () => {
    const copilotNames = new Set(configEntries('../com.github.copilot/hooks/hooks.json').map(entry => entry.name))
    const claudeNames = new Set(configEntries('hooks.json').map(entry => entry.name))
    expect(difference(COPILOT_ONLY_SCRIPTS, copilotNames)).toEqual([])
    expect([...claudeNames].filter(name => COPILOT_ONLY_SCRIPTS.has(name))).toEqual([])
  })
})
