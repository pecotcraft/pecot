// MCP の tools/list から interface/generated.json を書き出し、または一致を確かめる。
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
import { compareText } from '../../../../libs/interface-spec/src/domain/utility.js'
import { createMcpServer } from '../src/mcp/server.js'
import { allTools } from '../src/mcp/tools/index.js'

export const GENERATED_PATH = 'plugins/pecot-visual/interface/generated.json'
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-visual/cli exec tsx scripts/export-interface.ts --write'
const USAGE = 'usage: export-interface (--check | --write)'
// 接続の数行と版は src/mcp/tests/_client.ts と同値（テスト補助は import しない）。
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
  try {
    await client.connect(clientTransport)
    const result = await client.listTools()
    return result.tools
  }
  finally {
    try {
      await client.close()
    }
    finally {
      await handle.close()
    }
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

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- SDK の Tool は mutable
export function buildGenerated(tools: readonly Tool[]): GeneratedFile {
  const entries = tools.map(tool => ({
    id: `PV-${tool.name.toUpperCase().replaceAll('_', '-')}`,
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
  return generatedFileSchema.parse(normalize({ format: 1, plugin: 'pecot-visual', prefix: 'PV', entries }))
}

export function serialize(file: unknown): string {
  return `${JSON.stringify(normalize(file), undefined, 2)}\n`
}

export interface RunOptions {
  // 書き出し先。既定は GENERATED_PATH。
  readonly target?: string
  // 書き出す元のツール。既定は tools/list の結果。
  readonly tools?: readonly Tool[]
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? (error.message.split('\n', 1)[0] ?? 'unknown') : 'unknown'
}

function writeTarget(target: string, shown: string, text: string, output: Readonly<Output>): number {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 書き出し先は固定パスか、テストが渡す一時ディレクトリ
    mkdirSync(path.dirname(target), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    writeFileSync(target, text)
  }
  catch (error) {
    output.stderr(`error: cannot write ${shown}: ${reasonOf(error)}\n`)
    return 1
  }
  output.stdout(`wrote: ${shown}\n`)
  return 0
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型
function checkTarget(target: string, shown: string, generated: GeneratedFile, output: Readonly<Output>): number {
  let lines: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 書き出し先は固定パスか、テストが渡す一時ディレクトリ
    const current = readFileSync(target, 'utf8')
    if (current === serialize(generated)) return 0
    lines = diffGenerated(generatedFileSchema.parse(JSON.parse(current)), generated)
  }
  catch (error) {
    output.stderr(`error: cannot read ${shown}: ${reasonOf(error)}\n  run: ${WRITE_COMMAND}\n`)
    return 1
  }
  for (const line of formatStale(shown, lines, WRITE_COMMAND)) output.stderr(`${line}\n`)
  return 1
}

export async function run(argv: readonly string[], output: Readonly<Output>, options: Readonly<RunOptions> = {}): Promise<number> {
  const [mode, ...rest] = argv
  if ((mode !== '--check' && mode !== '--write') || rest.length > 0) {
    output.stderr(`${USAGE}\n`)
    return 2
  }
  const target = options.target ?? path.join(repositoryRoot(), GENERATED_PATH)
  const relative = path.relative(repositoryRoot(), target)
  const shown = relative.startsWith('..') ? target : relative.split(path.sep).join('/')
  const generated = buildGenerated(options.tools ?? await listTools())
  return mode === '--write' ? writeTarget(target, shown, serialize(generated), output) : checkTarget(target, shown, generated, output)
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- 自分自身の argv
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  })
}
