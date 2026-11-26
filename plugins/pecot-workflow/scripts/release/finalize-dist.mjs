// MCP 単体配布ツリーの仕上げ (#352)。publish-mcp-dist.sh からのみ呼ばれる。
// cli/dist の @pecot/workflow-core の import は、vendor/workflow-core/dist への相対パスに書き換える。
// 配布用 package.json は cli と lib の依存宣言から生成し、.claude-plugin/plugin.json は実版で書く。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const [rawDistRoot, version, rawWorkflowRoot] = process.argv.slice(2)
if (!rawDistRoot || !version || !rawWorkflowRoot) {
  console.error('usage: finalize-dist.mjs <dist-root> <version> <pecot-workflow-plugin-root>')
  process.exit(1)
}
const DIST_ROOT = path.resolve(rawDistRoot)
const WORKFLOW_ROOT = path.resolve(rawWorkflowRoot)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// --- 1. @pecot/workflow-core の import の書き換え ---

const CLI_DIST_DIR = path.join(DIST_ROOT, 'cli/dist')
const LIBRARY_DIST_DIR = path.join(DIST_ROOT, 'vendor/workflow-core/dist')
const LIBRARY_SPECIFIER = '@pecot/workflow-core'
for (const [dir, hint] of [[CLI_DIST_DIR, 'cli の build 未実行の疑い'], [LIBRARY_DIST_DIR, 'libs/workflow-core の build 未実行の疑い']]) {
  if (!existsSync(dir)) throw new Error(`配布ツリーに ${dir} がありません（${hint}）`)
}

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const child = path.join(dir, entry)
    return statSync(child).isDirectory() ? walk(child) : [child]
  })

// cli は lib を subpath（@pecot/workflow-core/domain/x.js）で import するので、クォート込みの接頭辞を置き換える。
// 置換の後にクォートの直後の package 名が残れば、想定外の参照の形なので止める。コメントの中の名前は見ない。
let rewrittenFiles = 0
for (const file of walk(CLI_DIST_DIR)) {
  if (!/\.(?:js|mjs|d\.ts)$/.test(file)) continue
  const source = readFileSync(file, 'utf8')
  if (!["'", '"'].some((quote) => source.includes(`${quote}${LIBRARY_SPECIFIER}`))) continue
  let prefix = path.relative(path.dirname(file), LIBRARY_DIST_DIR).split(path.sep).join('/')
  if (!prefix.startsWith('.')) prefix = `./${prefix}`
  const rewritten = ["'", '"'].reduce(
    (acc, quote) => acc.replaceAll(`${quote}${LIBRARY_SPECIFIER}/`, `${quote}${prefix}/`),
    source
  )
  if (["'", '"'].some((quote) => rewritten.includes(`${quote}${LIBRARY_SPECIFIER}`))) {
    throw new Error(`${file} に書き換えられない ${LIBRARY_SPECIFIER} の参照が残っています`)
  }
  writeFileSync(file, rewritten)
  rewrittenFiles++
}

// --- 2. 配布用 package.json ---

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
const libraryManifest = readJson(path.join(WORKFLOW_ROOT, 'vendor/workflow-core/package.json'))

// lib の dist が bare import する外部パッケージ。cli と同じ名前は、版指定が同じでなければ止める。
const libraryDeps = libraryManifest.dependencies ?? {}
const cliDeps = pick(cliManifest.dependencies, RUNTIME_DEPS, 'cli/package.json dependencies')
for (const [name, range] of Object.entries(libraryDeps)) {
  if (name in cliDeps && cliDeps[name] !== range) {
    throw new Error(`${name} の版指定が cli/package.json (${cliDeps[name]}) と libs/workflow-core/package.json (${range}) で違います`)
  }
}

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
  dependencies: Object.fromEntries(Object.entries({ ...cliDeps, ...libraryDeps }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
writeFileSync(path.join(DIST_ROOT, 'package.json'), `${JSON.stringify(distManifest, null, 2)}\n`)

// --- 3. plugin.json ---

// readVersion() の解決先（cli/dist/version.js の 2 階層上 = 配布ルート）。版だけ差し替える。
const pluginManifest = readJson(path.join(WORKFLOW_ROOT, '.claude-plugin/plugin.json'))
pluginManifest.version = version
mkdirSync(path.join(DIST_ROOT, '.claude-plugin'), { recursive: true })
writeFileSync(
  path.join(DIST_ROOT, '.claude-plugin/plugin.json'),
  `${JSON.stringify(pluginManifest, null, 2)}\n`
)

console.log(`specifier 書き換え: ${rewrittenFiles} ファイル`)
console.log(`manifest 生成: @pecot/workflow-mcp@${version} / deps ${Object.keys(distManifest.dependencies).length} 件`)
