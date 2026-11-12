/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは引数で渡された JUnit だけ */
// 2 つの JUnit を (classname, name) ごとの結果で比べ、差を出す。hooks の 2 回の実行の比較に使う。
// 使い方: tsx scripts/compare-junit.ts <junit1.xml> <junit2.xml>
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type Outcome = 'passed' | 'failed' | 'error' | 'skipped'

export interface Difference {
  readonly onlyFirst: readonly string[]
  readonly onlySecond: readonly string[]
  readonly changed: readonly string[]
}

const ENTITIES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', '\'']])

function unescapeXml(text: string): string {
  return text.replaceAll(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/giu, (whole: string, ...groups: readonly (string | undefined)[]) => {
    const [decimal, hex, named = ''] = groups
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    return ENTITIES.get(named) ?? whole
  })
}

function attributesOf(source: string): ReadonlyMap<string, string> {
  return new Map(Array.from(source.matchAll(/([\w:.-]+)="([^"]*)"/gu), match => [match[1] ?? '', unescapeXml(match[2] ?? '')]))
}

function outcomeOf(body: string): Outcome {
  // system-out などの CDATA の中身は、子の要素として読まない
  const children = body.replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/gu, '')
  if (/<error[\s/>]/u.test(children)) return 'error'
  if (/<failure[\s/>]/u.test(children)) return 'failed'
  if (/<skipped[\s/>]/u.test(children)) return 'skipped'
  return 'passed'
}

// JUnit の本文から、`classname::name` ごとの結果を作る。同じ key が重なれば後のものを取る
export function parseJunit(xml: string): ReadonlyMap<string, Outcome> {
  const cases = new Map<string, Outcome>()
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const attributes = attributesOf(match[1] ?? '')
    cases.set(`${attributes.get('classname') ?? ''}::${attributes.get('name') ?? ''}`, outcomeOf(match[2] ?? ''))
  }
  return cases
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : (a > b ? 1 : 0)
}

function keysWhere(cases: ReadonlyMap<string, Outcome>, isTarget: (key: string) => boolean): readonly string[] {
  const found: string[] = []
  for (const key of cases.keys()) {
    if (isTarget(key)) found.push(key)
  }
  return found.toSorted(byKey)
}

export function compareJunit(first: ReadonlyMap<string, Outcome>, second: ReadonlyMap<string, Outcome>): Difference {
  return {
    onlyFirst: keysWhere(first, key => !second.has(key)),
    onlySecond: keysWhere(second, key => !first.has(key)),
    changed: keysWhere(first, key => second.has(key) && first.get(key) !== second.get(key)),
  }
}

function labelOf(cases: ReadonlyMap<string, Outcome>, key: string): string {
  return cases.get(key) ?? 'none'
}

export interface Io {
  readonly stderr: (text: string) => void
}

// 終了コードを返す。0 は一致、1 は差あり、2 は使い方か読めないファイル
export function main(argv: readonly string[], io: Io): number {
  const [firstPath, secondPath, ...rest] = argv
  if (firstPath === undefined || secondPath === undefined || rest.length > 0) {
    io.stderr('usage: compare-junit.ts <junit1.xml> <junit2.xml>\n')
    return 2
  }
  for (const file of [firstPath, secondPath]) {
    if (!existsSync(file)) {
      io.stderr(`JUnit がありません: ${file}\n`)
      return 2
    }
  }
  const first = parseJunit(readFileSync(firstPath, 'utf8'))
  const second = parseJunit(readFileSync(secondPath, 'utf8'))
  const difference = compareJunit(first, second)
  if (difference.onlyFirst.length === 0 && difference.onlySecond.length === 0 && difference.changed.length === 0) return 0
  const lines: string[] = []
  if (difference.onlyFirst.length > 0) lines.push(`${firstPath} にだけあるケース:`, ...difference.onlyFirst.map(key => `  ${key} [${labelOf(first, key)}]`))
  if (difference.onlySecond.length > 0) lines.push(`${secondPath} にだけあるケース:`, ...difference.onlySecond.map(key => `  ${key} [${labelOf(second, key)}]`))
  if (difference.changed.length > 0) lines.push('結果が違うケース:', ...difference.changed.map(key => `  ${key}  1 回目=${labelOf(first, key)}  2 回目=${labelOf(second, key)}`))
  io.stderr(`${lines.join('\n')}\n`)
  return 1
}

// 直接起動したときだけ CLI として動く
const entryPoint = process.argv[1]
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  // eslint-disable-next-line unicorn/no-top-level-side-effects -- 直接起動したときだけ終了コードを返す
  process.exitCode = main(process.argv.slice(2), {
    stderr: (text) => {
      process.stderr.write(text)
    },
  })
}
