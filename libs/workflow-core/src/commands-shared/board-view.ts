// board sync が使う、ボードの読み取りと Archived の整理。

import { workflowFieldId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { fieldNameById, fieldNamesWithValues, readBoardProgress, transformItems } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { compareStrings } from '../domain/python-format.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { isLegacyWorkflowFieldName } from '../domain/migration.js'
import { hinted, RUN_COLON } from './command-hint.js'
import type { Output } from './output.js'
import { boardFieldsHint } from './project-sync.js'
import { STATUS_FIELD_NAME, UNUSED_FIELD_NAMES } from './workflow-fields.js'

/**
Archived のうち、ボードに残す件数
*/
const ARCHIVED_KEEP = 20

const DISPLAY_STATUSES: ReadonlySet<string> = new Set(['Backlog', 'Pending', 'Blocked', 'Ready', 'Active', 'In Review'])

function updatedAtOf(item: Readonly<BoardItem>): string {
  return typeof item.updatedAt === 'string' ? item.updatedAt : ''
}

/**
Archived のアイテムを updatedAt の新しい順に並べ、最新の 20 件を残して、残りをボードから消す。
消せなかった件数を warning の行に出す。消した件数（dry-run は消す予定の件数）と、消せなかった件数を返す
*/
export async function pruneArchivedItems(out: Readonly<Output>, client: Readonly<Pick<GitHubClient, 'deleteProjectItem'>>, config: ProjectConfig, allItems: readonly BoardItem[], isDryRun: boolean): Promise<{ readonly deleted: number, readonly failed: number }> {
  const archived = allItems.filter(item => item.workflow === 'Archived').toSorted((first, second) => compareStrings(updatedAtOf(second), updatedAtOf(first)))
  if (archived.length <= ARCHIVED_KEEP) return { deleted: 0, failed: 0 }
  const targets = archived.slice(ARCHIVED_KEEP)
  if (isDryRun) {
    out.planned({ verb: 'delete', target: `${String(targets.length)} archived items` })
    return { deleted: targets.length, failed: 0 }
  }
  let deleted = 0
  for (const item of targets) {
    // ID が文字列でないアイテムは、API を呼ばず、失敗として数える
    if (typeof item.id !== 'string') continue
    try {
      await client.deleteProjectItem(config.project.id, item.id)
      deleted += 1
    }
    catch (error: unknown) {
      // 削除の失敗は数えて続ける
      if (!(error instanceof GitHubAPIError)) throw error
    }
  }
  if (deleted > 0) out.done({ verb: 'delete', target: `${String(deleted)} archived items`, aside: true })
  const failed = targets.length - deleted
  if (failed > 0) out.warning(`failed to delete ${String(failed)} archived items`)
  return { deleted, failed }
}

/**
items を最大 limit 件ずつ並列に処理し、結果を items の順で返す。1 件でも投げたら、その例外で止まる
*/
export async function mapWithLimit<Item, Result>(items: readonly Item[], limit: number, task: (item: Item) => Promise<Result>): Promise<readonly Result[]> {
  const results: Result[] = []
  // 全ての worker が同じ iterator から次の項目を取る
  const pending = items.entries()
  const worker = async (): Promise<void> => {
    // eslint-disable-next-line security/detect-object-injection -- index は entries() の添字
    for (const [index, item] of pending) results[index] = await task(item)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface BoardRead {
  readonly allItems: readonly BoardItem[]
  /**
  表示するアイテム（OPEN の Backlog・Pending・Blocked・Ready・Active・In Review。リポジトリの指定があれば絞る）
  */
  readonly items: readonly BoardItem[]
  /**
  boardItemKey → 着手の判定の軽い入力。前提の無い Issue の個別の読み取りを省く
  */
  readonly progress: ReadonlyMap<string, BoardProgress>
  /**
  一覧を足す前のクエリで読み直した（Issue の依存関係に対応しない GHES）
  */
  readonly isLegacy: boolean
  /**
  進行の欄のボード上の今の名前。どの Item にも値が無ければ undefined
  */
  readonly workflowFieldName: string | undefined
  /**
  pecot が使わないフィールド（UNUSED_FIELD_NAMES）のうち、どれかの Item に値が残るものの名前
  */
  readonly unusedFieldNames: readonly string[]
  /**
  pecot-lane の選択肢の名前。ボードに single select の pecot-lane が無ければ undefined
  */
  readonly laneOptions: readonly string[] | undefined
}

/**
ボードのアイテムを全部読み、表示するものに絞る。進行の欄は設定のフィールド ID で読む
*/
export async function readBoard(client: Readonly<GitHubClient>, config: ProjectConfig, effectiveRepository: string | undefined): Promise<BoardRead> {
  const fieldId = workflowFieldId(config)
  const state: { isLegacy: boolean, laneOptions: readonly string[] | undefined } = { isLegacy: false, laneOptions: undefined }
  const rawItems = await client.listProjectItems(config.project.id, {
    workflowFieldId: fieldId,
    onLegacy: () => {
      state.isLegacy = true
    },
    onLaneOptions: (options) => {
      state.laneOptions = options
    },
  })
  const allItems = transformItems(rawItems, fieldId)
  const open = allItems.filter(item => item.content.state === 'OPEN' && typeof item.workflow === 'string' && DISPLAY_STATUSES.has(item.workflow))
  const items = effectiveRepository === undefined || effectiveRepository === '' ? open : open.filter(item => item.content.repository === effectiveRepository)
  return { allItems, items, progress: readBoardProgress(rawItems, STATUS_FIELD_NAME), isLegacy: state.isLegacy, workflowFieldName: fieldNameById(rawItems, fieldId), unusedFieldNames: fieldNamesWithValues(rawItems, UNUSED_FIELD_NAMES), laneOptions: state.laneOptions }
}

/**
進行の欄が旧い名前（pecot-workflow-<suffix>）のままか、pecot が使わないフィールドに値が残るなら、移行の手順を 1 つの warning で出す
*/
export function warnOldFieldName(out: Readonly<Output>, config: ProjectConfig, read: Readonly<BoardRead>): void {
  const name = read.workflowFieldName
  const legacy = name !== undefined && isLegacyWorkflowFieldName(name) ? `uses the old field name ${name}` : undefined
  const unused = read.unusedFieldNames.length > 0 ? `still has fields pecot does not use: ${read.unusedFieldNames.join(', ')}` : undefined
  const findings = [legacy, unused].filter(finding => finding !== undefined)
  if (findings.length === 0) return
  out.warning(hinted`this board ${findings.join(' and ')}\n${RUN_COLON}${boardFieldsHint({ owner: config.owner, number: config.project.number })}`)
}
