/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// 自動処理の結果の書き込み。コメント・既定の Status・起動ラベルの順に書く。auto-gate と auto-finish が呼ぶ。
import { autoMarker, renderAutoResult, resultEffects } from '@pecot/workflow-core/domain/auto-result.js'
import type { AutoNext, AutoResult } from '@pecot/workflow-core/domain/auto-result.js'
import { getOptionId } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { jsonField } from '@pecot/workflow-core/domain/json.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { autoLabel, issueDisplay, readOrStop, runIdentity, runUrl } from './auto-shared.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { hinted, RUN_COLON } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { boardFieldsHint } from '@pecot/workflow-core/commands-shared/project-sync.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { setIssueField } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { COMMENT_VALIDATION_EXIT_CODE, hasReportedTemplateTextViolations } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import AUTO_RESULT_TEMPLATE from '../templates/auto-result.md?raw'

const NEEDS_ATTENTION_KEY = 'needs_attention'
const MISSING_NEEDS_ATTENTION = 'Status option Needs Attention'
const MISSING_BOARD_ITEM = 'Issue on the board'

export interface AutoWrite {
  readonly result: AutoResult
  /**
  結果ごとの本文。質問・落ちたテスト・対象外の理由など
  */
  readonly body?: string
  readonly next?: AutoNext
  /**
  目印に書くブランチ
  */
  readonly branch: string
}

/**
待ちの値を書くボード項目。書けないときは item を undefined にし、足りない設定の名前を missing に入れる
*/
export interface WaitingTarget {
  readonly item: string | undefined
  readonly missing: readonly string[]
}

const NO_WAITING: WaitingTarget = { item: undefined, missing: [] }

/**
結果が待ちの値を書くものなら、ボード項目を引き、待ちの値の選択肢があるかを確かめる。書けないときは warning の行を出す
*/
export async function waitingTargetOf(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, result: AutoResult): Promise<WaitingTarget> {
  if (!resultEffects(result).setsWaiting) return NO_WAITING
  const display = issueDisplay(target)
  const item = await readOrStop(out, `the board item of ${display}`, async () => await client.getItemIdByIssue(config.project.id, target.owner, target.repository, target.number))
  if (item === undefined) {
    out.warning(`${display} is not on the board; the Status stays as it is`)
    return { item: undefined, missing: [MISSING_BOARD_ITEM] }
  }
  const optionId = getOptionId(config, 'status', NEEDS_ATTENTION_KEY)
  if (optionId === undefined || optionId === '') {
    out.warning(hinted`the board has no option Needs Attention for Status; the Status stays as it is\n${RUN_COLON}${boardFieldsHint({ owner: config.owner, number: config.project.number })}`)
    return { item: undefined, missing: [MISSING_NEEDS_ATTENTION] }
  }
  return { item, missing: [] }
}

function renderBody(out: Output, write: Readonly<AutoWrite>, missing: readonly string[]): string {
  const templateBody = stripLeadingHtmlComment(stripFrontmatter(AUTO_RESULT_TEMPLATE))
  const run = runIdentity()
  const url = runUrl()
  const body = renderAutoResult(templateBody, {
    result: write.result,
    label: autoLabel(),
    missing,
    ...write.body !== undefined && { body: write.body },
    ...write.next !== undefined && { next: write.next },
    ...url !== undefined && { runUrl: url },
    ...run !== undefined && { marker: autoMarker(write.result, run, write.branch) },
  })
  /* v8 ignore next -- 雛形と renderAutoResult の組み合わせは tests/auto-result-template.test.ts が全結果で確かめる */
  if (hasReportedTemplateTextViolations(out, body, 'auto-result', AUTO_RESULT_TEMPLATE)) throw new CommandExit(COMMENT_VALIDATION_EXIT_CODE, 'content-invalid')
  return body
}

function failWrite(out: Output, what: string, error: unknown): never {
  if (!(error instanceof GitHubAPIError)) throw error
  return stopWith(out, `could not ${what}: ${error.message}`, kindOfFailure(error))
}

/**
コメントの後の 2 つ（待ちの値・起動ラベル）を書く
*/
export async function applyResultEffects(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, result: AutoResult, waiting: Readonly<WaitingTarget>): Promise<void> {
  const display = issueDisplay(target)
  const { item } = waiting
  if (item !== undefined && resultEffects(result).setsWaiting) {
    try {
      await setIssueField(client, config, item, 'status', NEEDS_ATTENTION_KEY)
    }
    catch (error: unknown) {
      failWrite(out, `set the Status of ${display} to Needs Attention`, error)
    }
    out.done({ verb: 'set', target: `Status of ${display} to Needs Attention` })
  }
  if (!resultEffects(result).removesLabel) return
  const label = autoLabel()
  let removed: 'removed' | 'absent'
  try {
    removed = await client.removeIssueLabel(target.owner, target.repository, target.number, label)
  }
  catch (error: unknown) {
    return failWrite(out, `remove the label ${label} from ${display}`, error)
  }
  const removal: Operation = removed === 'removed'
    ? { verb: 'remove', target: `label ${label} from ${display}` }
    : { verb: 'unchanged', target: `label ${label} on ${display} (not attached)`, aside: true }
  out.done(removal)
}

/**
結果のコメントを書き、待ちの値と起動ラベルを書いて、コメントの URL を返す。コメントの後で失敗したら、済んだ行を出した後に error の行で止まる
*/
export async function writeAutoResult(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, write: Readonly<AutoWrite>): Promise<string | undefined> {
  const waiting = await waitingTargetOf(out, client, config, target, write.result)
  const body = renderBody(out, write, waiting.missing)
  const display = issueDisplay(target)
  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, body)
  }
  catch (error: unknown) {
    return failWrite(out, `create a comment on ${display}`, error)
  }
  out.done({ verb: 'create', target: `auto result comment (${write.result}) on ${display}` })
  await applyResultEffects(out, client, config, target, write.result, waiting)
  const url = jsonField(comment, 'html_url')
  return typeof url === 'string' ? url : undefined
}
