// MCP 単体配布ツリーの仕上げ (#352)。publish-mcp-dist.sh からのみ呼ばれる。
// 配布用 package.json を cli/package.json の依存宣言から生成し、.claude-plugin/plugin.json を実版で書く。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const [rawDistRoot, version, rawWorkflowRoot] = process.argv.slice(2)
if (!rawDistRoot || !version || !rawWorkflowRoot) {
  console.error('usage: finalize-dist.mjs <dist-root> <version> <pecot-workflow-plugin-root>')
  process.exit(1)
}
const DIST_ROOT = path.resolve(rawDistRoot)
const WORKFLOW_ROOT = path.resolve(rawWorkflowRoot)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// --- 1. 配布用 package.json ---

// cli/dist が bare import する外部パッケージ。版指定は必ず cli/package.json から読む。
const RUNTIME_DEPS = ['@modelcontextprotocol/server', 'commander', 'yaml', 'zod']

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

const cliManifest = readJson(path.join(WORKFLOW_ROOT, 'cli/package.json'))

// engines は node のみ残す。devEngines（pnpm の宣言）を写すと、npm が EBADDEVENGINES で止まり npx が起動しない。
const engineNode = cliManifest.engines?.node
if (typeof engineNode !== 'string') {
  throw new Error('cli/package.json に engines.node がありません')
}

// 配布物は npx が展開して bin を起動するだけで、build / test の script は持たない。
const distManifest = {
  name: '@pecot/workflow-mcp',
  version,
  type: 'module',
  description: 'pecot-workflow MCP server (standalone distribution)',
  license: 'MIT',
  // provenance の検証は、ワークフローのリポとの完全一致を求める。
  repository: {
    type: 'git',
    url: 'git+https://github.com/pecotcraft/pecot.git',
    directory: 'plugins/pecot-workflow'
  },
  bin: { 'pecot-workflow-mcp': 'bin/pecot-workflow-mcp.mjs' },
  engines: { node: engineNode },
  dependencies: pick(cliManifest.dependencies, RUNTIME_DEPS, 'cli/package.json dependencies')
}
writeFileSync(path.join(DIST_ROOT, 'package.json'), `${JSON.stringify(distManifest, null, 2)}\n`)

// --- 2. plugin.json ---

// readVersion() の解決先（cli/dist/version.js の 2 階層上 = 配布ルート）。版だけ差し替える。
const pluginManifest = readJson(path.join(WORKFLOW_ROOT, '.claude-plugin/plugin.json'))
pluginManifest.version = version
mkdirSync(path.join(DIST_ROOT, '.claude-plugin'), { recursive: true })
writeFileSync(
  path.join(DIST_ROOT, '.claude-plugin/plugin.json'),
  `${JSON.stringify(pluginManifest, null, 2)}\n`
)

console.log(`manifest 生成: @pecot/workflow-mcp@${version} / deps ${Object.keys(distManifest.dependencies).length} 件`)
