// MCP の tools/list から interface/generated.json を書き出し、または一致を確かめる。
/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのはリポジトリ内の固定パスだけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Tool は mutable な型 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { Tool } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { diffGenerated, formatStale } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import type { GeneratedFile } from '../../../../libs/interface-spec/src/domain/schema.js'
import { createMcpServer } from '../src/mcp/server.js'
import { allTools } from '../src/mcp/tools/index.js'

export const GENERATED_PATH = 'plugins/pecot-tools/interface/generated.json'
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-tools/cli exec tsx scripts/export-interface.ts --write'
const USAGE = 'usage: export-interface (--check | --write)'
const MODERN_PROTOCOL_VERSION = '2026-07-28'

export interface Output {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..')
}

// 世代は legacy（2025-11-25）が既定。modern はテストが同じ結果になることを確かめるために使う。
export async function listTools(era: 'legacy' | 'modern' = 'legacy'): Promise<readonly Tool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(allTools()), { transport: serverTransport })
  const client = new Client(
    { name: 'export-interface', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } } : {},
  )
  await client.connect(clientTransport)
  try {
    const result = await client.listTools()
    return result.tools
  }
  finally {
    await client.close()
    await handle.close()
  }
}

// $schema の位置は SDK とプロトコル世代で変わるので外し、キーは再帰的に並べて出力を固定する。
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element: unknown) => normalize(element))
  if (typeof value !== 'object' || value === null) return value
  const keys = Object.keys(value).filter(key => key !== '$schema')
  return Object.fromEntries(
    keys.toSorted(compareText).map(key => [key, normalize(Object.getOwnPropertyDescriptor(value, key)?.value)]),
  )
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function buildGenerated(tools: readonly Readonly<Tool>[]): GeneratedFile {
  const entries = tools.map(tool => ({
    id: `PT-${tool.name.toUpperCase().replaceAll('_', '-')}`,
    name: tool.name,
    description: tool.description ?? '',
    surfaces: { mcp: { tool: tool.name } },
    hidden: false,
    deprecated: false,
    input: tool.inputSchema,
    mcp: {
      ...(tool.outputSchema !== undefined && { output: tool.outputSchema }),
      ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    },
  })).toSorted((left, right) => compareText(left.id, right.id))
  return generatedFileSchema.parse(normalize({ format: 1, plugin: 'pecot-tools', prefix: 'PT', entries }))
}

export function serialize(file: unknown): string {
  return `${JSON.stringify(normalize(file), undefined, 2)}\n`
}

export async function run(argv: readonly string[], output: Output): Promise<number> {
  const [mode, ...rest] = argv
  if ((mode !== '--check' && mode !== '--write') || rest.length > 0) {
    output.stderr(`${USAGE}\n`)
    return 2
  }
  const target = path.join(repositoryRoot(), GENERATED_PATH)
  const generated = buildGenerated(await listTools())
  if (mode === '--write') {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, serialize(generated))
    return 0
  }
  const current = readFileSync(target, 'utf8')
  if (current === serialize(generated)) return 0
  const lines = diffGenerated(generatedFileSchema.parse(JSON.parse(current)), generated)
  for (const line of formatStale(GENERATED_PATH, lines, WRITE_COMMAND)) output.stderr(`${line}\n`)
  return 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  })
}
