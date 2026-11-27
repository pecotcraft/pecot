/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// Issue の作成・ボードへの追加・フィールドの設定と、判定に応じた列と札の書き込み（applyBoardMove）。cli/core/issue_board.py の移植に applyBoardMove を足した。
// 失敗は GitHubAPIError で呼び出し側に返す。表示と終了コードは呼び出し側が決める。
import { z } from 'zod'

import { COLUMN_CONFIG_KEYS, LABEL_CONFIG_KEYS } from '../domain/board-move.js'
import type { BoardMove, LabelValue, MissingValue, MovableColumn } from '../domain/board-move.js'
import { getFieldId, getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { displayReference } from '../domain/readiness.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { IssueReference } from '../domain/reference-parser.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { JsonObject } from '../domain/json.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { CreateIssueExtras } from '../infra/github/issues.js'
import { fieldWriteFailure } from './field-write-failure.js'
import type { FieldHintState } from './field-write-failure.js'
import type { Operation, Output } from './output.js'

// 作ったボード項目の Status（Tracker はここから始める）
const BOARD_STATUS = 'backlog'

export interface BoardItem {
  readonly itemId: string
  readonly issueNodeId: string
}

/**
Issue を作って API の応答を返す。作成に失敗したら GitHubAPIError
*/
export async function createIssue(
  client: GitHubClient,
  owner: string,
  repository: string,
  title: string,
  body: string,
  labels: readonly string[] | undefined,
  extras?: Readonly<CreateIssueExtras>,
): Promise<JsonObject> {
  return await client.createIssue(owner, repository, title, body, labels, extras)
}

/**
Issue をボードへ追加し、項目 ID と Issue の node id を返す。
追加済みの Issue には既存の項目 ID が返る（何度呼んでも同じ結果になる）。node id の取得かボードへの追加に失敗したら GitHubAPIError
*/
export async function addIssueToBoard(
  client: GitHubClient,
  config: ProjectConfig,
  owner: string,
  repository: string,
  issueNumber: number,
  issueNodeId: string | undefined,
): Promise<BoardItem> {
  const nodeId = issueNodeId === undefined || issueNodeId === '' ? await client.getIssueNodeId(owner, repository, issueNumber) : issueNodeId
  const itemId = await client.addToProject(config.project.id, nodeId)
  return { itemId, issueNodeId: nodeId }
}

/**
設定の workflow に、その status のオプションがあるか
*/
export function isStatusConfigured(config: ProjectConfig, status: string): boolean {
  const fieldId = getFieldId(config, 'workflow')
  const optionId = getOptionId(config, 'workflow', status)
  return fieldId !== undefined && fieldId !== '' && optionId !== undefined && optionId !== ''
}

/**
カスタムフィールドを 1 つ設定する。設定したら true。
設定に無いフィールド・オプションは何もせず false。更新に失敗したら GitHubAPIError
*/
// eslint-disable-next-line unicorn/consistent-boolean-name -- Python の set_issue_field と名前をそろえる
export async function setIssueField(
  client: GitHubClient,
  config: ProjectConfig,
  itemId: string,
  fieldName: string,
  optionName: string,
): Promise<boolean> {
  const fieldId = getFieldId(config, fieldName)
  const optionId = getOptionId(config, fieldName, optionName)
  if (fieldId === undefined || fieldId === '' || optionId === undefined || optionId === '') return false
  await client.updateProjectItemField(config.project.id, itemId, fieldId, optionId)
  return true
}

/**
ボード項目にそのフィールドの値が入っているか。
設定にないフィールドは入っているとみなす（設定できないので、空として扱わない）。取得に失敗したら GitHubAPIError
*/
// eslint-disable-next-line unicorn/consistent-boolean-name -- Python の item_has_field_value と名前をそろえる
export async function itemHasFieldValue(
  client: GitHubClient,
  config: ProjectConfig,
  owner: string,
  repository: string,
  issueNumber: number,
  itemId: string,
  fieldName: string,
): Promise<boolean> {
  const fieldId = getFieldId(config, fieldName)
  if (fieldId === undefined || fieldId === '') return true
  const filledFieldIds = await client.getItemSetFieldIds(config.project.id, owner, repository, issueNumber, itemId)
  return filledFieldIds.has(fieldId)
}

export interface PutOnBoardOptions {
  /**
  真なら、ボード項目の Status が空のときだけ入れる。人が動かした Status を戻さない
  */
  readonly onlyIfEmpty: boolean
}

/**
ボードへの追加と、Status（Backlog）の設定（何度やっても同じ結果になる）。ほかの欄は入れない。
途中で失敗して空のままの項目は、次の onlyIfEmpty の実行で直る。追加と欄の読み込みの失敗は GitHubAPIError。
Status の書き込みの失敗は error の行にし、書けなかった欄の数（0 か 1）を返す
*/
export async function putOnBoard(
  out: Readonly<Output>,
  client: GitHubClient,
  config: ProjectConfig,
  owner: string,
  repository: string,
  issueNumber: number,
  options: Readonly<PutOnBoardOptions>,
): Promise<number> {
  const { itemId } = await addIssueToBoard(client, config, owner, repository, issueNumber, undefined)
  if (options.onlyIfEmpty && await itemHasFieldValue(client, config, owner, repository, issueNumber, itemId, 'workflow')) return 0
  try {
    await setIssueField(client, config, itemId, 'workflow', BOARD_STATUS)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    const hintState: FieldHintState = { hasHinted: false }
    out.error(fieldWriteFailure(`could not set status ${BOARD_STATUS} of Tracker #${String(issueNumber)}: ${error.message}`, error, config, hintState))
    return 1
  }
  return 0
}

/**
列と札の行（moved: と set: Status of）に出した値。issue は行の表示の参照、reason は列を動かす理由の文。書いていない側は undefined
*/
export interface BoardMoveLine {
  readonly issue: string
  readonly column: { readonly from: string, readonly to: MovableColumn } | undefined
  readonly label: LabelValue | undefined
  readonly reason: string
}

/**
列と札を動かした（dry-run は動かす予定の）Issue 1 件。board sync・pr create・issue block / unblock の data が使う
*/
export const BOARD_MOVE_JSON = z.strictObject({
  issue: z.string().describe('Issue as shown in the moved line (#N, or owner/repo#N outside the home repository)'),
  from: z.string().optional().describe('Column before the move (omitted when only the Status changed)'),
  to: z.string().optional().describe('Column after the move (omitted when only the Status changed)'),
  label: z.string().optional().describe('Status value set (omitted when the Status did not change)'),
  reason: z.string().describe('Readiness that decided the move'),
})

export function moveJson({ issue, column, label, reason }: Readonly<BoardMoveLine>): z.input<typeof BOARD_MOVE_JSON> {
  return {
    issue,
    ...column !== undefined && { from: column.from, to: column.to },
    ...label !== undefined && { label },
    reason,
  }
}

export interface AppliedMove {
  /**
  実際に動いた先の列。動かなかったら undefined
  */
  readonly column: MovableColumn | undefined
  readonly missing: readonly MissingValue[]
  /**
  書き込みに失敗した。列だけ書けて札で失敗したときも真
  */
  readonly hasFailed: boolean
  /**
  書けた列と札。どちらも書かなかったら undefined
  */
  readonly written: BoardMoveLine | undefined
}

interface MoveTarget {
  readonly ref: IssueReference
  readonly home: RepositoryReference | undefined
}

function moveOperation(name: string, column: NonNullable<BoardMove['column']>, text: string): Operation {
  return { verb: 'move', target: `${name} ${column.from} -> ${column.to} (${text})` }
}

function labelOperation(name: string, label: LabelValue): Operation {
  return { verb: 'set', target: `Status of ${name} to ${label}` }
}

function warnConflict(out: Readonly<Output>, name: string, target: MoveTarget, conflict: NonNullable<BoardMove['conflict']>): void {
  const blockers = conflict.issues.map(issue => displayReference(issue, target.home))
  out.warning(`${name} is in ${conflict.column} but blocked${blockers.length > 0 ? ` by ${blockers.join(', ')}` : ''}`)
}

/**
decideBoardMove の結果をボードに書く。書き込みの失敗は warning にして続ける（元の列のまま）。
text は列を動かす理由の判定の文。board sync と issue block / unblock が使う。
hintState は、選択肢の ID を読み直す案内を 1 回の実行で 1 回だけ出すための印（省くと毎回出す）
*/
export async function applyBoardMove(
  out: Readonly<Output>,
  client: GitHubClient,
  config: ProjectConfig,
  itemId: string,
  target: MoveTarget,
  move: Readonly<BoardMove>,
  text: string,
  hintState?: FieldHintState,
): Promise<AppliedMove> {
  const name = displayReference(target.ref, target.home)
  if (move.conflict !== undefined) warnConflict(out, name, target, move.conflict)
  let column: BoardMoveLine['column']
  let label: LabelValue | undefined
  let hasFailed = false
  try {
    if (move.column !== undefined && await setIssueField(client, config, itemId, 'workflow', COLUMN_CONFIG_KEYS[move.column.to])) {
      column = { from: move.column.from, to: move.column.to }
      out.done(moveOperation(name, move.column, text))
    }
    if (move.label !== undefined && await setIssueField(client, config, itemId, 'status', LABEL_CONFIG_KEYS[move.label])) {
      label = move.label
      out.done(labelOperation(name, move.label))
    }
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(fieldWriteFailure(`could not move ${name}: ${error.message}`, error, config, hintState))
    hasFailed = true
  }
  const written = column === undefined && label === undefined ? undefined : { issue: name, column, label, reason: text }
  return { column: column?.to, missing: move.missing, hasFailed, written }
}

/**
applyBoardMove と同じ文を、書かずに予定の行として出す。予定の列と札を返し、どちらも無ければ undefined
*/
export function planBoardMove(out: Readonly<Output>, target: MoveTarget, move: Readonly<BoardMove>, text: string): BoardMoveLine | undefined {
  const name = displayReference(target.ref, target.home)
  if (move.conflict !== undefined) warnConflict(out, name, target, move.conflict)
  if (move.column !== undefined) out.planned(moveOperation(name, move.column, text))
  if (move.label !== undefined) out.planned(labelOperation(name, move.label))
  const column = move.column === undefined ? undefined : { from: move.column.from, to: move.column.to }
  return column === undefined && move.label === undefined ? undefined : { issue: name, column, label: move.label, reason: text }
}
