/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者の引数で決まる */
// issue create。--prepare・ファイル・-m の 3 つの形と、ファイルの一括投稿の前提を確かめる --plan がある。
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { formatPlanTable, formatStackableChains, resolveBatch } from '../domain/batch-plan.js'
import type { BatchFile, PlanRow, ResolvedPrerequisite } from '../domain/batch-plan.js'
import { decideBoardMove } from '../domain/board-move.js'
import type { BoardMove, BoardMoveInput, MovableColumn } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { InternalError, InvalidValueError } from '../domain/errors.js'
import { splitOwnerRepository, createRepositoryReference } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { FrontmatterError, stripFrontmatter, stripLeadingHtmlComment } from '../domain/frontmatter.js'
import type { IssueFrontmatter } from '../domain/frontmatter.js'
import { findBatchDuplicate, planOrders } from '../domain/issue-order.js'
import type { OrderRequest } from '../domain/issue-order.js'
import { upsertWaitsForMerge } from '../domain/prerequisites.js'
import { FLAG_ISSUE_CREATE_SLASH_PENDING, FLAG_ISSUE_PENDING } from '../domain/state.js'
import { compareStrings, pythonStrip, pythonStringRepr } from '../domain/python-format.js'
import { createIssueReference, issueReferenceKey, issueReferenceToCliReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { describeReadiness, displayReference, hasStarted } from '../domain/readiness.js'
import type { Progression } from '../domain/readiness.js'
import { parseIssueFile } from '../infra/frontmatter-file.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import { DEPENDENCIES_UNSUPPORTED } from '../infra/github/issues.js'
import type { GitHubClient } from '../infra/github/index.js'
import { OutputPathReservationError, normalizePath, outputDirectory, resolveRealPath, withReservedOutputPath } from '../infra/paths.js'
import { consumeFlag } from '../infra/state-store.js'
import { templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'
import { stopWith, requireActiveConfigPlain } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { applyBoardMove } from './issue-board.js'
import type { BoardItem } from './issue-board.js'
import { createReadinessCache, readIssueReadiness } from './issue-readiness.js'
import type { JudgedIssue, ReadinessCache } from './issue-readiness.js'
import {
  addToBoardOrWarn,
  buildIssueTitle,
  clientForIssueCreate,
  createIssueOrExit,
  ensureRepositoryInProject,
  ISSUE_TYPE_SCHEMA,
  issuePath,
  linkToParentEpic,
  normalizeParentEpicCli,
  PARENT_EPIC_DESCRIPTION,
  readUsedOrders,
  resolveEpicTargetRepository,
  resolveParentEpicReference,
  runWithExit,
  setIssueFields,
  stopForDuplicateOrder,
  summarizeCreatedIssue,
  TYPE_DEFAULT_STATUS,
  validateIssueTemplate,
  validateStatusForType,
  warnEpicRepositoryException,
} from './issue-shared.js'
import type { IssueField, IssueType } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const FILES_SCHEMA = z.array(z.string()).optional().describe('Path of a Markdown file with frontmatter (several for a batch post)')
const LABEL_SCHEMA = z.array(z.string()).optional().describe('Label (can be given several times)')
const TEMPLATE_SCHEMA = z.enum(['task', 'bug', 'epic', 'tracker', 'task-implement']).default('task').describe('Template type (with --prepare: task/bug/epic/tracker/task-implement)')

// 一括投稿の先行 Issue 番号の置き場所。key は先行ファイルの --suffix 由来か、ファイルの stem
const PLACEHOLDER_PATTERN = /\{\{issue:([^{}\s]+)\}\}/gu
// --prepare --suffix が作るファイル名 `issue-<template>-<YYYYMMDD>-<HHMMSS>-<suffix>`
const PREPARED_FILENAME_PATTERN = /^issue-.+-\d{8}-\d{6}-(?<suffix>.+)$/u
// Python の `$` は末尾の改行の前にも当たる
const REPOSITORY_SEGMENT_PATTERN = /^[\w.-]+\n?$/u

interface CreatedIssue {
  readonly repository: string
  readonly number: number
}

// --- 共通 ---

// owner/repo の形が不正なら error と終了コード 2。正しければ owner と name を返す
function validateRepositoryShape(output: Output, repository: string): readonly [string, string] {
  const parts = splitOwnerRepository(repository)
  const isValid = parts !== undefined && REPOSITORY_SEGMENT_PATTERN.test(parts.owner) && REPOSITORY_SEGMENT_PATTERN.test(parts.repository)
  const message = `invalid repository format: ${repository}\nexpected: owner/repo`
  return isValid ? [parts.owner, parts.repository] : stopWith(output, message, USAGE_EXIT_CODE)
}

interface PostPrerequisite {
  readonly reference: IssueReference
  readonly nodeId: () => Promise<string>
  readonly wait: 'stack' | 'merge'
  readonly reason: string | undefined
}

interface Posting {
  readonly owner: string
  readonly repository: string
  readonly title: string
  readonly body: string
  readonly labels: readonly string[] | undefined
  /**
  `created: ... from <source>` の source。ファイルの名前
  */
  readonly source: string | undefined
  /**
  真なら、作成の応答の node_id をボードへの追加に使う。偽なら、追加の側で取り直す
  */
  readonly useResponseNodeId: boolean
  readonly fields: readonly IssueField[]
  readonly parentReference: IssueReference | undefined
  readonly prerequisites: readonly PostPrerequisite[]
  /**
  真なら、前提をすべて付けた後に判定を読み、Blocked の列を直す。既存の Issue を前提に持ち、Blocked で作った Issue だけが真
  */
  readonly settleColumn: boolean
}

/**
1 回の投稿の間の記録。failures は付け直すコマンド
*/
interface PostingSession {
  readonly failures: string[]
  readonly cache: ReadinessCache
}

interface PostedIssue {
  readonly number: number
  /**
  作成の応答の node_id。無ければ、ボードへの追加で取れたもの
  */
  readonly nodeId: string | undefined
  /**
  列を Blocked から Ready へ動かしたか
  */
  readonly isMovedToReady: boolean
}

function reAddCommand(issue: IssueReference, prerequisite: Readonly<PostPrerequisite>): string {
  const base = `pecot issue block ${issueReferenceToCliReference(issue)} --by ${issueReferenceToCliReference(prerequisite.reference)}`
  return prerequisite.wait === 'merge' ? `${base} --wait merge --reason ${shellQuote(prerequisite.reason ?? '')}` : base
}

// シェルに展開されないよう、単一引用符で包む
function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

// 前提を 1 件ずつ付ける。失敗は warning にして続け、付け直すコマンドを session に積む。付けた数を返す
async function addPrerequisites(output: Output, client: GitHubClient, session: PostingSession, issue: IssueReference, issueNodeId: string | undefined, prerequisites: readonly PostPrerequisite[]): Promise<number> {
  const here = displayReference(issue, issue.repository)
  let linked = 0
  for (const prerequisite of prerequisites) {
    const there = displayReference(prerequisite.reference, issue.repository)
    try {
      if (issueNodeId === undefined) throw new GitHubAPIError('could not read the node ID of the Issue')
      await client.addBlockedBy(issueNodeId, await prerequisite.nodeId())
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      output.warning(`could not add blocked-by ${there} to ${here}: ${error.message}`)
      session.failures.push(reAddCommand(issue, prerequisite))
      continue
    }
    linked += 1
    output.done({ verb: 'add', target: `blocked-by ${there} to ${here}` })
  }
  return linked
}

// 列を直す入力。column には、この CLI が今書いた Blocked を渡す
function boardMoveInput(config: ProjectConfig, judged: Readonly<JudgedIssue>): BoardMoveInput {
  return {
    eligible: judged.target.state === 'open' && judged.target.kind === 'task',
    column: 'Blocked',
    label: judged.target.label,
    hasStarted: hasStarted(judged.target),
    hasPrerequisites: true,
    readiness: judged.readiness,
    labelWrittenByAutomation: false,
    available: {
      blocked: getOptionId(config, 'workflow', 'blocked') !== undefined,
      needsAttention: getOptionId(config, 'status', 'needs_attention') !== undefined,
      todo: getOptionId(config, 'status', 'todo') !== undefined,
    },
  }
}

// 既存の Issue を前提に持つ Issue の判定を読み、前提が済んでいれば Ready へ動かす。読めないときは、列をそのままにする
async function settleColumn(output: Output, client: GitHubClient, config: ProjectConfig, session: PostingSession, issue: IssueReference, item: BoardItem, linked: number): Promise<MovableColumn | undefined> {
  let judged
  try {
    judged = await readIssueReadiness(client, config, issue, session.cache)
  }
  catch (error: unknown) {
    if (error instanceof DependenciesUnsupportedError) return undefined
    throw error
  }
  if (judged.kind === 'unreadable' || judged.readiness === undefined) return undefined
  if (judged.prerequisites.length < linked) {
    output.warning(`could not read all blocked-by of ${displayReference(issue, issue.repository)} yet; left it in Blocked`)
    return undefined
  }
  const move = decideBoardMove(boardMoveInput(config, judged))
  if (move === undefined) return undefined
  // 起票の直後は、既定の自動化が札を書くので、札は書かない
  const applied = await applyBoardMove(output, client, config, item.itemId, { ref: issue, home: issue.repository }, withoutLabel(move), describeReadiness(judged.readiness, judged.prerequisites, issue.repository))
  return applied.column
}

function withoutLabel(move: Readonly<BoardMove>): BoardMove {
  return { missing: move.missing, ...move.column !== undefined && { column: move.column }, ...move.conflict !== undefined && { conflict: move.conflict } }
}

/**
Issue を作り、前提・ボード・欄・列の直し・親 Epic への接続・URL の出力まで順に行う。
前提を先に付けるので、後の段で止まっても、作った Issue の前提は付いている。
ボードへの追加に失敗したら、欄と列は飛ばして親 Epic への接続へ進む
*/
async function postIssue(output: Output, client: GitHubClient, config: ProjectConfig, session: PostingSession, posting: Readonly<Posting>): Promise<PostedIssue> {
  const { owner, repository } = posting
  const issue = await createIssueOrExit(output, client, owner, repository, posting.title, posting.body, posting.labels, posting.source)
  const { number, url, nodeId } = summarizeCreatedIssue(issue)
  const target = `Issue ${issuePath(owner, repository, number)}`
  const reference = createIssueReference(createRepositoryReference(owner, repository), number)
  consumeFlag(FLAG_ISSUE_PENDING)

  // 応答に node_id が無いときだけ、ボードへの追加の結果から取るので、先にボードへ足す
  let added: BoardItem | undefined
  let hasTriedBoard = false
  let issueNodeId = nodeId
  if (issueNodeId === undefined && posting.prerequisites.length > 0) {
    added = await addToBoardOrWarn(output, client, config, owner, repository, number, undefined, url)
    hasTriedBoard = true
    issueNodeId = added?.issueNodeId
  }
  const linked = await addPrerequisites(output, client, session, reference, issueNodeId, posting.prerequisites)
  if (!hasTriedBoard) added = await addToBoardOrWarn(output, client, config, owner, repository, number, posting.useResponseNodeId ? nodeId : undefined, url)

  let isMovedToReady = false
  if (added !== undefined) {
    const written = await setIssueFields(output, client, config, added.itemId, target, posting.fields)
    if (posting.settleColumn && written.includes('workflow') && linked === posting.prerequisites.length) {
      isMovedToReady = await settleColumn(output, client, config, session, reference, added, linked) === 'Ready'
    }
  }
  const knownNodeId = added?.issueNodeId ?? issueNodeId
  if (posting.parentReference !== undefined) {
    // ボードへの追加に失敗したときは、URL を出し済み
    await linkToParentEpic(output, client, target, posting.parentReference, knownNodeId ?? (() => client.getIssueNodeId(owner, repository, number)), added === undefined ? undefined : url)
  }
  if (added !== undefined) output.data(url)
  return { number, nodeId: knownNodeId, isMovedToReady }
}

function parentReferenceOf(raw: number | string | undefined, config: ProjectConfig, owner: string, repository: string): IssueReference | undefined {
  return raw === undefined ? undefined : resolveParentEpicReference(raw, config, owner, repository)
}

// --- --prepare ---

function prepareTemplate(output: Output, template: IssueType | 'task-implement', repository: string | undefined, suffix: string | undefined): void {
  if (template !== 'epic' && repository === undefined) {
    stopWith(output, '--repo owner/repo is required with --template task|bug|tracker|task-implement', USAGE_EXIT_CODE)
  }
  if (repository !== undefined) validateRepositoryShape(output, repository)

  const source = templateFile('issue', template)
  if (!existsSync(source)) {
    stopWith(output, `template not found: ${source}`)
  }
  let content = readTextFile(source)
  // 置き換えの文字列に `$` があっても、そのまま入れる
  if (repository !== undefined) content = content.replace('repository: ""', () => `repository: ${repository}`)

  const nameSuffix = suffix === undefined || suffix === '' ? '' : `-${suffix}`
  try {
    withReservedOutputPath(outputDirectory(), timestamp => `issue-${template}-${timestamp}${nameSuffix}.md`, (reserved) => {
      writeFileSync(reserved, content, 'utf8')
      output.data(reserved)
    })
  }
  catch (error: unknown) {
    if (!(error instanceof OutputPathReservationError)) throw error
    stopWith(output, error.message)
  }
}

// --- ファイルからの一括投稿 ---

// 前提に書けるキーすべて（幹と suffix）と、代表のキー（suffix があれば suffix、無ければ幹）
function fileKeys(file: string): { readonly key: string, readonly keys: readonly string[] } {
  const stem = path.parse(path.basename(file)).name
  const suffix = PREPARED_FILENAME_PATTERN.exec(stem)?.groups?.['suffix']
  return suffix === undefined ? { key: stem, keys: [stem] } : { key: suffix, keys: [stem, suffix] }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

// 1 件も投稿しないうちに、ファイルの重複・不在と、先行を指さないプレースホルダを止める
function validatePlaceholders(output: Output, files: readonly string[]): void {
  const seen = new Set<string>()
  const available = new Set<string>()
  for (const file of files) {
    const resolved = resolveRealPath(file)
    if (seen.has(resolved)) {
      stopWith(output, `file specified more than once: ${normalizePath(file)}`)
    }
    seen.add(resolved)
    if (!isFile(file)) {
      stopWith(output, `file not found: ${normalizePath(file)}`)
    }
    // フロントマターと冒頭のガイドコメントは投稿本文に出ないので、走査から外す
    const body = stripLeadingHtmlComment(stripFrontmatter(readTextFile(file)))
    for (const [, reference] of body.matchAll(PLACEHOLDER_PATTERN)) {
      if (reference === undefined || available.has(reference)) continue
      stopWith(output, `{{issue:${reference}}} in ${path.basename(file)} does not point to an earlier file (forward reference or unknown key)\nput the file it depends on earlier in the arguments`)
    }
    const { keys } = fileKeys(file)
    const collided = keys.filter(key => available.has(key)).toSorted(compareStrings)
    if (collided.length > 0) {
      stopWith(output, `placeholder keys collide: ${collided.join(', ')} (${path.basename(file)})`)
    }
    for (const key of keys) available.add(key)
  }
}

// ファイル入力の作成先。Epic は aggregation_repo の方針で決める
function fileTargetRepository(output: Output, frontmatter: IssueFrontmatter, config: ProjectConfig): readonly [string, string] {
  let resolved: string
  if (frontmatter.type === 'epic') {
    const explicit = frontmatter.repository === '' ? undefined : pythonStrip(frontmatter.repository)
    const target = resolveEpicTargetRepository(output, explicit, config)
    if (target.needsWarning) warnEpicRepositoryException(output, target.repository, config)
    resolved = target.repository
  }
  else {
    resolved = frontmatter.repository
  }
  const parts = splitOwnerRepository(resolved)
  if (parts === undefined) {
    stopWith(output, `invalid repository format in the frontmatter: ${pythonStringRepr(frontmatter.repository)}`)
  }
  return [parts.owner, parts.repository]
}

interface LocalFile {
  readonly name: string
  readonly frontmatter: IssueFrontmatter
  readonly body: string
  readonly owner: string
  readonly repository: string
  /**
  前提に書ける代表のキー。suffix があれば suffix、無ければ幹
  */
  readonly key: string
  readonly keys: readonly string[]
  readonly parentReference: IssueReference | undefined
  /**
  ボードに書く列。Blocked の列がボードに無いときは ready
  */
  readonly status: string
  readonly hasNoBlockedColumn: boolean
}

function stopForFrontmatter(output: Output, error: FrontmatterError, name: string): never {
  if (error.kind === 'parallel') return stopWith(output, `parallel is no longer supported in ${name}. Remove it`)
  if (error.kind === 'merge-without-reason') return stopWith(output, `blocked_by in ${name} needs reason for wait: merge`)
  return stopWith(output, error.message)
}

// 投稿の前に、`## Waits for merge` の節が書ける本文かを確かめる（番号は仮）
function checkWaitsForMergeWritable(output: Output, name: string, body: string, home: RepositoryReference, entries: IssueFrontmatter['blocked_by']): void {
  const entry = entries.find(candidate => candidate.wait === 'merge')
  if (entry === undefined) return
  try {
    upsertWaitsForMerge(body, home, createIssueReference(home, 1), entry.reason ?? 'x')
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError)) throw error
    stopWith(output, `cannot write the Waits for merge section of ${name}: ${error.message}`)
  }
}

function readLocalFile(output: Output, config: ProjectConfig, file: string): LocalFile {
  const name = path.basename(file)
  let parsed
  try {
    parsed = parseIssueFile(file)
  }
  catch (error: unknown) {
    if (!(error instanceof FrontmatterError)) throw error
    return stopForFrontmatter(output, error, name)
  }
  const { frontmatter } = parsed
  const [owner, repository] = fileTargetRepository(output, frontmatter, config)
  const home = createRepositoryReference(owner, repository)

  validateIssueTemplate(output, frontmatter.template ?? frontmatter.type, parsed.body.replaceAll(PLACEHOLDER_PATTERN, '#1'))
  const hasPrerequisites = frontmatter.blocked_by.length > 0
  const declared = frontmatter.status ?? (hasPrerequisites ? 'blocked' : TYPE_DEFAULT_STATUS[frontmatter.type])
  validateStatusForType(output, frontmatter.type, declared, hasPrerequisites ? ['blocked'] : undefined)
  checkWaitsForMergeWritable(output, name, parsed.body, home, frontmatter.blocked_by)

  const hasNoBlockedColumn = declared === 'blocked' && getOptionId(config, 'workflow', 'blocked') === undefined
  const { key, keys } = fileKeys(file)
  return {
    name,
    frontmatter,
    body: parsed.body,
    owner,
    repository,
    key,
    keys,
    parentReference: parentReferenceOf(frontmatter.parent_epic, config, owner, repository),
    status: hasNoBlockedColumn ? 'ready' : declared,
    hasNoBlockedColumn,
  }
}

function homeOf(file: Readonly<LocalFile>): RepositoryReference {
  return createRepositoryReference(file.owner, file.repository)
}

function frontmatterFields(file: Readonly<LocalFile>): readonly IssueField[] {
  const { frontmatter, status } = file
  const fields: IssueField[] = [{ fieldName: 'workflow', optionName: status, label: `status ${status}` }]
  if (frontmatter.priority !== undefined) fields.push({ fieldName: 'priority', optionName: frontmatter.priority, label: `priority ${frontmatter.priority}` })
  if (frontmatter.size !== undefined) fields.push({ fieldName: 'size', optionName: frontmatter.size, label: `size ${frontmatter.size}` })
  return fields
}

interface ParentGroup {
  readonly parent: IssueReference
  readonly members: readonly { readonly index: number, readonly file: LocalFile }[]
}

// 同じ親 Epic のファイルを、親ごとに、ファイルの順にまとめる。親の無いファイルは入らない
function groupByParent(files: readonly LocalFile[]): readonly ParentGroup[] {
  const byKey = new Map<string, { readonly parent: IssueReference, readonly members: { readonly index: number, readonly file: LocalFile }[] }>()
  const groups: ParentGroup[] = []
  for (const [index, file] of files.entries()) {
    const { parentReference: parent } = file
    if (parent === undefined) continue
    const key = issueReferenceKey(parent)
    let group = byKey.get(key)
    if (group === undefined) {
      group = { parent, members: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.members.push({ index, file })
  }
  return groups
}

function orderRequests(group: Readonly<ParentGroup>): readonly OrderRequest[] {
  return group.members.map(({ file }): OrderRequest => ({ file: file.name, order: file.frontmatter.order }))
}

function stopForBatchDuplicate(output: Output, duplicate: Readonly<{ order: number, files: readonly string[] }>): never {
  return stopWith(output, `order ${String(duplicate.order)} is specified by more than one file: ${duplicate.files.join(', ')}`)
}

function stopForOrderPlan(output: Output, parent: IssueReference, plan: Exclude<ReturnType<typeof planOrders>, { readonly kind: 'planned' }>): never {
  switch (plan.kind) {
    case 'duplicate-in-batch': {
      return stopForBatchDuplicate(output, plan)
    }
    case 'duplicate-existing': {
      return stopForDuplicateOrder(output, parent.number, plan.order, plan.existing, plan.nextAvailable)
    }
    case 'unreadable-parent': {
      return stopWith(output, `cannot assign order numbers: the parent Epic #${String(parent.number)} could not be read\nspecify order in the frontmatter, or try again`)
    }
  }
}

// 親ごとに、使われた番号を読んで番号を振る。ファイルの順に、番号を省いたものへ振った結果を返す
async function planFileOrders(output: Output, client: GitHubClient, files: readonly LocalFile[], groups: readonly ParentGroup[]): Promise<readonly (number | undefined)[]> {
  const assigned = new Map<number, number>()
  for (const group of groups) {
    const { parent } = group
    const used = await readUsedOrders(output, client, parent.repository.owner, parent.repository.repository, parent.number)
    const plan = planOrders(used, orderRequests(group))
    if (plan.kind !== 'planned') return stopForOrderPlan(output, parent, plan)
    for (const [position, order] of plan.orders.entries()) {
      const member = group.members.at(position)
      if (member === undefined) throw new InternalError('the planned orders do not match the files of the parent')
      assigned.set(member.index, order)
    }
  }
  return files.map((_, index) => assigned.get(index))
}

// 既存の Issue を前提にしたものの node ID を、投稿の前に読む。読めなければ止める
async function readExistingPrerequisites(output: Output, client: GitHubClient, files: readonly LocalFile[], prerequisites: readonly (readonly ResolvedPrerequisite[])[]): Promise<ReadonlyMap<string, string>> {
  const nodeIds = new Map<string, string>()
  for (const [index, file] of files.entries()) {
    const own = prerequisites.at(index) ?? []
    for (const { target } of own) {
      if (target.kind !== 'existing') continue
      const key = issueReferenceKey(target.reference)
      if (nodeIds.has(key)) continue
      const { owner, repository } = target.reference.repository
      try {
        const found = await client.getIssueNodeIdAndTitle(owner, repository, target.reference.number)
        nodeIds.set(key, found.id)
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `blocked_by in ${file.name} refers to ${issueReferenceToCliReference(target.reference)}, which could not be read: ${error.message}`)
      }
    }
  }
  return nodeIds
}

function chainsText(progressions: ReadonlyMap<string, Progression>, labels: ReadonlyMap<string, string>): string | undefined {
  return formatStackableChains(progressions, key => labels.get(key) ?? key)
}

function expandPlaceholders(body: string, created: ReadonlyMap<string, CreatedIssue>, owner: string, repository: string): string {
  return body.replaceAll(PLACEHOLDER_PATTERN, (whole: string, key: string) => {
    const issue = created.get(key)
    if (issue === undefined) return whole
    return issue.repository === `${owner}/${repository}` ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
  })
}

interface BatchContext {
  readonly locals: readonly LocalFile[]
  /**
  既存の Issue を表記する基準。一括の先頭のファイルのリポジトリ
  */
  readonly home: RepositoryReference
  readonly prerequisites: readonly (readonly ResolvedPrerequisite[])[]
  readonly progressions: ReadonlyMap<string, Progression>
  readonly orders: readonly (number | undefined)[]
  readonly nodeIds: ReadonlyMap<string, string>
  readonly client: GitHubClient
  readonly config: ProjectConfig
}

// blocked_by のあるファイルがあるのに、依存関係に対応しない GHES なら、何も作らずに止める。前提の無い一括は、読み取りを増やさない
async function ensureDependenciesSupported(output: Output, client: GitHubClient, locals: readonly LocalFile[]): Promise<void> {
  if (locals.every(local => local.frontmatter.blocked_by.length === 0)) return
  try {
    if (await client.supportsBlockedBy()) return
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(output, `could not check whether blocked-by is supported: ${error.message}`)
  }
  stopWith(output, DEPENDENCIES_UNSUPPORTED)
}

// 1 件も投稿しないうちに確かめられることをすべて確かめ、投稿に要るものをそろえる
async function prepareBatch(output: Output, files: readonly string[]): Promise<BatchContext> {
  validatePlaceholders(output, files)
  const config = requireActiveConfigPlain(output)
  const locals = files.map(file => readLocalFile(output, config, file))
  const [first] = locals
  if (first === undefined) throw new InternalError('no file to post')
  if (locals.some(local => local.hasNoBlockedColumn)) output.warning('the board has no Blocked column; Issues with blocked-by will be created in Ready')

  const batchFiles = locals.map((local): BatchFile => ({
    name: local.name,
    key: local.key,
    keys: local.keys,
    blockedBy: local.frontmatter.blocked_by.map(({ issue, wait, reason }) => ({ issue, wait, reason })),
  }))
  const resolution = resolveBatch(batchFiles)
  if (resolution.kind === 'error') stopWith(output, resolution.message)

  const groups = groupByParent(locals)
  for (const group of groups) {
    const duplicate = findBatchDuplicate(orderRequests(group))
    if (duplicate !== undefined) stopForBatchDuplicate(output, duplicate)
  }

  const client = createGitHubClient(output, config.host)
  const checkedRepositories = new Set<string>()
  for (const local of locals) {
    const repository = `${local.owner}/${local.repository}`
    if (checkedRepositories.has(repository)) continue
    checkedRepositories.add(repository)
    await ensureRepositoryInProject(output, config, client, local.owner, local.repository, `${repository} is not linked to the project`)
  }
  await ensureDependenciesSupported(output, client, locals)
  const orders = await planFileOrders(output, client, locals, groups)
  const nodeIds = await readExistingPrerequisites(output, client, locals, resolution.prerequisites)
  return { locals, home: homeOf(first), prerequisites: resolution.prerequisites, progressions: resolution.progressions, orders, nodeIds, client, config }
}

function titleOf(local: Readonly<LocalFile>, order: number | undefined): string {
  return buildIssueTitle(local.frontmatter.type, local.frontmatter.title, { parentEpic: local.parentReference?.number, order })
}

function existingLabels(context: Readonly<BatchContext>): Map<string, string> {
  const labels = new Map<string, string>()
  for (const list of context.prerequisites) {
    for (const { target, key } of list) {
      if (target.kind === 'existing') labels.set(key, displayReference(target.reference, context.home))
    }
  }
  return labels
}

function printPlan(output: Output, context: Readonly<BatchContext>): void {
  const rows = context.locals.map((local, index): PlanRow => ({
    file: local.key,
    order: context.orders.at(index),
    prerequisites: context.prerequisites.at(index) ?? [],
    progression: context.progressions.get(local.key),
  }))
  const chains = chainsText(context.progressions, existingLabels(context))
  output.data([formatPlanTable(rows, context.home), ...chains === undefined ? [] : ['', chains]].join('\n'))
}

function postPrerequisites(context: Readonly<BatchContext>, index: number, posted: readonly (PostedFile | undefined)[]): readonly PostPrerequisite[] {
  return (context.prerequisites.at(index) ?? []).map(({ target, key, wait, reason }): PostPrerequisite => {
    if (target.kind === 'existing') {
      const existingId = context.nodeIds.get(key)
      if (existingId === undefined) throw new InternalError(`the node ID of ${key} was not read before posting`)
      return { reference: target.reference, nodeId: () => Promise.resolve(existingId), wait, reason }
    }
    const earlier = posted.at(target.index)
    if (earlier === undefined) throw new InternalError('a prerequisite file has not been posted yet')
    return {
      reference: earlier.reference,
      nodeId: () => earlier.nodeId === undefined ? Promise.reject(new GitHubAPIError('could not read the node ID of the Issue')) : Promise.resolve(earlier.nodeId),
      wait,
      reason,
    }
  })
}

interface PostedFile {
  readonly reference: IssueReference
  readonly nodeId: string | undefined
}

async function postFiles(output: Output, context: Readonly<BatchContext>): Promise<void> {
  const { locals, client, config } = context
  const session: PostingSession = { failures: [], cache: createReadinessCache() }
  const created = new Map<string, CreatedIssue>()
  const posted: (PostedFile | undefined)[] = []
  const labels = existingLabels(context)
  const progressions = new Map(context.progressions)
  try {
    for (const [index, local] of locals.entries()) {
      const home = homeOf(local)
      const prerequisites = postPrerequisites(context, index, posted)
      let body = expandPlaceholders(local.body, created, local.owner, local.repository)
      for (const prerequisite of prerequisites) {
        if (prerequisite.wait === 'merge') body = upsertWaitsForMerge(body, home, prerequisite.reference, prerequisite.reason ?? '')
      }
      const result = await postIssue(output, client, config, session, {
        owner: local.owner,
        repository: local.repository,
        title: titleOf(local, context.orders.at(index)),
        body,
        labels: local.frontmatter.labels.length > 0 ? local.frontmatter.labels : undefined,
        source: local.name,
        useResponseNodeId: false,
        fields: frontmatterFields(local),
        parentReference: local.parentReference,
        prerequisites,
        settleColumn: local.status === 'blocked' && prerequisites.some(({ reference }) => !isBatchReference(reference, posted)),
      })
      const reference = createIssueReference(home, result.number)
      posted.push({ reference, nodeId: result.nodeId })
      labels.set(local.key, displayReference(reference, context.home))
      // Ready へ動かした Issue は、前提が済んでいるので、積む先を持たない
      if (result.isMovedToReady) progressions.set(local.key, { kind: 'alone' })
      for (const key of local.keys) created.set(key, { repository: `${local.owner}/${local.repository}`, number: result.number })
    }
  }
  finally {
    if (session.failures.length > 0) output.error(`could not add some blocked-by; add them again with:\n${session.failures.join('\n')}`)
  }
  consumeFlag(FLAG_ISSUE_CREATE_SLASH_PENDING)
  if (session.failures.length > 0) throw new CommandExit(1)
  const chains = chainsText(progressions, labels)
  if (chains !== undefined) output.data(`\n${chains}`)
}

// 前提が、この一括で作った Issue か
function isBatchReference(reference: IssueReference, posted: readonly (PostedFile | undefined)[]): boolean {
  return posted.some(entry => entry !== undefined && issueReferenceKey(entry.reference) === issueReferenceKey(reference))
}

async function createFromFiles(output: Output, files: readonly string[], isPlan: boolean): Promise<void> {
  const context = await prepareBatch(output, files)
  if (isPlan) {
    printPlan(output, context)
    return
  }
  await postFiles(output, context)
}

// --- -m の直接投稿 ---

interface DirectOptions {
  readonly message: string
  readonly title: string
  readonly repository: string
  readonly issueType: IssueType
  readonly status: string | undefined
  readonly priority: string | undefined
  readonly size: string | undefined
  readonly parentEpic: string | undefined
  readonly labels: readonly string[] | undefined
  readonly order: number | undefined
}

// config は epic の作成先を決めるときに読み済みなら渡す。無ければ、status の確認の後に読む
async function createDirect(output: Output, options: Readonly<DirectOptions>, loadedConfig: ProjectConfig | undefined): Promise<void> {
  const { issueType } = options
  // status は設定の取得や作成より前に確かめる
  let status: string
  if (options.status === undefined) {
    // eslint-disable-next-line security/detect-object-injection -- issueType は列挙型
    status = TYPE_DEFAULT_STATUS[issueType]
  }
  else {
    validateStatusForType(output, issueType, options.status)
    status = options.status
  }

  const config = loadedConfig ?? requireActiveConfigPlain(output)
  const [owner, repository] = validateRepositoryShape(output, options.repository)

  const parentReference = parentReferenceOf(normalizeParentEpicCli(options.parentEpic), config, owner, repository)
  const title = buildIssueTitle(issueType, options.title, { parentEpic: parentReference?.number, order: options.order })
  validateIssueTemplate(output, issueType, options.message)
  const client = await clientForIssueCreate(output, config, owner, repository, options.repository, parentReference, options.order)

  const fields: IssueField[] = [{ fieldName: 'workflow', optionName: status, label: `status ${status}` }]
  if (options.priority !== undefined && options.priority !== '') fields.push({ fieldName: 'priority', optionName: options.priority, label: `priority ${options.priority}` })
  if (options.size !== undefined && options.size !== '') fields.push({ fieldName: 'size', optionName: options.size, label: `size ${options.size}` })

  await postIssue(output, client, config, { failures: [], cache: createReadinessCache() }, {
    owner,
    repository,
    title,
    body: options.message,
    labels: options.labels !== undefined && options.labels.length > 0 ? options.labels : undefined,
    source: undefined,
    useResponseNodeId: true,
    fields,
    parentReference,
    prerequisites: [],
    settleColumn: false,
  })
}

interface MessageTarget {
  readonly repository: string
  /**
  epic は作成先を決めるときに読んだ設定。epic 以外は undefined
  */
  readonly config: ProjectConfig | undefined
}

// -m の作成先。epic 以外は --repo が要る。epic は aggregation_repo の方針で決める
function messageModeTarget(output: Output, issueType: IssueType, repository: string | undefined): MessageTarget {
  if (issueType !== 'epic') {
    if (repository === undefined || repository === '') {
      stopWith(output, '-r (repository) is required with -m')
    }
    return { repository, config: undefined }
  }
  const config = requireActiveConfigPlain(output)
  const target = resolveEpicTargetRepository(output, repository, config)
  if (target.needsWarning) warnEpicRepositoryException(output, target.repository, config)
  return { repository: target.repository, config }
}

const USAGE_TEXT = 'missing arguments\n'
  + 'direct posting: pecot issue create -t "TITLE" -r owner/repo -m "BODY"\n'
  + 'prepare a template: pecot issue create --prepare --template task --repo owner/repo\n'
  + 'from a file: pecot issue create <path>'

interface MessageInput {
  readonly title?: string | undefined
  readonly repo?: string | undefined
  readonly type: IssueType
  readonly status?: string | undefined
  readonly priority?: string | undefined
  readonly size?: string | undefined
  readonly parent_epic?: string | undefined
  readonly label?: readonly string[] | undefined
  readonly order?: number | undefined
}

// -m の直接投稿。入力の確認から作成まで
async function createFromMessage(output: Output, input: Readonly<MessageInput>, message: string): Promise<void> {
  if (input.title === undefined || input.title === '') {
    stopWith(output, '-t (title) is required with -m')
  }
  const target = messageModeTarget(output, input.type, input.repo)
  await createDirect(output, {
    message,
    title: input.title,
    repository: target.repository,
    issueType: input.type,
    status: input.status,
    priority: input.priority,
    size: input.size,
    parentEpic: input.parent_epic,
    labels: input.label,
    order: input.order,
  }, target.config)
  consumeFlag(FLAG_ISSUE_CREATE_SLASH_PENDING)
}

const ISSUE_CREATE = defineCommand({
  path: ['issue', 'create'],
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Create Issues from Markdown files with frontmatter',
  input: z.object({
    files: FILES_SCHEMA,
    message: z.string().optional().describe('Issue body (direct posting mode)'),
    title: z.string().optional().describe('Issue title (direct posting mode, required with -m)'),
    repo: z.string().optional().describe('Repository (owner/repo form; required with -m / --prepare unless epic)'),
    type: ISSUE_TYPE_SCHEMA,
    status: z.string().optional().describe('Status (backlog/pending/ready/active/in_review/archived)'),
    priority: z.string().optional().describe('Priority (high/medium/low)'),
    size: z.string().optional().describe('Size (xs/s/m/l)'),
    parent_epic: z.string().optional().describe(PARENT_EPIC_DESCRIPTION),
    order: z.int().optional().describe('Order number of the subtask (used with parent_epic)'),
    label: LABEL_SCHEMA,
    plan: z.boolean().default(false).describe('Show the progression table and stackable chains of the files without posting'),
    prepare: z.boolean().default(false).describe('Copy a template to the work directory'),
    template: TEMPLATE_SCHEMA,
    suffix: z.string().optional().describe('Suffix of the output file name (only with --prepare)'),
  }),
  positional: ['files'],
  shortFlags: { message: '-m', title: '-t', repo: '-r', label: '-l', prepare: '-p', suffix: '-s' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      if (input.plan && (input.prepare || input.message !== undefined)) {
        stopWith(output, '--plan cannot be used with --prepare or -m', USAGE_EXIT_CODE)
      }
      if (input.plan && (input.files === undefined || input.files.length === 0)) {
        stopWith(output, '--plan needs at least one file', USAGE_EXIT_CODE)
      }
      if (input.prepare) {
        prepareTemplate(output, input.template, input.repo, input.suffix)
      }
      else if (input.files !== undefined && input.files.length > 0) {
        await createFromFiles(output, input.files, input.plan)
      }
      else if (input.message === undefined) {
        stopWith(output, USAGE_TEXT)
      }
      else {
        await createFromMessage(output, input, input.message)
      }
    })
  },
})

export const ISSUE_CREATE_COMMANDS: readonly CommandDefinition[] = [ISSUE_CREATE]
