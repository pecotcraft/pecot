// pecot-tools MCP 単体配布ツリーの仕上げ (#1056)。publish-mcp-dist.sh からのみ呼ばれる。
//
// 1. 配布用 package.json を、cli/package.json の依存宣言から生成する。
// 2. .claude-plugin/plugin.json を実バージョンで書き出す。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const [rawDistRoot, version, rawToolsRoot] = process.argv.slice(2)
if (!rawDistRoot || !version || !rawToolsRoot) {
  console.error('usage: finalize-dist.mjs <dist-root> <version> <pecot-tools-plugin-root>')
  process.exit(1)
}
const DIST_ROOT = path.resolve(rawDistRoot)
const TOOLS_ROOT = path.resolve(rawToolsRoot)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// --- 1. 配布用 package.json ---

// cli/dist が bare import する外部パッケージ。バージョン指定は必ず cli/package.json から読む
// （配布物だけが古いバージョンに取り残されるのを防ぐ）。
const RUNTIME_DEPS = ['@modelcontextprotocol/server', 'commander', 'zod']

const pick = (source, names, origin) =>
  Object.fromEntries(
    names.map((name) => {
      const range = source?.[name]
      if (typeof range !== 'string') {
        throw new Error(`${origin} に ${name} の版指定がありません（依存の改名・削除の疑い）`)
      }
      return [name, range]
    })
  )

const cliManifest = readJson(path.join(TOOLS_ROOT, 'cli/package.json'))

// engines は node のみ残す。cli の manifest は npm / yarn を "<0.0.0" で塞いでいる（パッケージマネージャガード）。
// これを配布物へ写すと、engine-strict 環境で npx 自身が EBADENGINE になり起動しない。
const engineNode = cliManifest.engines?.node
if (typeof engineNode !== 'string') {
  throw new Error('cli/package.json に engines.node がありません')
}

// 配布物は npx が展開して bin を起動するだけで、build / test の script は持たない。
const distManifest = {
  name: '@pecot/tools-mcp',
  version,
  type: 'module',
  description: 'pecot-tools MCP server (standalone distribution)',
  license: 'MIT',
  // provenance の検証は、ワークフローのリポとの完全一致を求める。
  repository: {
    type: 'git',
    url: 'git+https://github.com/pecotcraft/pecot.git',
    directory: 'plugins/pecot-tools'
  },
  bin: { 'pecot-tools-mcp': 'bin/pecot-tools-mcp.mjs' },
  engines: { node: engineNode },
  dependencies: pick(cliManifest.dependencies, RUNTIME_DEPS, 'cli/package.json dependencies')
}
writeFileSync(path.join(DIST_ROOT, 'package.json'), `${JSON.stringify(distManifest, null, 2)}\n`)

// --- 2. plugin.json ---

// plugin.json は readVersion() の解決先（cli/dist/version.js から 2 階層上 = 配布ルート）。
// 版だけ差し替えて配布する。
const pluginManifest = readJson(path.join(TOOLS_ROOT, '.claude-plugin/plugin.json'))
pluginManifest.version = version
mkdirSync(path.join(DIST_ROOT, '.claude-plugin'), { recursive: true })
writeFileSync(
  path.join(DIST_ROOT, '.claude-plugin/plugin.json'),
  `${JSON.stringify(pluginManifest, null, 2)}\n`
)

console.log(`manifest 生成: @pecot/tools-mcp@${version} / deps ${Object.keys(distManifest.dependencies).length} 件`)
