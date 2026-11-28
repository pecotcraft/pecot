// 起票の決まりのうち、I/O を持たないもの（題の接頭辞と番号・種類ごとの既定の列・Epic の起票先）。
import type { IssueFrontmatter } from './frontmatter.js'
import { pythonStrip } from './python-format.js'

export type IssueType = IssueFrontmatter['type']

export const VALID_STATUSES: ReadonlySet<string> = new Set(['backlog', 'pending', 'blocked', 'ready', 'active', 'in_review', 'archived'])

/**
Issue 種別 → タイトルの接頭辞
*/
const TYPE_PREFIX_MAP: ReadonlyMap<string, string> = new Map([
  ['task', '[Task]'],
  ['bug', '[Bug]'],
  ['epic', '[Epic]'],
  ['tracker', '[Tracker]'],
])

/**
種別の題の接頭辞（`[Task]` など）。知らない種別は空
*/
export function titlePrefixOf(issueType: string): string {
  return TYPE_PREFIX_MAP.get(issueType) ?? ''
}

export interface IssueTitleOptions {
  readonly parentEpic?: number | undefined
  readonly order?: number | undefined
}

/**
タイトルの番号。2 桁にそろえる
*/
export function orderLabel(order: number): string {
  return String(order).padStart(2, '0')
}

/**
タイトルに接頭辞と、Epic 番号・order を付ける。例は `[Task] #353-04: タイトル`
*/
export function buildIssueTitle(issueType: string, title: string, options: Readonly<IssueTitleOptions> = {}): string {
  const prefix = titlePrefixOf(issueType)
  const hasPrefix = prefix !== '' && title.startsWith(prefix)
  const baseTitle = hasPrefix ? pythonStrip(title.slice(prefix.length)) : title
  if (options.parentEpic !== undefined && options.order !== undefined) {
    const number = `#${String(options.parentEpic)}-${orderLabel(options.order)}`
    return prefix === '' ? `${number}: ${baseTitle}` : `${prefix} ${number}: ${baseTitle}`
  }
  return prefix === '' || hasPrefix ? title : `${prefix} ${title}`
}

const TITLE_ORDER_PATTERN = /^#(\d+)-(\d+)([a-z])?: /u

/**
題を、接頭辞・番号（`#<親>-<順>: `）・残りに分けたもの
*/
export interface TitleParts {
  /**
  種別の接頭辞と空白 1 つで始まるか
  */
  readonly hasPrefix: boolean
  readonly parentEpic: number | undefined
  readonly order: number | undefined
  /**
  番号の部分の文字どおりの表記（`#353-04: `）。無ければ空
  */
  readonly orderText: string
  readonly rest: string
}

/**
題を種別の接頭辞と番号に分ける。接頭辞が無くても番号は読む
*/
export function splitIssueTitle(issueType: string, title: string): TitleParts {
  const prefix = titlePrefixOf(issueType)
  const hasPrefix = prefix !== '' && title.startsWith(`${prefix} `)
  const afterPrefix = hasPrefix ? title.slice(prefix.length + 1) : title
  const match = TITLE_ORDER_PATTERN.exec(afterPrefix)
  if (match === null) return { hasPrefix, parentEpic: undefined, order: undefined, orderText: '', rest: afterPrefix }
  const [orderText, parent = '', order = ''] = match
  return { hasPrefix, parentEpic: Number(parent), order: Number(order), orderText, rest: afterPrefix.slice(orderText.length) }
}

export type EpicTarget
  = | {
    readonly kind: 'resolved'
    readonly repository: string
    /**
    指定の repo が aggregation_repo と違う例外
    */
    readonly isException: boolean
  }
  | { readonly kind: 'undecidable' }

/**
Epic を作るリポジトリを、aggregation_repo の方針で決める。指定が無く、aggregation_repo が無ければ決められない
*/
export function epicTargetRepository(repository: string | undefined, aggregation: string | undefined): EpicTarget {
  const explicit = repository === undefined || pythonStrip(repository) === '' ? undefined : pythonStrip(repository)
  if (explicit === undefined) return aggregation === undefined ? { kind: 'undecidable' } : { kind: 'resolved', repository: aggregation, isException: false }
  return { kind: 'resolved', repository: explicit, isException: aggregation !== undefined && explicit !== aggregation }
}
