// SingleSelect フィールドの選択肢を差し込む純粋な関数。I/O を持たない。

/**
更新の入力に渡す選択肢。既存の選択肢は id を持ち、新しい選択肢は id を持たない
*/
export type FieldOptionInput = Readonly<{ id?: string, name: string, color: string, description: string }>

export type OptionPlacement = Readonly<{ after: string } | { before: string } | { end: true }>

function indexOfName(options: readonly Readonly<{ name: string }>[], name: string): number {
  const lowered = name.toLowerCase()
  return options.findIndex(option => option.name.toLowerCase() === lowered)
}

// 既存の選択肢は id・name・color・description をそのまま写す（id を落とすと選択肢が作り直され、カードの値が消える）
function copyOption(option: FieldOptionInput): FieldOptionInput {
  return option.id === undefined ? { name: option.name, color: option.color, description: option.description } : { id: option.id, name: option.name, color: option.color, description: option.description }
}

/**
差し込み先の候補のうち、基準の名前が既存にある最初のものを選ぶ。どれも無ければ末尾
*/
export function choosePlacement(existing: readonly Readonly<{ name: string }>[], candidates: readonly OptionPlacement[]): OptionPlacement {
  const anchored = candidates.find((candidate) => {
    if ('after' in candidate) return indexOfName(existing, candidate.after) !== -1
    if ('before' in candidate) return indexOfName(existing, candidate.before) !== -1
    return true
  })
  return anchored ?? { end: true }
}

/**
既存の選択肢の並びに、新しい選択肢を 1 つ差し込む。同じ名前（大文字と小文字は区別しない）が既にあれば undefined
*/
export function insertOption(
  existing: readonly FieldOptionInput[],
  option: Readonly<{ name: string, color: string, description: string }>,
  placement: OptionPlacement,
): readonly FieldOptionInput[] | undefined {
  if (indexOfName(existing, option.name) !== -1) return undefined
  const copied = existing.map(item => copyOption(item))
  const created: FieldOptionInput = { name: option.name, color: option.color, description: option.description }
  let position = copied.length
  if ('after' in placement) {
    const found = indexOfName(existing, placement.after)
    if (found !== -1) position = found + 1
  }
  else if ('before' in placement) {
    const found = indexOfName(existing, placement.before)
    if (found !== -1) position = found
  }
  return [...copied.slice(0, position), created, ...copied.slice(position)]
}
