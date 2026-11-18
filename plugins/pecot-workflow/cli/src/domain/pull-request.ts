// PR コマンドの入出力を持たない関数。本文の検証、Closes の抽出と追記、`pr show` の Markdown の整形、preflight の警告の判定。
// 引数の型は、infra/github/pulls.ts の返す値が構造として満たす形をここに持つ（domain は infra を import できない）。

import { commandHint, hinted, inputHint, inputNameHint, joinHinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import type { PullRequestReadout } from './issue-readout.js'
import { PYTHON_LINE_BREAK, parsePythonInteger, pythonRightStrip, pythonStrip, splitCodePoints, truncateCodePoints } from './python-format.js'
import { hasSummaryImage, maskCodeAndComments, validateBodyStyle, validateHeadingSummaries, validateSections } from './sections.js'
import type { SectionHeading } from './sections.js'
import { isSameRepository } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'
import type { BaseReading } from './state.js'
import { RESTACK_PATH } from './restack.js'
import type { RestackDecision } from './restack.js'

// Issue 参照（`#N`、URL 内のフラグメントは除く）。`owner/repo#N` の形も受ける
const ISSUE_REFERENCE_PATTERN = /(?:^|[^/])#\d+|[\w-]+\/[\w.-]+#\d+/u

// Python の `\s`（str.isspace）と同じ空白
const PYTHON_SPACE = String.raw`[\t\n\v\f\r\u{1C}-\u{20}\u{85}\u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}]`

// GitHub が認識する close・fix・resolve と、それぞれの -s / -es / -d 付きの形。`owner/repo#N` の形も受ける
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列から組み立てる
const CLOSING_KEYWORDS_PATTERN = new RegExp(String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${PYTHON_SPACE}+(?:([\w-]+)/([\w.-]+))?#(\p{Nd}+)`, 'giu')

const PR_CREATE_PATH = ['pr', 'create']

export const SCREENSHOT_MISSING_ERROR: HintedText = hinted`Summary has no image and \`screenshot\` gives no reason to omit one. If the change alters a screen, Markdown the tool writes for GitHub, or CLI output text, take a screenshot and add it to Summary as \`![alt](./<file>.png)\`. Otherwise, write the reason in the \`screenshot\` frontmatter field (\`${inputNameHint(PR_CREATE_PATH, 'screenshot')}\` with \`${inputNameHint(PR_CREATE_PATH, 'message')}\`)`

/**
本文のコードと HTML コメントの外の Closes / Fixes / Resolves に続く、repository の Issue 番号を、出てきた順に重複なしで返す。
GitHub が既定ブランチ宛ての PR で数えない所は数えない
*/
export function extractClosingIssueNumbers(body: string, repository: Readonly<RepositoryReference>): readonly number[] {
  const numbers: number[] = []
  for (const match of maskCodeAndComments(body).matchAll(CLOSING_KEYWORDS_PATTERN)) {
    const [, owner, name = '', digits = ''] = match
    if (owner === undefined || isSameRepository({ owner, repository: name }, repository)) numbers.push(Number(parsePythonInteger(digits)))
  }
  return [...new Set(numbers)]
}

/**
本文にその Issue 番号の参照が無ければ、末尾に `Closes #N` を足す。あればそのまま返す
*/
export function appendIssueCloseIfNeeded(body: string, issueNumber: number): string {
  // URL 内のフラグメントは (^|[^/]) で除く。直後に数字が続くものは否定の先読みで除く
  // eslint-disable-next-line security/detect-non-literal-regexp -- Issue 番号は整数
  const pattern = new RegExp(String.raw`(^|[^/])#${String(issueNumber)}(?!\p{Nd})`, 'u')
  return pattern.test(body) ? body : `${pythonRightStrip(body)}\n\nCloses #${String(issueNumber)}`
}

/**
本文に Issue 参照（`#N` か `owner/repo#N`）があるか
*/
export function hasIssueReference(body: string): boolean {
  return ISSUE_REFERENCE_PATTERN.test(body)
}

/**
リリース PR か。release テンプレート、または develop から release への PR
*/
export function isReleasePullRequest(template: string, base: string, head: string | undefined, developBranch: string | undefined, releaseBranch: string | undefined): boolean {
  return template === 'release' || (releaseBranch !== undefined && releaseBranch !== '' && base === releaseBranch && head === developBranch)
}

export interface PullRequestContentOptions {
  readonly body: string
  readonly base: string
  readonly developBranch: string | undefined
  readonly releaseBranch: string | undefined
  readonly head: string | undefined
  readonly template: string
  readonly skipIssueReferenceCheck: boolean
  /**
  Summary に画像が無い理由。正規化済みで、無ければ undefined
  */
  readonly screenshot: string | undefined
  /**
  テンプレートから取り出した必須の節。空なら節の検証をしない
  */
  readonly requiredSections: readonly SectionHeading[]
  /**
  積んで着手した記録の base（下の段のブランチ）。開発ブランチのほか、この base も通す
  */
  readonly stackedBase?: string | undefined
}

/**
PR の内容を検証し、エラーの文を返す（無ければ空）。ブランチ設定の欠けは、呼び出し側が先に止める
*/
export function validatePullRequestContent(options: Readonly<PullRequestContentOptions>): readonly (string | HintedText)[] {
  const { body, base, developBranch, releaseBranch, requiredSections } = options
  const errors: (string | HintedText)[] = []
  const isRelease = isReleasePullRequest(options.template, base, options.head, developBranch, releaseBranch)

  if (!isRelease && !options.skipIssueReferenceCheck && !hasIssueReference(body)) {
    errors.push(hinted`PR body has no Issue reference \`#N\` (use \`${inputHint(PR_CREATE_PATH, 'no_issue_ref')}\` for a PR not tied to an Issue)`)
  }

  if (requiredSections.length > 0) {
    const missing = validateSections(body, requiredSections)
    if (missing.length > 0) errors.push(`missing sections: ${missing.join(', ')}`)
    const summaryErrors = validateHeadingSummaries(body, requiredSections)
    if (summaryErrors.length > 0) errors.push(`heading summary rule violations: ${summaryErrors.join(', ')}`)
  }

  const styleErrors = validateBodyStyle(body)
  if (styleErrors.length > 0) errors.push(`disallowed syntax: ${styleErrors.join(', ')}`)

  if (!isRelease && (options.screenshot === undefined || options.screenshot === '') && !hasSummaryImage(body)) {
    errors.push(SCREENSHOT_MISSING_ERROR)
  }

  if (isRelease) {
    if (releaseBranch !== undefined && releaseBranch !== '' && base !== releaseBranch) errors.push(`release PR base branch must be ${releaseBranch} (given: ${base})`)
  }
  else if (developBranch !== undefined && developBranch !== '' && base !== developBranch) {
    const { stackedBase } = options
    const isStacked = stackedBase !== undefined && stackedBase !== '' && stackedBase !== developBranch
    if (!isStacked) errors.push(`base branch must be ${developBranch} (given: ${base})`)
    else if (base !== stackedBase) errors.push(`base branch must be ${developBranch} or ${stackedBase} (given: ${base})`)
  }
  return errors
}

export interface PullRequestBaseInput {
  readonly reading: BaseReading
  /**
  渡された base（テンプレートの base か --base）
  */
  readonly base: string
  readonly developBranch: string
  /**
  下の段のブランチを head に持つ PR（pickLowerPullRequest で選んだもの）。積んだ記録のときだけ見る
  */
  readonly lowerPullRequest?: Readonly<PullRequestReadout> | undefined
}

export type PullRequestBaseStop
  = | { readonly kind: 'stop', readonly reason: 'malformed', readonly content: string }
    | { readonly kind: 'stop', readonly reason: 'no-open-pr', readonly branch: string }
    | { readonly kind: 'stop', readonly reason: 'lower-open', readonly branch: string, readonly pullRequest: number, readonly base: string }

export interface PullRequestBaseUse {
  readonly kind: 'use'
  /**
  PR を作る base
  */
  readonly base: string
  /**
  新しい PR と一緒にスタックへ登録する、下の段の PR の番号。登録しなければ undefined
  */
  readonly stackOn: number | undefined
  /**
  内容の検証（validatePullRequestContent）に渡す記録の base
  */
  readonly stackedBase: string | undefined
  /**
  下の段の PR がマージ済みか。題の scope を記録のコミットから比べるのは、マージ済みのときだけ
  */
  readonly isLowerMerged: boolean
}

export type PullRequestBaseDecision = PullRequestBaseStop | PullRequestBaseUse

/**
base の記録と下の段の PR の状態から、PR を作る base とスタックへの登録を決める。
記録の base でも開発ブランチでもない base は、そのまま返して内容の検証で落とす
*/
export function decidePullRequestBase(input: Readonly<PullRequestBaseInput>): PullRequestBaseDecision {
  const { reading, base, developBranch } = input
  if (reading.kind === 'malformed') return { kind: 'stop', reason: 'malformed', content: reading.content }
  if (reading.kind === 'development') return { kind: 'use', base, stackOn: undefined, stackedBase: undefined, isLowerMerged: false }
  const { branch } = reading.record
  const lower = input.lowerPullRequest
  if (lower === undefined || lower.state === 'CLOSED') return { kind: 'stop', reason: 'no-open-pr', branch }
  const isKnownBase = base === branch || base === developBranch
  if (lower.state === 'MERGED') return { kind: 'use', base: isKnownBase ? developBranch : base, stackOn: undefined, stackedBase: branch, isLowerMerged: true }
  if (base === developBranch) return { kind: 'stop', reason: 'lower-open', branch, pullRequest: lower.number, base }
  return { kind: 'use', base, stackOn: base === branch ? lower.number : undefined, stackedBase: branch, isLowerMerged: false }
}

const LOWER_STATE_ORDER: readonly PullRequestReadout['state'][] = ['OPEN', 'MERGED', 'CLOSED']

/**
下の段のブランチを head に持つ PR から、base を決める 1 本を選ぶ。fork でないもののうち、開いている・マージ済み・閉じた の順（同じ状態なら渡した順の先頭）
*/
export function pickLowerPullRequest(pullRequests: readonly PullRequestReadout[]): PullRequestReadout | undefined {
  const own = pullRequests.filter(pullRequest => !pullRequest.isCrossRepository)
  return LOWER_STATE_ORDER.map(state => own.find(pullRequest => pullRequest.state === state)).find(found => found !== undefined)
}

/**
止めた理由の文（`error: ` の前置きを含まない）。下の段の PR が無いときは、直し方の行を続ける
*/
export function describeBaseStop(stop: Readonly<PullRequestBaseStop>): readonly string[] {
  switch (stop.reason) {
    case 'malformed': {
      return [`.pecot-base is malformed: ${stop.content}`]
    }
    case 'no-open-pr': {
      return [`base branch ${stop.branch} has no open PR`, `reopen the PR of ${stop.branch}, or create a new one, then run pr create again`]
    }
    case 'lower-open': {
      return [`base branch must be ${stop.branch} while its PR #${String(stop.pullRequest)} is open (given: ${stop.base})`]
    }
  }
}

// `pr show` の整形

export interface IssueSummary {
  readonly number: number
  readonly title: string
}

export interface PullRequestView {
  readonly number: number
  readonly state: string
  readonly title: string
  readonly body: string
  readonly head_ref: string
  readonly base_ref: string
  readonly is_draft: boolean
  readonly mergeable: string
  readonly comments: number
  readonly closing_issues: readonly IssueSummary[]
  readonly referenced_issues: readonly IssueSummary[]
}

export interface PullRequestSlimView extends PullRequestView {
  readonly reviews: readonly { readonly state: string, readonly author: string | null }[]
}

export interface ReviewView {
  readonly state: string
  readonly author: string | null
  readonly body: string
  readonly submitted_at: string | null
}

export interface ReviewThreadView {
  readonly is_resolved: boolean
  readonly path: string | null
  readonly line: number | null
  readonly comments: readonly { readonly author: string | null, readonly body: string, readonly created_at: string | null }[]
}

export interface PullRequestWithReviewsView extends PullRequestView {
  readonly reviews: readonly ReviewView[]
  readonly review_threads: readonly ReviewThreadView[]
}

// ISO 8601 の先頭 10 文字（YYYY-MM-DD）。10 文字に満たなければ空
function datePart(timestamp: string | null): string {
  return timestamp !== null && splitCodePoints(timestamp).length >= 10 ? truncateCodePoints(timestamp, 10) : ''
}

function metaLine(pr: PullRequestView): string {
  const parts = [`**State:** ${pr.state}`]
  if (pr.is_draft) parts.push('**Draft**')
  if (pr.mergeable !== '') parts.push(`**Mergeable:** ${pr.mergeable}`)
  if (pr.comments > 0) parts.push(`**Comments:** ${String(pr.comments)}`)
  return parts.join(' | ')
}

function referencedIssueLine(issue: IssueSummary): string {
  return `  - #${String(issue.number)}${issue.title === '' ? '' : ` ${issue.title}`}`
}

/**
`pr show` の既定の Markdown
*/
export function formatPullRequestMarkdown(pr: PullRequestSlimView): string {
  const lines = [`## PR #${String(pr.number)} ${pr.title}`, '', metaLine(pr), '', `**Branch:** \`${pr.head_ref}\` → \`${pr.base_ref}\``, '']

  if (pr.closing_issues.length > 0) {
    lines.push('**Closing Issues:**', ...pr.closing_issues.map(issue => `  - #${String(issue.number)} ${issue.title}`), '')
  }
  if (pr.referenced_issues.length > 0) {
    lines.push('**Referenced Issues:**', ...pr.referenced_issues.map(issue => referencedIssueLine(issue)), '')
  }
  if (pr.reviews.length > 0) {
    lines.push('**Reviews:**', ...pr.reviews.map(review => `  - ${review.author ?? 'None'}: ${review.state}`), '')
  }

  lines.push('---', '', pr.body)
  return lines.join('\n')
}

/**
レビュー本文の節。レビューが無ければ空文字
*/
export function formatReviewsMarkdown(reviews: readonly ReviewView[]): string {
  if (reviews.length === 0) return ''
  const lines = ['## Reviews', '']
  for (const review of reviews) {
    const author = review.author === null || review.author === '' ? '(unknown)' : review.author
    const date = datePart(review.submitted_at)
    lines.push(`### @${author} (${review.state})${date === '' ? '' : ` - ${date}`}`)
    const body = pythonStrip(review.body)
    if (body !== '') lines.push('', body)
    lines.push('')
  }
  return lines.join('\n')
}

/**
行コメント（reviewThreads）の節。無ければ空文字
*/
export function formatReviewThreadsMarkdown(threads: readonly ReviewThreadView[]): string {
  if (threads.length === 0) return ''
  const lines = ['## Line Comments', '']
  for (const thread of threads) {
    const path = thread.path === null || thread.path === '' ? '(unknown file)' : thread.path
    const lineInfo = thread.line === null || thread.line === 0 ? '' : `:${String(thread.line)}`
    lines.push(`### \`${path}${lineInfo}\` [${thread.is_resolved ? 'Resolved' : 'Open'}]`, '')
    for (const comment of thread.comments) {
      const author = comment.author === null || comment.author === '' ? '(unknown)' : comment.author
      const date = datePart(comment.created_at)
      lines.push(`**@${author}**${date === '' ? '' : ` (${date})`}:`)
      const body = pythonStrip(comment.body)
      if (body !== '') lines.push(...body.split('\n').map(line => `> ${line}`))
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
`pr show --reviews` の Markdown。Issue ごとに詳細を見るコマンドを添え、レビュー本文と行コメントを続ける
*/
export function formatPullRequestWithReviewsMarkdown(pr: PullRequestWithReviewsView, owner: string, repository: string): string {
  const lines = [`## PR #${String(pr.number)} ${pr.title}`, '', metaLine(pr), '', `**Branch:** \`${pr.head_ref}\` → \`${pr.base_ref}\``, '']
  const detailsLine = (issue: IssueSummary): string => `    → details: issue show ${owner}/${repository}/${String(issue.number)}`

  if (pr.closing_issues.length > 0) {
    lines.push('**Closing Issues:**')
    for (const issue of pr.closing_issues) lines.push(`  - #${String(issue.number)} ${issue.title}`, detailsLine(issue))
    lines.push('')
  }
  if (pr.referenced_issues.length > 0) {
    lines.push('**Referenced Issues:**')
    for (const issue of pr.referenced_issues) lines.push(referencedIssueLine(issue), detailsLine(issue))
    lines.push('')
  }

  lines.push('---', '', pr.body, '')

  const reviews = formatReviewsMarkdown(pr.reviews)
  if (reviews !== '') lines.push('---', '', reviews)
  const threads = formatReviewThreadsMarkdown(pr.review_threads)
  if (threads !== '') lines.push('---', '', threads)
  return lines.join('\n')
}

// preflight

export interface PreflightWarning {
  readonly label: string
  readonly message: string
  readonly fixHint: HintedText
}

/**
`git status` の出力に変更があるか。空・取得失敗の印・「nothing to commit」かつ「working tree clean」は無し
*/
export function hasStatusChanges(gitStatus: string): boolean {
  const stripped = pythonStrip(gitStatus)
  return stripped !== '' && stripped !== '(git status failed)' && !(gitStatus.includes('nothing to commit') && gitStatus.includes('working tree clean'))
}

/**
stash の一覧の文字列に、stash の項目があるか（「(no stash)」と取得失敗の印は無し）
*/
export function hasStashEntries(stashList: string): boolean {
  return stashList !== '(no stash)' && !stashList.startsWith('(git stash')
}

export interface PushStatus {
  readonly isPushed: boolean
  readonly message: string
  /**
  手元と remote の両方に、相手に無いコミットがあるか
  */
  readonly isDiverged: boolean
}

/**
ahead と behind のコミット数から、push の状態の文を作る
*/
export function describePushStatus(remote: string, branch: string, ahead: number, behind: number): PushStatus {
  if (ahead === 0 && behind === 0) return { isPushed: true, message: `in sync with ${remote}/${branch}`, isDiverged: false }
  if (behind === 0) return { isPushed: false, message: `${String(ahead)} unpushed commits`, isDiverged: false }
  if (ahead === 0) return { isPushed: true, message: `${remote}/${branch} is ${String(behind)} commits ahead (pull recommended)`, isDiverged: false }
  return { isPushed: false, message: `diverged: local is ${String(ahead)} commits ahead, ${remote}/${branch} is ${String(behind)} ahead`, isDiverged: true }
}

// 文の中にロングオプションを書けない（lint）ので、git の引数から組む
const PULL_REBASE_COMMAND = ['git', 'pull', '--rebase'].join(' ')
export const FORCE_PUSH_COMMAND = ['git', 'push', '--force-with-lease'].join(' ')

/**
diverged の直し方。fast-forward でない push は拒まれるので、取り込むか、書き換えたなら lease 付きで上書きする
*/
export const DIVERGED_FIX_HINT: HintedText = hinted`${PULL_REBASE_COMMAND}, or ${FORCE_PUSH_COMMAND} if you rewrote pushed commits`

/**
PR の head。`owner:branch` は、同じネットワークの別のリポ（fork）のブランチ（GitHub の Pulls API の head の形）
*/
export interface HeadReference {
  /**
  fork の owner。`:` の無い head では undefined
  */
  readonly owner: string | undefined
  readonly branch: string
}

/**
head を owner とブランチ名に分ける。git のブランチ名に `:` は使えないので、最初の `:` で分ける。
owner かブランチ名が空なら undefined
*/
export function parseHeadReference(head: string): HeadReference | undefined {
  const index = head.indexOf(':')
  if (index === -1) return head === '' ? undefined : { owner: undefined, branch: head }
  const owner = head.slice(0, index)
  const branch = head.slice(index + 1)
  return owner === '' || branch === '' ? undefined : { owner, branch }
}

/**
fork のブランチの push の直し方。上流の無いブランチでも fork へ向くよう、remote とブランチ名を明示する
*/
export function forkPushFixHint(remote: string, branch: string, isDiverged: boolean): HintedText {
  return isDiverged
    ? hinted`${PULL_REBASE_COMMAND} ${remote} ${branch}, or ${FORCE_PUSH_COMMAND} ${remote} ${branch} if you rewrote pushed commits`
    : hinted`git push ${remote} ${branch}`
}

/**
積んだブランチが diverged のときの直し方。載せ直しが要るか、載せ直し済みで push と記録の書き直しが残れば pr restack、
要らなければ diverged の直し方、決められなければ pr restack --check
*/
export function pushFixHintOf(decision: Readonly<RestackDecision> | undefined): HintedText {
  if (decision === undefined || decision.kind === 'gone') return hinted`${commandHint(RESTACK_PATH, { check: true })}`
  return decision.kind === 'moved' || decision.kind === 'merged' || decision.kind === 'rebased' ? hinted`${commandHint(RESTACK_PATH)}` : DIVERGED_FIX_HINT
}

export interface PreflightFacts {
  readonly gitStatus: string
  readonly stashList: string
  readonly isPushed: boolean
  readonly pushMessage: string
  /**
  Push Status の直し方。省くと git push
  */
  readonly pushFixHint?: HintedText | undefined
}

/**
警告を、未 push・変更あり・stash ありの順で返す
*/
export function collectPreflightWarnings(facts: Readonly<PreflightFacts>): readonly PreflightWarning[] {
  const warnings: PreflightWarning[] = []
  if (!facts.isPushed) warnings.push({ label: 'Push Status', message: facts.pushMessage, fixHint: facts.pushFixHint ?? hinted`git push` })
  if (hasStatusChanges(facts.gitStatus)) warnings.push({ label: 'Git Status', message: 'modified or untracked files', fixHint: hinted`commit` })
  if (hasStashEntries(facts.stashList)) {
    const count = facts.stashList.split(PYTHON_LINE_BREAK).filter(line => pythonStrip(line) !== '').length
    warnings.push({ label: 'Stash List', message: `${String(count)} stash entries`, fixHint: hinted`check them` })
  }
  return warnings
}

/**
警告 1 行の文
*/
export function formatPreflightWarning(warning: PreflightWarning): HintedText {
  return joinHinted([`${warning.label}: ${warning.message} (fix: `, warning.fixHint, ')'], '')
}
