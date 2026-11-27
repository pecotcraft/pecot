// 起動する Node.js の版判定。既知の脆弱性の修正を含まない版では MCP サーバを起動しない（判定は main.ts）。
// hook が node の型除去で直接読むので、enum・namespace・パラメータプロパティ・import を使わない。

/**
系列（major）ごとの最低版で、2026-10-21 の Node.js セキュリティリリース（CVE-2026-111497 ほか）の修正版。25 系は修正版が無い。
上げ方は `.claude/rules/devcontainer.md` の「Node.js」。2 つの複製の一致は pecot-visual の node-runtime.test.ts が検証する。
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
    `required: ${requiredVersionsText()}`,
    `(fix: update Node.js and run again; with nvm: nvm install ${suggestedNodeVersion()})`,
  ].join('\n')
}

/**
起動してよい版なら undefined、止めるべき版なら字下げ無しの複数行の案内文を返す。
main.ts は診断行の共通の関数に渡し、続きの行の字下げはそちらが付ける。
表に無い major は、表の最大 major より新しければ修正後のリリースとみなして許可し、
それ以外（24 未満・サポート終了の 25 系）は止める。
*/
export function nodeRuntimeGuidance(version: string): string | undefined {
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

/**
hook がそのまま書く形。続きの行の先頭に空白 2 つを付けた案内文を返す。
*/
export function checkNodeRuntime(version: string): string | undefined {
  return nodeRuntimeGuidance(version)?.split('\n').join('\n  ')
}
