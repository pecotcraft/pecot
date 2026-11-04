#!/usr/bin/env bash
# Copilot CLI 向けの Agent Plugins 1.0 形式と、Claude Code 向けの従来形式の整合テスト（#1230）。
# 1.0 形式は、ルートの plugin.json / mcp.json。
# 従来形式は、.claude-plugin/plugin.json / .mcp.json。
#
# Copilot は 1.0 形式のプラグインでは .github/plugin/plugin.json・.mcp.json・hooks/ を読まず、
# Claude は従来形式の側だけを読む。2 つの形式を併置するので、次を押さえる。
#   - ルートの plugin.json と .claude-plugin/plugin.json の name・version が一致する。
#   - 1.0 は閉じたスキーマなので、plugin.json に hooks・mcpServers などを書かない。
#   - mcp.json の $schema が plugin.json と同じバージョン（agent-plugins.org/schemas/ 配下）になる。
#   - mcp.json の command がプラグイン相対で実在する。stdio の command は 1.0 では展開されない。
#   - 従来形式の .mcp.json と同じサーバ・同じ args を持つ。どちらも env を付けない。
#     データ置き場は両クライアントが CLAUDE_PLUGIN_DATA / PLUGIN_DATA で渡し、wrapper がその順で解決する。
#   - MCP のサーバ名（キー）は pecot-visual / pecot-visual-playwright / pecot-tools。
#     Copilot CLI はキーをそのままツール名の前置きにし、同名のキーは後から読んだものが勝つ。
#     そのためプラグインの名前で揃える。
#   - Copilot の hooks は com.github.copilot/hooks/hooks.json にある。
#     旧 hooks-copilot.json と .github/plugin/plugin.json は無い。
#
#   bash plugins/pecot-visual/cli/tests/bootstrap/manifest.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PLUGIN_NAME=pecot-v
BIN=pecotv
# 従来形式の .mcp.json と mcp.json に載る MCP サーバ名（"名前:実行ファイル" か "名前:npx"）
SERVERS='pecot-visual:pecotv pecot-visual-playwright:npx'
HOOKS_COPILOT=yes

node - "$PLUGIN_ROOT" "$PLUGIN_NAME" "$BIN" "$SERVERS" "$HOOKS_COPILOT" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const [root, pluginName, bin, servers, hooksCopilot] = process.argv.slice(2)
let pass = 0
let fail = 0
const ok = (name) => { pass += 1; console.log(`ok   ${name}`) }
const ng = (name, detail) => { fail += 1; console.log(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`) }
const check = (name, condition, detail) => (condition ? ok(name) : ng(name, detail))
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

const claude = read('.claude-plugin/plugin.json')
const manifest = read('plugin.json')
const mcp = read('mcp.json')
const legacyMcp = read('.mcp.json')

// --- plugin.json ---
const PLUGIN_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/plugin\.schema\.json$/
const schemaMatch = PLUGIN_SCHEMA.exec(manifest.$schema ?? '')
check('plugin.json: $schema が Agent Plugins の plugin スキーマ', schemaMatch !== null, manifest.$schema)
check('plugin.json: name が .claude-plugin/plugin.json と一致する', manifest.name === claude.name && manifest.name === pluginName, `${manifest.name} / ${claude.name}`)
check('plugin.json: version が .claude-plugin/plugin.json と一致する', manifest.version === claude.version && typeof manifest.version === 'string', `${manifest.version} / ${claude.version}`)
const ALLOWED = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const extra = Object.keys(manifest).filter((key) => !ALLOWED.has(key))
check('plugin.json: 1.0 の閉じたスキーマにないキー（hooks・mcpServers など）を持たない', extra.length === 0, extra.join(', '))
check('plugin.json: description を持つ', typeof manifest.description === 'string' && manifest.description !== '')

// --- mcp.json ---
const MCP_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/mcp\.schema\.json$/
const mcpMatch = MCP_SCHEMA.exec(mcp.$schema ?? '')
check('mcp.json: $schema が Agent Plugins の mcp スキーマ', mcpMatch !== null, mcp.$schema)
check('mcp.json: $schema の版が plugin.json と同じ', schemaMatch !== null && mcpMatch !== null && schemaMatch[1] === mcpMatch[1], `${schemaMatch?.[1]} / ${mcpMatch?.[1]}`)
const mcpExtra = Object.keys(mcp).filter((key) => key !== '$schema' && key !== 'mcpServers')
check('mcp.json: $schema と mcpServers 以外のキーを持たない', mcpExtra.length === 0, mcpExtra.join(', '))

for (const entry of servers.split(' ')) {
  const [name, executable] = entry.split(':')
  const server = mcp.mcpServers?.[name]
  const legacy = legacyMcp.mcpServers?.[name]
  check(`mcp.json: サーバ ${name} がある`, server !== undefined)
  check(`.mcp.json: サーバ ${name} がある`, legacy !== undefined)
  if (server === undefined || legacy === undefined) continue
  check(`mcp.json(${name}): type が stdio`, server.type === 'stdio', server.type)
  check(`.mcp.json(${name}): env を付けない`, legacy.env === undefined)
  check(`mcp.json(${name}): 従来形式の .mcp.json と args が同じ`, JSON.stringify(server.args) === JSON.stringify(legacy.args), `${JSON.stringify(server.args)} / ${JSON.stringify(legacy.args)}`)
  if (executable === 'npx') {
    check(`mcp.json(${name}): env を付けない`, server.env === undefined)
    check(`mcp.json(${name}): command が npx`, server.command === 'npx', server.command)
    check(`.mcp.json(${name}): command が npx`, legacy.command === 'npx', legacy.command)
    // npx が取るパッケージは版まで固定する（@latest だと起動のたびに最新を取りに行く）。args のうちフラグでない最初の要素がパッケージ。
    // Claude Code 向けの .mcp.json と Copilot CLI 向けの mcp.json の両方を見る。
    for (const [file, target] of [['mcp.json', server], ['.mcp.json', legacy]]) {
      const packageSpec = (target.args ?? []).find((arg) => !String(arg).startsWith('-'))
      check(`${file}(${name}): npx のパッケージが版まで固定されている`, /^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/.test(String(packageSpec)), String(packageSpec))
    }
  }
  else {
    check(`mcp.json(${name}): env を付けない`, server.env === undefined, JSON.stringify(server.env))
    check(`mcp.json(${name}): command がプラグイン相対（./bin/${executable}）`, server.command === `./bin/${executable}`, server.command)
    check(`.mcp.json(${name}): command が \${CLAUDE_PLUGIN_ROOT}/bin/${executable}`, legacy.command === `\${CLAUDE_PLUGIN_ROOT}/bin/${executable}`, legacy.command)
    const resolved = path.join(root, server.command)
    let executableFile = false
    try { fs.accessSync(resolved, fs.constants.X_OK); executableFile = true } catch { /* 下で報告 */ }
    check(`mcp.json(${name}): command の実体が実行可能`, executableFile, resolved)
  }
}
const names = Object.keys(mcp.mcpServers ?? {}).sort().join(',')
check('mcp.json: サーバの集合が .mcp.json と同じ', names === Object.keys(legacyMcp.mcpServers ?? {}).sort().join(','), names)
check('mcp.json: command がプラグインルートの外を指さない', Object.values(mcp.mcpServers ?? {}).every((server) => !String(server.command).includes('..')))

// --- Copilot の hooks と旧形式の manifest ---
const exists = (file) => fs.existsSync(path.join(root, file))
if (hooksCopilot === 'yes') {
  check('com.github.copilot/hooks/hooks.json がある', exists('com.github.copilot/hooks/hooks.json'))
  check('旧 hooks/hooks-copilot.json は無い', !exists('hooks/hooks-copilot.json'))
  JSON.parse(fs.readFileSync(path.join(root, 'com.github.copilot/hooks/hooks.json'), 'utf8'))
}
check('旧 .github/plugin/plugin.json は無い（1.0 形式では Copilot が読まない）', !exists('.github/plugin/plugin.json'))

// --- エージェント: Copilot は com.github.copilot/agents から読む。agents/ への相対 symlink ---
const linkPath = path.join(root, 'com.github.copilot/agents')
let linkTarget
try { linkTarget = fs.readlinkSync(linkPath) } catch { /* 下で報告 */ }
check('com.github.copilot/agents が ../agents を指す相対 symlink', linkTarget === '../agents', String(linkTarget))
const agentFiles = fs.readdirSync(path.join(root, 'agents')).filter((f) => f.endsWith('.md'))
let visible = []
try { visible = fs.readdirSync(linkPath) } catch { /* 下で報告 */ }
check('agents/*.md が 1 つ以上ある', agentFiles.length > 0)
check('com.github.copilot/agents の中に agents/*.md が全部見える', agentFiles.every((f) => visible.includes(f)), visible.join(','))

console.log(`pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
JS
