// npm の version range が「あるメジャー版で満たされ得るか」だけを判定する最小実装。
//
// infra/slidev-project/eslint-runner.ts が使う。
// 見るのは、テンプレートが宣言した eslint の range と、実際に解決した eslint のメジャーが一致するかどうか。
// 判定に要るのはメジャーの一致だけなので semver パッケージは足さない。
// 単体配布形態の起動層は npx が毎起動 install し直すため、依存を 1 つ増やすと起動時間に直接働く。
//
// 対応表記は次のとおり。
// `*` / `x` / 空文字、`||` による OR、`A - B` のハイフン範囲、
// 比較子 `^ ~ >= <= > < =`、比較子なしの `9` / `9.x` / `9.17.0`。
// 解釈できない表記（プレリリース・ビルドメタデータ付きを含む）は「満たされ得ない」に倒す。
// 呼び出し元が fail-closed で使うため。

/**
メジャー版の位置に来る `x` / `X` / `*`（= メジャー無指定）。
*/
const WILDCARD_PARTS: ReadonlySet<string> = new Set(['x', 'X', '*'])

/**
比較子の先頭に付く演算子。`>=` を `>` より先に並べて長い方から食わせる。
*/
const OPERATOR_PATTERN = /^(?:>=|<=|[\^~><=])/u

/**
数字だけで構成された版パート。
*/
const NUMERIC_PART_PATTERN = /^\d+$/u

/**
ハイフン範囲 `A - B`。両端はいずれも 1 トークン。
*/
const HYPHEN_RANGE_PATTERN = /^(?<low>\S+) - (?<high>\S+)$/u

/**
`range` を満たす版のうち、メジャーが `major` のものが存在し得るか。

「存在し得るか」であって、「特定の版が満たすか」ではない。
呼び出し元が見たいのは、宣言された range が意図しているメジャーと、解決した実体のメジャーが同じかどうかだ。
マイナー・パッチの一致までは要求しない。
テンプレートは `^9.17.0` のようなキャレット宣言で、実体は範囲内の任意の版になる。
*/
export function doesRangeAllowMajor(range: string, major: number): boolean {
  return range
    .split('||')
    .some(clause => doesClauseAllowMajor(clause.trim(), major))
}

/**
OR で分けた 1 節。空白区切りの比較子は AND。
*/
function doesClauseAllowMajor(clause: string, major: number): boolean {
  if (clause === '' || WILDCARD_PARTS.has(clause)) return true

  const hyphen = HYPHEN_RANGE_PATTERN.exec(clause)
  const comparators = hyphen === null
    ? clause.split(/\s+/u)
    : [`>=${hyphen.groups?.['low'] ?? ''}`, `<=${hyphen.groups?.['high'] ?? ''}`]

  return comparators.every(comparator => doesComparatorAllowMajor(comparator, major))
}

function doesComparatorAllowMajor(comparator: string, major: number): boolean {
  if (comparator === '' || WILDCARD_PARTS.has(comparator)) return true

  const operator = OPERATOR_PATTERN.exec(comparator)?.[0] ?? ''
  const parts = comparator.slice(operator.length).replace(/^v/u, '').split('.')
  const rawMajor = parts[0] ?? ''
  if (WILDCARD_PARTS.has(rawMajor)) return true
  // 解釈できない表記（`workspace:*`・URL 依存・プレリリース付き `10.0.0-rc.1` など）は
  // 満たされ得ないものとして扱う。マイナー・パッチまで見るのは、上限表記の判定
  // （下の `<`）がそこを材料にするためで、読めない部分があるまま通すと fail-open になる。
  if (parts.some(part => !isInterpretablePart(part))) return false
  const bound = Math.trunc(Number(rawMajor))

  if (operator === '>=') return major >= bound
  // `>9` は semver では `>=10.0.0` でメジャー 9 を 1 つも含まない。一方 `>9.0` /
  // `>9.9.9` は同じメジャーの上位版が残るため、メジャー 9 を含む。
  if (operator === '>') return hasMinorPart(parts) ? major >= bound : major > bound
  if (operator === '<=') return major <= bound
  if (operator === '<') {
    // 上限がちょうど `X` / `X.0` / `X.0.0` なら、メジャー X の版は 1 つも含まれない。
    return major === bound ? !(isZeroOrAbsent(parts[1]) && isZeroOrAbsent(parts[2])) : major < bound
  }
  // `^` / `~` / `=` / 比較子なしは、いずれもメジャーを 1 つに固定する。
  return major === bound
}

/**
数字のみ、またはワイルドカード（`x` / `X` / `*`）のパートか。
*/
function isInterpretablePart(part: string): boolean {
  return NUMERIC_PART_PATTERN.test(part) || WILDCARD_PARTS.has(part)
}

/**
マイナーが数字で指定されているか（`9.x` はメジャーのみの指定と同じ扱い）。
*/
function hasMinorPart(parts: readonly string[]): boolean {
  const minor = parts[1]
  return minor !== undefined && NUMERIC_PART_PATTERN.test(minor)
}

function isZeroOrAbsent(part: string | undefined): boolean {
  return part === undefined || part === '0'
}
