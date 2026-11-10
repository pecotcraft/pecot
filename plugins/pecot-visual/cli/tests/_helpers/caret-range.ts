// caret range (`^x.y.z`) の最小判定。semver を依存へ足さず、2 つのテストが共有する。

/**
`1.2.3` を [1, 2, 3] にする。
*/
export function parseVersionTriple(version: string): readonly number[] {
  return version.split('.').map(part => Math.trunc(Number(part)))
}

/**
semver triple の辞書順比較。a > b で正、a < b で負。
*/
export function compareVersionTriple(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    // eslint-disable-next-line security/detect-object-injection -- index は 0..2 の loop counter
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
caret range (`^x.y.z`) を version が満たさない理由を返す。満たすなら undefined。

caret の互換の単位は左端の非 0 の桁。major・minor がともに 0 なら patch、major が 0 なら minor の一致も求める。
*/
export function caretRangeViolation(version: string, range: string): string | undefined {
  if (!/^\^\d+\.\d+\.\d+$/.test(range)) return `宣言が caret range ではない: ${range}`
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `版が完全一致指定ではない: ${version}`
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
  return /^\^\d+\.\d+\.\d+$/.test(inner)
    ? caretRangeViolation(inner.slice(1), outer)
    : `宣言が caret range ではない: ${inner}`
}
