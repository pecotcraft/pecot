// Claude Code の manifest と、Agent Plugins 1.0 の plugin.json・mcp.json・Copilot 向けの定義を比べる。
/* eslint-disable security/detect-non-literal-fs-filename -- プラグインの直下の固定のファイルだけを読む */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MCP_SERVER_NAME } from '../src/mcp/server.js'
import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const PACKAGE_NAME = '@pecot/workflow-mcp'
// 利用者が入力する層の名前。ツールの名前空間と Copilot CLI のインストール先になる。
const PLUGIN_NAME = 'pecot-w'
const PLAYWRIGHT_SERVER_NAME = 'pecot-workflow-playwright'
const REMOTE_SERVER_NAME = 'context7'

// 起動するサーバは command・args、リモートのサーバは url を持つ。
const ServerSchema = z.strictObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.unknown().optional(),
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
  it('.claude-plugin/plugin.json の name は pecot-w', async () => {
    await explains('Claude Code 向けの manifest（`.claude-plugin/plugin.json`）のテストです。`name` がプラグインの名前 `pecot-w` であることを確認します。')
    stepSync('name を比べる', () => {
      expect(claudeManifest.name).toBe(PLUGIN_NAME)
    })
  })

  it('plugin.json の name・version が .claude-plugin/plugin.json と一致する', async () => {
    await explains('Agent Plugins 向けの `plugin.json` と、Claude Code 向けの manifest の整合のテストです。`name` と `version` が、両方の manifest で一致することを確認します。')
    stepSync('name と version を比べる', () => {
      expect([manifest.name, manifest.version]).toEqual([claudeManifest.name, claudeManifest.version])
    })
  })

  it('plugin.json と mcp.json の $schema が、同じ版の Agent Plugins のスキーマを指す', async () => {
    await explains('`plugin.json` と `mcp.json` の `$schema` のテストです。どちらも同じ版の Agent Plugins のスキーマを指していることを確認します。')
    const { pluginVersion, mcpVersion } = stepSync('2 つの $schema から版を読む', () => ({
      pluginVersion: PLUGIN_SCHEMA.exec(manifest.$schema ?? '')?.[1],
      mcpVersion: MCP_SCHEMA.exec(mcp.$schema ?? '')?.[1],
    }))
    stepSync('スキーマの版を比べる', () => {
      expect(pluginVersion).toBeDefined()
      expect(mcpVersion).toBe(pluginVersion)
    })
  })

  it('plugin.json は 1.0 の閉じたスキーマに無いキーを持たず、description を持つ', async () => {
    await explains('Agent Plugins 1.0 の `plugin.json` の項目のテストです。閉じたスキーマに存在しないキーを持たず、`description` が空でないことを確認します。')
    const unknownKeys = stepSync('スキーマに無いキーを集める', () => Object.keys(manifest).filter(key => !ALLOWED_MANIFEST_KEYS.has(key)))
    stepSync('キーと description を比べる', () => {
      expect(unknownKeys).toEqual([])
      expect(manifest.description).toMatch(/\S/)
    })
  })

  it('mcp.json は $schema と mcpServers だけを持つ', async () => {
    await explains('Agent Plugins 向けの `mcp.json` の項目のテストです。最上位のキーが `$schema` と `mcpServers` だけであることを確認します。')
    const keys = stepSync('最上位のキーを集める', () => Object.keys(mcpRaw).toSorted(byCodePoint))
    stepSync('キーを比べる', () => {
      expect(keys).toEqual(['$schema', 'mcpServers'])
    })
  })

  it('MCP のサーバは 2 組とも MCP_SERVER_NAME・playwright・context7 の 3 つ', async () => {
    await explains('MCP のサーバーの定義のテストです。`mcp.json` と `.mcp.json` のどちらも、サーバーが `MCP_SERVER_NAME`・playwright・context7 の 3 つだけであることを確認します。')
    const expected = [MCP_SERVER_NAME, PLAYWRIGHT_SERVER_NAME, REMOTE_SERVER_NAME].toSorted(byCodePoint)
    const { agentPluginsNames, claudeNames } = stepSync('2 組のサーバーの名前を集める', () => ({
      agentPluginsNames: Object.keys(mcp.mcpServers).toSorted(byCodePoint),
      claudeNames: Object.keys(claudeMcp.mcpServers).toSorted(byCodePoint),
    }))
    stepSync('サーバーの名前を比べる', () => {
      expect(agentPluginsNames).toEqual(expected)
      expect(claudeNames).toEqual(expected)
    })
  })

  it('旧 .github/plugin/plugin.json を持たない（1.0 形式では Copilot CLI が読まない）', async () => {
    await explains('旧い形式の定義が残っていないことのテストです。`.github/plugin/plugin.json` が存在しないことを確認します。')
    const isExisting = stepSync('旧い定義のファイルの有無を調べる', () => hasPluginFile('.github/plugin/plugin.json'))
    stepSync('ファイルが無いことを比べる', () => {
      expect(isExisting).toBe(false)
    })
  })
})

describe('MCP のサーバの起動', () => {
  const pinned = `${PACKAGE_NAME}@${claudeManifest.version}`

  it('.mcp.json は npx で、plugin.json と同じ版の npm の package を起動する', async () => {
    await explains('Claude Code 向けの `.mcp.json` の起動の定義のテストです。`npx` で、`plugin.json` と同じ版の npm の package を起動することを確認します。')
    const server = stepSync('.mcp.json のサーバーの定義を読む', () => claudeServers.get(MCP_SERVER_NAME))
    stepSync('起動の定義を比べる', () => {
      expect(server).toEqual({ command: 'npx', args: ['--prefix=${CLAUDE_PLUGIN_DATA}', '-y', pinned] })
    })
  })

  it('mcp.json は stdio の npx で、plugin.json と同じ版の npm の package を起動する', async () => {
    await explains('Agent Plugins 向けの `mcp.json` の起動の定義のテストです。`stdio` の `npx` で、`plugin.json` と同じ版の npm の package を起動することを確認します。')
    const server = stepSync('mcp.json のサーバーの定義を読む', () => agentPluginsServers.get(MCP_SERVER_NAME))
    stepSync('起動の定義を比べる', () => {
      expect(server).toEqual({ type: 'stdio', command: 'npx', args: ['--prefix=${PLUGIN_DATA}', '-y', pinned] })
    })
  })

  it.for([MCP_SERVER_NAME, PLAYWRIGHT_SERVER_NAME])('%s の 2 組の args は、データ置き場の変数名だけが違う', async (name) => {
    await explains('2 組の MCP の定義の整合のテストです。それぞれのサーバーの `args` が、データ置き場の変数名を除いて一致することを確認します。')
    const { agentPlugins, claudeCode } = stepSync('2 組の args からデータ置き場の変数名を伏せる', () => ({
      agentPlugins: maskDataDirectory(agentPluginsServers.get(name)?.args ?? []),
      claudeCode: maskDataDirectory(claudeServers.get(name)?.args ?? []),
    }))
    stepSync('args を比べる', () => {
      expect(agentPlugins).toEqual(claudeCode)
    })
  })

  it('playwright のサーバは、データ置き場を --prefix にした npx で版を固定した package を起動する', async () => {
    await explains('playwright のサーバーの起動の定義のテストです。データ置き場を `--prefix` にした `npx` で、版を固定した package を起動し、`stdio` で接続することを確認します。')
    const server = stepSync('playwright のサーバーの定義を読む', () => claudeServers.get(PLAYWRIGHT_SERVER_NAME))
    const packageSpec = server?.args?.find(argument => !argument.startsWith('-'))
    stepSync('起動の定義と固定した版を比べる', () => {
      expect([server?.command, server?.args?.[0], server?.env]).toEqual(['npx', '--prefix=${CLAUDE_PLUGIN_DATA}', undefined])
      expect(pinnedVersion(packageSpec ?? '')).toMatch(PINNED_VERSION)
      expect(agentPluginsServers.get(PLAYWRIGHT_SERVER_NAME)?.type).toBe('stdio')
    })
  })

  it('context7 は、.mcp.json が http、mcp.json が streamable-http で、url が同じ', async () => {
    await explains('リモートの MCP サーバー（context7）の定義のテストです。`.mcp.json` は `http`、`mcp.json` は `streamable-http` で、url が同じで、`headers` と `env` を持たないことを確認します。')
    const { claudeCode, agentPlugins } = stepSync('2 組の context7 の定義を読む', () => ({
      claudeCode: claudeServers.get(REMOTE_SERVER_NAME),
      agentPlugins: agentPluginsServers.get(REMOTE_SERVER_NAME),
    }))
    stepSync('接続の種類と url と headers・env を比べる', () => {
      expect([claudeCode?.type, agentPlugins?.type]).toEqual(['http', 'streamable-http'])
      expect(agentPlugins?.url).toMatch(/^https:\/\//)
      expect(agentPlugins?.url).toBe(claudeCode?.url)
      expect([claudeCode?.headers, claudeCode?.env, agentPlugins?.headers, agentPlugins?.env]).toEqual([undefined, undefined, undefined, undefined])
    })
  })

  it('プラグインの直下に bin/ を持たない', async () => {
    await explains('プラグインの構成のテストです。プラグインの直下に `bin/` が存在しないことを確認します。')
    const isExisting = stepSync('bin/ の有無を調べる', () => hasPluginFile('bin'))
    stepSync('bin/ が無いことを比べる', () => {
      expect(isExisting).toBe(false)
    })
  })
})

describe('Copilot CLI 向けの定義', () => {
  const copilotAgentsDirectory = 'com.github.copilot/agents'

  it('com.github.copilot/hooks/hooks.json があり、旧 hooks/hooks-copilot.json は無い', async () => {
    await explains('Copilot CLI 向けの hook の定義のテストです。`com.github.copilot/hooks/hooks.json` が存在し、旧い `hooks/hooks-copilot.json` が存在しないことを確認します。')
    const isOldExisting = stepSync('旧い hook の定義の有無を調べる', () => hasPluginFile('hooks/hooks-copilot.json'))
    stepSync('hook の定義を比べる', () => {
      expect(() => readJson('com.github.copilot/hooks/hooks.json')).not.toThrow()
      expect(isOldExisting).toBe(false)
    })
  })

  it('com.github.copilot/agents は symlink でない実ディレクトリで、ファイル名の集合が agents/*.md と同じ', async () => {
    await explains('Copilot CLI 向けのエージェントの定義のテストです。`com.github.copilot/agents` がシンボリックリンクではない実ディレクトリで、ファイル名の集合が `agents/*.md` と一致することを確認します。')
    const { isDirectory, originals, copies } = stepSync('エージェントの定義のディレクトリとファイル名を読む', () => ({
      isDirectory: lstatSync(path.join(PLUGIN_ROOT, copilotAgentsDirectory)).isDirectory(),
      originals: agentFiles('agents'),
      copies: agentFiles(copilotAgentsDirectory),
    }))
    stepSync('ディレクトリの種類とファイル名を比べる', () => {
      expect(isDirectory).toBe(true)
      expect(originals.length).toBeGreaterThan(0)
      expect(copies).toEqual(originals)
    })
  })

  // auto は定義に model があると 400 model_not_supported で失敗する（#416）。
  it.for(agentFiles(copilotAgentsDirectory))('com.github.copilot/agents/%s は model を持たず、name・description・本文が agents/ と同じ', async (file) => {
    await explains('Copilot CLI 向けのエージェントの定義のテストです。各ファイルが `model` を持たず、`name`・`description`・本文が `agents/` の同名のファイルと一致することを確認します。')
    const { copy, original } = stepSync('写しと元のエージェントの定義を読む', () => ({
      copy: splitDefinition(readText(path.join(copilotAgentsDirectory, file))),
      original: splitDefinition(readText(path.join('agents', file))),
    }))
    stepSync('model の有無と name・description・本文を比べる', () => {
      expect(copy?.keys.has('model')).toBe(false)
      expect([copy?.keys.get('name'), copy?.keys.get('description'), copy?.body]).toEqual([original?.keys.get('name'), original?.keys.get('description'), original?.body])
    })
  })
})
