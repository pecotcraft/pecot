/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはプラグインのリポジトリ内のファイルのみ */
// pecot-workflow の .mcp.json にある playwright の MCP サーバの起動定義を確かめる（#139）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pluginRoot, projectRoot } from '../_helpers/paths.js'
import { parseJson } from '../_helpers/text.js'

const SERVER = 'pecot-workflow-playwright'
const PREFIX = '--prefix=${CLAUDE_PLUGIN_ROOT}/bin'

interface McpServer {
  readonly command: unknown
  readonly args: readonly string[]
  readonly keys: readonly string[]
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) throw new Error('オブジェクトではありません')
  return Object.fromEntries(Object.entries(value))
}

function asStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new Error('文字列の配列ではありません')
  return value
}

function mcpServer(file: string, name: string): McpServer {
  const root = asRecord(parseJson(readFileSync(file, 'utf8')))
  const servers = asRecord(root['mcpServers'])
  const server = asRecord(Reflect.get(servers, name))
  return { command: server['command'], args: asStrings(server['args']), keys: Object.keys(server) }
}

describe('pecot-workflow-playwright の起動定義', () => {
  it('npx で起動し、env を持たない', () => {
    const server = mcpServer(path.join(pluginRoot, '.mcp.json'), SERVER)
    expect(server.command).toBe('npx')
    expect(server.keys).not.toContain('env')
  })

  it('prefix は package.json の無い bin/ を指す', () => {
    // npm は cwd から上へたどった package.json の devEngines が npm 以外だと npx を止める。package.json の無い bin/ を prefix にして避ける。
    const server = mcpServer(path.join(pluginRoot, '.mcp.json'), SERVER)
    expect(server.args[0]).toBe(PREFIX)
    expect(statSync(path.join(pluginRoot, 'bin')).isDirectory()).toBe(true)
    expect(existsSync(path.join(pluginRoot, 'bin', 'package.json'))).toBe(false)
  })

  it('パッケージのバージョンを固定している', () => {
    const server = mcpServer(path.join(pluginRoot, '.mcp.json'), SERVER)
    const spec = server.args.find(argument => !argument.startsWith('-'))
    // eslint-disable-next-line security/detect-unsafe-regex -- 固定の短い入力にだけ当てる
    expect(spec).toMatch(/^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/u)
  })

  it('引数は pecot-visual の playwright と同じにする', () => {
    const server = mcpServer(path.join(pluginRoot, '.mcp.json'), SERVER)
    const visual = mcpServer(path.join(projectRoot, 'plugins', 'pecot-visual', '.mcp.json'), 'pecot-visual-playwright')
    expect(server.args).toEqual(visual.args)
  })
})
