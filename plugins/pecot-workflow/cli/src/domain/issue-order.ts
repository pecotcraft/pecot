// タイトルの通し番号（specs/024 の R13）。サブタスクのタイトルと明示の番号から、使われた番号・重複・次の番号を決める。I/O を持たない。

// タイトルの先頭の `#123-01:` と `#123-01a:` から、Epic 番号・番号・枝の文字を取る。`[Task] ` のような接頭辞は許す
const ORDER_PATTERN = /^#(\d+)-(\d+)([a-z])?:/u
const TITLE_PREFIX_PATTERN = /^\[[^\]]*\] ?/u

export interface SubIssueTitle {
  readonly number: number
  readonly state: string
  readonly title: string
}

export interface UsedOrder {
  readonly number: number
  readonly state: string
  readonly title: string
  /**
  タイトルの番号。枝の文字は数えない
  */
  readonly order: number
}

/**
サブタスクのうち、タイトルが親 Epic の番号付きのものを、使われた番号にする
*/
export function usedOrdersOf(subIssues: readonly SubIssueTitle[], parentEpic: number): readonly UsedOrder[] {
  const used: UsedOrder[] = []
  for (const sub of subIssues) {
    const [, epic, order] = ORDER_PATTERN.exec(sub.title.replace(TITLE_PREFIX_PATTERN, '')) ?? []
    if (epic === undefined || order === undefined || Number(epic) !== parentEpic) continue
    used.push({ number: sub.number, state: sub.state, title: sub.title, order: Number(order) })
  }
  return used
}

export interface OrderRequest {
  readonly file: string
  /**
  明示の番号。省いたら undefined
  */
  readonly order: number | undefined
}

export type OrderPlan
  = | { readonly kind: 'planned', readonly orders: readonly number[] }
    | { readonly kind: 'duplicate-in-batch', readonly order: number, readonly files: readonly string[] }
    | { readonly kind: 'duplicate-existing', readonly order: number, readonly existing: UsedOrder, readonly nextAvailable: number }
    | { readonly kind: 'unreadable-parent' }

function explicitOrders(requests: readonly OrderRequest[]): ReadonlyMap<number, readonly string[]> {
  const explicit = new Map<number, string[]>()
  for (const { file, order } of requests) {
    if (order !== undefined) explicit.set(order, [...explicit.get(order) ?? [], file])
  }
  return explicit
}

/**
一括の中で明示の番号が重なるものを返す。ネットワークを使わずに確かめられる
*/
export function findBatchDuplicate(requests: readonly OrderRequest[]): { readonly order: number, readonly files: readonly string[] } | undefined {
  for (const [order, files] of explicitOrders(requests)) {
    if (files.length > 1) return { order, files }
  }
  return undefined
}

/**
同じ親 Epic のファイルに番号を振る。requests はファイルの順。
使われた番号は、親のサブタスクのタイトルから読んだもの（読めなければ undefined）。
明示の番号は、既存の番号とも、ほかのファイルの明示の番号とも重ねない。
省いたファイルには、既存の番号と明示の番号の最大の次から、ファイルの順に振る。省いたファイルがあって使われた番号を読めなければ、決められない
*/
export function planOrders(used: readonly UsedOrder[] | undefined, requests: readonly OrderRequest[]): OrderPlan {
  const explicit = explicitOrders(requests)
  // 省いたファイルへの番号と、重複のときの案内は、同じ「既存と明示の最大の次」
  const first = Math.max(0, ...(used ?? []).map(entry => entry.order), ...explicit.keys()) + 1
  for (const [order, files] of explicit) {
    if (files.length > 1) return { kind: 'duplicate-in-batch', order, files }
    const existing = used?.find(entry => entry.order === order)
    if (existing !== undefined) return { kind: 'duplicate-existing', order, existing, nextAvailable: first }
  }
  if (used === undefined && requests.some(({ order }) => order === undefined)) return { kind: 'unreadable-parent' }

  let next = first
  const orders = requests.map(({ order }) => {
    if (order !== undefined) return order
    const assigned = next
    next += 1
    return assigned
  })
  return { kind: 'planned', orders }
}
