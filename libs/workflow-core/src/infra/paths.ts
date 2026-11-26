/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。ここは解決だけ */
// pecot リポジトリ基準のパス解決。`.pecot/` 配下のパス定義の唯一の置き場。
// projectRoot() でプロジェクトルートを解決する。

import { realpathSync } from 'node:fs'
import path from 'node:path'

import { ProjectRootNotFoundError } from '../domain/errors.js'
import { gitToplevel } from './git.js'
import { isFileNotFound, hasErrorCode } from './os-error.js'

// プロジェクトルート基準の相対パス
export const PECOT_DIR = '.pecot'
// フック状態の保存先
export const STATE_DIR = `${PECOT_DIR}/state`
// 人・エージェントの作業ファイル置き場（タスク ID = Issue 番号単位）
export const WORK_DIR = `${PECOT_DIR}/work`
// 設定ファイルの置き場
export const CONFIG_DIR = `${PECOT_DIR}/config`
// CLI / hooks 専用の一時ファイル置き場
export const TMP_DIR = `${PECOT_DIR}/tmp`
// MCP の instructions が案内する、テンプレートの写しの置き場
export const OUTPUT_DIR = `${TMP_DIR}/output`

// .pecot/ 配下の生成物を git 管理外にする ignore（hook と pecot worktree が生成）
export const PECOT_GITIGNORE_FILENAME = `${PECOT_DIR}/.gitignore`

// ワークツリー設定（symlink / setup_command）
export const WORKTREE_CONFIG_FILENAME = `${CONFIG_DIR}/worktree-config.json`
// ワークツリー作成時のコピー除外パターン（gitignore 形式）
export const WORKTREE_IGNORE_FILENAME = `${CONFIG_DIR}/.worktreeignore`
// フック設定
export const HOOKS_CONFIG_FILENAME = `${CONFIG_DIR}/hooks-config.json`
// アクティブなプロジェクト設定のポインタ
export const ACTIVE_PROJECT_FILENAME = `${CONFIG_DIR}/projects/.active`

/**
パス文字列を Python の Path と同じ形にする（空のセグメントと `.` を落とし、末尾のスラッシュを落とす）
*/
export function normalizePath(text: string): string {
  const segments = text.split('/').filter(segment => segment !== '' && segment !== '.')
  return `${text.startsWith('/') ? '/' : ''}${segments.join('/')}` || '.'
}

/**
シンボリックリンクを解決した絶対パス。存在しない部分は、存在する最も深い親を解決して字句どおりにつなぐ（Python の Path.resolve()）
*/
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target)
  try {
    return realpathSync(absolute)
  }
  catch (error: unknown) {
    const parent = path.dirname(absolute)
    if (parent !== absolute && isFileNotFound(error)) return path.join(resolveRealPath(parent), path.basename(absolute))
    throw error
  }
}

export interface ProjectRootOptions {
  /**
  起点のディレクトリ。省略すると呼び出し元の作業ディレクトリ
  */
  readonly cwd?: string | undefined
}

function currentDirectory(options: Readonly<ProjectRootOptions>): string | undefined {
  try {
    return options.cwd ?? process.cwd()
  }
  catch (error: unknown) {
    // 作業ディレクトリが消えているとき
    if (hasErrorCode(error)) return undefined
    throw error
  }
}

/**
プロジェクトルートを取得する。
1. CLAUDE_PROJECT_DIR があれば使う（テスト上書き用）。
2. なければ git rev-parse --show-toplevel で解決する（GIT_* を除いて実行する）。

どれも得られなければ ProjectRootNotFoundError
*/
export function projectRoot(options: Readonly<ProjectRootOptions> = {}): string {
  const fromEnvironment = process.env['CLAUDE_PROJECT_DIR']
  if (fromEnvironment !== undefined && fromEnvironment !== '') return normalizePath(fromEnvironment)

  const cwd = currentDirectory(options)

  // git push 等のフック内では GIT_DIR 等が設定され、作業ディレクトリの代わりに参照される。
  // そのため GIT_* を除いて作業ディレクトリ基準で解決する
  const toplevel = gitToplevel({ cwd, stripGitEnvironment: true })
  if (toplevel !== undefined) return toplevel

  throw new ProjectRootNotFoundError('project root not found: run inside a git repository or set the CLAUDE_PROJECT_DIR environment variable')
}

function normalizedDataDirectory(raw: string | undefined): string | undefined {
  const value = raw?.replace(/[\r\n]+$/u, '')
  return value === undefined || value === '' || value.startsWith('${') || !value.startsWith('/') ? undefined : value
}

const DATA_DIRECTORY_PROJECT = 'pecot-workflow'

/**
データ置き場。作らずに値を返す。有効な HOME と有効な XDG_DATA_HOME がどちらも無いときは undefined。

bin/_lib.sh の plugin_data_dir_resolve と同じ解決順で、同じ入力なら同じ結果になる。
この対応は infra/tests/paths.test.ts が固定する。
順序は CLAUDE_PLUGIN_DATA、PLUGIN_DATA、XDG_DATA_HOME、HOME。
有効な値は、空でない絶対パスだけ。
先頭が変数展開の書式（ドル記号と開き波括弧）の値は無効とする。
末尾の改行と CR は落とす。
XDG_DATA_HOME の下は `pecot/pecot-workflow`、HOME の下は `.local/share/pecot/pecot-workflow`
*/
export function dataDirectory(): string | undefined {
  const client = normalizedDataDirectory(process.env['CLAUDE_PLUGIN_DATA']) ?? normalizedDataDirectory(process.env['PLUGIN_DATA'])
  if (client !== undefined) return client
  const xdg = normalizedDataDirectory(process.env['XDG_DATA_HOME'])
  if (xdg !== undefined) return `${xdg}/pecot/${DATA_DIRECTORY_PROJECT}`
  const home = normalizedDataDirectory(process.env['HOME'])
  return home === undefined ? undefined : `${home}/.local/share/pecot/${DATA_DIRECTORY_PROJECT}`
}
