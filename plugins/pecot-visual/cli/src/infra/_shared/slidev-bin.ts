// `@slidev/cli` の bin (`bin/slidev.mjs`) の解決。
//
// slidev を子プロセスとして起動する箇所は 2 つある。
// pptx 変換の `slidev build` は infra/slidev-to-pptx/runner.ts、
// プレビューの dev サーバは mcp/dev-server-registry.ts。
// どちらも同じ実体を引く必要があるため、解決はここに 1 本だけ置く。
//
// `npx` は使わない。レジストリ取得へフォールバックし得るうえ、3 段のプロセスツリーになり、
// SIGTERM で孫が残る (dev サーバでは孤児がポートを掴んだままになる)。

import { createRequire } from 'node:module'
import path from 'node:path'

import { DEPENDENCY_RECOVERY_HINT, resolveDependency } from './dependency-root.js'

const requireFromHere = createRequire(import.meta.url)

/**
`@slidev/cli` の bin (`bin/slidev.mjs`) の絶対パスを解決する。
`package.json#exports` を経由しない。
そのため `@slidev/cli/package.json` を解決して package root を取得し、`bin.slidev` フィールドを参照する。

解決できないときは throw する。畳み方は呼び出し元で違う。
pptx 変換 (slidev-to-pptx/runner.ts) は、commands/slidev-to-pptx が RuntimeError として扱う。
MCP 側では `setup` 誘導つきの ToolResult になる。
dev サーバ (mcp/dev-server-registry.ts) は、起動試行の try/catch が `dev-server-spawn-failed` として畳む。
*/
/* c8 ignore start -- production の `@slidev/cli` を resolve する箇所。test は port で差し替える */
export function resolveSlidevBin(): string {
  const packageJsonPath = resolveDependency('@slidev/cli/package.json', import.meta.url)
  if (packageJsonPath === undefined) {
    throw new Error(`cannot resolve @slidev/cli; ${DEPENDENCY_RECOVERY_HINT}`)
  }
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻り値の narrowing
  const packageJson = requireFromHere(packageJsonPath) as Readonly<{ bin?: Readonly<Record<string, string>> | string }>
  const binEntry = packageJson.bin
  const relativeBin
    = typeof binEntry === 'string'
      ? binEntry
      : binEntry?.['slidev'] ?? 'bin/slidev.mjs'
  return path.resolve(path.dirname(packageJsonPath), relativeBin)
}
/* c8 ignore stop */
