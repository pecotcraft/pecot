// PR の決まりのうち、入出力を持たない関数。閉じる Issue の抽出、base の判断、preflight の警告の判定。

import { commandHint, hinted, joinHinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import type { PullRequestReadout } from './issue-readout.js'
import { PYTHON_LINE_BREAK, parsePythonInteger, pythonStrip } from './python-format.js'
import { maskCodeAndComments } from './sections.js'
import { isSameRepository } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'
import type { BaseReading } from './state.js'
import { RESTACK_PATH } from './restack.js'
import type { RestackDecision } from './restack.js'

// Python の `\s`（str.isspace）と同じ空白
const PYTHON_SPACE = String.raw`[\t\n\v\f\r\u{1C}-\u{20}\u{85}\u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}]`

// GitHub が認識する close・fix・resolve と、それぞれの -s / -es / -d 付きの形。`owner/repo#N` の形も受ける
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列から組み立てる
const CLOSING_KEYWORDS_PATTERN = new RegExp(String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${PYTHON_SPACE}+(?:([\w-]+)/([\w.-]+))?#(\p{Nd}+)`, 'giu')

/**
本文のコードと HTML コメントの外に、Issue を閉じる語（他のリポの `owner/repo#N` も含む）があるか
*/
export function hasClosingReference(body: string): boolean {
  return maskCodeAndComments(body).matchAll(CLOSING_KEYWORDS_PATTERN).next().done !== true
}

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
リリース PR か。release テンプレート、または develop から release への PR
*/
export function isReleasePullRequest(template: string, base: string, head: string | undefined, developBranch: string | undefined, releaseBranch: string | undefined): boolean {
  return template === 'release' || (releaseBranch !== undefined && releaseBranch !== '' && base === releaseBranch && head === developBranch)
}

export interface PullRequestBaseInput {
  readonly reading: BaseReading
  /**
  渡された base（テンプレートの base か --base）
  */
  readonly base: string
  readonly developBranch: string
  /**
  親ブランチを head に持つ PR（pickLowerPullRequest で選んだもの）。スタックの記録のときだけ見る
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
  新しい PR と一緒にスタックへ登録する、親 PR の番号。登録しなければ undefined
  */
  readonly stackOn: number | undefined
  /**
  スタックの記録の base。スタックしていなければ undefined
  */
  readonly stackedBase: string | undefined
  /**
  親 PR がマージ済みか。題の scope を記録のコミットから比べるのは、マージ済みのときだけ
  */
  readonly isLowerMerged: boolean
}

export type PullRequestBaseDecision = PullRequestBaseStop | PullRequestBaseUse

/**
base の記録と親 PR の状態から、PR を作る base とスタックへの登録を決める。
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
親ブランチを head に持つ PR から、base を決める 1 本を選ぶ。fork でないもののうち、開いている・マージ済み・閉じた の順（同じ状態なら渡した順の先頭）
*/
export function pickLowerPullRequest(pullRequests: readonly PullRequestReadout[]): PullRequestReadout | undefined {
  const own = pullRequests.filter(pullRequest => !pullRequest.isCrossRepository)
  return LOWER_STATE_ORDER.map(state => own.find(pullRequest => pullRequest.state === state)).find(found => found !== undefined)
}

/**
止めた理由の文（`error: ` の前置きを含まない）。親 PR が無いときは、直し方の行を続ける
*/
export function describeBaseStop(stop: Readonly<PullRequestBaseStop>): readonly (string | HintedText)[] {
  switch (stop.reason) {
    case 'malformed': {
      return [`.pecot-base is malformed: ${stop.content}`]
    }
    case 'no-open-pr': {
      return [`base branch ${stop.branch} has no open PR`, hinted`reopen the PR of ${stop.branch}, or create a new one, then call pr_check again`]
    }
    case 'lower-open': {
      return [`base branch must be ${stop.branch} while its PR #${String(stop.pullRequest)} is open (given: ${stop.base})`]
    }
  }
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
スタックしたブランチが diverged のときの直し方。スタックし直しが要るか、スタックし直し済みで push と記録の書き直しが残れば pr restack、
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
