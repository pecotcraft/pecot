// pnpm の default catalog を読み、`catalog:` の依存を実際の範囲へ置き換える（単体配布の npm install は解決できない）。
// 直接起動: node catalog.mjs <package.json> <pnpm-workspace.yaml|->

import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'
import { isSelfExecuted } from './self-exec.mjs'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// pnpm は default catalog をトップレベル `catalog` か `catalogs.default` のどちらか一方で定義させる。両方あれば pnpm と同じく throw する。
export function readDefaultCatalog(yamlText) {
  const workspace = parse(yamlText)
  const top = isPlainObject(workspace) && isPlainObject(workspace.catalog) ? workspace.catalog : undefined
  const named = isPlainObject(workspace) && isPlainObject(workspace.catalogs) && isPlainObject(workspace.catalogs.default)
    ? workspace.catalogs.default
    : undefined
  if (top && named) {
    throw new Error(
      "The 'default' catalog was defined multiple times. Use the 'catalog' field or 'catalogs.default', but not both."
    )
  }
  return top ?? named ?? {}
}

// catalog: を参照しうる依存の欄。pnpm は 4 欄とも解決する。
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

// 名前付き catalog と、catalog に無い名前は配布物を壊すので throw する。
export function resolveCatalog(dependencies, catalog) {
  const resolved = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string' || !range.startsWith('catalog:')) {
      resolved[name] = range
      continue
    }
    const catalogName = range.slice('catalog:'.length)
    if (catalogName !== '' && catalogName !== 'default') {
      throw new Error(`${name} の ${range} は名前付き catalog です。default catalog（catalog:）だけを解決できます`)
    }
    const value = catalog[name]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${name} の catalog: に対応する版が pnpm-workspace.yaml の catalog にありません`)
    }
    resolved[name] = value
  }
  return resolved
}

// manifest の 4 欄を置き換えた写しを返す。置き換え後に catalog: が残れば throw する。
export function resolveManifest(manifest, catalog) {
  const resolved = { ...manifest }
  for (const field of DEPENDENCY_FIELDS) {
    if (!isPlainObject(manifest[field])) continue
    resolved[field] = resolveCatalog(manifest[field], catalog)
    for (const [name, range] of Object.entries(resolved[field])) {
      if (typeof range === 'string' && range.startsWith('catalog:')) {
        throw new Error(`${name} の ${field} に catalog: が残っています: ${range}`)
      }
    }
  }
  return resolved
}

if (isSelfExecuted(import.meta.url)) {
  const [manifestPath, workspaceYamlPath] = process.argv.slice(2)
  if (!manifestPath || !workspaceYamlPath) {
    console.error('usage: catalog.mjs <package.json> <pnpm-workspace.yaml|->')
    process.exit(1)
  }
  const catalog = readDefaultCatalog(readFileSync(workspaceYamlPath === '-' ? 0 : workspaceYamlPath, 'utf8'))
  const manifest = resolveManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), catalog)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
