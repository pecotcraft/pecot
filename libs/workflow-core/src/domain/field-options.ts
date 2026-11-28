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

/**
既存の選択肢は id・name・color・description をそのまま写す（id を落とすと選択肢が作り直され、カードの値が消える）
*/
export function copyOption(option: FieldOptionInput): FieldOptionInput {
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
名前が大文字と小文字まで同じ選択肢。無ければ undefined
*/
export function findOptionByName<T extends Readonly<{ name: string }>>(options: readonly T[], name: string): T | undefined {
  return options.find(option => option.name === name)
}

/**
既存の選択肢を写し、名前（大文字と小文字を区別）の無い追加分だけを末尾に足す。added は足した名前
*/
export function appendOptions(
  existing: readonly FieldOptionInput[],
  additions: readonly Readonly<{ name: string, color: string, description: string }>[],
): Readonly<{ options: readonly FieldOptionInput[], added: readonly string[] }> {
  const options = existing.map(item => copyOption(item))
  const added: string[] = []
  for (const addition of additions) {
    if (findOptionByName(options, addition.name) !== undefined) continue
    options.push({ name: addition.name, color: addition.color, description: addition.description })
    added.push(addition.name)
  }
  return { options, added }
}
