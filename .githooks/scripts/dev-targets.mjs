// 開発版を出すプラグインを、標準入力の変わったファイル（1 行 1 つ）から決め、[{plugin, name}] の JSON を書く。
// --all は 3 つ全部、--patterns は publish-npm.yml の push.paths と同じパターンの一覧を書く。
import { readFileSync } from 'node:fs'

const PLUGINS = ['pecot-visual', 'pecot-tools', 'pecot-workflow']

// 変わると 3 つ全部の配布物が変わるパス。
const SHARED = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'LICENSE',
  '.githooks/lib/mcp-publish-common.sh',
  '.githooks/scripts/attach-mcp-tgz.sh',
  '.githooks/scripts/origin-slug.mjs',
  '.githooks/scripts/dev-version.mjs',
  '.githooks/scripts/dev-superseded.mjs',
  '.githooks/scripts/dev-targets.mjs',
  '.devcontainer/**',
  '.github/workflows/publish-npm.yml',
]

// プラグインごとのパス。text-rules は pecot-visual の、workflow-core は pecot-workflow の配布物に同梱する。
const OWN = {
  'pecot-visual': ['plugins/pecot-visual/**', 'libs/text-rules/**'],
  'pecot-tools': ['plugins/pecot-tools/**'],
  'pecot-workflow': ['plugins/pecot-workflow/**', 'libs/workflow-core/**'],
}

const matches = (pattern, file) =>
  pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern

const entry = (plugin) => ({ plugin, name: plugin.replace(/^pecot-/, '') })
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && !['--all', '--patterns'].includes(args[0]))) {
  console.error(`ERROR: usage: dev-targets.mjs [--all|--patterns] < files: ${args.join(' ')}`)
  process.exit(1)
}

if (args[0] === '--patterns') {
  print([...SHARED, ...PLUGINS.flatMap((p) => OWN[p])])
} else if (args[0] === '--all') {
  print(PLUGINS.map(entry))
} else {
  const files = readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  const shared = files.some((f) => SHARED.some((p) => matches(p, f)))
  print(
    PLUGINS.filter((p) => shared || files.some((f) => OWN[p].some((pat) => matches(pat, f)))).map(entry),
  )
}
