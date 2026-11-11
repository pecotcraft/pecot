import type { SourceFile } from './environment-names.js'
import { compareText, formatFinding } from './finding.js'
import type { COVERAGE_MODES } from './schema.js'

// 前後に [A-Za-z0-9_-] が続く文字列（PT-X-011 の途中や xPW-A-01）は ID としない。
const BEHAVIOR_ID = /(?<![\w-])P[WTV]-[A-Z0-9-]+-\d{2}(?![\w-])/gu

export interface FoundId {
  readonly id: string
  readonly line: number
}

export interface LinkPlugin {
  readonly name: string
  readonly coverage: (typeof COVERAGE_MODES)[number]
  readonly ids: readonly string[]
  readonly tests: readonly SourceFile[]
}

// テストのファイルの文字列から、振る舞いの項目の ID と行番号を集める。コメントの中も数える。
export function scanBehaviorIds(file: SourceFile): FoundId[] {
  return file.text.split('\n').flatMap((text, index) =>
    text.matchAll(BEHAVIOR_ID).map(found => ({ id: found[0], line: index + 1 })).toArray())
}

// プラグインのテストで見つけた ID はそのプラグインの定義書の ID とだけ比べる。決定的な順の失敗の行を返す。
export function checkLinks(plugins: readonly LinkPlugin[]): string[] {
  const undefinedIds: { readonly file: string, readonly line: number, readonly id: string }[] = []
  const untested: string[] = []
  for (const plugin of plugins) {
    const defined = new Set(plugin.ids)
    const seen = new Set<string>()
    for (const file of plugin.tests) {
      for (const found of scanBehaviorIds(file)) {
        seen.add(found.id)
        if (!defined.has(found.id)) undefinedIds.push({ file: file.path, line: found.line, id: found.id })
      }
    }
    if (plugin.coverage === 'on') untested.push(...defined.difference(seen))
  }
  return [
    ...undefinedIds
      .toSorted((left, right) => compareText(left.file, right.file) || left.line - right.line || compareText(left.id, right.id))
      .map(item => formatFinding({ file: item.file, line: item.line, reason: `${item.id} is not defined` })),
    ...untested.toSorted(compareText).map(id => `error: ${id} has no test`),
  ]
}
