/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client と stream は mutable */
// シナリオ 1 件を流して、golden と同じ形の結果を作る。parity.test.ts が使う。
// 流れ: 一時 root を用意し、MCP のサーバを子プロセスで起動してツールを 1 回呼び、.pecot/ とデータ置き場を回収し、正規化する。
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

import type { Client } from '@modelcontextprotocol/client'
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { AttachingClient } from '../_helpers/attaching-client.js'
import { outputSchemaIssues, toolOutcomeOf } from '../_helpers/mcp-client.js'
import { step } from '../_helpers/step.js'
import { compareStrings } from './baseline.js'
import type { Golden, Scenario, Substitution } from './scenario.js'
import { normalizeDeep, normalizeText } from './scenario.js'
import { baseEnvironment, createSandbox, destroySandbox, pluginRoot } from './setup.js'

/**
起動する MCP のサーバ
*/
export interface Launcher {
  readonly command: string
  readonly args: readonly string[]
}

export interface Outcome {
  /**
  呼べなかったときは undefined
  */
  readonly golden: Golden | undefined
  /**
  サーバを起動できなかった・呼べなかった理由。呼べたら undefined
  */
  readonly spawnError: string | undefined
  readonly timedOut: boolean
}

export const CHILD_TIMEOUT_MS = 25_000

// データ置き場のうち、比べない置き場所
const DATA_EXCLUDED = new Set(['venv', 'runtime'])

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'
}

function collect(baseDirectory: string, relative: string, prefix: string, files: Map<string, unknown>): void {
  const absolute = path.join(baseDirectory, relative)
  let stat
  try {
    stat = lstatSync(absolute)
  }
  catch (error) {
    // 無いものは飛ばす。権限などそれ以外の失敗は隠さない
    if (isNotFound(error)) return
    throw error
  }
  const key = `${prefix}${relative}`
  if (stat.isSymbolicLink()) {
    files.set(key, { symlink: readlinkSync(absolute) })
  }
  else if (stat.isDirectory()) {
    for (const name of readdirSync(absolute).toSorted(compareStrings)) {
      collect(baseDirectory, path.join(relative, name), prefix, files)
    }
  }
  else {
    files.set(key, readFileSync(absolute, 'utf8'))
  }
}

// 一時 root 直下のサブワークツリー（wt*/<repo>/）の中身。.git は除く。キーは作業リポからの相対にする
function collectWorktrees(root: string, repositoryDirectory: string, files: Map<string, unknown>): void {
  const repositoryName = path.basename(repositoryDirectory)
  for (const name of readdirSync(root).toSorted(compareStrings)) {
    if (!name.startsWith('wt')) continue
    const worktreeDirectory = path.join(root, name, repositoryName)
    const prefix = `${path.relative(repositoryDirectory, worktreeDirectory)}/`
    let entries: string[]
    try {
      entries = readdirSync(worktreeDirectory).toSorted(compareStrings)
    }
    catch (error) {
      // ツールがワークツリーを消した後は、無いものとして次へ進む
      if (isNotFound(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (entry !== '.git') collect(worktreeDirectory, entry, prefix, files)
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

export function collectFiles(root: string, repositoryDirectory: string, dataDirectory: string, substitutions: readonly Substitution[]): Record<string, unknown> {
  const files = new Map<string, unknown>()
  collect(repositoryDirectory, '.pecot', '', files)
  collectWorktrees(root, repositoryDirectory, files)
  for (const name of readdirSync(dataDirectory).toSorted(compareStrings)) {
    if (!DATA_EXCLUDED.has(name)) collect(dataDirectory, name, 'data/', files)
  }
  const sorted = [...files].toSorted(([a], [b]) => compareStrings(a, b))
  const normalized = normalizeDeep(Object.fromEntries(sorted), substitutions)
  return recordOf(normalized)
}

interface Called {
  readonly isError: boolean
  readonly text: string | undefined
  readonly structuredContent: Readonly<Record<string, unknown>>
}

type CallResult
  = | { readonly kind: 'called', readonly called: Called, readonly stderr: string }
    | { readonly kind: 'failed', readonly reason: string, readonly timedOut: boolean }

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close()
  }
  catch {
    // 後始末の失敗は結果に関係しない
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// サーバを起動し、tools/list の outputSchema で結果を確かめながら、ツールを 1 回呼ぶ
async function callOnce(launcher: Launcher, scenario: Scenario, cwd: string, environment: Readonly<Record<string, string>>): Promise<CallResult> {
  const transport = new StdioClientTransport({ command: launcher.command, args: [...launcher.args], env: { ...environment }, cwd, stderr: 'pipe' })
  // 読み切らないと、パイプが埋まった時点でサーバが止まる
  let serverStderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    serverStderr += String(chunk)
  })
  const client = new AttachingClient({ name: 'parity', version: '0.0.0' })
  try {
    await client.connect(transport, { timeout: CHILD_TIMEOUT_MS })
    const listed = await client.listTools(undefined, { timeout: CHILD_TIMEOUT_MS })
    const definition = listed.tools.find(tool => tool.name === scenario.tool)
    if (definition?.outputSchema === undefined) throw new Error(`tools/list に ${scenario.tool} の outputSchema がありません`)
    // toolDefinition を渡すと、client が成功の structuredContent を outputSchema で検証し、合わなければ例外にする
    const result = await client.callTool({ name: scenario.tool, arguments: { ...scenario.arguments } }, { timeout: CHILD_TIMEOUT_MS, toolDefinition: definition })
    const { isError, structured, text } = toolOutcomeOf(result)
    // client は失敗の結果を検証しないので、同じ outputSchema でここで確かめる
    const issues = isError ? await outputSchemaIssues(definition.outputSchema, structured) : []
    if (issues.length > 0) throw new Error(`失敗の structuredContent が outputSchema に合いません: ${issues.join('; ')}`)
    return { kind: 'called', called: { isError, text, structuredContent: structured }, stderr: serverStderr }
  }
  catch (error: unknown) {
    const reason = `${messageOf(error)}${serverStderr === '' ? '' : `\n${serverStderr}`}`
    return { kind: 'failed', reason, timedOut: SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout }
  }
  finally {
    await closeQuietly(client)
  }
}

export async function runScenario(scenario: Scenario, launcher: Launcher): Promise<Outcome> {
  const sandbox = createSandbox(scenario)
  try {
    const environment = { ...baseEnvironment(sandbox), ...scenario.setup.env }
    const cwd = path.resolve(sandbox.repositoryDirectory, scenario.setup.cwd)
    const call = await step(`組み立てたサーバで ${scenario.tool} を呼ぶ`, async () => await callOnce(launcher, scenario, cwd, environment))
    const substitutions: readonly Substitution[] = [
      { from: sandbox.root, to: '{{TMP}}' },
      { from: pluginRoot, to: '{{PLUGIN_ROOT}}' },
    ]
    const normalized = (value: unknown): unknown => normalizeDeep(value, substitutions)
    const golden: Golden | undefined = call.kind === 'failed'
      ? undefined
      : {
          isError: call.called.isError,
          ...call.called.text !== undefined && { text: normalizeText(call.called.text, substitutions) },
          structuredContent: recordOf(normalized(call.called.structuredContent)),
          stderr: normalizeText(call.stderr, substitutions),
          files: collectFiles(sandbox.root, sandbox.repositoryDirectory, sandbox.dataDirectory, substitutions),
        }
    return {
      golden,
      spawnError: call.kind === 'failed' ? call.reason : undefined,
      timedOut: call.kind === 'failed' && call.timedOut,
    }
  }
  finally {
    destroySandbox(sandbox)
  }
}
