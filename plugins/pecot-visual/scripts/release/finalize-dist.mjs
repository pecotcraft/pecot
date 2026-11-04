// pecotv MCP 単体配布ツリーの仕上げ (#982)。publish-mcp-dist.sh からのみ呼ばれる。
//
// 1. eslint プラグイン dist の specifier を、配布ツリー内の相対パスへ書き換える。
//    deck-lint.config.js はプラグイン dist を相対パスで import するので、書き換えない。dist の存在だけ確かめる。
//    text-constraints dist が import する @pecot/text-rules も、vendor/text-rules の実体へ向ける。
//    cli/dist が動的 import する @pecot/text-rules も同じ実体へ向ける。
// 2. 配布用 package.json と .claude-plugin/plugin.json を実版で生成する。
//
// 同梱した eslint プラグインを `file:` 依存で解決させると、npx の warm 起動が必ず失敗する。
// 失敗は `npm error Cannot destructure property 'package' of 'node.target' as it is null` で、
// 手元で再現を確認した。
// そこで配布物は npm の依存解決に任せず、ツリー内の実体を相対 import で直接指す。

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

import { buildDistManifest } from './dist-manifest.mjs'

const [rawDistRoot, version, rawPecotvRoot, rawRepoRoot] = process.argv.slice(2)
if (!rawDistRoot || !version || !rawPecotvRoot || !rawRepoRoot) {
  console.error('usage: finalize-dist.mjs <dist-root> <version> <pecotv-plugin-root> <repo-root>')
  process.exit(1)
}
const DIST_ROOT = path.resolve(rawDistRoot)
const PECOTV_ROOT = path.resolve(rawPecotvRoot)
const REPO_ROOT = path.resolve(rawRepoRoot)

const SLIDEV_DIR = path.join(DIST_ROOT, 'assets/slidev')
const ESLINT_DIR = path.join(SLIDEV_DIR, 'scripts/eslint')
const SHARED_SPECIFIER = '@v-slidev/eslint-shared'
const SHARED_ENTRY = path.join(ESLINT_DIR, '_shared/dist/index.js')
const TEXT_RULES_SPECIFIER = '@pecot/text-rules'
const TEXT_RULES_ENTRY = path.join(DIST_ROOT, 'vendor/text-rules/dist/index.js')

// deck-lint.config.js が相対パスで import するプラグイン dist（assets/slidev 相対）。
const PLUGIN_ENTRIES = [
  'scripts/eslint/slidev-pages-lint/dist/index.js',
  'scripts/eslint/text-constraints/dist/index.js'
]

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const child = path.join(dir, entry)
    return statSync(child).isDirectory() ? walk(child) : [child]
  })

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const requireFile = (file, hint) => {
  if (!existsSync(file)) {
    throw new Error(`配布ツリーに ${file} がありません（${hint}）`)
  }
}

// --- 1. specifier 書き換え ---

requireFile(SHARED_ENTRY, 'eslint プラグインの build 未実行、または .gitignore の dist/ で除外された疑い')
requireFile(TEXT_RULES_ENTRY, 'libs/text-rules の build 未実行の疑い')

// 置換はクォート込みで行う。
// 裸の文字列置換だと `@v-slidev/eslint-shared/rules` のような subpath import の前半だけが差し替わる。
// その結果、存在しない path を指す import が生成される。
const replaceSpecifier = (source, specifier, replacement) =>
  ["'", '"'].reduce(
    (acc, quote) => acc.replaceAll(`${quote}${specifier}${quote}`, `${quote}${replacement}${quote}`),
    source
  )

// 置換後に specifier が残っていれば、上記の subpath import など想定外の参照形になる。
// 誤ったパスを配布するより、ここで止める。
const assertNoResidual = (source, specifier, origin) => {
  if (source.includes(specifier)) {
    throw new Error(`${origin} に書き換えられない ${specifier} の参照が残っています（subpath import の疑い）`)
  }
}

// eslint プラグイン dist 内の specifier を、そのファイルから実体への相対パスへ書き換える。
let rewrittenFiles = 0
const rewriteImports = (file, source, specifier, entry) => {
  let rel = path.relative(path.dirname(file), entry)
  if (!rel.startsWith('.')) rel = `./${rel}`
  const rewritten = replaceSpecifier(source, specifier, rel)
  assertNoResidual(rewritten, specifier, file)
  return rewritten
}

// cli/dist は配布ツリーの cli/dist に置かれ、text-rules の実体は vendor/text-rules にある。
const CLI_DIST_DIR = path.join(DIST_ROOT, 'cli/dist')
requireFile(CLI_DIST_DIR, 'cli の build 未実行の疑い')

// cli/dist が import するのは text-rules だけなので、cli/dist には text-rules の置換だけを掛ける。
const rewriteTree = (dir, specifiers) => {
  for (const file of walk(dir)) {
    if (!/\.(?:js|mjs)$/.test(file)) continue
    let source = readFileSync(file, 'utf8')
    const original = source
    for (const [specifier, entry] of specifiers) {
      if (source.includes(specifier)) source = rewriteImports(file, source, specifier, entry)
    }
    if (source === original) continue
    writeFileSync(file, source)
    rewrittenFiles++
  }
}
rewriteTree(ESLINT_DIR, [
  [SHARED_SPECIFIER, SHARED_ENTRY],
  [TEXT_RULES_SPECIFIER, TEXT_RULES_ENTRY],
])
rewriteTree(CLI_DIST_DIR, [[TEXT_RULES_SPECIFIER, TEXT_RULES_ENTRY]])

// deck-lint.config.js は書き換えない。dist が欠けた配布物を出さないため、存在だけ確かめる。
requireFile(path.join(SLIDEV_DIR, 'deck-lint.config.js'), 'publish-mcp-dist.sh の git archive 対象から外れた疑い')
// cli と hook が --config で渡す側。環境変数 PECOTV_DECK_LINT を読んで deck-lint.config.js へ渡す。
requireFile(path.join(SLIDEV_DIR, 'deck-lint.env.config.js'), 'publish-mcp-dist.sh の git archive 対象から外れた疑い')
for (const rel of PLUGIN_ENTRIES) {
  requireFile(path.join(SLIDEV_DIR, rel), 'eslint プラグインの build 未実行の疑い')
}

// --- 2. manifest 生成 ---

// 依存集合の組み立ては dist-manifest.mjs だけが持つ。
// リリース前の依存監査も、同じ関数で配布 package.json を再現する。
const distManifest = buildDistManifest(PECOTV_ROOT, version, REPO_ROOT)
writeFileSync(path.join(DIST_ROOT, 'package.json'), `${JSON.stringify(distManifest, null, 2)}\n`)

// plugin.json は readVersion() の解決先（CLAUDE_PLUGIN_ROOT 経由）。版だけ差し替えて配布する。
const pluginManifest = readJson(path.join(PECOTV_ROOT, '.claude-plugin/plugin.json'))
pluginManifest.version = version
mkdirSync(path.join(DIST_ROOT, '.claude-plugin'), { recursive: true })
writeFileSync(
  path.join(DIST_ROOT, '.claude-plugin/plugin.json'),
  `${JSON.stringify(pluginManifest, null, 2)}\n`
)

console.log(`specifier 書き換え: ${rewrittenFiles} ファイル`)
console.log(`manifest 生成: @pecot/visual-mcp@${version} / deps ${Object.keys(distManifest.dependencies).length} 件`)
