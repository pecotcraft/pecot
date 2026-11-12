/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下のみ */
// hooks-config.json.sample と README の設定キー一覧とスクリプト実体の、三者の突合の静的な確認。
// 3 つの出所から独立にキーの集合を取り出し、双方向に一致することを見る。sample の値は、スクリプトの
// pecot_hook_enabled の第 2 引数（既定の値）と揃っていなければならない。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings, isRecord } from '../parity/baseline.js'
import { hooksDirectory } from './_helpers/paths.js'
import { jsonDumps, parseJson, splitLines } from './_helpers/text.js'

// 意図的に sample の値をスクリプトの既定から離すキー。足すときは離す理由をコメントで残す。
const ALLOWED_VALUE_DIVERGENCE: ReadonlySet<string> = new Set()

// `pecot_hook_enabled "<key>" <default>` の実呼び出し。キーの文字種は制限しない。
// 既定の値は省略を許し、省略は別のケースで落とす。必須にすると、呼び出しごとキーが脱落してすり抜ける。
// eslint-disable-next-line security/detect-unsafe-regex -- 入力は hooks の 1 行。量指定子は固定の区切りで終わり、バックトラックは増えない
const HOOK_ENABLED = /pecot_hook_enabled\s+(?<quote>["'])(?<key>[^"']+)\k<quote>(?:\s+(?<default>true|false)\b)?/gu
// `_external_post_check "<key>" ...` は第 1 引数のキーを受け取る。既定の値は定義側から読む。
const EXTERNAL_POST_CHECK = /_external_post_check\s+(?<quote>["'])(?<key>[^"']+)\k<quote>/gu
const EXTERNAL_POST_CHECK_DEFINITION = /_external_post_check\s*\(\s*\)/u
const HOOK_ENABLED_VARIABLE = /pecot_hook_enabled\s+["']\$\{?\w+\}?["']\s+(?<default>true|false)\b/u

const README_SECTION_START = '## 設定キー一覧'
const README_SECTION_END = '## フック実行フロー'
// 見出しは行単位の完全一致で探す。部分一致だと、接頭辞を保った改名を取り逃がす。
const README_SECTION_START_PATTERN = /^## 設定キー一覧$/gmu
const README_SECTION_END_PATTERN = /^## フック実行フロー$/gmu
// 表のセルの先頭の `key`。注記つきのセルでも先頭のキーを拾う。
const README_KEY_CELL = /^`(?<key>[^`]+)`/u

interface GateCall {
  readonly key: string
  readonly default: string | undefined
  readonly location: string
}

// hooks/ 直下のエントリも含めた、tests 以外のシェルスクリプト。
function gateScriptPaths(): string[] {
  return globSync('**/*.sh', { cwd: hooksDirectory })
    .filter(relative => !relative.split('/').includes('tests'))
    .toSorted(comparePathParts)
}

// Python の Path の並びに合わせる。パスを構成要素ごとに比べる。
function comparePathParts(left: string, right: string): number {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const firstDifference = leftParts.map((part, index) => compareStrings(part, rightParts.at(index) ?? '')).find(order => order !== 0)
  return firstDifference ?? leftParts.length - rightParts.length
}

// 行末のコメントを落とす。pecot_hook_enabled の呼び出し行の引用符の中に # を含む例は無い。
function stripComment(line: string): string {
  return line.split('#', 1)[0] ?? ''
}

function readLines(relative: string): string[] {
  return splitLines(readFileSync(path.join(hooksDirectory, relative), 'utf8'))
}

function hookEnabledCalls(): GateCall[] {
  const calls: GateCall[] = []
  for (const relative of gateScriptPaths()) {
    for (const [offset, line] of readLines(relative).entries()) {
      for (const match of stripComment(line).matchAll(HOOK_ENABLED)) {
        calls.push({ key: match.groups?.['key'] ?? '', default: match.groups?.['default'], location: `${relative}:${String(offset + 1)}` })
      }
    }
  }
  return calls
}

function externalPostCheckCalls(): { key: string, location: string }[] {
  const calls: { key: string, location: string }[] = []
  for (const relative of gateScriptPaths()) {
    for (const [offset, line] of readLines(relative).entries()) {
      for (const match of stripComment(line).matchAll(EXTERNAL_POST_CHECK)) {
        calls.push({ key: match.groups?.['key'] ?? '', location: `${relative}:${String(offset + 1)}` })
      }
    }
  }
  return calls
}

// `_external_post_check` の定義側の、変数キーの pecot_hook_enabled の呼び出しから既定の値を読む。
function externalPostCheckDefault(): string {
  const found: { default: string, location: string }[] = []
  for (const relative of gateScriptPaths()) {
    const stripped = readLines(relative).map(line => stripComment(line))
    if (stripped.every(line => !EXTERNAL_POST_CHECK_DEFINITION.test(line))) continue
    for (const [offset, line] of stripped.entries()) {
      const value = HOOK_ENABLED_VARIABLE.exec(line)?.groups?.['default']
      if (value !== undefined) found.push({ default: value, location: `${relative}:${String(offset + 1)}` })
    }
  }
  expect(found, '`_external_post_check` 定義側の変数キー `pecot_hook_enabled` 呼び出しが 1 箇所に特定できません').toHaveLength(1)
  return found[0]?.default ?? ''
}

// スクリプト実体が gate しているキーの集合。変数キーの形は、ヘルパー経由のキーで解決する。
function scriptKeys(): Set<string> {
  const direct = hookEnabledCalls().map(call => call.key).filter(key => !key.startsWith('$'))
  return new Set([...direct, ...externalPostCheckCalls().map(call => call.key)])
}

// キーから既定の値への写像。同じキーが異なる既定の値で呼ばれていたら落とす。
function scriptDefaults(): Map<string, string> {
  const found = new Map<string, { value: string, location: string }[]>()
  const add = (key: string, value: string, location: string): void => {
    found.set(key, [...found.get(key) ?? [], { value, location }])
  }
  for (const call of hookEnabledCalls()) {
    if (call.key.startsWith('$') || call.default === undefined) continue
    add(call.key, call.default, call.location)
  }
  const askDefault = externalPostCheckDefault()
  for (const call of externalPostCheckCalls()) add(call.key, askDefault, call.location)

  const defaults = new Map<string, string>()
  for (const [key, occurrences] of found) {
    const values = new Set(occurrences.map(occurrence => occurrence.value))
    expect(values.size, `キー \`${key}\` が複数の異なる既定の値で呼ばれています: ${JSON.stringify(occurrences)}`).toBe(1)
    defaults.set(key, occurrences[0]?.value ?? '')
  }
  return defaults
}

// 見出しの行の位置を返す。start は見出しの先頭、end は見出しの末尾。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- RegExp は読むだけ
function findHeading(text: string, pattern: RegExp, from: number): { start: number, end: number } | undefined {
  for (const match of text.matchAll(pattern)) {
    if (match.index >= from) return { start: match.index, end: match.index + match[0].length }
  }
  return undefined
}

// README の設定キー一覧の節にある表の第 1 列から、キーを取り出す。
function readmeKeys(): Set<string> {
  const text = readFileSync(path.join(hooksDirectory, 'README.md'), 'utf8')
  const start = findHeading(text, README_SECTION_START_PATTERN, 0)
  expect(start, `README に見出し \`${README_SECTION_START}\` がありません。見出しを改名した場合は本テストの見出しの定数も更新すること`).toBeDefined()
  const end = findHeading(text, README_SECTION_END_PATTERN, start?.end ?? 0)
  expect(end, `README の \`${README_SECTION_START}\` 以降に見出し \`${README_SECTION_END}\` がありません。見出しを改名した場合は本テストの見出しの定数も更新すること`).toBeDefined()
  const keys = new Set<string>()
  const sectionLines = splitLines(text.slice(start?.start ?? 0, end?.start ?? 0))
  for (const line of sectionLines) {
    if (!line.startsWith('|')) continue
    const firstCell = (line.trim().replaceAll(/^\|+|\|+$/gu, '').split('|', 1)[0] ?? '').trim()
    const key = README_KEY_CELL.exec(firstCell)?.groups?.['key']
    if (key !== undefined) keys.add(key)
  }
  return keys
}

// sample を読む。重複キーは後勝ちで消えるので、先に弾く。sample は値が真偽値だけの平らなオブジェクト。
function sampleConfig(): Map<string, unknown> {
  const raw = readFileSync(path.join(hooksDirectory, 'hooks-config.json.sample'), 'utf8')
  const seen = new Set<string>()
  for (const match of raw.matchAll(/"(?<key>(?:[^"\\]|\\.)*)"\s*:/gu)) {
    const key = match.groups?.['key'] ?? ''
    expect(seen.has(key), `sample にキー \`${key}\` が重複しています`).toBe(false)
    seen.add(key)
  }
  const parsed = parseJson(raw)
  if (!isRecord(parsed)) throw new TypeError('sample がオブジェクトではありません')
  return new Map(Object.entries(parsed))
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(item => !right.has(item)).toSorted(compareStrings)
}

describe('hooks の設定キー', () => {
  it('すべての pecot_hook_enabled の呼び出しが、既定の値を明示している', () => {
    const missing = hookEnabledCalls().filter(call => call.default === undefined)
    expect(missing.map(call => `${call.location} キー \`${call.key}\``), '既定の値（true / false）を明示していない pecot_hook_enabled の呼び出しがあります').toEqual([])
  })

  it('sample のキーは、スクリプトが gate するキーと双方向に一致する', () => {
    const sample = new Set(sampleConfig().keys())
    const scripts = scriptKeys()
    expect(difference(scripts, sample), 'スクリプトに存在するが sample に無いキー（sample への追記抜け）').toEqual([])
    expect(difference(sample, scripts), 'sample に存在するがスクリプトから呼ばれていないキー（削除抜け）').toEqual([])
  })

  it('README の設定キー一覧のキーは、スクリプトが gate するキーと双方向に一致する', () => {
    const readme = readmeKeys()
    const scripts = scriptKeys()
    expect(difference(scripts, readme), 'スクリプトに存在するが README 設定キー一覧に無いキー（README への追記抜け）').toEqual([])
    expect(difference(readme, scripts), 'README 設定キー一覧に存在するがスクリプトから呼ばれていないキー（削除抜け）').toEqual([])
  })

  it('sample の値は、スクリプトの既定の値と一致する', () => {
    const defaults = scriptDefaults()
    const mismatches = [...sampleConfig()]
      .filter(([key, value]) => defaults.has(key) && !ALLOWED_VALUE_DIVERGENCE.has(key) && jsonDumps(value) !== defaults.get(key))
      .map(([key, value]) => [key, value, defaults.get(key)])
    expect(mismatches, 'sample の値がスクリプトの既定と不一致です（キー、sample、スクリプト）').toEqual([])
  })
})
