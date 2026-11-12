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

const UNDETERMINED_PREFIX = 'cannot determine the target repository'

// 空文字は無いものとして扱う
function valueOf(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = new Map(Object.entries(environment)).get(name)
  return value === undefined || value === '' ? undefined : value
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

// 実体パスが root と同じ、または root の配下
function isInside(directory: string, root: string): boolean {
  try {
    const real = resolveRealPath(directory)
    const rootReal = resolveRealPath(root)
    return real === rootReal || real.startsWith(rootReal.endsWith('/') ? rootReal : `${rootReal}/`)
  }
  catch {
    // 実体を解決できないときは、プラグインの root の中とは言えない
    return false
  }
}

/**
環境変数の指すディレクトリが使えないときの理由の文
*/
export function unusableReason(name: string, value: string): string {
  return `${UNDETERMINED_PREFIX}: ${name} is not a usable directory: ${value}`
}

function moveOrUnusable(name: string, value: string, cwd: string): SessionDirectory {
  const directory = path.resolve(cwd, value)
  return isDirectory(directory)
    ? { kind: 'move', directory: normalizePath(directory), variable: name, value }
    : { kind: 'undetermined', reason: unusableReason(name, value) }
}

/**
サーバが対象のリポを見るディレクトリを決める。条件の表は specs/020-workflow-ts-mcp/contracts/mcp-tools.md の「対象のリポ」。
相対パスの変数は、移る前の cwd を起点にして絶対パスへ直す
*/
export function resolveSessionDirectory(environment: Readonly<Record<string, string | undefined>>, cwd: string): SessionDirectory {
  const pluginRoot = valueOf(environment, 'CLAUDE_PLUGIN_ROOT')
  // cwd がプラグインの root の中でなければ、ホストがセッションのディレクトリを cwd にして起動している
  if (pluginRoot === undefined || !isInside(cwd, path.resolve(cwd, pluginRoot))) return { kind: 'stay' }

  const session = valueOf(environment, 'COPILOT_SESSION_CWD')
  if (session !== undefined) return moveOrUnusable('COPILOT_SESSION_CWD', session, cwd)
  const project = valueOf(environment, 'CLAUDE_PROJECT_DIR')
  if (project !== undefined) return moveOrUnusable('CLAUDE_PROJECT_DIR', project, cwd)
  return {
    kind: 'undetermined',
    reason: `${UNDETERMINED_PREFIX}: the server was started in the plugin directory (${cwd}) and the host passed no session directory (COPILOT_SESSION_CWD or CLAUDE_PROJECT_DIR); GitHub Copilot CLI passes it from 1.0.106`,
  }
}
