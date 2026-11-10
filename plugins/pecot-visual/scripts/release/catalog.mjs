// pnpm の default catalog を読み、`catalog:` の依存を実際の範囲へ置き換える。
// 単体配布の npm install は catalog: を解決できないために要る。
//
//   import: resolveCatalog(dependencies, catalog) / readDefaultCatalog(yamlText)
//
//   直接起動: node catalog.mjs <package.json> <pnpm-workspace.yaml|->
//   package.json の catalog: をその場で置き換える。

import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'
import { isSelfExecuted } from './self-exec.mjs'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// トップレベル `catalog` と `catalogs.default` は pnpm では同じ default catalog。両方あれば両方を併せる。
export function readDefaultCatalog(yamlText) {
  const workspace = parse(yamlText)
  const top = isPlainObject(workspace) && isPlainObject(workspace.catalog) ? workspace.catalog : {}
  const named = isPlainObject(workspace) && isPlainObject(workspace.catalogs) && isPlainObject(workspace.catalogs.default)
    ? workspace.catalogs.default
    : {}
  return { ...named, ...top }
}

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

if (isSelfExecuted(import.meta.url)) {
  const [manifestPath, workspaceYamlPath] = process.argv.slice(2)
  if (!manifestPath || !workspaceYamlPath) {
    console.error('usage: catalog.mjs <package.json> <pnpm-workspace.yaml|->')
    process.exit(1)
  }
  const catalog = readDefaultCatalog(readFileSync(workspaceYamlPath === '-' ? 0 : workspaceYamlPath, 'utf8'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const field of ['dependencies', 'devDependencies']) {
    if (isPlainObject(manifest[field])) manifest[field] = resolveCatalog(manifest[field], catalog)
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
