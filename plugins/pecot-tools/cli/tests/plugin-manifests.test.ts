// Claude Code の .claude-plugin/plugin.json・.mcp.json と、Agent Plugins 1.0 の plugin.json・mcp.json を比べる。
/* eslint-disable security/detect-non-literal-fs-filename -- プラグインの直下の固定のファイルだけを読む */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MCP_SERVER_NAME } from '../src/mcp/server.js'
import { explains } from './_helpers/explains.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const PACKAGE_NAME = '@pecot/tools-mcp'
// 利用者が入力する層の名前。ツールの名前空間と Copilot CLI のインストール先になる。
const PLUGIN_NAME = 'pecot-t'

const ServerSchema = z.strictObject({
  type: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.unknown().optional(),
})
const McpSchema = z.object({ $schema: z.string().optional(), mcpServers: z.record(z.string(), ServerSchema) })
const ManifestSchema = z.looseObject({ $schema: z.string().optional(), name: z.string(), version: z.string(), description: z.string().optional() })

function readJson(file: string): unknown {
  const text = readFileSync(path.join(PLUGIN_ROOT, file), 'utf8')
  return JSON.parse(text)
}

// データ置き場の変数名だけを伏せる。
function maskDataDirectory(arguments_: readonly string[]): readonly string[] {
  return arguments_.map(argument => argument.replace(/\$\{(?:CLAUDE_)?PLUGIN_DATA\}/, '<data>'))
}

const claudeManifest = ManifestSchema.parse(readJson('.claude-plugin/plugin.json'))
const manifest = ManifestSchema.parse(readJson('plugin.json'))
const claudeMcp = McpSchema.parse(readJson('.mcp.json'))
const mcpRaw = z.record(z.string(), z.unknown()).parse(readJson('mcp.json'))
const mcp = McpSchema.parse(mcpRaw)
const claudeServer = new Map(Object.entries(claudeMcp.mcpServers)).get(MCP_SERVER_NAME)
const agentPluginsServer = new Map(Object.entries(mcp.mcpServers)).get(MCP_SERVER_NAME)

const PLUGIN_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/plugin\.schema\.json$/
const MCP_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/mcp\.schema\.json$/
// Agent Plugins 1.0 の plugin.json は閉じたスキーマ。
const ALLOWED_MANIFEST_KEYS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])

const hasPluginFile = (file: string): boolean => existsSync(path.join(PLUGIN_ROOT, file))
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b))

describe('プラグインの 2 組の manifest', () => {
  it('.claude-plugin/plugin.json の name は pecot-t', async () => {
    await explains('Claude Code 向けの `.claude-plugin/plugin.json` のテストです。`name` がプラグインの名前 `pecot-t` であることを確認します。')
    expect(claudeManifest.name).toBe(PLUGIN_NAME)
  })

  it('plugin.json の name・version が .claude-plugin/plugin.json と一致する', async () => {
    await explains('Agent Plugins 向けの `plugin.json` のテストです。`name` と `version` が、`.claude-plugin/plugin.json` の値と一致することを確認します。')
    expect([manifest.name, manifest.version]).toEqual([claudeManifest.name, claudeManifest.version])
  })

  it('plugin.json と mcp.json の $schema が、同じ版の Agent Plugins のスキーマを指す', async () => {
    await explains('`plugin.json` と `mcp.json` の `$schema` のテストです。どちらも Agent Plugins のスキーマを指し、スキーマの版が同じであることを確認します。')
    const pluginVersion = PLUGIN_SCHEMA.exec(manifest.$schema ?? '')?.[1]
    const mcpVersion = MCP_SCHEMA.exec(mcp.$schema ?? '')?.[1]

    expect(pluginVersion).toBeDefined()
    expect(mcpVersion).toBe(pluginVersion)
  })

  it('plugin.json は 1.0 の閉じたスキーマに無いキーを持たず、description を持つ', async () => {
    await explains('Agent Plugins 1.0 の閉じたスキーマに対する `plugin.json` のテストです。許可されたキー以外を持たず、`description` が空でないことを確認します。')
    expect(Object.keys(manifest).filter(key => !ALLOWED_MANIFEST_KEYS.has(key))).toEqual([])
    expect(manifest.description).toMatch(/\S/)
  })

  it('mcp.json は $schema と mcpServers だけを持つ', async () => {
    await explains('`mcp.json` のキーのテストです。最上位のキーが `$schema` と `mcpServers` の 2 つだけであることを確認します。')
    expect(Object.keys(mcpRaw).toSorted(byCodePoint)).toEqual(['$schema', 'mcpServers'])
  })

  it('MCP のサーバは 2 組とも MCP_SERVER_NAME の 1 つだけ', async () => {
    await explains('MCP のサーバの登録のテストです。`mcp.json` と `.mcp.json` のどちらにも、`MCP_SERVER_NAME` のサーバだけが登録されていることを確認します。')
    expect(Object.keys(mcp.mcpServers)).toEqual([MCP_SERVER_NAME])
    expect(Object.keys(claudeMcp.mcpServers)).toEqual([MCP_SERVER_NAME])
  })

  it('旧 .github/plugin/plugin.json を持たない（1.0 形式では Copilot CLI が読まない）', async () => {
    await explains('旧形式のマニフェストのテストです。`.github/plugin/plugin.json` が存在しないことを確認します。')
    expect(hasPluginFile('.github/plugin/plugin.json')).toBe(false)
  })
})

describe('MCP のサーバの起動', () => {
  const pinned = `${PACKAGE_NAME}@${claudeManifest.version}`

  it('.mcp.json は npx で、plugin.json と同じ版の npm の package を起動する', async () => {
    await explains('Claude Code 向けの `.mcp.json` のテストです。`npx` で、`plugin.json` と同じ版の npm のパッケージを起動する設定になっていることを確認します。')
    expect(claudeServer).toEqual({ command: 'npx', args: ['--prefix=${CLAUDE_PLUGIN_DATA}', '-y', pinned] })
  })

  it('mcp.json は stdio の npx で、plugin.json と同じ版の npm の package を起動する', async () => {
    await explains('Agent Plugins 向けの `mcp.json` のテストです。stdio の `npx` で、`plugin.json` と同じ版の npm のパッケージを起動する設定になっていることを確認します。')
    expect(agentPluginsServer).toEqual({ type: 'stdio', command: 'npx', args: ['--prefix=${PLUGIN_DATA}', '-y', pinned] })
  })

  it('2 組の args は、データ置き場の変数名だけが違う', async () => {
    await explains('2 組の `mcp.json` の `args` のテストです。データ置き場の変数名を除いた引数の並びが、2 組で一致することを確認します。')
    const agentPlugins = maskDataDirectory(agentPluginsServer?.args ?? [])
    const claudeCode = maskDataDirectory(claudeServer?.args ?? [])

    expect(agentPlugins).toEqual(claudeCode)
  })

  it('プラグインの直下に bin/ を持たない', async () => {
    await explains('CLI の廃止後のプラグインの構成のテストです。プラグインの直下に `bin` ディレクトリが存在しないことを確認します。')
    expect(hasPluginFile('bin')).toBe(false)
  })
})
