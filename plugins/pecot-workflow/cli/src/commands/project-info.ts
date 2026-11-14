// board show の表示と、Archived の整理、Dependabot alert の収集。
import { effectiveReleaseType, workflowFieldName } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { DependabotAlertError, fetchDependabotAlertStatus } from '../domain/dependabot.js'
import type { DependabotAlertStatus } from '../domain/dependabot.js'
import { formatItemsJson, readBoardProgress, transformItems } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import { compareStrings } from '../domain/python-format.js'
import { createDependabotSource } from '../infra/github/dependabot-source.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { Output } from './output.js'
import { STATUS_FIELD_NAME } from './project-sync.js'

/**
Archived のうち、ボードに残す件数
*/
const ARCHIVED_KEEP = 20

/**
Dependabot alert を並列に取る数の上限（Python の _ALERT_FETCH_MAX_WORKERS と同じ）
*/
const ALERT_FETCH_MAX_WORKERS = 8

const DISPLAY_STATUSES: ReadonlySet<string> = new Set(['Backlog', 'Pending', 'Blocked', 'Ready', 'Active', 'In Review'])

/**
取得に失敗したリポジトリは、理由の文字列
*/
export type AlertStatus = DependabotAlertStatus | string

function updatedAtOf(item: Readonly<BoardItem>): string {
  return typeof item.updatedAt === 'string' ? item.updatedAt : ''
}

/**
Archived のアイテムを updatedAt の新しい順に並べ、最新の 20 件を残して、残りをボードから消す。
消せなかった分は warning にとどめる
*/
export async function pruneArchivedItems(out: Readonly<Output>, client: Readonly<Pick<GitHubClient, 'deleteProjectItem'>>, config: ProjectConfig, allItems: readonly BoardItem[]): Promise<void> {
  const archived = allItems.filter(item => item.workflow === 'Archived').toSorted((first, second) => compareStrings(updatedAtOf(second), updatedAtOf(first)))
  if (archived.length <= ARCHIVED_KEEP) return
  const targets = archived.slice(ARCHIVED_KEEP)
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
  if (deleted > 0) out.done({ verb: 'delete', target: `${String(deleted)} archived items` })
  const failed = targets.length - deleted
  if (failed > 0) out.warning(`failed to delete ${String(failed)} archived items`)
}

/**
登録リポジトリごとの Dependabot alert の状態（登録の順）。
1 つの取得の失敗でボードの表示を止めないよう、DependabotAlertError はここで理由の文字列にする
*/
export async function collectAlertStatuses(client: Readonly<GitHubClient>, config: ProjectConfig): Promise<readonly AlertStatus[]> {
  const source = createDependabotSource(client)
  return await mapWithLimit(config.repositories, ALERT_FETCH_MAX_WORKERS, async (entry): Promise<AlertStatus> => {
    try {
      return await fetchDependabotAlertStatus(source, config.host, entry.owner, entry.name)
    }
    catch (error: unknown) {
      if (error instanceof DependabotAlertError) return error.message
      throw error
    }
  })
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

/**
index 番目の取得結果。件数が登録のリポジトリとずれていたら投げる
*/
function statusAt(statuses: readonly AlertStatus[], index: number): AlertStatus {
  const status = statuses.at(index)
  if (status === undefined) throw new RangeError(`no Dependabot alert status for repository #${String(index)}`)
  return status
}

function alertsJson(status: AlertStatus): JsonObject {
  return typeof status === 'string' ? { error: status } : { enabled: status.enabled, open_count: status.openCount, max_severity: status.maxSeverity ?? JSON_NULL, alerts_url: status.alertsUrl }
}

function alertsLine(status: AlertStatus): string {
  if (typeof status === 'string') return `    dependabot_alerts: fetch failed (${status})`
  if (!status.enabled) return '    dependabot_alerts: disabled'
  return `    dependabot_alerts: open ${String(status.openCount)}`
}

export interface InfoView {
  readonly config: ProjectConfig
  readonly projectName: string
  readonly statuses: readonly AlertStatus[]
}

/**
アイテムの JSON の readiness を引く。判定の無いアイテムは null
*/
export type ReadinessSource = (item: BoardItem) => JsonObject | typeof JSON_NULL

/**
info --json の出力
*/
export function infoJson(view: Readonly<InfoView>, items: readonly BoardItem[], readiness?: ReadinessSource): string {
  const { config, projectName, statuses } = view
  const output = {
    project: {
      name: projectName,
      host: config.host,
      owner: config.owner,
      number: config.project.number,
      aggregation_repo: config.aggregation_repo ?? JSON_NULL,
    },
    repositories: config.repositories.map((entry, index) => ({
      full_name: `${entry.owner}/${entry.name}`,
      owner: entry.owner,
      name: entry.name,
      develop_branch: entry.develop_branch ?? JSON_NULL,
      release_branch: entry.release_branch ?? JSON_NULL,
      dependabot_alerts: alertsJson(statusAt(statuses, index)),
    })),
    board: readiness === undefined ? formatItemsJson(items) : { items: items.map(item => ({ ...item, readiness: readiness(item) })) },
  }
  return JSON.stringify(output, undefined, 2)
}

function repositoryLines(view: Readonly<InfoView>): readonly string[] {
  const { config, statuses } = view
  if (config.repositories.length === 0) return ['## Registered repositories', '- none']
  const lines = ['## Registered repositories']
  for (const [index, entry] of config.repositories.entries()) {
    const develop = entry.develop_branch === undefined || entry.develop_branch === '' ? [] : [`develop: ${entry.develop_branch}`]
    const release = entry.release_branch === undefined || entry.release_branch === '' ? [] : [`release: ${entry.release_branch}`]
    const branches = [...develop, ...release]
    const fullName = `${entry.owner}/${entry.name}`
    lines.push(
      branches.length > 0 ? `- ${fullName} (${branches.join(', ')})` : `- ${fullName}`,
      `    release_type: ${effectiveReleaseType(entry)}`,
      alertsLine(statusAt(statuses, index)),
    )
    if (entry.packages !== undefined && entry.packages.length > 0) {
      for (const item of entry.packages) lines.push(`    package: ${item.name} → ${item.changelog}`)
    }
    else if (entry.changelog_file !== undefined && entry.changelog_file !== '') {
      lines.push(`    changelog: ${entry.changelog_file}`)
    }
  }
  return lines
}

/**
info の Markdown の出力
*/
export function infoMarkdown(view: Readonly<InfoView>, effectiveRepository: string | undefined, boardOutput: string, chainsSection?: string): string {
  const { config, projectName } = view
  const aggregation = config.aggregation_repo === undefined || config.aggregation_repo === '' ? 'none' : `\`${config.aggregation_repo}\``
  return [
    '# Project info',
    '',
    '## Overview',
    `- Project: ${projectName}`,
    `- Host: ${config.host}`,
    `- Owner: ${config.owner}`,
    `- Roadmap repo: ${aggregation}`,
    '',
    ...repositoryLines(view),
    '',
    effectiveRepository === undefined || effectiveRepository === '' ? '## Board status' : `## Board status (filter: ${effectiveRepository})`,
    '',
    boardOutput,
    ...(chainsSection === undefined ? [] : ['', chainsSection]),
  ].join('\n')
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
}

/**
ボードのアイテムを全部読み、表示するものに絞る
*/
export async function readBoard(client: Readonly<GitHubClient>, config: ProjectConfig, effectiveRepository: string | undefined): Promise<BoardRead> {
  const fieldName = workflowFieldName(config)
  const state = { isLegacy: false }
  const rawItems = await client.listProjectItems(config.project.id, { workflowFieldName: fieldName, onLegacy: () => {
    state.isLegacy = true
  } })
  const allItems = transformItems(rawItems, fieldName)
  const open = allItems.filter(item => item.content.state === 'OPEN' && typeof item.workflow === 'string' && DISPLAY_STATUSES.has(item.workflow))
  const items = effectiveRepository === undefined || effectiveRepository === '' ? open : open.filter(item => item.content.repository === effectiveRepository)
  return { allItems, items, progress: readBoardProgress(rawItems, STATUS_FIELD_NAME), isLegacy: state.isLegacy }
}
