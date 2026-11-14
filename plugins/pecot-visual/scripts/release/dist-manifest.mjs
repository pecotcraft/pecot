// pecotv MCP 単体配布ツリーの package.json を組み立てる (#982 / #1050)。
//
// finalize-dist.mjs（publish の仕上げ）と audit-mcp-dist.sh（リリース前の依存監査）の
// 双方から使う。監査が必要とするのは配布 package.json の依存集合だけで、ビルド成果物には
// 依存しない。そのため manifest の生成をここへ切り出し、組み立てを 1 か所に保つ。
//
//   import: buildDistManifest(pecotvRoot, version, repoRoot) はオブジェクトを返す。
//   直接起動: node dist-manifest.mjs <pecotv-plugin-root> <version> <repo-root> は JSON を stdout へ出す。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isSelfExecuted } from './self-exec.mjs'

// 配布 package.json の dependencies。npx は毎起動で node_modules を作り直す。
// ここに載せてよいのは起動層だけとする。
// slidev / dom-to-pptx 等の重量物は、runtime_setup ツールが置き場の mcp-dist/ へ入れる永続層の担当になる。
// 版指定は必ず既存 manifest から読む。配布物だけが古い版に取り残されるのを防ぐ。
const RUNTIME_DEPS = [
  '@modelcontextprotocol/server',
  '@xmldom/xmldom',
  'commander',
  'mime-types',
  'playwright',
  'xpath',
  'yaml',
  'yauzl',
  'yazl',
  'zod'
]
const LINT_DEPS = ['eslint', '@eslint/markdown']
// 同梱する eslint プラグイン dist が bare import する外部パッケージ。宣言を漏らすと
// npm の hoisting 次第で解決できたりできなかったりする（配布物では必ず宣言する）。
// textlint 一式は、同梱する text-rules の依存として libs/text-rules/package.json から載せる。
// synckit は text-constraints が bare import するので、ここで宣言する。
const ESLINT_PLUGIN_DEPS = [
  { manifest: 'scripts/eslint/_shared/package.json', names: ['js-yaml'] },
  { manifest: 'scripts/eslint/text-constraints/package.json', names: ['synckit'] },
  { manifest: 'scripts/eslint/validate-references/package.json', names: ['ajv'] }
]

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

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

const parseVersion = (text) => text.replace(/^[^0-9]*/, '').split('.').slice(0, 3).map(Number)

// 固定値 pin（例: '2.9.1'）が caret 範囲（例: '^2.9.1'）を満たすかを判定する。
// どちらも caret でない、または caret 以外の書式を含む組は満たさない扱いにして止める。
const pinSatisfiesCaret = (pin, caret) => {
  if (!/^\d+\.\d+\.\d+$/.test(pin) || !/^\^\d+\.\d+\.\d+$/.test(caret)) return false
  const have = parseVersion(pin)
  const want = parseVersion(caret)
  const pivot = want.findIndex((n) => n !== 0)
  const fixed = pivot === -1 ? 2 : pivot
  for (let i = 0; i <= fixed; i += 1) if (have[i] !== want[i]) return false
  for (let i = fixed + 1; i < 3; i += 1) {
    if (have[i] > want[i]) return true
    if (have[i] < want[i]) return false
  }
  return true
}

// 複数の出所の依存を 1 つにまとめる。同名で範囲が異なるときは、一方が固定値で
// もう一方の範囲を満たす場合に限り、固定値を採る。それ以外は片方を捨てずに止める。
const mergeDependencies = (groups) => {
  const merged = {}
  const origins = {}
  for (const { origin, dependencies } of groups) {
    for (const [name, range] of Object.entries(dependencies)) {
      const prev = merged[name]
      if (prev === undefined || prev === range) {
        merged[name] = range
        origins[name] = origin
        continue
      }
      if (pinSatisfiesCaret(range, prev)) {
        merged[name] = range
      } else if (!pinSatisfiesCaret(prev, range)) {
        throw new Error(
          `${name} の範囲が衝突しています（${origins[name]}: ${prev} / ${origin}: ${range}）。` +
            '固定値が他方の範囲を満たす組でなければ配布できません'
        )
      }
      origins[name] = origin
    }
  }
  return merged
}

export function buildDistManifest(rawPecotvRoot, version, rawRepoRoot) {
  const PECOTV_ROOT = path.resolve(rawPecotvRoot)
  const REPO_ROOT = path.resolve(rawRepoRoot)
  const SLIDEV_SOURCE = path.join(PECOTV_ROOT, 'assets/slidev')
  const cliManifest = readJson(path.join(PECOTV_ROOT, 'cli/package.json'))
  // lint の依存（eslint と @eslint/markdown）の宣言元。deck-lint の設定と同じ assets/slidev に置く。
  const slidevManifest = readJson(path.join(SLIDEV_SOURCE, 'package.json'))
  const textRulesManifest = readJson(path.join(REPO_ROOT, 'libs/text-rules/package.json'))
  const textRulesDependencies = textRulesManifest.dependencies
  if (!textRulesDependencies || Object.keys(textRulesDependencies).length === 0) {
    throw new Error('libs/text-rules/package.json に dependencies がありません（text-rules の依存が配布から欠けます）')
  }

  // engines は node のみ残す。devEngines は写さない。
  // pecotv の manifest は devEngines.packageManager に pnpm を宣言している（パッケージマネージャガード #806 / #52）。
  // これを配布物へ写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
  const engineNode = cliManifest.engines?.node
  if (typeof engineNode !== 'string') {
    throw new Error('cli/package.json に engines.node がありません')
  }

  return {
    name: '@pecot/visual-mcp',
    version,
    type: 'module',
    description: 'pecotv MCP server (standalone distribution)',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/pecotcraft/pecot.git', directory: 'plugins/pecot-visual' },
    bin: { 'pecot-visual-mcp': 'bin/pecot-visual-mcp.mjs' },
    engines: { node: engineNode },
    dependencies: mergeDependencies([
      { origin: 'cli/package.json', dependencies: pick(cliManifest.dependencies, RUNTIME_DEPS, 'cli/package.json dependencies') },
      {
        origin: 'assets/slidev/package.json',
        dependencies: pick(slidevManifest.devDependencies, LINT_DEPS, 'assets/slidev/package.json devDependencies')
      },
      ...ESLINT_PLUGIN_DEPS.map(({ manifest, names }) => ({
        origin: manifest,
        dependencies: pick(readJson(path.join(SLIDEV_SOURCE, manifest)).dependencies, names, manifest)
      })),
      // 同梱する @pecot/text-rules の dependencies。名前は列挙せず libs/text-rules の manifest から導く。
      // text-rules が依存を持たない状態は、配布から依存が丸ごと欠ける異常として止める。
      { origin: 'libs/text-rules/package.json dependencies', dependencies: textRulesDependencies }
    ])
  }
}

if (isSelfExecuted(import.meta.url)) {
  const [rawPecotvRoot, version, rawRepoRoot] = process.argv.slice(2)
  if (!rawPecotvRoot || !version || !rawRepoRoot) {
    console.error('usage: dist-manifest.mjs <pecotv-plugin-root> <version> <repo-root>')
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(buildDistManifest(rawPecotvRoot, version, rawRepoRoot), null, 2)}\n`)
}
