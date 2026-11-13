/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// Issue の作成・ボードへの追加・フィールドの設定。cli/core/issue_board.py の移植。
// 失敗は GitHubAPIError で呼び出し側に返す。表示と終了コードは呼び出し側が決める。
import { COLUMN_CONFIG_KEYS, LABEL_CONFIG_KEYS } from '../domain/board-move.js'
import type { BoardMove, MissingValue, MovableColumn } from '../domain/board-move.js'
import { getFieldId, getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { isSameRepository, repositoryFullName } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { JsonObject } from '../domain/json.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { Output } from './output.js'

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
): Promise<JsonObject> {
  return await client.createIssue(owner, repository, title, body, labels)
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
  真なら、ボード項目のそのフィールドが空のときだけ入れる。人が動かした Status や Priority を戻さない
  */
  readonly onlyIfEmpty: boolean
}

/**
ボードへの追加と、Status（Backlog）・Priority の設定（何度やっても同じ結果になる）。
途中で失敗して空のままの項目は、次の onlyIfEmpty の実行で直る。失敗したら GitHubAPIError
*/
export async function putOnBoard(
  client: GitHubClient,
  config: ProjectConfig,
  owner: string,
  repository: string,
  issueNumber: number,
  priority: string | undefined,
  options: Readonly<PutOnBoardOptions>,
): Promise<void> {
  const { itemId } = await addIssueToBoard(client, config, owner, repository, issueNumber, undefined)
  const fields: (readonly [string, string])[] = [['workflow', BOARD_STATUS]]
  if (priority !== undefined) fields.push(['priority', priority])
  for (const [fieldName, option] of fields) {
    if (options.onlyIfEmpty && await itemHasFieldValue(client, config, owner, repository, issueNumber, itemId, fieldName)) continue
    await setIssueField(client, config, itemId, fieldName, option)
  }
}

/**
メッセージに出す Issue の表記。home と同じリポジトリは `#N`、別のリポジトリは `owner/repo#N`。home が無ければ常に `#N`
*/
export function issueLabel(reference: IssueReference, home: RepositoryReference | undefined): string {
  const number = `#${String(reference.number)}`
  return home === undefined || isSameRepository(reference.repository, home) ? number : `${repositoryFullName(reference.repository)}${number}`
}

export interface AppliedMove {
  /**
  実際に動いた先の列。動かなかったら undefined
  */
  readonly column: MovableColumn | undefined
  readonly missing: readonly MissingValue[]
}

/**
decideBoardMove の結果をボードに書く。書き込みの失敗は warning にして続ける（元の列のまま）。
text は列を動かす理由の判定の文
*/
export async function applyBoardMove(
  out: Readonly<Output>,
  client: GitHubClient,
  config: ProjectConfig,
  itemId: string,
  target: { readonly ref: IssueReference, readonly home: RepositoryReference | undefined },
  move: Readonly<BoardMove>,
  text: string,
): Promise<AppliedMove> {
  const name = issueLabel(target.ref, target.home)
  if (move.conflict !== undefined) {
    const blockers = move.conflict.issues.map(issue => issueLabel(issue, target.home))
    out.warning(`${name} is in ${move.conflict.column} but blocked${blockers.length > 0 ? ` by ${blockers.join(', ')}` : ''}`)
  }
  let moved: MovableColumn | undefined
  try {
    if (move.column !== undefined && await setIssueField(client, config, itemId, 'workflow', COLUMN_CONFIG_KEYS[move.column.to])) {
      moved = move.column.to
      out.done({ verb: 'move', target: `${name} ${move.column.from} -> ${move.column.to} (${text})` })
    }
    if (move.label !== undefined && await setIssueField(client, config, itemId, 'status', LABEL_CONFIG_KEYS[move.label])) {
      out.done({ verb: 'set', target: `Status of ${name} to ${move.label}` })
    }
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not move ${name}: ${error.message}`)
  }
  return { column: moved, missing: move.missing }
}
