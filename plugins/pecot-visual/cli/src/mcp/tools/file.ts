// PostToolUse の mcp_tool フックが呼ぶ 3 ツール（file_lint・file_validate・file_brief）。
// 結果は command フックの stdout と同じに読まれるので、text は JSON のオブジェクト 1 つにし、isError を付けない。
/* eslint-disable security/detect-non-literal-fs-filename -- 編集されたファイルと、プラグインの同梱物のパスだけを扱う */
// ToolCallContext.signal（AbortSignal）は readonly にできない。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { executeSlideTheme } from '../../commands/slidev-project/theme.js'
import { isRecord } from '../../domain/_shared/json.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import type { DeckLintInput } from '../../domain/slidev-theme/deck-lint-input.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import { DEPENDENCY_RECOVERY_HINT } from '../../infra/_shared/dependency-root.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { spawnPromise } from '../../infra/_shared/process.js'
import { resolveEslintBin } from '../../infra/slidev-project/eslint-runner.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import type { ToolCallContext, ToolDefinition } from '../server.js'
import { formatError } from './_shared.js'

// 文脈の上限は UTF-8 のバイト数（Copilot CLI の上限がバイトのため）。
const CONTEXT_MAX_LAYOUT = 3500
const CONTEXT_MAX_ESLINT = 3500
const CONTEXT_MAX_TEXT_LINT = 3000
const CONTEXT_MAX_REFERENCES = 3000

const ESLINT_TIMEOUT_MS = 30_000
const TEXT_LINT_TIMEOUT_MS = 20_000
const VALIDATOR_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 10_000

const TIMEOUT_EXIT_CODE = 124
const CRASH_BANNER = 'Oops! Something went wrong'
const RECOVERY_LINE = `To restore it, ${DEPENDENCY_RECOVERY_HINT}.`
const UNLINKED_RECOVERY_LINE = 'Relinking node_modules with slide_sync (node_modules_only: true) restores it.'
const LAYOUT_SECTION_KEYS: readonly string[] = ['status', 'best_practices', 'anti_patterns']

const fileInput = z.object({
  file_path: z.string().describe('Absolute path of the file that was written or edited (the hook passes tool_input.file_path)'),
  cwd: z.string().optional().describe('Working directory of the session. Text rules for a file outside a git repository read .textlintignore from here'),
})

const fileOutput = z.object({
  hookSpecificOutput: z.strictObject({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().describe('Notice passed to the agent'),
  }).optional().describe('Present only when there is something to tell the agent'),
})

type FileInput = z.infer<typeof fileInput>

interface HookOutput {
  readonly hookSpecificOutput?: { readonly hookEventName: 'PostToolUse', readonly additionalContext: string }
}

/**
返すオブジェクトを text 1 ブロックと structuredContent の両方に載せる。
*/
function hookResult(additionalContext?: string): CallToolResult {
  const output: HookOutput = additionalContext === undefined
    ? {}
    : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output } }
}

/**
1 行目に `<kind>: `、2 行目以降に空白 2 つを付ける。空行は空のまま残す。
*/
export function hookMessage(kind: 'warning', text: string): string {
  return text.replace(/\n+$/, '').split('\n')
    .map((line, index) => (index === 0 ? `${kind}: ${line}` : (line === '' ? '' : `  ${line}`)))
    .join('\n')
}

interface CappedContext {
  readonly body: string
  // 切ったときだけ "Truncated at ..." の 1 行
  readonly note: string
}

/**
本文を UTF-8 のバイト数で行単位に切る。切ったら、残りの行のうち `item` に合う数を note に書く。
*/
export function capContext(max: number, item: RegExp, unit: string, text: string): CappedContext {
  const lines = text.replace(/\n+$/, '').split('\n')
  let size = 0
  let cut: number | undefined
  for (const [index, line] of lines.entries()) {
    const cost = Buffer.byteLength(line) + (index === 0 ? 0 : 1)
    if (size + cost > max) {
      cut = index
      break
    }
    size += cost
  }
  if (cut === undefined) return { body: lines.join('\n'), note: '' }
  const rest = lines.slice(Math.max(cut, 1)).filter(line => item.test(line)).length
  const body = cut === 0 ? headWithinBytes(lines[0] ?? '', max) : lines.slice(0, cut).join('\n')
  return { body, note: `Truncated at ${String(max)} bytes: ${String(rest)} more ${unit} not shown.` }
}

function headWithinBytes(line: string, max: number): string {
  let head = ''
  for (const character of line) {
    if (Buffer.byteLength(head + character) > max) break
    head += character
  }
  return head
}

function withNote(capped: Readonly<CappedContext>): string {
  return capped.note === '' ? '' : `\n${capped.note}`
}

/**
編集されたファイルの位置。dir は論理パス（symlink を解かない）。
*/
interface EditedFile {
  readonly filePath: string
  readonly directory: string
  readonly talkRoot: string | undefined
  // talkRoot からの相対パス。talk-dir の外なら undefined
  readonly relative: string | undefined
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  }
  catch {
    return false
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  }
  catch {
    return false
  }
}

/**
`slides.md` と `pages/` を持つ最も近い上の dir。論理パスで遡る（pages/ が talk-dir の外への symlink でも見失わない）。
*/
export function findTalkRoot(directory: string): string | undefined {
  let current = directory
  while (current !== '' && current !== path.dirname(current)) {
    if (isFile(path.join(current, 'slides.md')) && isDirectory(path.join(current, 'pages'))) return current
    current = path.dirname(current)
  }
  return undefined
}

function locateFile(input: Readonly<FileInput>): EditedFile | undefined {
  if (input.file_path === '') return undefined
  const filePath = path.resolve(input.cwd ?? process.cwd(), input.file_path)
  const directory = path.dirname(filePath)
  const talkRoot = isDirectory(directory) ? findTalkRoot(directory) : undefined
  const relative = talkRoot === undefined
    ? undefined
    : [path.relative(talkRoot, directory), path.basename(filePath)].filter(part => part !== '').join('/')
  return { filePath, directory, talkRoot, relative }
}

function isPagesMarkdown(relative: string | undefined): boolean {
  return relative?.startsWith('pages/') === true && relative.endsWith('.md')
}

// deck lint の対象。text lint は二重に報告しないよう、ここを飛ばす。
function isDeckLintTarget(relative: string | undefined): boolean {
  return isPagesMarkdown(relative) || relative === 'slides.md'
}

function physicalPath(target: string): string {
  try {
    return realpathSync(target)
  }
  catch {
    return target
  }
}

function assetsDirectory(): string {
  return physicalPath(path.join(resolvePluginRoot(), 'assets', 'slidev'))
}

type ThemeLint = { readonly ok: true, readonly lint: DeckLintInput, readonly directory: string }
  | { readonly ok: false, readonly reason: string | undefined, readonly detail: string }

async function readThemeLint(talkRoot: string): Promise<ThemeLint> {
  try {
    const { data } = await executeSlideTheme({ dir: talkRoot }, { files: new NodeThemeFiles() })
    return { ok: true, lint: data.lint, directory: data.theme.directory }
  }
  catch (error: unknown) {
    return { ok: false, reason: themeErrorReason(error), detail: formatError(error) }
  }
}

/**
テーマを読めなかった理由の文。eslint は theme-unlinked・theme-none 以外の theme-* を「宣言を読めない」と書く。
*/
function themeFailureLine(theme: Readonly<{ reason: string | undefined, detail: string }>, isDeclarationWording = false): string {
  if (theme.reason === 'theme-unlinked') {
    return `The theme could not be resolved (reason: theme-unlinked). ${theme.detail}\n${UNLINKED_RECOVERY_LINE}`
  }
  if (theme.reason === undefined) return `The theme declaration could not be fetched (${theme.detail}).`
  if (isDeclarationWording && theme.reason !== 'theme-none') {
    return `The theme declaration could not be read (reason: ${theme.reason}). ${theme.detail}`
  }
  return `The theme could not be resolved (reason: ${theme.reason}). ${theme.detail}`
}

function exitLabel(result: Readonly<SpawnResult>): string {
  if (result.timedOut) return String(TIMEOUT_EXIT_CODE)
  return result.exitCode === null ? `signal ${result.signal ?? 'unknown'}` : String(result.exitCode)
}

function combinedOutput(result: Readonly<SpawnResult>): string {
  return [result.stdout, result.stderr].filter(text => text !== '').join('\n').replace(/\n+$/, '')
}

function headLines(text: string): string {
  return text.split('\n').slice(0, 10).join('\n')
}

async function guarded(notify: (reason: string) => CallToolResult, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  }
  catch (error: unknown) {
    return notify(`An unexpected error stopped the check: ${formatError(error)}`)
  }
}

// --- file_lint ---

async function lintWithEslint(file: Readonly<EditedFile>, talkRoot: string, relative: string, call: Readonly<ToolCallContext>): Promise<CallToolResult> {
  const notify = (reason: string): CallToolResult => hookResult(hookMessage('warning',
    `eslint not run: ${file.filePath}\n${reason}\nNo eslint result exists for this file, so violations have not been detected.`))
  return guarded(notify, async () => {
    const assets = assetsDirectory()
    const theme = await readThemeLint(talkRoot)
    let eslintBin: string | undefined
    try {
      eslintBin = resolveEslintBin(assets)
    }
    catch {
      eslintBin = undefined
    }
    const deckLintConfig = path.join(assets, 'deck-lint.env.config.js')
    const missing = [
      ...(eslintBin === undefined || !isFile(eslintBin) ? ['node_modules/eslint'] : []),
      ...(isFile(deckLintConfig) ? [] : ['deck-lint.env.config.js']),
    ]
    if (eslintBin === undefined || missing.length > 0) {
      const themeDirectory = theme.ok ? theme.directory : 'unresolved'
      return notify(`The lint environment is incomplete (missing: ${missing.join(', ')} / theme: ${themeDirectory}).\n${RECOVERY_LINE}`)
    }
    if (!theme.ok) return notify(themeFailureLine(theme, true))

    // 相対パスを物理の cwd で渡す。絶対パスだと symlink をまたいだときに base path の外と判定される。
    const result = await spawnPromise(process.execPath, [eslintBin, '--no-fix', '--config', deckLintConfig, relative], {
      cwd: physicalPath(talkRoot),
      // interface-env: none
      env: { ...process.env, PECOTV_DECK_LINT: JSON.stringify(theme.lint) },
      timeoutMs: ESLINT_TIMEOUT_MS,
      signal: call.signal,
    })
    const output = combinedOutput(result)

    if (!result.timedOut && result.exitCode === 0) {
      if (output.includes('outside of base path')) {
        return hookResult(hookMessage('warning', `eslint skipped: ${file.filePath}\n\n`
          + `eslint did not lint the file because it judged the file to be outside its base path (talk root: ${talkRoot} / eslint argument: ${relative}). `
          + 'No lint ran, so violations in this file have not been detected.'))
      }
      if (output.includes('no matching configuration')) {
        return notify(`eslint judged the file to be outside its configuration (eslint argument: ${relative} / talk root: ${talkRoot}). `
          + 'The path is a lint target, so the eslint config may be inconsistent.')
      }
      // node の警告などの未知の出力は、違反として報告しない。
      return hookResult()
    }

    const isCrashed = output.includes(CRASH_BANNER)
    if (!isCrashed && output !== '' && result.exitCode === 1 && !result.timedOut) {
      const capped = capContext(CONTEXT_MAX_ESLINT, /^\s+\d+:\d+\s/, 'violations', output.replace(/^\s*\n/, ''))
      return hookResult(hookMessage('warning', `eslint violations: ${file.filePath}\n\n${capped.body}\n\n`
        + `The output above lists the eslint violations in this file.${withNote(capped)}`))
    }

    const head = headLines(output)
    return notify(`${eslintFailureReason(result, isCrashed)}.${head === '' ? '' : `\neslint output: ${head}`}`)
  })
}

function eslintFailureReason(result: Readonly<SpawnResult>, isCrashed: boolean): string {
  if (isCrashed) return `eslint crashed (exit ${exitLabel(result)} / config resolution failure, plugin load failure, etc.)`
  if (result.timedOut) return 'eslint timed out (over 30 seconds)'
  if (result.exitCode === 2) return 'eslint exited with a fatal error (exit 2 / config resolution failure, etc.)'
  return `eslint exited abnormally (exit ${exitLabel(result)})`
}

async function repositoryRoot(directory: string): Promise<string | undefined> {
  if (!isDirectory(directory)) return undefined
  const result = await spawnPromise('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
  const top = result.stdout.trim()
  return top !== '' && result.exitCode === 0 ? top : undefined
}

function textLintBin(): string {
  return path.join(resolvePluginRoot(), 'vendor', 'text-rules', 'dist', 'bin', 'pecot-text-lint.js')
}

async function lintWithTextRules(file: Readonly<EditedFile>, cwd: string | undefined, call: Readonly<ToolCallContext>): Promise<CallToolResult> {
  const notify = (reason: string): CallToolResult => hookResult(hookMessage('warning',
    `text lint not run: ${file.filePath}\n${reason}\nThe writing rules were not applied to this file, so no violations were detected.`))
  return guarded(notify, async () => {
    const bin = textLintBin()
    if (!isFile(bin)) return notify(`pecot-text-lint is missing (${bin}).\n${RECOVERY_LINE}`)

    // bin は作業ディレクトリの .textlintignore を読むので、ファイルの属するリポのルートで動かす。
    const runDirectory = await repositoryRoot(file.directory) ?? cwd
    const result = await spawnPromise(process.execPath, [bin, file.filePath], {
      ...(runDirectory !== undefined && isDirectory(runDirectory) && { cwd: runDirectory }),
      timeoutMs: TEXT_LINT_TIMEOUT_MS,
      signal: call.signal,
    })
    if (!result.timedOut && result.exitCode === 0) return hookResult()

    const output = result.stdout.replace(/\n+$/, '')
    if (output !== '' && result.exitCode === 1 && !result.timedOut) {
      const capped = capContext(CONTEXT_MAX_TEXT_LINT, /./, 'violations', output)
      return hookResult(hookMessage('warning', `text lint violations: ${file.filePath}\n\n${capped.body}\n\n`
        + `The text above does not satisfy the writing rules. The rules stay enabled.${withNote(capped)}`))
    }
    if (result.timedOut) return notify('pecot-text-lint timed out (over 20 seconds).')
    const stderrHead = headLines(result.stderr.replace(/\n+$/, ''))
    return notify(`pecot-text-lint failed (exit ${exitLabel(result)}):${stderrHead === '' ? '' : `\n${stderrHead}`}`)
  })
}

async function lintFile(input: Readonly<FileInput>, call: Readonly<ToolCallContext>): Promise<CallToolResult> {
  const file = locateFile(input)
  if (file === undefined) return hookResult()
  if (file.talkRoot !== undefined && file.relative !== undefined && isDeckLintTarget(file.relative)) {
    return lintWithEslint(file, file.talkRoot, file.relative, call)
  }
  return lintWithTextRules(file, input.cwd, call)
}

// --- file_validate ---

const VALIDATOR_FOOTER = /^\d+ files checked, \d+ error\(s\) found\.$/

async function validateFile(input: Readonly<FileInput>, call: Readonly<ToolCallContext>): Promise<CallToolResult> {
  const file = locateFile(input)
  if (file === undefined || !/\.ya?ml$/.test(file.filePath)) return hookResult()
  const baseName = path.basename(file.filePath)
  // validator が飛ばすファイル。検証されないのが正しい。
  if (baseName === '_template.yaml') return hookResult()
  const { talkRoot } = file
  // 参照の dir の名前に "ref" を含む前提で、テーマを読む前に絞る（public/ などの yaml でテーマの知らせを出さない）。
  if (talkRoot === undefined || !/[Rr]ef/.test(path.relative(talkRoot, file.directory))) return hookResult()

  const notify = (reason: string): CallToolResult => hookResult(hookMessage('warning',
    `references validation not run: ${file.filePath}\n${reason}\nNo validation ran for this file, so violations have not been detected.`))
  return guarded(notify, async () => {
    const assets = assetsDirectory()
    const validator = path.join(assets, 'scripts', 'eslint', 'validate-references', 'dist', 'index.js')
    if (!isFile(validator)) {
      return notify('The validation environment is incomplete (missing: assets/slidev/scripts/eslint/validate-references/dist/index.js '
        + `/ assets: ${assets}).\n${RECOVERY_LINE}`)
    }
    const theme = await readThemeLint(talkRoot)
    if (!theme.ok) return notify(themeFailureLine(theme))

    const physicalDirectory = physicalPath(file.directory)
    const referencesDirectory = theme.lint.referencesDirectories.find(directory => physicalPath(directory) === physicalDirectory)
    if (referencesDirectory === undefined) return hookResult()

    // validator は argv[1] と import.meta.url を比べて自己実行を判定するので、物理パスで渡す。
    const result = await spawnPromise(process.execPath, [physicalPath(validator), '--dir', physicalDirectory], {
      cwd: physicalPath(talkRoot),
      timeoutMs: VALIDATOR_TIMEOUT_MS,
      signal: call.signal,
    })
    const output = combinedOutput(result)
    const lines = output.split('\n')
    const footer = lines.findLast(line => VALIDATOR_FOOTER.test(line))
    // validator は参照の dir の直下の *.yaml だけを読む。完走しても、編集したファイルを含まないことがある。
    const isFileChecked = lines.includes(`  ✓ ${baseName}`) || lines.includes(`  ✗ ${baseName}`)

    if (!result.timedOut && result.exitCode === 0) {
      if (footer === undefined) {
        return notify(`The validator exited with 0 but printed no completion footer (validator: ${validator}). The validation may not have run.`)
      }
      if (!isFileChecked) {
        return notify(`The validator completed (${footer}), but ${baseName} is not among the validated files. `
          + 'The validator reads only *.yaml directly under the references dir (*.yml and subdirectories are excluded).')
      }
      return hookResult()
    }

    if (footer !== undefined && result.exitCode === 1 && !result.timedOut) {
      const attribution = isFileChecked
        ? ''
        : `\n${baseName} itself is not among the validated files (the validator reads only *.yaml directly under the references dir).`
      const categoryHint = output.includes('required property \'category\'')
        ? '\nA layout yaml without `category` takes an id from `layout_categories` in `_common.yaml`. '
        + 'Right after a theme update, relinking node_modules with slide_sync (node_modules_only: true) refreshes that vocabulary.'
        : ''
      const capped = capContext(CONTEXT_MAX_REFERENCES, /^ {4}\[/, 'violations', output)
      return hookResult(hookMessage('warning', `references schema violations: ${footer}\n`
        + `This is the validation result for the whole references directory (edited file: ${file.filePath}).${attribution}\n\n`
        + `${capped.body}\n\nThe output above lists the schema violations.${categoryHint}${withNote(capped)}`))
    }

    const head = headLines(output)
    return notify(`${validatorFailureReason(result, output)}.${head === '' ? '' : `\nvalidator output: ${head}`}`)
  })
}

function validatorFailureReason(result: Readonly<SpawnResult>, output: string): string {
  if (result.timedOut) return 'The validator timed out (over 30 seconds)'
  if (result.exitCode !== 1) return `The validator exited abnormally (exit ${exitLabel(result)})`
  return output === ''
    ? 'The validator exited abnormally without output (exit 1 / failed cd to the talk root, etc.)'
    : 'The validator crashed (exit 1 / no completion footer: broken dist, module resolution failure, missing target dir, etc.)'
}

// --- file_brief ---

interface SharedReferenceModule {
  readonly extractFrontmatterText: (text: string) => string | null
  readonly parseFrontmatter: (text: string) => unknown
  readonly loadLayoutReference: (directories: readonly string[], layout: string) => Record<string, unknown> | null
}

function isSharedReferenceModule(value: unknown): value is SharedReferenceModule {
  return isRecord(value)
    && typeof value['extractFrontmatterText'] === 'function'
    && typeof value['parseFrontmatter'] === 'function'
    && typeof value['loadLayoutReference'] === 'function'
}

/**
参照の YAML から、規約の項目の原文の行を抜き出す。トップレベルのキーの行から、次のトップレベルの要素の手前までを 1 ブロックにする。
*/
function sectionBlocks(source: string, reference: Readonly<Record<string, unknown>>): readonly string[] {
  const lines = source.split('\n')
  const blockAt = (start: number): string => {
    const next = lines.slice(start + 1).findIndex(line => /^\S/.test(line))
    const picked = lines.slice(start, next === -1 ? lines.length : start + 1 + next)
    while (picked.at(-1)?.trim() === '') picked.pop()
    return picked.join('\n')
  }
  const keys = new Set(Object.entries(reference).filter(([, value]) => value !== undefined).map(([key]) => key))
  return LAYOUT_SECTION_KEYS.filter(key => keys.has(key))
    .map(key => lines.findIndex(line => line.startsWith(`${key}:`)))
    .filter(start => start !== -1)
    .toSorted((a, b) => a - b)
    .map(start => blockAt(start))
}

async function briefFile(input: Readonly<FileInput>): Promise<CallToolResult> {
  const file = locateFile(input)
  // slides.md は束ねる側なので対象外。判定装置ではないので、出せないときは何も知らせない。
  if (file?.talkRoot === undefined || !isPagesMarkdown(file.relative)) return hookResult()
  try {
    const shared = path.join(assetsDirectory(), 'scripts', 'eslint', '_shared', 'dist', 'index.js')
    if (!isFile(shared)) return hookResult()
    const theme = await readThemeLint(file.talkRoot)
    if (!theme.ok || theme.lint.referencesDirectories.length === 0) return hookResult()
    const directories = theme.lint.referencesDirectories
    const physicalDirectory = physicalPath(file.directory)
    if (directories.some(directory => physicalPath(directory) === physicalDirectory)) return hookResult()

    const module_: unknown = await import(pathToFileURL(physicalPath(shared)).href)
    if (!isSharedReferenceModule(module_)) return hookResult()
    const source = readFileSync(file.filePath, 'utf8')
    if (module_.extractFrontmatterText(source) === null) return hookResult()
    const frontmatter = module_.parseFrontmatter(source)
    const layout = isRecord(frontmatter) ? frontmatter['layout'] : undefined
    // `../` と、`_template` などの内部ファイルを弾く。
    if (typeof layout !== 'string' || !/^[a-z0-9][\w.-]*$/i.test(layout)) return hookResult()
    const yamlPath = directories.map(directory => path.join(directory, `${layout}.yaml`)).find(candidate => existsSync(candidate))
    if (yamlPath === undefined) return hookResult()
    const reference = module_.loadLayoutReference(directories, layout)
    if (reference === null) return hookResult()
    const sections = sectionBlocks(readFileSync(yamlPath, 'utf8'), reference)
    if (sections.length === 0) return hookResult()

    const capped = capContext(CONTEXT_MAX_LAYOUT, /./, 'lines', `${yamlPath}:\n\n${sections.join('\n\n')}`)
    return hookResult(`${capped.body}${withNote(capped)}`)
  }
  catch {
    return hookResult()
  }
}

// --- 定義 ---

function fileTool(
  name: string,
  title: string,
  description: string,
  handle: (input: Readonly<FileInput>, call: Readonly<ToolCallContext>) => Promise<CallToolResult>,
): ToolDefinition {
  return {
    name,
    isForHook: true,
    config: {
      title,
      description,
      inputSchema: fileInput,
      outputSchema: fileOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (arguments_, call): Promise<CallToolResult> => {
      const parsed = fileInput.safeParse(arguments_)
      return parsed.success ? await handle(parsed.data, call) : hookResult()
    },
  }
}

const HOOK_NOTE = 'Called by the PostToolUse hook after Write and Edit. '
  + 'Returns {} when there is nothing to report, otherwise hookSpecificOutput.additionalContext. Never fails.'

/**
編集したファイルの lint。talk-dir の pages/**\/*.md と slides.md はテーマの規則の eslint、それ以外は文章規則。
*/
export const fileLintTool: ToolDefinition = fileTool(
  'file_lint',
  'Lint edited file',
  'Lints a file that was just written or edited. Slide pages and slides.md in a talk-dir are linted with the theme rules (eslint); '
  + 'other files are checked with the writing rules (pecot-text-lint) from the root of their git repository. ' + HOOK_NOTE,
  lintFile,
)

/**
編集した参照の YAML を、テーマの参照の dir ごと validate-references で検証する。
*/
export const fileValidateTool: ToolDefinition = fileTool(
  'file_validate',
  'Validate reference yaml',
  'Validates the reference yaml directory of a talk-dir when a yaml in it was edited, against the reference schema. '
  + 'Only directories listed in the theme lint.referencesDirectories are validated; _template.yaml is skipped. ' + HOOK_NOTE,
  validateFile,
)

/**
編集したページの layout に当たる参照の YAML から、status・best_practices・anti_patterns の原文を返す。
*/
export const fileBriefTool: ToolDefinition = fileTool(
  'file_brief',
  'Brief layout conventions',
  'Returns the status, best_practices and anti_patterns sections, verbatim, of the reference yaml for the layout '
  + 'of an edited page under pages/ in a talk-dir, with the yaml path. It does not judge the page. ' + HOOK_NOTE,
  async input => briefFile(input),
)
