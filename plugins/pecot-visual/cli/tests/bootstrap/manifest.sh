#!/usr/bin/env bash
# Agent Plugins 1.0 形式と従来形式の、登録ファイルの整合テスト（#1230）。
# 1.0 形式は plugin.json / mcp.json、従来形式は .claude-plugin/plugin.json / .mcp.json。
#   bash plugins/pecot-visual/cli/tests/bootstrap/manifest.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$PLUGIN_ROOT/../../.githooks/scripts/test_report/bash-test.sh"

PLUGIN_NAME=pecot-v
BIN=pecotv
# 従来形式の .mcp.json と mcp.json に載る MCP サーバ名（"名前:実行ファイル" か "名前:npx"）
SERVERS='pecot-visual:pecotv pecot-visual-playwright:npx'
HOOKS_COPILOT=yes

# 確かめの結果を 1 行ずつ出す。node が落ちたら bt_finish まで届かないので、broken として出る。
manifest_records() {
  node - "$PLUGIN_ROOT" "$PLUGIN_NAME" "$BIN" "$SERVERS" "$HOOKS_COPILOT" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const [root, pluginName, bin, servers, hooksCopilot] = process.argv.slice(2)
// 確かめを 1 行ずつ「pass|fail<TAB>題<TAB>理由」で出し、bash の側で bt_* に渡す。
const expect = (name, condition, detail) => console.log([condition ? 'pass' : 'fail', name, String(detail ?? '条件を満たさない').replace(/[\t\n]/g, ' ')].join('\t'))
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

const claude = read('.claude-plugin/plugin.json')
const manifest = read('plugin.json')
const mcp = read('mcp.json')
const legacyMcp = read('.mcp.json')

// --- plugin.json ---
const PLUGIN_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/plugin\.schema\.json$/
const schemaMatch = PLUGIN_SCHEMA.exec(manifest.$schema ?? '')
expect('plugin.json: $schema が Agent Plugins の plugin スキーマ', schemaMatch !== null, manifest.$schema)
expect('plugin.json: name が .claude-plugin/plugin.json と一致する', manifest.name === claude.name && manifest.name === pluginName, `${manifest.name} / ${claude.name}`)
expect('plugin.json: version が .claude-plugin/plugin.json と一致する', manifest.version === claude.version && typeof manifest.version === 'string', `${manifest.version} / ${claude.version}`)
const ALLOWED = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const extra = Object.keys(manifest).filter((key) => !ALLOWED.has(key))
expect('plugin.json: 1.0 の閉じたスキーマにないキー（hooks・mcpServers など）を持たない', extra.length === 0, extra.join(', '))
expect('plugin.json: description を持つ', typeof manifest.description === 'string' && manifest.description !== '')

// --- mcp.json ---
const MCP_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/mcp\.schema\.json$/
const mcpMatch = MCP_SCHEMA.exec(mcp.$schema ?? '')
expect('mcp.json: $schema が Agent Plugins の mcp スキーマ', mcpMatch !== null, mcp.$schema)
expect('mcp.json: $schema の版が plugin.json と同じ', schemaMatch !== null && mcpMatch !== null && schemaMatch[1] === mcpMatch[1], `${schemaMatch?.[1]} / ${mcpMatch?.[1]}`)
const mcpExtra = Object.keys(mcp).filter((key) => key !== '$schema' && key !== 'mcpServers')
expect('mcp.json: $schema と mcpServers 以外のキーを持たない', mcpExtra.length === 0, mcpExtra.join(', '))

for (const entry of servers.split(' ')) {
  const [name, executable] = entry.split(':')
  const server = mcp.mcpServers?.[name]
  const legacy = legacyMcp.mcpServers?.[name]
  expect(`mcp.json: サーバ ${name} がある`, server !== undefined)
  expect(`.mcp.json: サーバ ${name} がある`, legacy !== undefined)
  if (server === undefined || legacy === undefined) continue
  expect(`mcp.json(${name}): type が stdio`, server.type === 'stdio', server.type)
  expect(`.mcp.json(${name}): env を付けない`, legacy.env === undefined)
  // プラグイン root の変数は、.mcp.json が ${CLAUDE_PLUGIN_ROOT}、mcp.json が ${PLUGIN_ROOT}。同じものとして比べる。
  const legacyArgs = (legacy.args ?? []).map((arg) => String(arg).split('${CLAUDE_PLUGIN_ROOT}').join('${PLUGIN_ROOT}'))
  expect(`mcp.json(${name}): 従来形式の .mcp.json と args が同じ`, JSON.stringify(server.args) === JSON.stringify(legacyArgs), `${JSON.stringify(server.args)} / ${JSON.stringify(legacy.args)}`)
  if (executable === 'npx') {
    expect(`mcp.json(${name}): env を付けない`, server.env === undefined)
    expect(`mcp.json(${name}): command が npx`, server.command === 'npx', server.command)
    expect(`.mcp.json(${name}): command が npx`, legacy.command === 'npx', legacy.command)
    // npm は cwd から上へたどって見つけた package.json の devEngines が npm 以外だと npx を止める。
    // --prefix に package.json の無い bin/ を指すと、npm はそこから上へたどらない。
    for (const [file, target, rootVar] of [['mcp.json', server, '${PLUGIN_ROOT}'], ['.mcp.json', legacy, '${CLAUDE_PLUGIN_ROOT}']]) {
      expect(`${file}(${name}): args の先頭が --prefix=${rootVar}/bin`, (target.args ?? [])[0] === `--prefix=${rootVar}/bin`, String((target.args ?? [])[0]))
    }
    expect(`${name}: --prefix の bin/ が実在する`, fs.statSync(path.join(root, 'bin'), { throwIfNoEntry: false })?.isDirectory() === true)
    expect(`${name}: --prefix の bin/ に package.json が無い`, !fs.existsSync(path.join(root, 'bin', 'package.json')))
    // npx が取るパッケージは版まで固定する（@latest だと起動のたびに最新を取りに行く）。args のうちフラグでない最初の要素がパッケージ。
    // Claude Code 向けの .mcp.json と Copilot CLI 向けの mcp.json の両方を見る。
    for (const [file, target] of [['mcp.json', server], ['.mcp.json', legacy]]) {
      const packageSpec = (target.args ?? []).find((arg) => !String(arg).startsWith('-'))
      expect(`${file}(${name}): npx のパッケージが版まで固定されている`, /^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/.test(String(packageSpec)), String(packageSpec))
    }
  }
  else {
    expect(`mcp.json(${name}): env を付けない`, server.env === undefined, JSON.stringify(server.env))
    expect(`mcp.json(${name}): command がプラグイン相対（./bin/${executable}）`, server.command === `./bin/${executable}`, server.command)
    expect(`.mcp.json(${name}): command が \${CLAUDE_PLUGIN_ROOT}/bin/${executable}`, legacy.command === `\${CLAUDE_PLUGIN_ROOT}/bin/${executable}`, legacy.command)
    const resolved = path.join(root, server.command)
    let executableFile = false
    try { fs.accessSync(resolved, fs.constants.X_OK); executableFile = true } catch { /* 下で報告 */ }
    expect(`mcp.json(${name}): command の実体が実行可能`, executableFile, resolved)
  }
}
const names = Object.keys(mcp.mcpServers ?? {}).sort().join(',')
expect('mcp.json: サーバの集合が .mcp.json と同じ', names === Object.keys(legacyMcp.mcpServers ?? {}).sort().join(','), names)
expect('mcp.json: command がプラグインルートの外を指さない', Object.values(mcp.mcpServers ?? {}).every((server) => !String(server.command).includes('..')))

// --- Copilot の hooks と旧形式の manifest ---
const exists = (file) => fs.existsSync(path.join(root, file))
if (hooksCopilot === 'yes') {
  expect('com.github.copilot/hooks/hooks.json がある', exists('com.github.copilot/hooks/hooks.json'))
  expect('旧 hooks/hooks-copilot.json は無い', !exists('hooks/hooks-copilot.json'))
  JSON.parse(fs.readFileSync(path.join(root, 'com.github.copilot/hooks/hooks.json'), 'utf8'))
}
expect('旧 .github/plugin/plugin.json は無い（1.0 形式では Copilot が読まない）', !exists('.github/plugin/plugin.json'))

// --- エージェント: Copilot は com.github.copilot/agents から読む。agents/ と本文を同じにした実ファイル ---
// auto は定義に model があると 400 model_not_supported で失敗する（#416）。frontmatter の残りは pecot-workflow の agent-definitions.test.ts が確かめる（#551）。
const agentsDir = path.join(root, 'agents')
const copilotAgentsDir = path.join(root, 'com.github.copilot/agents')
const fix = '直し方: agents/ の定義の name・description と本文を、com.github.copilot/agents/ の同名のファイルに写す'
// frontmatter をトップレベルのキーごとの生の行に分け、本文と合わせて返す。pecot-workflow の manifest.sh と同じ処理なので、直すときは両方を直す。
const splitDefinition = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return undefined
  const keys = {}
  let current
  for (const line of m[1].split('\n')) {
    const key = /^([A-Za-z][\w-]*):/.exec(line)
    if (key) { current = key[1]; keys[current] = [] }
    if (current !== undefined) keys[current].push(line)
  }
  return { keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.join('\n')])), body: text.slice(m[0].length) }
}
const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()
expect('agents/*.md が 1 つ以上ある', agentFiles.length > 0)
let copilotIsDir = false
try { copilotIsDir = fs.lstatSync(copilotAgentsDir).isDirectory() } catch { /* 下で報告 */ }
expect('com.github.copilot/agents が symlink でない実ディレクトリ', copilotIsDir, fix)
const copilotFiles = copilotIsDir ? fs.readdirSync(copilotAgentsDir).filter((f) => f.endsWith('.md')).sort() : []
expect('com.github.copilot/agents のファイル名の集合が agents/*.md と同じ', agentFiles.join(',') === copilotFiles.join(','), `${copilotFiles.join(',')}。${fix}`)
for (const f of copilotFiles) {
  const copy = splitDefinition(fs.readFileSync(path.join(copilotAgentsDir, f), 'utf8'))
  expect(`com.github.copilot/agents/${f}: frontmatter に model: が無い`, copy !== undefined && !('model' in copy.keys), '直し方: model: の行を消す')
  if (copy === undefined || !agentFiles.includes(f)) continue
  const orig = splitDefinition(fs.readFileSync(path.join(agentsDir, f), 'utf8'))
  for (const key of ['name', 'description']) {
    expect(`com.github.copilot/agents/${f}: ${key} が agents/${f} と同じ`, orig !== undefined && copy.keys[key] !== undefined && copy.keys[key] === orig.keys[key], fix)
  }
  expect(`com.github.copilot/agents/${f}: 本文が agents/${f} と同じ`, orig !== undefined && copy.body === orig.body, fix)
}
JS
}
RESULTS="$(manifest_records)"
while IFS=$'\t' read -r status name detail; do
  case "$status" in
    pass) bt_pass "$name" ;;
    fail) bt_fail "$name" "$detail" ;;
  esac
done <<< "$RESULTS"
bt_finish
