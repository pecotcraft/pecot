// Claude Code の manifest と、Agent Plugins 1.0 の plugin.json・mcp.json・Copilot 向けの定義を比べる。
/* eslint-disable security/detect-non-literal-fs-filename -- プラグインの直下の固定のファイルだけを読む */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MCP_SERVER_NAME } from '../src/mcp/server.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const PACKAGE_NAME = '@pecot/visual-mcp'
// 利用者が入力する層の名前。ツールの名前空間と Copilot CLI のインストール先になる。
const PLUGIN_NAME = 'pecot-v'
const PLAYWRIGHT_SERVER_NAME = 'pecot-visual-playwright'

const ServerSchema = z.strictObject({
  type: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.unknown().optional(),
})
const McpSchema = z.object({ $schema: z.string().optional(), mcpServers: z.record(z.string(), ServerSchema) })
const ManifestSchema = z.looseObject({ $schema: z.string().optional(), name: z.string(), version: z.string(), description: z.string().optional() })

function readText(file: string): string {
  return readFileSync(path.join(PLUGIN_ROOT, file), 'utf8')
}

function readJson(file: string): unknown {
  return JSON.parse(readText(file))
}

// データ置き場の変数名だけを伏せる。
function maskDataDirectory(arguments_: readonly string[]): readonly string[] {
  return arguments_.map(argument => argument.replace(/\$\{(?:CLAUDE_)?PLUGIN_DATA\}/, '<data>'))
}

interface AgentDefinition {
  readonly keys: ReadonlyMap<string, string>
  readonly body: string
}

// frontmatter をトップレベルのキーごとの生の行に分け、本文と合わせて返す。
function splitDefinition(text: string): AgentDefinition | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (match === null) return undefined
  const keys = new Map<string, string[]>()
  let current: string[] | undefined
  const lines = (match[1] ?? '').split('\n')
  for (const line of lines) {
    const key = /^([a-z][\w-]*):/i.exec(line)?.[1]
    if (key !== undefined) {
      current = []
      keys.set(key, current)
    }
    current?.push(line)
  }
  return { keys: new Map([...keys].map(([key, lines]) => [key, lines.join('\n')])), body: text.slice(match[0].length) }
}

const claudeManifest = ManifestSchema.parse(readJson('.claude-plugin/plugin.json'))
const manifest = ManifestSchema.parse(readJson('plugin.json'))
const claudeMcp = McpSchema.parse(readJson('.mcp.json'))
const mcpRaw = z.record(z.string(), z.unknown()).parse(readJson('mcp.json'))
const mcp = McpSchema.parse(mcpRaw)
const claudeServers = new Map(Object.entries(claudeMcp.mcpServers))
const agentPluginsServers = new Map(Object.entries(mcp.mcpServers))

const PLUGIN_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/plugin\.schema\.json$/
const MCP_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/mcp\.schema\.json$/
// Agent Plugins 1.0 の plugin.json は閉じたスキーマ。
const ALLOWED_MANIFEST_KEYS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
// npx が取る package は版まで固定する。@latest だと起動のたびに最新を取りに行く。
const PINNED_VERSION = /^\d+\.\d+\.\d+$/
const pinnedVersion = (spec: string): string => spec.slice(spec.lastIndexOf('@') + 1)

const hasPluginFile = (file: string): boolean => existsSync(path.join(PLUGIN_ROOT, file))
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b))
const agentFiles = (directory: string): readonly string[] => readdirSync(path.join(PLUGIN_ROOT, directory)).filter(file => file.endsWith('.md')).toSorted(byCodePoint)

describe('プラグインの 2 組の manifest', () => {
  it('.claude-plugin/plugin.json の name は pecot-v', () => {
    expect(claudeManifest.name).toBe(PLUGIN_NAME)
  })

  it('plugin.json の name・version が .claude-plugin/plugin.json と一致する', () => {
    expect([manifest.name, manifest.version]).toEqual([claudeManifest.name, claudeManifest.version])
  })

  it('plugin.json と mcp.json の $schema が、同じ版の Agent Plugins のスキーマを指す', () => {
    const pluginVersion = PLUGIN_SCHEMA.exec(manifest.$schema ?? '')?.[1]
    const mcpVersion = MCP_SCHEMA.exec(mcp.$schema ?? '')?.[1]

    expect(pluginVersion).toBeDefined()
    expect(mcpVersion).toBe(pluginVersion)
  })

  it('plugin.json は 1.0 の閉じたスキーマに無いキーを持たず、description を持つ', () => {
    expect(Object.keys(manifest).filter(key => !ALLOWED_MANIFEST_KEYS.has(key))).toEqual([])
    expect(manifest.description).toMatch(/\S/)
  })

  it('mcp.json は $schema と mcpServers だけを持つ', () => {
    expect(Object.keys(mcpRaw).toSorted(byCodePoint)).toEqual(['$schema', 'mcpServers'])
  })

  it('MCP のサーバは 2 組とも MCP_SERVER_NAME と playwright の 2 つ', () => {
    const expected = [MCP_SERVER_NAME, PLAYWRIGHT_SERVER_NAME].toSorted(byCodePoint)

    expect(Object.keys(mcp.mcpServers).toSorted(byCodePoint)).toEqual(expected)
    expect(Object.keys(claudeMcp.mcpServers).toSorted(byCodePoint)).toEqual(expected)
  })

  it('旧 .github/plugin/plugin.json を持たない（1.0 形式では Copilot CLI が読まない）', () => {
    expect(hasPluginFile('.github/plugin/plugin.json')).toBe(false)
  })
})

describe('MCP のサーバの起動', () => {
  const pinned = `${PACKAGE_NAME}@${claudeManifest.version}`

  it('.mcp.json は npx で、plugin.json と同じ版の npm の package を起動する', () => {
    expect(claudeServers.get(MCP_SERVER_NAME)).toEqual({ command: 'npx', args: ['--prefix=${CLAUDE_PLUGIN_DATA}', '-y', pinned] })
  })

  it('mcp.json は stdio の npx で、plugin.json と同じ版の npm の package を起動する', () => {
    expect(agentPluginsServers.get(MCP_SERVER_NAME)).toEqual({ type: 'stdio', command: 'npx', args: ['--prefix=${PLUGIN_DATA}', '-y', pinned] })
  })

  it.for([MCP_SERVER_NAME, PLAYWRIGHT_SERVER_NAME])('%s の 2 組の args は、データ置き場の変数名だけが違う', (name) => {
    const agentPlugins = maskDataDirectory(agentPluginsServers.get(name)?.args ?? [])
    const claudeCode = maskDataDirectory(claudeServers.get(name)?.args ?? [])

    expect(agentPlugins).toEqual(claudeCode)
  })

  it('playwright のサーバは、データ置き場を --prefix にした npx で版を固定した package を起動する', () => {
    const server = claudeServers.get(PLAYWRIGHT_SERVER_NAME)
    const packageSpec = server?.args.find(argument => !argument.startsWith('-'))

    expect([server?.command, server?.args[0], server?.env]).toEqual(['npx', '--prefix=${CLAUDE_PLUGIN_DATA}', undefined])
    expect(pinnedVersion(packageSpec ?? '')).toMatch(PINNED_VERSION)
    expect(agentPluginsServers.get(PLAYWRIGHT_SERVER_NAME)?.type).toBe('stdio')
  })

  it('プラグインの直下に bin/ を持たない', () => {
    expect(hasPluginFile('bin')).toBe(false)
  })
})

describe('Copilot CLI 向けの定義', () => {
  const copilotAgentsDirectory = 'com.github.copilot/agents'

  it('com.github.copilot/hooks/hooks.json があり、旧 hooks/hooks-copilot.json は無い', () => {
    expect(() => readJson('com.github.copilot/hooks/hooks.json')).not.toThrow()
    expect(hasPluginFile('hooks/hooks-copilot.json')).toBe(false)
  })

  it('com.github.copilot/agents は symlink でない実ディレクトリで、ファイル名の集合が agents/*.md と同じ', () => {
    expect(lstatSync(path.join(PLUGIN_ROOT, copilotAgentsDirectory)).isDirectory()).toBe(true)
    expect(agentFiles('agents').length).toBeGreaterThan(0)
    expect(agentFiles(copilotAgentsDirectory)).toEqual(agentFiles('agents'))
  })

  // auto は定義に model があると 400 model_not_supported で失敗する（#416）。
  it.for(agentFiles(copilotAgentsDirectory))('com.github.copilot/agents/%s は model を持たず、name・description・本文が agents/ と同じ', (file) => {
    const copy = splitDefinition(readText(path.join(copilotAgentsDirectory, file)))
    const original = splitDefinition(readText(path.join('agents', file)))

    expect(copy?.keys.has('model')).toBe(false)
    expect([copy?.keys.get('name'), copy?.keys.get('description'), copy?.body]).toEqual([original?.keys.get('name'), original?.keys.get('description'), original?.body])
  })
})
