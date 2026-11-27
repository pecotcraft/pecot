// board show の表示と、Archived の整理、Dependabot alert の収集。
import { z } from 'zod'

import { effectiveReleaseType, workflowFieldId } from '../domain/config.js'
import type { ProjectConfig, Repository } from '../domain/config.js'
import { DependabotAlertError, fetchDependabotAlertStatus } from '../domain/dependabot.js'
import type { DependabotAlertStatus } from '../domain/dependabot.js'
import { fieldNameById, fieldNamesWithValues, formatItemsJson, readBoardProgress, transformItems } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { JSON_NULL } from '../domain/json-null.js'
import { summarizeLanes } from '../domain/lanes.js'
import type { LaneSummary } from '../domain/lanes.js'
import { compareStrings } from '../domain/python-format.js'
import { createDependabotSource } from '../infra/github/dependabot-source.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { READINESS_JSON } from './issue-readiness.js'
import { isLegacyWorkflowFieldName } from '../domain/migration.js'
import { commandHint, hinted, placeholder, RUN_COLON } from './command-hint.js'
import type { BoardReadinessJson } from './issue-readiness.js'
import type { Output } from './output.js'
import { STATUS_FIELD_NAME, UNUSED_FIELD_NAMES } from './project-sync.js'

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

const ALERTS_JSON = z.union([
  z.strictObject({
    error: z.string().describe('Reason the Dependabot alerts could not be fetched'),
  }),
  z.strictObject({
    enabled: z.boolean().describe('Whether Dependabot alerts are enabled'),
    open_count: z.int().describe('Number of open alerts (0 when disabled)'),
    max_severity: z.string().nullable().describe('Highest severity of the open alerts (null when there is none)'),
    alerts_url: z.string().describe('URL of the alert list'),
  }),
])

// extend は同じ名前のキーを元の位置のまま置き換えるので、キーの並びは readinessJson と同じに保たれる
const BOARD_READINESS_JSON = READINESS_JSON.extend({
  kind: z.enum(['startable', 'stackable', 'blocked', 'unknown']).describe('Readiness judgment (unknown when the prerequisites could not be read)'),
  text: z.string().describe('Readiness as shown in the Readiness column'),
})

const BOARD_CONTENT_JSON = z.strictObject({
  number: z.unknown().optional().describe('Issue or PR number'),
  state: z.unknown().optional().describe('State of the Issue or PR (OPEN etc.)'),
  url: z.unknown().optional().describe('URL of the Issue or PR'),
  labels: z.array(z.string()).optional().describe('Label names'),
  repository: z.string().optional().describe('Repository (owner/repo)'),
})

const BOARD_ITEM_JSON = z.strictObject({
  id: z.unknown().optional().describe('Project item ID'),
  workflow: z.string().nullable().optional().describe('Column (workflow field value) of the item'),
  lane: z.string().nullable().optional().describe('Value of the pecot-lane field (null when the item has none or the board has no pecot-lane field)'),
  title: z.unknown().optional().describe('Title of the Issue or PR'),
  updatedAt: z.unknown().optional().describe('Last update time of the item'),
  content: BOARD_CONTENT_JSON.describe('Issue or PR on the card'),
  readiness: BOARD_READINESS_JSON.nullable().optional().describe('Readiness of a Ready or Blocked Issue (null for other items; omitted when the server does not support issue dependencies)'),
})

const PACKAGE_JSON = z.strictObject({
  name: z.string().describe('Package name'),
  changelog: z.string().describe('Path of the CHANGELOG of the package'),
})

const REPOSITORY_JSON = z.strictObject({
  full_name: z.string().describe('Repository (owner/repo)'),
  owner: z.string().describe('Owner of the repository'),
  name: z.string().describe('Name of the repository'),
  develop_branch: z.string().nullable().describe('Develop branch (null when not set)'),
  release_branch: z.string().nullable().describe('Release branch (null when not set)'),
  dependabot_alerts: ALERTS_JSON.describe('Dependabot alert status, or the reason it could not be fetched'),
  release_type: z.enum(['single', 'multi', 'nx']).describe('Release type in effect'),
  packages: z.array(PACKAGE_JSON).describe('Packages of a monorepo (data only; empty when none)'),
  changelog_file: z.string().optional().describe('CHANGELOG path set for a repository without packages (data only; omitted when not set)'),
})

const LANE_SUMMARY_JSON = z.strictObject({
  name: z.string().nullable().describe('Value of the pecot-lane field (null for the Issues without a value)'),
  count: z.int().describe('Number of open Issues with this value'),
  startable: z.int().describe('Number of those Issues in Ready whose readiness is startable'),
})
/**
board show の MCP の data。project・repositories・board・lanes は --json と同じ。repositories の release_type・packages・changelog_file と mismatches は data にだけ足す
*/
export const BOARD_SHOW_OUTPUT = z.strictObject({
  project: z.strictObject({
    name: z.string().describe('Name of the project config'),
    host: z.string().describe('GitHub host'),
    owner: z.string().describe('Owner of the project'),
    number: z.int().describe('Project number'),
    aggregation_repo: z.string().nullable().describe('Roadmap (aggregation) repository (null when not set)'),
  }).describe('Overview of the project'),
  repositories: z.array(REPOSITORY_JSON).describe('Registered repositories, in registration order'),
  board: z.strictObject({
    items: z.array(BOARD_ITEM_JSON).describe('Open items in Backlog, Pending, Blocked, Ready, Active and In Review'),
  }).describe('Board status'),
  lanes: z.array(LANE_SUMMARY_JSON).describe('Open Issues of the board items counted per pecot-lane value, in the order of the field options (values without Issues count 0; Issues without a value come last). Empty when the board has no pecot-lane field'),
  mismatches: z.int().describe('Number of Ready or Blocked Issues whose column or Status may not match the judgment (data only)'),
})

export type BoardShowJson = z.input<typeof BOARD_SHOW_OUTPUT>

type RepositoryExtras = Pick<BoardShowJson['repositories'][number], 'release_type' | 'packages' | 'changelog_file'>

/**
--json に出す中身（data にだけ足す項目を除いたもの）
*/
export type BoardShowCore = Omit<BoardShowJson, 'repositories' | 'mismatches'> & { readonly repositories: readonly Omit<BoardShowJson['repositories'][number], keyof RepositoryExtras>[] }

function alertsJson(status: AlertStatus): z.input<typeof ALERTS_JSON> {
  return typeof status === 'string' ? { error: status } : { enabled: status.enabled, open_count: status.openCount, max_severity: status.maxSeverity ?? JSON_NULL, alerts_url: status.alertsUrl }
}

function alertsLine(status: AlertStatus): string {
  if (typeof status === 'string') return `    dependabot_alerts: fetch failed (${status})`
  if (!status.enabled) return '    dependabot_alerts: disabled'
  return `    dependabot_alerts: open ${String(status.openCount)}`
}

export interface BoardShowView {
  readonly config: ProjectConfig
  readonly projectName: string
  readonly statuses: readonly AlertStatus[]
  /**
  pecot-lane の選択肢の名前。ボードに pecot-lane が無ければ undefined
  */
  readonly laneOptions?: readonly string[] | undefined
}

/**
アイテムの JSON の readiness を引く。判定の無いアイテムは null
*/
export type ReadinessSource = (item: BoardItem) => BoardReadinessJson | typeof JSON_NULL

function repositoryJson(entry: Repository, status: AlertStatus): BoardShowCore['repositories'][number] {
  return {
    full_name: `${entry.owner}/${entry.name}`,
    owner: entry.owner,
    name: entry.name,
    develop_branch: entry.develop_branch ?? JSON_NULL,
    release_branch: entry.release_branch ?? JSON_NULL,
    dependabot_alerts: alertsJson(status),
  }
}

function itemJson(item: BoardItem): z.input<typeof BOARD_ITEM_JSON> {
  const { labels } = item.content
  return { ...item, content: { ...item.content, labels: labels === undefined ? undefined : [...labels] } }
}

// board-judgment.ts の toTarget と同じく、URL で PR を見分ける
function isPullRequestItem(item: BoardItem): boolean {
  return typeof item.content.url === 'string' && item.content.url.includes('/pull/')
}

function laneSummaries(options: readonly string[] | undefined, items: readonly BoardItem[], readiness: ReadinessSource | undefined): LaneSummary[] {
  const issues = items.filter(item => !isPullRequestItem(item)).map(item => ({
    lane: item.lane ?? JSON_NULL,
    isStartable: item.workflow === 'Ready' && readiness !== undefined && readiness(item)?.kind === 'startable',
  }))
  return [...summarizeLanes(options, issues)]
}

/**
--json の標準出力と MCP の data の中身。キーを並べた順が --json の出力の順になる
*/
export function boardShowData(view: Readonly<BoardShowView>, items: readonly BoardItem[], readiness?: ReadinessSource): BoardShowCore {
  const { config, projectName, statuses } = view
  return {
    project: {
      name: projectName,
      host: config.host,
      owner: config.owner,
      number: config.project.number,
      aggregation_repo: config.aggregation_repo ?? JSON_NULL,
    },
    repositories: config.repositories.map((entry, index) => repositoryJson(entry, statusAt(statuses, index))),
    board: readiness === undefined
      ? { items: formatItemsJson(items).items.map(item => itemJson(item)) }
      : { items: items.map((item) => {
          const found = readiness(item)
          return { ...itemJson(item), readiness: found }
        }) },
    lanes: laneSummaries(view.laneOptions, items, readiness),
  }
}

/**
info --json の出力
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の input の型は配列が可変
export function boardShowJson(data: Readonly<BoardShowCore>): string {
  return JSON.stringify(data, undefined, 2)
}

/**
MCP の data。--json の中身に、リポジトリごとの release_type・packages・changelog_file と、食い違いの件数を足す
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の input の型は配列が可変
export function boardShowResult(view: Readonly<BoardShowView>, core: Readonly<BoardShowCore>, mismatches: number): BoardShowJson {
  const { config, statuses } = view
  return {
    ...core,
    repositories: config.repositories.map((entry, index) => ({ ...repositoryJson(entry, statusAt(statuses, index)), ...repositoryExtras(entry) })),
    mismatches,
  }
}

function repositoryExtras(entry: Repository): RepositoryExtras {
  return {
    release_type: effectiveReleaseType(entry),
    packages: (entry.packages ?? []).map(item => ({ name: item.name, changelog: item.changelog })),
    ...entry.changelog_file !== undefined && entry.changelog_file !== '' && { changelog_file: entry.changelog_file },
  }
}

function repositoryLines(view: Readonly<BoardShowView>): readonly string[] {
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

function lanesSection(lanes: readonly LaneSummary[]): readonly string[] {
  if (lanes.length === 0) return []
  const rows = lanes.map(lane => `| ${lane.name ?? '(none)'} | ${String(lane.count)} | ${String(lane.startable)} |`)
  return ['', '## Lanes', '', '| Lane | Issues | Startable |', '|------|--------|-----------|', ...rows]
}

/**
info の Markdown の出力。lanes が空でなければ、Board status の後に Lanes の節を足す
*/
export function boardShowMarkdown(view: Readonly<BoardShowView>, effectiveRepository: string | undefined, boardOutput: string, lanes: readonly LaneSummary[] = []): string {
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
    ...lanesSection(lanes),
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
  out.warning(hinted`this board ${findings.join(' and ')}\n${RUN_COLON}${commandHint(['project', 'init'], { owner: config.owner, name: placeholder('name'), host: config.host })}`)
}
