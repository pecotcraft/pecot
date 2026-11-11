/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が渡すプロジェクトルート配下 */
// ワークツリー設定の管理。
//
// プロジェクト単位 wtN 構成（`<root>/base/<repo>` と `<root>/wtN/<repo>`）の設定を扱う。
// 次の 2 ファイルの読み書きを提供する。
//   - `.pecot/config/worktree-config.json` は、シンボリックリンクと setup コマンドを保持する。
//   - `.pecot/config/.worktreeignore`（gitignore 形式）は、コピー除外パターンを定義する。
// 設定ファイルは各リポジトリの main WT ルート（`<root>/base/<repo>/`）に置く。
//
// 検証エラーの文は、Python の CLI（pydantic）が出していた書式に合わせる。
// 不正な JSON の文だけは JSON パーサーのもので、Python の JSONDecodeError の文とは違う。
// main WT の探索（findWorktreeConfigFile）は worktree.ts にある。worktree.ts がこのファイルを読むため、相互の import を避けて置いた。

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PecotError, InvalidValueError } from '../domain/errors.js'
import { isJsonObject, jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { isJsonArray, pythonStrip, ValidationFailure } from '../domain/python-format.js'
import type { JsonValue, ValidationIssue } from '../domain/python-format.js'
import { isDirectory, isFile } from './file-kind.js'
import { runGit } from './git.js'
import { hasErrorCode, OsError, toOsError } from './os-error.js'
import {
  ACTIVE_PROJECT_FILENAME,
  PECOT_DIR,
  PECOT_GITIGNORE_FILENAME,
  HOOKS_CONFIG_FILENAME,
  normalizePath,
  WORK_DIR,
  WORKTREE_IGNORE_FILENAME,
} from './paths.js'
import type { Diagnostics } from './diagnostics.js'
import { compileGitIgnoreSpec } from './gitignore-spec.js'
import type { GitIgnoreSpec } from './gitignore-spec.js'
import { readTextFile } from './text-file.js'
import { pluginRoot } from '../version.js'

// 定数

/**
`pecot worktree init` で生成される .worktreeignore のデフォルト内容
*/
export const DEFAULT_WORKTREEIGNORE_CONTENT = `\
# Git メタデータ
.git/

# Python キャッシュ。
__pycache__/
*.pyc
*.pyo
.venv/
venv/
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/

# カバレッジ
htmlcov/
.coverage

# ビルド生成物
dist/
build/

# JS 依存
node_modules/

# pecot の実行時状態・一時領域（config は worktree-config の links 経由で symlink）
.pecot/
tmp/

# Nx ビルド状態（version-plans は残すので .nx/ 丸ごとは除外しない）
.nx/workspace-data/
`

// .pecot/.gitignore の生成スクリプト。中身の本体は hook 側に置き、CLI は複製せずに呼ぶ
const PECOT_GITIGNORE_ENSURE_RELATIVE = 'hooks/lib/core/pecot-gitignore-ensure.sh'

// 型

export interface SymlinkResult {
  readonly symlinkPath: string
  /**
  ターゲットの絶対パス
  */
  readonly targetPath: string
  readonly action: 'created' | 'skipped' | 'error'
  /**
  追加メッセージ（エラー詳細など）。無ければ空
  */
  readonly message: string
}

/**
ワークツリー設定の操作に失敗した
*/
export class WorktreeConfigError extends PecotError {}

/**
個別リンク定義。キーは設定ファイルの JSON と同じ
*/
export interface WorktreeLinkItem {
  /**
  wt 側リポジトリルートからの相対パス（symlink の配置先）
  */
  readonly path: string
  /**
  base 直下のリポジトリ名（symlink ターゲットの所在）
  */
  readonly target_repo: string
  /**
  `base/<target_repo>/` 配下の相対パス
  */
  readonly target_path: string
  readonly description: string | undefined
}

/**
ワークツリー設定全体（v3）。キーの順は設定ファイルに保存する順
*/
export interface WorktreeConfig {
  readonly version: 3
  readonly description: string | undefined
  readonly links: readonly WorktreeLinkItem[]
  /**
  WT 作成直後にサブ WT ルートで実行するコマンド（shell 経由）
  */
  readonly setup_command: string | undefined
  /**
  setup_command の timeout 秒数。無ければ無制限
  */
  readonly setup_command_timeout: number | undefined
}

// 検証（pydantic の WorktreeConfig と同じ文を作る）

function issueOf(type: string, location: readonly (string | number)[], message: string, input: JsonValue | undefined): ValidationIssue {
  return { type, location, message, input }
}

function valueError(location: readonly (string | number)[], message: string, input: JsonValue): ValidationIssue {
  return issueOf('value_error', location, `Value error, ${message}`, input)
}

function validateRelativePath(value: string, fieldName: string): string | undefined {
  if (value === '' || pythonStrip(value) === '') return `${fieldName} must not be empty`
  if (value.startsWith('/')) return `absolute paths are not allowed: ${value}`
  if (value.split('/').includes('..')) return `parent directory references are not allowed: ${value}`
  return undefined
}

function validateTargetRepository(value: string): string | undefined {
  if (value === '' || pythonStrip(value) === '') return 'target_repo must not be empty'
  if (value.includes('/')) return `target_repo must not contain a slash: ${value}`
  if (value === '..' || value === '.') return `invalid target_repo: ${value}`
  return undefined
}

// 文字列の項目。型が違えば string_type、validate が文を返せば value_error
function parseString(value: JsonValue | undefined, location: readonly (string | number)[], validate?: (text: string) => string | undefined): { readonly issues: readonly ValidationIssue[], readonly value: string | undefined } {
  if (typeof value !== 'string') return { issues: [issueOf('string_type', location, 'Input should be a valid string', value)], value: undefined }
  const message = validate?.(value)
  return message === undefined ? { issues: [], value } : { issues: [valueError(location, message, value)], value: undefined }
}

function parseOptionalString(value: JsonValue | undefined, location: readonly (string | number)[]): { readonly issues: readonly ValidationIssue[], readonly value: string | undefined } {
  return value === undefined || value === null ? { issues: [], value: undefined } : parseString(value, location)
}

function parseRequiredString(object: JsonObject, key: string, location: readonly (string | number)[], validate: (text: string) => string | undefined): { readonly issues: readonly ValidationIssue[], readonly value: string } {
  const value = jsonField(object, key)
  if (value === undefined) return { issues: [issueOf('missing', location, 'Field required', object)], value: '' }
  const parsed = parseString(value, location, validate)
  return { issues: parsed.issues, value: parsed.value ?? '' }
}

function parseLinkItem(item: JsonValue, index: number): { readonly issues: readonly ValidationIssue[], readonly link: WorktreeLinkItem } {
  const base = ['links', index]
  const placeholder: WorktreeLinkItem = { path: '', target_repo: '', target_path: '', description: undefined }
  if (!isJsonObject(item)) {
    return { issues: [issueOf('model_type', base, 'Input should be a valid dictionary or instance of WorktreeLinkItem', item)], link: placeholder }
  }
  const pathField = parseRequiredString(item, 'path', [...base, 'path'], text => validateRelativePath(text, 'path'))
  const repositoryField = parseRequiredString(item, 'target_repo', [...base, 'target_repo'], validateTargetRepository)
  const targetPathField = parseRequiredString(item, 'target_path', [...base, 'target_path'], text => validateRelativePath(text, 'target_path'))
  const descriptionField = parseOptionalString(jsonField(item, 'description'), [...base, 'description'])
  return {
    issues: [...pathField.issues, ...repositoryField.issues, ...targetPathField.issues, ...descriptionField.issues],
    link: { path: pathField.value, target_repo: repositoryField.value, target_path: targetPathField.value, description: descriptionField.value },
  }
}

function parseLinks(value: JsonValue | undefined): { readonly issues: readonly ValidationIssue[], readonly links: readonly WorktreeLinkItem[] } {
  if (value === undefined) return { issues: [], links: [] }
  if (!isJsonArray(value)) return { issues: [issueOf('list_type', ['links'], 'Input should be a valid list', value)], links: [] }
  const parsed = value.map((item, index) => parseLinkItem(item, index))
  return { issues: parsed.flatMap(entry => entry.issues), links: parsed.map(entry => entry.link) }
}

// int の lax な変換。bool は 0・1、前後の空白・符号・数字の間の `_`・小数部が 0 だけの文字列は整数にする
function convertToInteger(value: JsonValue): { readonly value: number } | { readonly type: string, readonly message: string } {
  if (typeof value === 'boolean') return { value: value ? 1 : 0 }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { value } : { type: 'int_from_float', message: 'Input should be a valid integer, got a number with a fractional part' }
  }
  if (typeof value === 'string') {
    const text = pythonStrip(value)
    if (text.replace(/^[+-]/u, '').split('_').every(group => /^\d+$/u.test(group))) return { value: Number(text.replaceAll('_', '')) }
    if (/^[+-]?\d+\.0*$/u.test(text)) return { value: Number(text.slice(0, text.indexOf('.'))) }
    return { type: 'int_parsing', message: 'Input should be a valid integer, unable to parse string as an integer' }
  }
  return { type: 'int_type', message: 'Input should be a valid integer' }
}

function parseTimeout(value: JsonValue | undefined): { readonly issues: readonly ValidationIssue[], readonly value: number | undefined } {
  if (value === undefined || value === null) return { issues: [], value: undefined }
  const location = ['setup_command_timeout']
  const converted = convertToInteger(value)
  if ('type' in converted) return { issues: [issueOf(converted.type, location, converted.message, value)], value: undefined }
  if (converted.value <= 0) return { issues: [valueError(location, `setup_command_timeout must be a positive integer: ${String(converted.value)}`, value)], value: undefined }
  return { issues: [], value: converted.value }
}

/**
JSON の値から WorktreeConfig を作る。形が不正なら ValidationFailure（表題は WorktreeConfig）。
未知のキーは無視する
*/
export function parseWorktreeConfig(data: JsonValue): WorktreeConfig {
  if (!isJsonObject(data)) {
    throw new ValidationFailure('WorktreeConfig', [issueOf('model_type', [], 'Input should be a valid dictionary or instance of WorktreeConfig', data)])
  }
  const version = jsonField(data, 'version')
  const versionIssues = version === undefined || version === 3 ? [] : [issueOf('literal_error', ['version'], 'Input should be 3', version)]
  const description = parseOptionalString(jsonField(data, 'description'), ['description'])
  const links = parseLinks(jsonField(data, 'links'))
  const setupCommand = parseOptionalString(jsonField(data, 'setup_command'), ['setup_command'])
  const timeout = parseTimeout(jsonField(data, 'setup_command_timeout'))
  const issues = [...versionIssues, ...description.issues, ...links.issues, ...setupCommand.issues, ...timeout.issues]
  if (issues.length > 0) throw new ValidationFailure('WorktreeConfig', issues)
  return { version: 3, description: description.value, links: links.links, setup_command: setupCommand.value, setup_command_timeout: timeout.value }
}

// 設定操作関数

/**
JSON ファイルから WorktreeConfig を読む。ファイルが無い・JSON が不正・検証に失敗したら WorktreeConfigError
*/
export function loadConfig(file: string): WorktreeConfig {
  const shown = normalizePath(file)
  if (!existsSync(file)) throw new WorktreeConfigError(`config file not found: ${shown}`)

  let data: JsonValue
  try {
    data = parseJsonText(readTextFile(file))
  }
  catch (error: unknown) {
    // 文言は JSON パーサーのもので、Python の JSONDecodeError の文とは違う
    if (error instanceof InvalidValueError) throw new WorktreeConfigError(`JSON parse error: ${shown}: ${error.message}`, { cause: error })
    throw error
  }

  try {
    return parseWorktreeConfig(data)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) throw new WorktreeConfigError(`config file validation failed: ${shown}: ${error.message}`, { cause: error })
    throw error
  }
}

/**
WorktreeConfig を JSON ファイルに保存する。値の無い項目は出さず、非 ASCII の文字はそのまま出す。親ディレクトリが無ければ作る
*/
export function saveConfig(config: Readonly<WorktreeConfig>, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, undefined, 2)}\n`)
}

// Python の str.splitlines() が行を分ける文字。読んだ後の改行は \n に揃っているが、これらでも分ける
const LINE_BREAKS: ReadonlySet<string> = new Set(['\n', '\v', '\f', '\u{1C}', '\u{1D}', '\u{1E}', '\u{85}', '\u{2028}', '\u{2029}'])

function splitLines(text: string): readonly string[] {
  const lines: string[] = []
  let current = ''
  for (const character of text) {
    if (LINE_BREAKS.has(character)) {
      lines.push(current)
      current = ''
    }
    else {
      current += character
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
メイン WT 配下の .worktreeignore を gitignore の仕様として読む。
空行と `#` 行は読み飛ばす。

不正な gitignore パターンのうち、範囲の記法が不正なものは何にも当たらない扱いで残る。
空行・コメント行を除いた有効行が 1 つ以上あるのに、何かに当たりうるパターンが 1 本も載らなかったときは warning を出す。

.worktreeignore が無ければ WorktreeConfigError
*/
export function loadCopyExcludeSpec(mainWorktree: string, diagnostics: Diagnostics): GitIgnoreSpec {
  const file = path.join(mainWorktree, WORKTREE_IGNORE_FILENAME)
  if (!existsSync(file)) {
    throw new WorktreeConfigError(`copy exclude config not found: ${WORKTREE_IGNORE_FILENAME}\n  run pecot worktree init to generate the template`)
  }

  const rawLines = splitLines(readTextFile(file))
  const effectiveLines = rawLines.filter(line => pythonStrip(line) !== '' && !pythonStrip(line).startsWith('#'))
  const spec = compileGitIgnoreSpec(rawLines)

  // `/` 単体や空白のみの行などは、何にも当たらないパターンになる。それしか残らなかったら意図通りではない可能性が高い
  if (effectiveLines.length > 0 && spec.matchablePatternCount === 0) {
    diagnostics.warning(`all patterns in ${normalizePath(file)} are invalid (${String(effectiveLines.length)} effective lines silently ignored): check the gitignore syntax`)
  }
  return spec
}

function createLink(link: Pick<WorktreeLinkItem, 'path' | 'target_repo' | 'target_path'> & { readonly description: string }): WorktreeLinkItem {
  return link
}

/**
デフォルト設定のテンプレート。CLAUDE.local.md / .env / .claude/settings.local.json の 3 リンクを含む。
selfRepository を指定すると、hooks-config.json / projects/.active / .pecot/work のリンク（自リポの main WT を指す）も含む
*/
export function getDefaultConfig(targetRepository: string, selfRepository?: string): WorktreeConfig {
  const links = [
    createLink({ path: 'CLAUDE.local.md', target_repo: targetRepository, target_path: 'CLAUDE.local.md', description: 'ローカル向け CLAUDE 指示（Git 管理外）' }),
    createLink({ path: '.env', target_repo: targetRepository, target_path: '.env', description: '環境変数（Git 管理外）' }),
    createLink({ path: '.claude/settings.local.json', target_repo: targetRepository, target_path: '.claude/settings.local.json', description: 'Claude Code のローカル設定' }),
  ]
  if (selfRepository !== undefined) {
    links.push(
      createLink({ path: HOOKS_CONFIG_FILENAME, target_repo: selfRepository, target_path: HOOKS_CONFIG_FILENAME, description: 'pecot hooks 有効/無効設定（main WT と共有）' }),
      createLink({ path: ACTIVE_PROJECT_FILENAME, target_repo: selfRepository, target_path: ACTIVE_PROJECT_FILENAME, description: 'active project ポインタ（main WT と共有）' }),
      createLink({ path: WORK_DIR, target_repo: selfRepository, target_path: WORK_DIR, description: `作業ファイル置き場（main WT の ${WORK_DIR} を共有）` }),
    )
  }
  return {
    version: 3,
    description: 'wtN/<repo> から base/<target_repo>/<target_path> への相対 symlink 設定。 target_repo は WT 間で共有したいファイルを置くメインリポ名に置換し、 不要な link は削除してください。',
    links,
    setup_command: undefined,
    setup_command_timeout: undefined,
  }
}

// Symlink 生成

function resolveAbsoluteTarget(projectRoot: string, link: Readonly<WorktreeLinkItem>): string {
  return path.join(projectRoot, 'base', link.target_repo, link.target_path)
}

/**
repositoryRoot のリポジトリで relativePath が tracked かどうか。対象がディレクトリでも、配下の tracked file が返るので拾える。
.git 不在・git CLI 不在・cwd 不在などの異常系は false（ガード無し）に倒す
*/
function isTrackedInRepository(repositoryRoot: string, relativePath: string): boolean {
  try {
    const result = runGit(['ls-files', '--', relativePath], { cwd: repositoryRoot })
    return result.exitCode === 0 && result.stdout.trim() !== ''
  }
  catch (error: unknown) {
    if (error instanceof OsError) return false
    throw error
  }
}

function isSymbolicLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink()
  }
  catch {
    return false
  }
}

/**
リアルファイル／ディレクトリが配置先にあるときの上書き可否の判定。既存の symlink は常に張り替えるので呼ばれない
*/
export type OverwriteStrategy = (symlinkPath: string, targetPath: string) => boolean

// 1 本の link 定義を、実際のファイルシステム操作に変換する
function processLink(link: Readonly<WorktreeLinkItem>, projectRoot: string, worktreeRoot: string, canOverwrite: OverwriteStrategy, diagnostics: Diagnostics): SymlinkResult {
  const symlinkPath = path.join(worktreeRoot, link.path)
  const targetPath = resolveAbsoluteTarget(projectRoot, link)

  if (!existsSync(targetPath)) {
    const message = isSymbolicLink(targetPath) ? `target is a dangling symlink: ${targetPath}` : `target does not exist: ${targetPath}`
    diagnostics.warning(message)
    return { symlinkPath, targetPath, action: 'skipped', message }
  }

  let relativeTarget = path.relative(path.dirname(symlinkPath), targetPath)
  try {
    mkdirSync(path.dirname(symlinkPath), { recursive: true })
    // 親が symlink 経由でも解決できるよう、実体の親ディレクトリからの相対にする
    relativeTarget = path.relative(realpathSync(path.dirname(symlinkPath)), targetPath)

    if (isSymbolicLink(symlinkPath)) {
      unlinkSync(symlinkPath)
    }
    else if (existsSync(symlinkPath)) {
      if (isTrackedInRepository(worktreeRoot, link.path)) {
        diagnostics.warning(`symlink creation skipped because the path is tracked by git: ${symlinkPath}`)
        return { symlinkPath, targetPath, action: 'error', message: `symlink creation aborted because the path is tracked by git: ${link.path}` }
      }
      if (!canOverwrite(symlinkPath, targetPath)) {
        return { symlinkPath, targetPath, action: 'skipped', message: `a real file exists: ${symlinkPath}` }
      }
      if (isDirectory(symlinkPath)) rmSync(symlinkPath, { recursive: true })
      else unlinkSync(symlinkPath)
    }

    symlinkSync(relativeTarget, symlinkPath)
    return { symlinkPath, targetPath, action: 'created', message: '' }
  }
  catch (error: unknown) {
    if (!hasErrorCode(error)) throw error
    const converted = toOsError(error)
    const message = converted instanceof Error ? converted.message : String(converted)
    diagnostics.warning(`failed to create the symlink: ${symlinkPath} -> ${relativeTarget}: ${message}`)
    return { symlinkPath, targetPath, action: 'error', message }
  }
}

/**
.pecot/.gitignore の生成スクリプトのパス。
bin/pecot が export する CLAUDE_PLUGIN_ROOT を起点にし、無ければソースツリーの plugin ルートを起点にする。
スクリプトの有無は問わない（無ければ呼び出し側の警告に、見当違いでない候補パスが出る）
*/
export function pecotGitignoreEnsureScript(): string {
  return path.join(pluginRoot(), PECOT_GITIGNORE_ENSURE_RELATIVE)
}

// .pecot/ 配下へ link を張る前に、WT の .pecot/.gitignore を用意する（#1219）。
// link 先の symlink（hooks-config.json・projects/・work 等）は .pecot/.gitignore が ignore する前提。
// ただしこのファイルを作るのは Claude Code の hook だけで、既定の .worktreeignore は .pecot/ をコピー対象から外す。
// そのため WT を作った直後は symlink が未追跡として出る。symlink にした .gitignore は git が読まないので実ファイルで置く。
// 生成に失敗しても link 作成は続ける（未追跡が見えるだけで、作業は妨げない）
function ensurePecotGitignore(config: Readonly<WorktreeConfig>, worktreeRoot: string, diagnostics: Diagnostics): void {
  if (config.links.every(link => !link.path.startsWith(`${PECOT_DIR}/`))) return
  const script = pecotGitignoreEnsureScript()
  if (!isFile(script)) {
    diagnostics.warning(`generation script for ${PECOT_GITIGNORE_FILENAME} not found: ${script}`)
    return
  }
  const result = spawnSync('bash', [script], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: worktreeRoot },
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw toOsError(result.error)
  if (result.status !== 0) diagnostics.warning(`could not generate ${PECOT_GITIGNORE_FILENAME}: ${result.stderr.trim()}`)
}

/**
シンボリックリンクを作る（既存ファイル／ディレクトリは常に上書き）
*/
export function createSymlinks(config: Readonly<WorktreeConfig>, projectRoot: string, worktreeRoot: string, diagnostics: Diagnostics): readonly SymlinkResult[] {
  ensurePecotGitignore(config, worktreeRoot, diagnostics)
  return config.links.map(link => processLink(link, projectRoot, worktreeRoot, () => true, diagnostics))
}

export interface SafeSymlinkOptions {
  /**
  true なら、リアルファイル／ディレクトリを上書きする
  */
  readonly force?: boolean | undefined
  /**
  force でないときの上書き可否の確認。無ければ上書きしない
  */
  readonly confirm?: OverwriteStrategy | undefined
}

/**
シンボリックリンクを安全に作る。リアルファイル／ディレクトリがあるとき、force または confirm で上書き可否を決める
*/
export function createSymlinksSafe(config: Readonly<WorktreeConfig>, projectRoot: string, worktreeRoot: string, diagnostics: Diagnostics, options: Readonly<SafeSymlinkOptions> = {}): readonly SymlinkResult[] {
  const canOverwrite: OverwriteStrategy = (symlinkPath, targetPath) => options.force === true || (options.confirm?.(symlinkPath, targetPath) ?? false)
  ensurePecotGitignore(config, worktreeRoot, diagnostics)
  return config.links.map(link => processLink(link, projectRoot, worktreeRoot, canOverwrite, diagnostics))
}
