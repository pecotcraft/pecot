// 起動する Node.js の版判定。既知の脆弱性の修正を含まない版では CLI と MCP サーバを起動しない。
// MCP サーバの stderr は利用者の目に入らないため、警告ではなく起動拒否にする。
// 層構成（domain ← infra ← mcp）のどこにも属さない起動前の確認なので src 直下に置く。
//
// このファイルは Node.js 24 の型除去（type stripping）でそのまま実行できる構文だけで書く。
// enum・namespace・パラメータプロパティを使わず、他モジュールを import しない。
// ランチャーと hook が node から直接読み込んで checkNodeRuntime を呼ぶため。
//
// 判定は cli.ts の main() で行う。静的 import の評価後に動くため、import の段階で落ちる
// 古い major（23 以前）では案内を出せないことがある。判定だけのエントリモジュールには分けない。

/**
系列（major）ごとの最低版。2026-10-21 の Node.js セキュリティリリース
（Brotli 展開の RCE CVE-2026-111497 ほか）の修正版。25 系はサポート終了で修正版が無い。
次のセキュリティリリースで上げるときは、現行の版を次のコマンドで列挙する。
`grep -rn '24.22.1' plugins .githooks`（node_modules・アイコン SVG のヒットは除く）。
ヒットした箇所を同じ変更で更新する。
表・engines・フックの期待値・両プラグインの複製の一致は node-runtime.test.ts が検証する。
*/
export const MINIMUM_NODE_VERSIONS: Readonly<Record<number, string>> = {
  24: '24.22.1',
  26: '26.12.1',
}

type VersionTuple = readonly [number, number, number]
interface ParsedVersion {
  readonly tuple: VersionTuple
  readonly prerelease: boolean
}

function parseVersion(version: string): ParsedVersion | undefined {
  const withoutBuild = (version.split('+', 1)[0] ?? '').replace(/^v/, '')
  const hyphen = withoutBuild.indexOf('-')
  const core = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen)
  const parts = core.split('.')
  if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) return undefined
  const [major, minor, patch] = parts.map(Number)
  return major === undefined || minor === undefined || patch === undefined ? undefined : { tuple: [major, minor, patch], prerelease: hyphen !== -1 }
}

// semver ではプレリリースは同じ major.minor.patch の release より前になる。
function isAtLeast(actual: ParsedVersion, minimum: VersionTuple): boolean {
  const [major, minor, patch] = actual.tuple
  const [minimumMajor, minimumMinor, minimumPatch] = minimum
  if (major !== minimumMajor) return major > minimumMajor
  if (minor !== minimumMinor) return minor > minimumMinor
  if (patch !== minimumPatch) return patch > minimumPatch
  return !actual.prerelease
}

function requiredVersionsText(): string {
  return Object.entries(MINIMUM_NODE_VERSIONS)
    .map(([major, minimum]) => `${major}.x: ${minimum} or later`)
    .join(', ')
}

/**
案内に載せる更新先の版。表の最小 major の最低版。
*/
export function suggestedNodeVersion(): string {
  const majors = Object.keys(MINIMUM_NODE_VERSIONS).map(Number)
  const lowest = MINIMUM_NODE_VERSIONS[Math.min(...majors)]
  return lowest ?? ''
}

function guidance(version: string): string {
  return [
    `Node.js ${version} does not include fixes for known vulnerabilities; not starting`,
    `  required: ${requiredVersionsText()}`,
    `  (fix: update Node.js and run again; with nvm: nvm install ${suggestedNodeVersion()})`,
  ].join('\n')
}

/**
起動してよい版なら undefined、止めるべき版なら利用者向けの案内文を返す。
表に無い major は、表の最大 major より新しければ修正後のリリースとみなして許可し、
それ以外（24 未満・サポート終了の 25 系）は止める。
*/
export function checkNodeRuntime(version: string): string | undefined {
  const actual = parseVersion(version)
  if (actual === undefined) return guidance(version)
  const minimum = MINIMUM_NODE_VERSIONS[actual.tuple[0]]
  if (minimum === undefined) {
    const newest = Math.max(...Object.keys(MINIMUM_NODE_VERSIONS).map(Number))
    return actual.tuple[0] > newest ? undefined : guidance(version)
  }
  const minimumVersion = parseVersion(minimum)
  if (minimumVersion === undefined) return guidance(version)
  return isAtLeast(actual, minimumVersion.tuple) ? undefined : guidance(version)
}
