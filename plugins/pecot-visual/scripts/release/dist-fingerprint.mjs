// pecotv MCP 単体配布ツリーの依存ツリー指紋を計算する (#1059)。
//
// 監査 (audit-mcp-dist.sh) と publish (publish-mcp-dist.sh) は、同じ配布 package.json から別プロセスで依存を解決する。
// 両者が同一の依存ツリーを見たことを、比較して確かめるための指紋。
// shrinkwrap ファイル全体の sha256 は使えない。
// ルートパッケージ自身の version が、監査時（bump 前）と publish 時（bump 後）で必ず異なる。
// そのため、依存が同一でも不一致になる。
//
// 指紋の対象は、`packages` からルート "" の `version` だけを除いた木。
// ルートの name / bin / engines / dependencies 宣言は、監査と publish で不変なので残す。
// 宣言だけがずれた場合も、検出できる。
// キーは再帰的にソートし、配列は順序を保つ。npm の shrinkwrap では、配列の順序が意味を持つためだ。
//
//   import: distFingerprint(shrinkwrap) -> 64 桁 hex
//
//   直接起動: node dist-fingerprint.mjs <shrinkwrap-path> -> 指紋を stdout に 1 行

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isSelfExecuted } from './self-exec.mjs'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function distFingerprint(shrinkwrap) {
  const packages = isPlainObject(shrinkwrap) ? shrinkwrap.packages : undefined
  if (!isPlainObject(packages)) {
    throw new Error('shrinkwrap に packages がありません（lockfileVersion 3 の shrinkwrap ではない疑い）')
  }
  const root = packages['']
  if (!isPlainObject(root)) {
    throw new Error('shrinkwrap の packages にルート "" がありません（依存解決に失敗した shrinkwrap の疑い）')
  }
  const { version: _version, ...rootRest } = root
  const target = { ...packages, '': rootRest }
  return createHash('sha256').update(JSON.stringify(canonicalize(target))).digest('hex')
}

if (isSelfExecuted(import.meta.url)) {
  const [shrinkwrapPath] = process.argv.slice(2)
  if (!shrinkwrapPath) {
    console.error('usage: dist-fingerprint.mjs <shrinkwrap-path>')
    process.exit(1)
  }
  process.stdout.write(distFingerprint(JSON.parse(readFileSync(shrinkwrapPath, 'utf8'))) + '\n')
}
