// `pecot mcp` が起動のときに移る、セッションのディレクトリの判定。
// GitHub Copilot CLI は、プラグインのサーバをプラグインの root を cwd にして起動する。
import { statSync } from 'node:fs'
import path from 'node:path'

import { normalizePath, resolveRealPath } from '../infra/paths.js'

/**
判定の結果。move は directory へ移る。variable と value は元の環境変数で、移れなかったときの理由に使う。
stay は cwd のまま。undetermined は決められない（reason は stderr にそのまま出せる 1 行）
*/
export type SessionDirectory
  = | { readonly kind: 'move', readonly directory: string, readonly variable: string, readonly value: string }
    | { readonly kind: 'stay' }
    | { readonly kind: 'undetermined', readonly reason: string }

export const UNDETERMINED_PREFIX = 'cannot determine the target repository'

// 空文字は無いものとして扱う
function valueOf(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value: unknown = Object.hasOwn(environment, name) ? Reflect.get(environment, name) : undefined
  return typeof value !== 'string' || value === '' ? undefined : value
}

function isDirectory(target: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ホストが渡したセッションのディレクトリの有無を見る
    return statSync(target).isDirectory()
  }
  catch {
    return false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Containment
  = | { readonly kind: 'inside' | 'outside' }
    | { readonly kind: 'unresolved', readonly reason: string }

// directory の実体パスが root と同じ、または root の配下。無いパスは字句どおりに解くので投げない。
// 投げるのは権限などの失敗で、解決できなかったパスを理由に入れる
function containment(directory: string, root: string): Containment {
  let failed = directory
  try {
    const real = resolveRealPath(directory)
    failed = root
    const rootReal = resolveRealPath(root)
    const isInside = real === rootReal || real.startsWith(rootReal.endsWith('/') ? rootReal : `${rootReal}/`)
    return { kind: isInside ? 'inside' : 'outside' }
  }
  catch (error: unknown) {
    return { kind: 'unresolved', reason: `${UNDETERMINED_PREFIX}: cannot resolve the real path of ${failed}: ${messageOf(error)}` }
  }
}

/**
環境変数の指すディレクトリが使えないときの理由の文。directory は相対パスを cwd で絶対にした値、cause は移るのに失敗した元の文
*/
export function unusableReason(name: string, value: string, directory: string, cause?: string): string {
  const resolved = path.isAbsolute(value) ? '' : ` (resolved to ${directory})`
  return `${UNDETERMINED_PREFIX}: ${name} is not a usable directory: ${value}${resolved}${cause === undefined ? '' : `: ${cause}`}`
}

function moveOrUnusable(name: string, value: string, cwd: string): SessionDirectory {
  const directory = path.resolve(cwd, value)
  return isDirectory(directory)
    ? { kind: 'move', directory: normalizePath(directory), variable: name, value }
    : { kind: 'undetermined', reason: unusableReason(name, value, directory) }
}

// Agent Plugins 1.0 が約束する PLUGIN_ROOT と、Claude Code・Copilot CLI が渡す CLAUDE_PLUGIN_ROOT
const PLUGIN_ROOT_VARIABLES = ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']

/**
サーバが対象のリポを見るディレクトリを決める。条件の表は specs/020-workflow-ts-mcp/contracts/mcp-tools.md の「対象のリポ」。
相対パスの変数は、移る前の cwd を起点にして絶対パスへ直す
*/
export function resolveSessionDirectory(environment: Readonly<Record<string, string | undefined>>, cwd: string): SessionDirectory {
  // cwd がプラグインの root の中でなければ、ホストがセッションのディレクトリを cwd にして起動している
  let isInsidePlugin = false
  for (const name of PLUGIN_ROOT_VARIABLES) {
    const value = valueOf(environment, name)
    if (value === undefined) continue
    const result = containment(cwd, path.resolve(cwd, value))
    if (result.kind === 'unresolved') return { kind: 'undetermined', reason: result.reason }
    isInsidePlugin ||= result.kind === 'inside'
  }
  if (!isInsidePlugin) return { kind: 'stay' }

  const session = valueOf(environment, 'COPILOT_SESSION_CWD')
  if (session !== undefined) return moveOrUnusable('COPILOT_SESSION_CWD', session, cwd)
  // COPILOT_PLUGIN_ROOT があれば Copilot CLI の起動で、CLAUDE_PROJECT_DIR は起動したシェルから継いだ値
  const project = valueOf(environment, 'CLAUDE_PROJECT_DIR')
  if (project !== undefined && valueOf(environment, 'COPILOT_PLUGIN_ROOT') === undefined) return moveOrUnusable('CLAUDE_PROJECT_DIR', project, cwd)
  return {
    kind: 'undetermined',
    reason: `${UNDETERMINED_PREFIX}: the server was started in the plugin directory (${cwd}) and the host passed no session directory (COPILOT_SESSION_CWD); upgrade GitHub Copilot CLI to 1.0.106 or later, or start the server in the target repository`,
  }
}
