// pecot-lane（利用者が Issue を分類するのに使う任意の欄）の名前と、一覧の集計。

/**
分類の欄のフィールド名
*/
export const LANE_FIELD_NAME = 'pecot-lane'

/**
pecot-lane の値ごとの Issue の数。name が null の組は値の無い Issue
*/
export interface LaneSummary {
  readonly name: string | null
  readonly count: number
  readonly startable: number
}

/**
集計に渡す Issue 1 件。lane が null なら値が無い
*/
export interface LaneEntry {
  readonly lane: string | null
  readonly isStartable: boolean
}

/**
値ごとに Issue を数える。並びは選択肢の順で、Issue の無い選択肢も 0 件で出す。
選択肢に無い値は出てきた順で選択肢の後に、値の無い組は 1 件以上あるときだけ末尾に置く。
options が undefined（ボードに pecot-lane が無い）なら空
*/
export function summarizeLanes(options: readonly string[] | undefined, items: readonly LaneEntry[]): readonly LaneSummary[] {
  if (options === undefined) return []
  const counts = new Map<string | null, { count: number, startable: number }>(options.map(name => [name, { count: 0, startable: 0 }]))
  for (const { lane } of items) {
    if (lane !== null && !counts.has(lane)) counts.set(lane, { count: 0, startable: 0 })
  }
  for (const { lane, isStartable } of items) {
    const found = counts.get(lane) ?? { count: 0, startable: 0 }
    found.count += 1
    if (isStartable) found.startable += 1
    counts.set(lane, found)
  }
  return [...counts].map(([name, { count, startable }]) => ({ name, count, startable }))
}
