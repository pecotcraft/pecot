// issue 系のコマンドが共有する関数と定数。I/O を持たない起票の決まりは domain/issue-rules.ts にある。
// error の行を出して止めるのは stopWith(output, 文, n)。
import { isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { formatHinted } from '../domain/command-hint.js'
import { BaseError } from '../domain/errors.js'
import { parseIssueReference, ReferenceParseError } from '../domain/reference-parser.js'
import { resolveShortReferenceBase, withUnreadableReason } from '../domain/repository-resolver.js'
import { extractSectionsFromTemplate } from '../domain/sections.js'
import type { SectionHeading } from '../domain/sections.js'
import { closedHeadingGuidance, EM_DASH_HINT, templateViolations } from '../domain/template-violations.js'
import type { TemplateViolationCode } from '../domain/template-violations.js'
import { gitRunnerFor } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { commandHint, hinted, RUN } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

export { VALID_STATUSES } from '../domain/issue-rules.js'

/**
issue comment のテンプレ検証失敗の終了コード。通信失敗・設定なし・引数不足の 1 と区別し、hooks がこの値で分岐する
*/
export const COMMENT_VALIDATION_EXIT_CODE = 3

export const ISSUE_REF_DESCRIPTION = 'Issue reference (`owner/repo/N`, or the short form `N` in the repository of `repo`, or else of the git remote of the current directory)'

// --- 終了の表し方 ---

/**
Issue 参照が不正。parseIssueReferenceOrExit が終了コード 2 にする
*/
class BadParameterError extends BaseError {
  readonly text: string | HintedText

  // message は描いた文。text は、案内を他の文へ埋め込む用途で持つ
  constructor(text: string | HintedText) {
    super(formatHinted(text))
    this.text = text
  }
}

/**
run の本体を包む。終わったら 0 を返す。例外はそのまま伝える。CommandExit は defineTool が受けて終了コードにする
*/
export async function runWithExit(body: () => Promise<void>): Promise<0> {
  await body()
  return 0
}

// --- Issue 参照 ---

/**
`owner/repo/N` の表記。エラー文と done の行の対象、MCP の data の参照に使う
*/
export function issuePath(owner: string, repository: string, number: number): string {
  return `${owner}/${repository}/${String(number)}`
}

export interface IssueTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

/**
Issue 参照（`owner/repo/N` または短縮形 `N`）を分ける。不正、または base が決まらない短縮形なら BadParameterError
*/
function parseIssueReferenceFromContext(repository: string | undefined, raw: string): IssueTarget {
  const { base, unreadable } = resolveShortReferenceBase(repository, gitRunnerFor())
  try {
    const reference = parseIssueReference(raw, base, { repositoryFlag: true })
    return { owner: reference.repository.owner, repository: reference.repository.repository, number: reference.number }
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) throw new BadParameterError(withUnreadableReason(error.hintedText ?? error.message, unreadable))
    throw error
  }
}

/**
parseIssueReferenceFromContext の失敗を、error の行と終了コード 2 にしたもの
*/
export function parseIssueReferenceOrExit(output: Output, repository: string | undefined, raw: string): IssueTarget {
  try {
    return parseIssueReferenceFromContext(repository, raw)
  }
  catch (error: unknown) {
    if (!(error instanceof BadParameterError)) throw error
    return stopWith(output, error.text, 'invalid-input', USAGE_EXIT_CODE)
  }
}

// --- status ---

/**
不正な status と、有効な値を出して終了コード 1
*/
export function exitInvalidStatus(output: Output, status: string): never {
  return stopWith(output, `invalid status: ${status}\nvalid values: backlog/pending/blocked/ready/active/in_review/archived`, 'invalid-input')
}

// --- ボード ---

/**
クライアントを作り、リポジトリがプロジェクトにあることを確かめる。無ければ error と終了コード 1。board add・board move が使う
*/
export async function connectToProject(output: Output, config: ProjectConfig, owner: string, repository: string): Promise<GitHubClient> {
  const client = createGitHubClient(output, config.host)
  if (!await isRepositoryInProject(config, owner, repository, client)) stopWith(output, `repository ${owner}/${repository} is not in the project`, 'repo-not-in-project')
  return client
}

/**
ボードに無い status の error の文。blocked は後から足せる option なので、足し方の hint を添える
*/
export function notConfiguredMessage(status: string): string | HintedText {
  const base = `status '${status}' is not configured in the project`
  return status === 'blocked' ? hinted`${base}\nhint: ${RUN} ${commandHint(['project', 'init'])} to add the Blocked option to the board` : base
}

// --- テンプレートの検証 ---

/**
本文を文字列のテンプレートと比べ、違反を 1 つの error にして出す。違反があれば true。ファイルを持たない bundle（action）が使う。
templateName はファイル名から拡張子を除いたもの
*/
export function hasReportedTemplateTextViolations(output: Output, body: string, templateName: string, templateText: string, options: { readonly emDashHint?: boolean } = {}): boolean {
  return hasReportedSectionViolations(output, body, { label: templateName, stem: templateName, required: extractSectionsFromTemplate(templateText) }, options)
}

interface TemplateSections {
  readonly label: string
  readonly stem: string
  readonly required: readonly SectionHeading[]
}

function hasReportedSectionViolations(output: Output, body: string, template: Readonly<TemplateSections>, options: { readonly emDashHint?: boolean }): boolean {
  const { label, stem } = template
  const violations = templateViolations(body, template)
  if (violations.length === 0) return false

  const details = (code: TemplateViolationCode): readonly string[] => violations.filter(violation => violation.code === code).map(violation => violation.detail)
  const missing = details('missing-section')
  const lines = [`the body does not follow the template ${label}`]
  if (missing.length > 0) {
    lines.push(`missing sections: ${missing.join(', ')}`)
    if (options.emDashHint === true && missing.some(section => section.includes(' — <'))) lines.push(`hint: ${EM_DASH_HINT}`)
  }
  const groups: readonly (readonly [TemplateViolationCode, string])[] = [
    ['heading-summary', 'heading summary rule violations'],
    ['body-style', 'unusable notation'],
    ['fold', 'collapse rule violations'],
  ]
  for (const [code, heading] of groups) {
    if (details(code).length > 0) lines.push(`${heading}: ${details(code).join(', ')}`)
  }
  const extraHeadings = details('extra-heading')
  if (extraHeadings.length > 0) lines.push(`headings not in the template: ${extraHeadings.join(', ')} (${String(closedHeadingGuidance(stem))})`)
  output.error(lines.join('\n'))
  return true
}
