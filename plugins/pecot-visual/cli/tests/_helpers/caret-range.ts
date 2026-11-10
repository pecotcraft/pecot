// caret range (`^x.y.z`) の最小判定。semver を依存へ足さず、2 つのテストが共有する。

const NUMBER = '(?:0|[1-9]\\d*)'
const EXACT_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`)
const CARET_RANGE = new RegExp(`^\\^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`)

export function parseVersionTriple(version: string): readonly number[] {
  return version.split('.').map(part => Math.trunc(Number(part)))
}

export function compareVersionTriple(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    // eslint-disable-next-line security/detect-object-injection -- index は 0..2 の loop counter
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
version が caret range を満たさない理由を返す。左端の非 0 の桁が互換の単位なので、0.x は minor、0.0.x は patch の一致も求める。
*/
export function caretRangeViolation(version: string, range: string): string | undefined {
  if (!CARET_RANGE.test(range)) return `宣言が caret range ではない: ${range}`
  if (!EXACT_VERSION.test(version)) return `版が完全一致指定ではない: ${version}`
  const lowerBound = parseVersionTriple(range.slice(1))
  const actual = parseVersionTriple(version)
  if (actual[0] !== lowerBound[0]) return `${version} が ${range} と major 不一致`
  if (lowerBound[0] === 0 && actual[1] !== lowerBound[1]) {
    return `${version} が ${range} と minor 不一致 (0.x の caret は minor が互換の単位)`
  }
  if (lowerBound[0] === 0 && lowerBound[1] === 0 && actual[2] !== lowerBound[2]) {
    return `${version} が ${range} と patch 不一致 (0.0.x の caret は patch が互換の単位)`
  }
  if (compareVersionTriple(actual, lowerBound) < 0) return `${version} が ${range} の下限未満`
  return undefined
}

/**
`inner`（`^x.y.z`）の範囲が `outer`（`^x.y.z`）の範囲の外に出る理由を返す。中なら undefined。
inner の下限が outer を満たせば、inner の範囲全体が outer の中に入る。
*/
export function caretRangeOutside(inner: string, outer: string): string | undefined {
  return CARET_RANGE.test(inner)
    ? caretRangeViolation(inner.slice(1), outer)
    : `宣言が caret range ではない: ${inner}`
}
