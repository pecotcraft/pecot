/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者の引数で決まる */
// issue create。ファイル・-m・--freeform の 3 つの形がある。ファイルの予行は issue check（issue-check.ts）が担う。
import { statSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { formatStackableChains, resolveBatch } from '../domain/batch-plan.js'
import type { BatchFile, ResolvedPrerequisite } from '../domain/batch-plan.js'
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
import { PYTHON_LINE_BREAK, compareStrings, pythonRightStrip, pythonStrip, pythonStringRepr, truncateCodePoints } from '../domain/python-format.js'
import { createIssueReference, issueReferenceKey, issueReferenceToCliReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { describeReadiness, displayReference, hasStarted, stackChains } from '../domain/readiness.js'
import type { Progression } from '../domain/readiness.js'
import { parseIssueFile } from '../infra/frontmatter-file.js'
import { configSourcePath, projectNameOf } from '../infra/config-store.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import { DEPENDENCIES_UNSUPPORTED } from '../infra/github/issues.js'
import type { GitHubClient } from '../infra/github/index.js'
import { normalizePath, resolveRealPath } from '../infra/paths.js'
import { readTextFile } from '../infra/text-file.js'
import type { AttributeDefinition, AttributeError, AttributeInput, AttributeWrite } from '../domain/attributes.js'
import type { JsonObject } from '../domain/json.js'
import { LANE_FIELD_NAME } from '../domain/lanes.js'
import {
  ATTRIBUTE_ERROR_JSON,
  ATTRIBUTE_FAILURE_JSON,
  ATTRIBUTES_INPUT,
  attributeInputs,
  builtinOutcome,
  checkAttributes,
  createBuiltins,
  isLaneAttribute,
  labelsConflict,
  laneConflict,
  readDefinitions,
  reportAttributeErrors,
  warnFailures,
  writeIssueFields,
  writeProjectFields,
} from './attribute-writes.js'
import type { AttributeErrorJson, AttributeOutcome, DefinitionsCache, IssueLocationTarget, RawAttributes } from './attribute-writes.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'

import { commandHint, hinted, inputHint, inputNameHint, joinHinted, placeholder } from './command-hint.js'
import type { CommandHint } from './command-hint.js'
import { PROJECT_INPUT, requireBoardConfig, requireConfigFor, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import type { FieldHintState } from './field-write-failure.js'
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
const CREATE_PATH = ['issue', 'create']

// 一括投稿の先行 Issue 番号の置き場所。key は先行ファイルの名前の幹
const PLACEHOLDER_PATTERN = /\{\{issue:([^{}\s]+)\}\}/gu
// Python の `$` は末尾の改行の前にも当たる
const REPOSITORY_SEGMENT_PATTERN = /^[\w.-]+\n?$/u

interface CreatedIssue {
  readonly repository: string
  readonly number: number
}

// validateStatusForType が、作るときの status を型の既定（backlog・ready）か、前提があるときの blocked に限る
const CREATED_STATUS = z.enum(['backlog', 'blocked', 'ready'])

type CreatedStatus = z.infer<typeof CREATED_STATUS>

function isCreatedStatus(value: string): value is CreatedStatus {
  return CREATED_STATUS.safeParse(value).success
}

const CREATED_ISSUE_DATA = z.strictObject({
  owner: z.string().describe('Owner of the repository of the Issue'),
  repository: z.string().describe('Name of the repository of the Issue'),
  number: z.int().describe('Issue number'),
  url: z.string().describe('URL of the Issue'),
  status: CREATED_STATUS.optional().describe('Workflow status written on the board (ready when it was moved out of blocked; omitted when not written)'),
  parent: z.string().optional().describe('Parent Epic the Issue was added to as a sub-issue (owner/repo/N; omitted when none)'),
})

export const STACKABLE_CHAINS = z.array(z.array(z.string())).optional().describe('Stackable chains, each from the bottom; files by key, existing Issues as #N or owner/repo#N (omitted when none)')

const CREATE_FAILURE_JSON = ATTRIBUTE_FAILURE_JSON.extend({
  issue: z.string().describe('Issue whose attribute could not be written (owner/repo/N)'),
})

const ISSUE_CREATE_OUTPUT = z.strictObject({
  issues: z.array(CREATED_ISSUE_DATA).describe('Issues created, in the order of creation (also kept on a failure after some were created)'),
  stackableChains: STACKABLE_CHAINS,
  errors: z.array(ATTRIBUTE_ERROR_JSON).optional().describe('Why the attribute values were not accepted; no Issue was created (omitted when none)'),
  failed: z.array(CREATE_FAILURE_JSON).optional().describe('Attributes that passed the check but could not be written, with the reason (omitted when none)'),
})

type IssueCreateData = z.input<typeof ISSUE_CREATE_OUTPUT>
type CreatedIssueData = z.input<typeof CREATED_ISSUE_DATA>
type CreateFailureJson = z.input<typeof CREATE_FAILURE_JSON>
type CreateOutput = Output<IssueCreateData>

// --- 共通 ---

// owner/repo の形が不正なら error と終了コード 2。正しければ owner と name を返す
function validateRepositoryShape(output: Output, repository: string): readonly [string, string] {
  const parts = splitOwnerRepository(repository)
  const isValid = parts !== undefined && REPOSITORY_SEGMENT_PATTERN.test(parts.owner) && REPOSITORY_SEGMENT_PATTERN.test(parts.repository)
  const message = `invalid repository format: ${repository}\nexpected: owner/repo`
  return isValid ? [parts.owner, parts.repository] : stopWith(output, message, 'invalid-input', USAGE_EXIT_CODE)
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
  /**
  検証を通った attributes の書く予定
  */
  readonly attributes: readonly AttributeWrite[]
}

/**
1 回の投稿の間の記録。failures は付け直すコマンド、attributeFailures は書けなかった機能
*/
interface PostingSession {
  readonly failures: CommandHint[]
  readonly cache: ReadinessCache
  /**
  作った Issue の data。失敗で止まっても残すよう、変わるたびに result へ渡す
  */
  readonly issues: CreatedIssueData[]
  readonly fieldHint: FieldHintState
  readonly attributeFailures: CreateFailureJson[]
}

function newSession(): PostingSession {
  return { failures: [], cache: createReadinessCache(), issues: [], fieldHint: { hasHinted: false }, attributeFailures: [] }
}

// 組み込みは起票の応答と比べ、Issue fields はボードと関係なく、ボードのフィールドはボードに足せたときだけ書く
async function writeCreatedAttributes(output: CreateOutput, client: GitHubClient, config: ProjectConfig, session: PostingSession, issue: Readonly<IssueLocationTarget>, created: JsonObject, item: BoardItem | undefined, writes: readonly AttributeWrite[]): Promise<void> {
  if (writes.length === 0) return
  const target = `Issue ${issuePath(issue.owner, issue.repository, issue.number)}`
  const fields = await writeIssueFields(client, issue, writes)
  const board: AttributeOutcome = item === undefined
    ? { changed: [], failed: writes.filter(write => write.source === 'project').map(write => ({ name: write.name, source: write.source, reason: 'the Issue could not be added to the board' })) }
    : await writeProjectFields(client, config.project.id, item.itemId, writes)
  const parts: readonly AttributeOutcome[] = [builtinOutcome(writes, created), fields, board]
  const changed = parts.flatMap(part => part.changed)
  const failed = parts.flatMap(part => part.failed)
  if (changed.length > 0) output.done({ verb: 'set', target: `${target} ${changed.map(change => change.name).join(', ')}` })
  warnFailures(output, target, failed)
  if (failed.length === 0) return
  const issueText = issuePath(issue.owner, issue.repository, issue.number)
  session.attributeFailures.push(...failed.map(item => ({ issue: issueText, ...item })))
  output.result({ failed: [...session.attributeFailures] })
}

type AttributeCheck
  = | { readonly ok: true, readonly writes: readonly AttributeWrite[] }
    | { readonly ok: false, readonly errors: readonly AttributeError[] }

/**
起票する 1 件の attributes の照らし合わせに要るもの
*/
interface CreateAttributeRequest {
  readonly owner: string
  readonly repository: string
  readonly inputs: readonly AttributeInput[]
  /**
  label かフロントマターの labels があるか
  */
  readonly hasLabels: boolean
  /**
  入力かフロントマターの lane
  */
  readonly lane: string | undefined
  readonly parent: IssueReference | undefined
}

/**
1 回の起票で使い回す読み取り。parentLanes は親 Epic ごとの pecot-lane の値
*/
interface CreateCheckCache {
  readonly definitions: DefinitionsCache
  readonly parentLanes: Map<string, string | undefined>
  readonly noLaneField: { hasWarned: boolean }
}

function newCheckCache(): CreateCheckCache {
  return { definitions: new Map(), parentLanes: new Map(), noLaneField: { hasWarned: false } }
}

const NO_LANE_SUFFIX = 'Issues will be created without a lane'

function laneInput(value: string): AttributeInput {
  return { name: LANE_FIELD_NAME, value, source: 'project' }
}

// 親 Epic の pecot-lane の値。読めなければ warning にして、値なしとして続ける
async function parentLaneOf(output: Output, client: GitHubClient, config: ProjectConfig, parent: IssueReference, cache: CreateCheckCache): Promise<string | undefined> {
  const key = issueReferenceKey(parent)
  if (cache.parentLanes.has(key)) return cache.parentLanes.get(key)
  let lane: string | undefined
  try {
    lane = await client.getIssueLane(config.project.id, parent.repository.owner, parent.repository.repository, parent.number)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`could not read ${LANE_FIELD_NAME} of the parent Epic ${issueReferenceToCliReference(parent)}: ${error.message}; ${NO_LANE_SUFFIX}`)
  }
  cache.parentLanes.set(key, lane)
  return lane
}

// lane の入力か親 Epic の値を、attributes の pecot-lane の入力にする。attributes に pecot-lane があれば足さない
async function laneOf(output: Output, client: GitHubClient, config: ProjectConfig, request: Readonly<CreateAttributeRequest>, cache: CreateCheckCache): Promise<string | undefined> {
  if (request.inputs.some(input => isLaneAttribute(input))) return undefined
  if (request.lane !== undefined) return request.lane
  return request.parent === undefined ? undefined : await parentLaneOf(output, client, config, request.parent, cache)
}

function hasLaneField(definitions: readonly AttributeDefinition[]): boolean {
  return definitions.some(definition => definition.name === LANE_FIELD_NAME && definition.source === 'project' && definition.kind === 'single_select')
}

// 起票の前に attributes と lane を照らす。どちらも無ければ定義を読まない
async function checkCreateAttributes(output: Output, client: GitHubClient, config: ProjectConfig, request: Readonly<CreateAttributeRequest>, cache: CreateCheckCache): Promise<AttributeCheck> {
  const { owner, repository } = request
  const lane = await laneOf(output, client, config, request, cache)
  let inputs = lane === undefined ? request.inputs : [...request.inputs, laneInput(lane)]
  if (inputs.length === 0) return { ok: true, writes: [] }
  let validation
  try {
    if (lane !== undefined) {
      const read = await readDefinitions(output, client, config, { owner, repository }, cache.definitions)
      // ボードのフィールドを読めなかったときは、照らし合わせが unreadable_attribute で止める
      if (!hasLaneField(read.definitions) && !read.unreadable.has('project')) {
        inputs = request.inputs
        if (!cache.noLaneField.hasWarned) output.warning(`the board has no single select field ${LANE_FIELD_NAME}; ${NO_LANE_SUFFIX}`)
        cache.noLaneField.hasWarned = true
      }
    }
    validation = await checkAttributes(output, client, config, { owner, repository }, inputs, undefined, cache.definitions)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(output, `could not read the attributes of ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
  }
  const errors = [...labelsConflict(request.inputs, request.hasLabels), ...laneConflict(request.inputs, request.lane !== undefined), ...validation.ok ? [] : validation.errors]
  return validation.ok && errors.length === 0 ? validation : { ok: false, errors }
}

interface FileAttributeErrors {
  readonly file: string | undefined
  readonly errors: readonly AttributeError[]
}

// 照らして合わなかった値を error の行と errors に出し、Issue を作らずに止める
function stopForAttributeErrors(output: Output, entries: readonly FileAttributeErrors[], record: ((errors: readonly AttributeErrorJson[]) => void) | undefined): never {
  const errors = entries.flatMap(entry => reportAttributeErrors(output, entry.errors, entry.file))
  record?.(errors)
  return stopWith(output, 'did not create any Issue: some attribute values do not fit the definitions', 'invalid-input')
}

function recordCreateErrors(output: CreateOutput): (errors: readonly AttributeErrorJson[]) => void {
  return (errors) => {
    output.result({ issues: [], errors: [...errors] })
  }
}

// 投稿中の Issue は常に末尾にある。isUpdate なら末尾を書き換え、そうでなければ足す
function recordIssue(output: CreateOutput, session: PostingSession, entry: Readonly<CreatedIssueData>, isUpdate: boolean): void {
  if (isUpdate) session.issues.pop()
  session.issues.push(entry)
  output.result({ issues: [...session.issues] })
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
  readonly isOnBoard: boolean
}

function reAddCommand(issue: IssueReference, prerequisite: Readonly<PostPrerequisite>): CommandHint {
  const base = { issue_ref: issueReferenceToCliReference(issue), by: issueReferenceToCliReference(prerequisite.reference) }
  return commandHint(['issue', 'block'], prerequisite.wait === 'merge' ? { ...base, wait: 'merge', reason: prerequisite.reason ?? '' } : base)
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
    labelWrittenByAutomation: judged.labelWrittenByAutomation,
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
    judged = await readIssueReadiness(client, config, issue, session.cache, undefined, undefined, true)
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
  const applied = await applyBoardMove(output, client, config, item.itemId, { ref: issue, home: issue.repository }, withoutLabel(move), describeReadiness(judged.readiness, judged.prerequisites, issue.repository), session.fieldHint)
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
async function postIssue(output: CreateOutput, client: GitHubClient, config: ProjectConfig, session: PostingSession, posting: Readonly<Posting>): Promise<PostedIssue> {
  const { owner, repository } = posting
  const builtins = createBuiltins(posting.attributes)
  const issue = await createIssueOrExit(output, client, owner, repository, posting.title, posting.body, builtins.labels ?? posting.labels, posting.source, builtins.extras)
  const { number, url, nodeId } = summarizeCreatedIssue(issue)
  const entry: CreatedIssueData = { owner, repository, number, url }
  recordIssue(output, session, entry, false)
  const target = `Issue ${issuePath(owner, repository, number)}`
  const reference = createIssueReference(createRepositoryReference(owner, repository), number)

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
  let status: CreatedStatus | undefined
  if (added !== undefined) {
    const written = await setIssueFields(output, client, config, added.itemId, target, posting.fields, session.fieldHint)
    const option = written.includes('workflow') ? posting.fields.find(field => field.fieldName === 'workflow')?.optionName : undefined
    if (option !== undefined && isCreatedStatus(option)) status = option
    recordIssue(output, session, { ...entry, ...status !== undefined && { status } }, true)
    if (posting.settleColumn && written.includes('workflow') && linked === posting.prerequisites.length) {
      isMovedToReady = await settleColumn(output, client, config, session, reference, added, linked) === 'Ready'
      if (isMovedToReady) status = 'ready'
    }
  }
  await writeCreatedAttributes(output, client, config, session, { owner, repository, number }, issue, added, posting.attributes)
  const knownNodeId = added?.issueNodeId ?? issueNodeId
  let parent: string | undefined
  if (posting.parentReference !== undefined) {
    // ボードへの追加に失敗したときは、URL を出し済み
    parent = await linkToParentEpic(output, client, target, posting.parentReference, knownNodeId ?? (() => client.getIssueNodeId(owner, repository, number)), added === undefined ? undefined : url)
  }
  recordIssue(output, session, { ...entry, ...status !== undefined && { status }, ...parent !== undefined && { parent } }, true)
  if (added !== undefined) output.data(url)
  return { number, nodeId: knownNodeId, isMovedToReady, isOnBoard: added !== undefined }
}

function parentReferenceOf(raw: number | string | undefined, config: ProjectConfig, owner: string, repository: string): IssueReference | undefined {
  return raw === undefined ? undefined : resolveParentEpicReference(raw, config, owner, repository)
}

// --- ファイルからの一括投稿 ---

// 前提に書けるキー。ファイルの名前の幹
function fileKeys(file: string): { readonly key: string, readonly keys: readonly string[] } {
  const stem = path.parse(path.basename(file)).name
  return { key: stem, keys: [stem] }
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
      stopWith(output, `file specified more than once: ${normalizePath(file)}`, 'invalid-input')
    }
    seen.add(resolved)
    if (!isFile(file)) {
      stopWith(output, `file not found: ${normalizePath(file)}`, 'invalid-input')
    }
    // フロントマターと冒頭のガイドコメントは投稿本文に出ないので、走査から外す
    const body = stripLeadingHtmlComment(stripFrontmatter(readTextFile(file)))
    for (const [, reference] of body.matchAll(PLACEHOLDER_PATTERN)) {
      if (reference === undefined || available.has(reference)) continue
      stopWith(output, `{{issue:${reference}}} in ${path.basename(file)} does not point to an earlier file (forward reference or unknown key)\nput the file it depends on earlier in the arguments`, 'content-invalid')
    }
    const { keys } = fileKeys(file)
    const collided = keys.filter(key => available.has(key)).toSorted(compareStrings)
    if (collided.length > 0) {
      stopWith(output, `placeholder keys collide: ${collided.join(', ')} (${path.basename(file)})`, 'content-invalid')
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
    stopWith(output, `invalid repository format in the frontmatter: ${pythonStringRepr(frontmatter.repository)}`, 'content-invalid')
  }
  return [parts.owner, parts.repository]
}

export interface LocalFile {
  readonly name: string
  readonly frontmatter: IssueFrontmatter
  readonly body: string
  readonly owner: string
  readonly repository: string
  /**
  前提に書けるキー。ファイルの名前の幹
  */
  readonly key: string
  readonly keys: readonly string[]
  readonly parentReference: IssueReference | undefined
  /**
  ボードに書く列。Blocked の列がボードに無いときは ready
  */
  readonly status: string
  readonly hasNoBlockedColumn: boolean
  readonly attributes: readonly AttributeInput[]
}

function stopForFrontmatter(output: Output, error: FrontmatterError, name: string): never {
  if (error.kind === 'parallel') return stopWith(output, `parallel is no longer supported in ${name}. Remove it`, 'content-invalid')
  if (error.kind === 'merge-without-reason') return stopWith(output, `blocked_by in ${name} needs reason for wait: merge`, 'content-invalid')
  return stopWith(output, error.message, 'content-invalid')
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
    stopWith(output, `cannot write the Waits for merge section of ${name}: ${error.message}`, 'content-invalid')
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
    attributes: (frontmatter.attributes ?? []).map(({ name, value, source }) => ({ name, value, ...source !== undefined && { source } })),
  }
}

// ファイルごとに、作成先のリポの定義で attributes を照らす。1 つでも合わなければ、すべての誤りを出して止める
async function checkFileAttributes(output: Output, client: GitHubClient, config: ProjectConfig, locals: readonly LocalFile[], record: ((errors: readonly AttributeErrorJson[]) => void) | undefined): Promise<readonly (readonly AttributeWrite[])[]> {
  const cache = newCheckCache()
  const writes: (readonly AttributeWrite[])[] = []
  const failed: FileAttributeErrors[] = []
  for (const local of locals) {
    const check = await checkCreateAttributes(output, client, config, {
      owner: local.owner,
      repository: local.repository,
      inputs: local.attributes,
      hasLabels: local.frontmatter.labels.length > 0,
      lane: local.frontmatter.lane,
      parent: local.parentReference,
    }, cache)
    if (check.ok) writes.push(check.writes)
    else failed.push({ file: local.name, errors: check.errors })
  }
  if (failed.length > 0) stopForAttributeErrors(output, failed, record)
  return writes
}

function homeOf(file: Readonly<LocalFile>): RepositoryReference {
  return createRepositoryReference(file.owner, file.repository)
}

function statusFields(status: string): readonly IssueField[] {
  return [{ fieldName: 'workflow', optionName: status, label: `status ${status}` }]
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
  return stopWith(output, `order ${String(duplicate.order)} is specified by more than one file: ${duplicate.files.join(', ')}`, 'order-conflict')
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
      return stopWith(output, `cannot assign order numbers: the parent Epic #${String(parent.number)} could not be read\nspecify order in the frontmatter, or try again`, 'github-api')
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
        stopWith(output, `blocked_by in ${file.name} refers to ${issueReferenceToCliReference(target.reference)}, which could not be read: ${error.message}`, 'dependency-unreadable')
      }
    }
  }
  return nodeIds
}

export function chainsText(progressions: ReadonlyMap<string, Progression>, labels: ReadonlyMap<string, string>): string | undefined {
  return formatStackableChains(progressions, key => labels.get(key) ?? key)
}

// formatStackableChains と同じ並びを、表記に直した配列で返す
export function chainsData(progressions: ReadonlyMap<string, Progression>, labels: ReadonlyMap<string, string>): Pick<IssueCreateData, 'stackableChains'> {
  const chains = stackChains(progressions).filter(chain => chain.length >= 2).map(chain => chain.map(key => labels.get(key) ?? key))
  return chains.length === 0 ? {} : { stackableChains: chains }
}

function expandPlaceholders(body: string, created: ReadonlyMap<string, CreatedIssue>, owner: string, repository: string): string {
  return body.replaceAll(PLACEHOLDER_PATTERN, (whole: string, key: string) => {
    const issue = created.get(key)
    if (issue === undefined) return whole
    return issue.repository === `${owner}/${repository}` ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
  })
}

export interface BatchContext {
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
  /**
  ファイルの順の、検証を通った attributes の書く予定
  */
  readonly attributeWrites: readonly (readonly AttributeWrite[])[]
}

// blocked_by のあるファイルがあるのに、依存関係に対応しない GHES なら、何も作らずに止める。前提の無い一括は、読み取りを増やさない
async function ensureDependenciesSupported(output: Output, client: GitHubClient, locals: readonly LocalFile[]): Promise<void> {
  if (locals.every(local => local.frontmatter.blocked_by.length === 0)) return
  try {
    if (await client.supportsBlockedBy()) return
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(output, `could not check whether blocked-by is supported: ${error.message}`, kindOfFailure(error))
  }
  stopWith(output, DEPENDENCIES_UNSUPPORTED, 'dependency-rejected')
}

// 作成先のリポから設定を選ぶ。repository が無い（Epic の既定）ときは対象のリポが無いので、board sync と同じくボード全体の決め方で選ぶ
function configForCreate(output: Output, repository: string | undefined, project: string | undefined, commandPath: readonly string[] = CREATE_PATH): ProjectConfig {
  const given = repository === undefined ? '' : pythonStrip(repository)
  if (given === '') return requireBoardConfig(output, project, commandPath)
  const [owner, name] = validateRepositoryShape(output, given)
  return requireConfigFor(output, { owner, repository: name }, project, commandPath).config
}

// 一括作成の設定。ファイルごとに作成先のリポで選び、ファイルの間で分かれたら 1 件も作らずに止める
function configForFiles(output: Output, files: readonly string[], project: string | undefined, commandPath: readonly string[]): ProjectConfig {
  const chosen = files.map((file) => {
    let repository: string
    try {
      const { frontmatter } = parseIssueFile(file)
      repository = frontmatter.repository
      // Epic だけが repository を省ける（git remote のリポで設定を選び、aggregation_repo に作る）
      if ((frontmatter.type !== 'epic' || pythonStrip(repository) !== '') && splitOwnerRepository(pythonStrip(repository)) === undefined) stopWith(output, `invalid repository format in the frontmatter: ${pythonStringRepr(repository)}`, 'content-invalid')
    }
    catch (error: unknown) {
      if (!(error instanceof FrontmatterError)) throw error
      return stopForFrontmatter(output, error, path.basename(file))
    }
    const config = configForCreate(output, repository, project, commandPath)
    return { file: path.basename(file), config, source: configSourcePath(config) ?? '' }
  })
  const [first] = chosen
  if (first === undefined) throw new InternalError('no file to post')
  if (chosen.some(entry => entry.source !== first.source)) {
    stopWith(output, `the files belong to different project configs: ${chosen.map(entry => `${entry.file} (${projectNameOf(entry.source)})`).join(', ')}\npost them separately`, 'invalid-input')
  }
  return first.config
}

// 1 件も投稿しないうちに確かめられることをすべて確かめ、投稿に要るものをそろえる。issue check もこれを使う
export async function prepareBatch(output: Output, files: readonly string[], project: string | undefined, commandPath: readonly string[] = CREATE_PATH, recordErrors?: (errors: readonly AttributeErrorJson[]) => void): Promise<BatchContext> {
  validatePlaceholders(output, files)
  const config = configForFiles(output, files, project, commandPath)
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
  if (resolution.kind === 'error') stopWith(output, resolution.message, 'invalid-input')

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
  const attributeWrites = await checkFileAttributes(output, client, config, locals, recordErrors)
  return { locals, home: homeOf(first), prerequisites: resolution.prerequisites, progressions: resolution.progressions, orders, nodeIds, client, config, attributeWrites }
}

function titleOf(local: Readonly<LocalFile>, order: number | undefined): string {
  return buildIssueTitle(local.frontmatter.type, local.frontmatter.title, { parentEpic: local.parentReference?.number, order })
}

export function existingLabels(context: Readonly<BatchContext>): Map<string, string> {
  const labels = new Map<string, string>()
  for (const list of context.prerequisites) {
    for (const { target, key } of list) {
      if (target.kind === 'existing') labels.set(key, displayReference(target.reference, context.home))
    }
  }
  return labels
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

async function postFiles(output: CreateOutput, context: Readonly<BatchContext>): Promise<void> {
  const { locals, client, config } = context
  const session = newSession()
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
        fields: statusFields(local.status),
        parentReference: local.parentReference,
        prerequisites,
        settleColumn: local.status === 'blocked' && prerequisites.some(({ reference }) => !isBatchReference(reference, posted)),
        attributes: context.attributeWrites.at(index) ?? [],
      })
      const reference = createIssueReference(home, result.number)
      posted.push({ reference, nodeId: result.nodeId })
      labels.set(local.key, displayReference(reference, context.home))
      // Ready へ動かした Issue は、前提が済んでいるので、スタック先を持たない
      if (result.isMovedToReady) progressions.set(local.key, { kind: 'alone' })
      for (const key of local.keys) created.set(key, { repository: `${local.owner}/${local.repository}`, number: result.number })
    }
  }
  finally {
    if (session.failures.length > 0) output.error(joinHinted(['could not add some blocked-by; add them again with:', ...session.failures.map(hint => [hint])]))
  }
  if (session.failures.length > 0) throw new CommandExit(1, 'partial-failure')
  output.result(chainsData(progressions, labels))
  const chains = chainsText(progressions, labels)
  if (chains !== undefined) output.data(`\n${chains}`)
}

// 前提が、この一括で作った Issue か
function isBatchReference(reference: IssueReference, posted: readonly (PostedFile | undefined)[]): boolean {
  return posted.some(entry => entry !== undefined && issueReferenceKey(entry.reference) === issueReferenceKey(reference))
}

async function createFromFiles(output: CreateOutput, files: readonly string[], project: string | undefined): Promise<void> {
  await postFiles(output, await prepareBatch(output, files, project, CREATE_PATH, recordCreateErrors(output)))
}

// --- -m の直接投稿 ---

interface DirectOptions {
  readonly message: string
  readonly title: string
  readonly repository: string
  readonly issueType: IssueType
  readonly status: string | undefined
  readonly parentEpic: string | undefined
  readonly labels: readonly string[] | undefined
  readonly order: number | undefined
  readonly project: string | undefined
  readonly attributes: readonly AttributeInput[]
  readonly lane: string | undefined
}

// config は epic の作成先を決めるときに読み済みなら渡す。無ければ、status の確認の後に読む
async function createDirect(output: CreateOutput, options: Readonly<DirectOptions>, loadedConfig: ProjectConfig | undefined): Promise<void> {
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

  const [owner, repository] = validateRepositoryShape(output, options.repository)
  const config = loadedConfig ?? requireConfigFor(output, { owner, repository }, options.project, CREATE_PATH).config

  const parentReference = parentReferenceOf(normalizeParentEpicCli(options.parentEpic), config, owner, repository)
  const title = buildIssueTitle(issueType, options.title, { parentEpic: parentReference?.number, order: options.order })
  validateIssueTemplate(output, issueType, options.message)
  const client = await clientForIssueCreate(output, config, owner, repository, options.repository, parentReference, options.order)
  const labels = options.labels !== undefined && options.labels.length > 0 ? options.labels : undefined
  const attributes = await checkDirectAttributes(output, client, config, { owner, repository, inputs: options.attributes, hasLabels: labels !== undefined, lane: options.lane, parent: parentReference })

  await postIssue(output, client, config, newSession(), {
    owner,
    repository,
    title,
    body: options.message,
    labels,
    source: undefined,
    useResponseNodeId: true,
    fields: statusFields(status),
    parentReference,
    prerequisites: [],
    settleColumn: false,
    attributes,
  })
}

// 直接の起票と freeform の attributes を照らす。合わなければ止める
async function checkDirectAttributes(output: CreateOutput, client: GitHubClient, config: ProjectConfig, request: Readonly<CreateAttributeRequest>): Promise<readonly AttributeWrite[]> {
  const check = await checkCreateAttributes(output, client, config, request, newCheckCache())
  return check.ok ? check.writes : stopForAttributeErrors(output, [{ file: undefined, errors: check.errors }], recordCreateErrors(output))
}

interface MessageTarget {
  readonly repository: string
  /**
  epic は作成先を決めるときに読んだ設定。epic 以外は undefined
  */
  readonly config: ProjectConfig | undefined
}

// -m の作成先。epic 以外は --repo が要る。epic は aggregation_repo の方針で決める
function messageModeTarget(output: Output, issueType: IssueType, repository: string | undefined, project: string | undefined): MessageTarget {
  if (issueType !== 'epic') {
    if (repository === undefined || repository === '') {
      stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'repo')} is required with ${inputNameHint(CREATE_PATH, 'message')}`, 'invalid-input')
    }
    return { repository, config: undefined }
  }
  const config = configForCreate(output, repository, project)
  const target = resolveEpicTargetRepository(output, repository, config)
  if (target.needsWarning) warnEpicRepositoryException(output, target.repository, config)
  return { repository: target.repository, config }
}

const USAGE_TEXT = hinted`missing arguments
direct posting: ${commandHint(CREATE_PATH, { title: placeholder('TITLE'), repo: 'owner/repo', message: placeholder('BODY') })}
free format: ${commandHint(CREATE_PATH, { freeform: true, repo: 'owner/repo', message: placeholder('BODY') })}
from a file: ${commandHint(CREATE_PATH, { files: placeholder('path') })}`

// --- --freeform ---

// Python の re の `\s` と同じ集合。JS の `\s` と違い、U+001C〜U+001F を含む。U+FEFF は含まない
// eslint-disable-next-line no-control-regex -- Python の空白に含まれる制御文字
const PYTHON_WHITESPACE_RUN = /[\p{White_Space}\u{1C}\u{1D}\u{1E}\u{1F}]+/gu

// テンプレートの検証を飛ばす freeform でも、起票規約への参照を本文の末尾に残す
const FREEFORM_FOOTER = '<!-- issue create の freeform で起票（テンプレ検証スキップ）。起票ルール: skills/w-help/references/issue-flow-rules.md#起票時の既定-status -->'

const FREEFORM_TITLE_LENGTH = 50

interface FreeformInput {
  readonly message?: string | undefined
  readonly repo?: string | undefined
  readonly type: IssueType
  readonly status?: string | undefined
  readonly parent_epic?: string | undefined
  readonly order?: number | undefined
  readonly label?: readonly string[] | undefined
  readonly project?: string | undefined
  readonly attributes?: RawAttributes
  readonly lane?: string | undefined
}

// テンプレートを確かめずに、メッセージだけで Issue を作る。タイトルは 1 行目の先頭 50 文字の空白を 1 つにまとめたもの
async function createFreeform(output: CreateOutput, input: Readonly<FreeformInput>): Promise<void> {
  const { message, repo, type: issueType } = input
  if (message === undefined || pythonStrip(message) === '') stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'message')} is required with ${inputHint(CREATE_PATH, 'freeform')}`, 'invalid-input', USAGE_EXIT_CODE)
  if (repo === undefined || repo === '') stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'repo')} is required with ${inputHint(CREATE_PATH, 'freeform')}`, 'invalid-input', USAGE_EXIT_CODE)
  let status: string
  if (input.status === undefined) {
    // eslint-disable-next-line security/detect-object-injection -- issueType は列挙型
    status = TYPE_DEFAULT_STATUS[issueType]
  }
  else {
    validateStatusForType(output, issueType, input.status)
    status = input.status
  }
  const [owner, repository] = validateRepositoryShape(output, repo)
  const { config } = requireConfigFor(output, { owner, repository }, input.project, CREATE_PATH)
  const parentReference = parentReferenceOf(normalizeParentEpicCli(input.parent_epic), config, owner, repository)
  const [firstLine = ''] = pythonStrip(message).split(PYTHON_LINE_BREAK)
  const cleaned = pythonStrip(truncateCodePoints(firstLine, FREEFORM_TITLE_LENGTH).replaceAll(PYTHON_WHITESPACE_RUN, ' '))
  const title = buildIssueTitle(issueType, cleaned, { parentEpic: parentReference?.number, order: input.order })
  const client = await clientForIssueCreate(output, config, owner, repository, repo, parentReference, input.order)
  if (parentReference !== undefined && issueType === 'epic') output.warning('giving a parent Epic to an Epic is not recommended')
  const labels = input.label !== undefined && input.label.length > 0 ? input.label : undefined
  const attributes = await checkDirectAttributes(output, client, config, { owner, repository, inputs: attributeInputs(input.attributes), hasLabels: labels !== undefined, lane: input.lane, parent: parentReference })

  await postIssue(output, client, config, newSession(), {
    owner,
    repository,
    title,
    body: `${pythonRightStrip(message)}\n\n${FREEFORM_FOOTER}`,
    labels,
    source: undefined,
    useResponseNodeId: true,
    fields: statusFields(status),
    parentReference,
    prerequisites: [],
    settleColumn: false,
    attributes,
  })
}

interface MessageInput {
  readonly title?: string | undefined
  readonly repo?: string | undefined
  readonly type: IssueType
  readonly status?: string | undefined
  readonly parent_epic?: string | undefined
  readonly label?: readonly string[] | undefined
  readonly order?: number | undefined
  readonly project?: string | undefined
  readonly attributes?: RawAttributes
  readonly lane?: string | undefined
}

// -m の直接投稿。入力の確認から作成まで
async function createFromMessage(output: CreateOutput, input: Readonly<MessageInput>, message: string): Promise<void> {
  if (input.title === undefined || input.title === '') {
    stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'title')} is required with ${inputNameHint(CREATE_PATH, 'message')}`, 'invalid-input')
  }
  const target = messageModeTarget(output, input.type, input.repo, input.project)
  await createDirect(output, {
    message,
    title: input.title,
    repository: target.repository,
    issueType: input.type,
    status: input.status,
    parentEpic: input.parent_epic,
    labels: input.label,
    order: input.order,
    project: input.project,
    attributes: attributeInputs(input.attributes),
    lane: input.lane,
  }, target.config)
}

const ISSUE_CREATE = defineCommand({
  path: ['issue', 'create'],
  title: 'Create Issues',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Create Issues from Markdown files with frontmatter',
  input: z.object({
    files: FILES_SCHEMA,
    message: z.string().optional().describe('Issue body (direct posting mode)'),
    title: z.string().optional().describe('Issue title (direct posting mode, required with `message`)'),
    repo: z.string().optional().describe('Repository (owner/repo form; required with `message` unless epic)'),
    type: ISSUE_TYPE_SCHEMA,
    status: z.string().optional().describe('Status (backlog/pending/ready/active/in_review/archived)'),
    parent_epic: z.string().optional().describe(PARENT_EPIC_DESCRIPTION),
    order: z.int().optional().describe('Order number of the subtask (used with parent_epic)'),
    label: LABEL_SCHEMA,
    attributes: ATTRIBUTES_INPUT.describe('Attributes to write by name (the attributes that issue_attributes lists): name, value and, only when the same name is in several sources, source; null values are skipped; cannot be used with files (write attributes in the front matter instead)'),
    lane: z.string().min(1).optional().describe(`Value of the board field ${LANE_FIELD_NAME}, one of its options; when omitted with parent_epic, the value of the parent Epic; cannot be used with files (write lane in the front matter instead)`),
    freeform: z.boolean().default(false).describe('Create the Issue from a free-format message without the template check (title from the first 50 characters of the first line)'),
    project: PROJECT_INPUT,
  }),
  output: ISSUE_CREATE_OUTPUT,
  positional: ['files'],
  shortFlags: { message: '-m', title: '-t', repo: '-r', label: '-l' },
  aliases: { attributes: '--attribute' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput<IssueCreateData>(false, io)
    const hasFiles = input.files !== undefined && input.files.length > 0
    return await runWithExit(async () => {
      if ((hasFiles || input.title !== undefined) && input.freeform) {
        stopWith(output, hinted`${inputHint(CREATE_PATH, 'freeform')} cannot be used with ${inputNameHint(CREATE_PATH, 'files')} or ${inputNameHint(CREATE_PATH, 'title')}`, 'invalid-input', USAGE_EXIT_CODE)
      }
      if (hasFiles && input.attributes !== undefined) {
        stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'attributes')} cannot be used with ${inputNameHint(CREATE_PATH, 'files')}; write attributes in the front matter`, 'invalid-input', USAGE_EXIT_CODE)
      }
      if (hasFiles && input.lane !== undefined) {
        stopWith(output, hinted`${inputNameHint(CREATE_PATH, 'lane')} cannot be used with ${inputNameHint(CREATE_PATH, 'files')}; write lane in the front matter`, 'invalid-input', USAGE_EXIT_CODE)
      }
      if (input.freeform) {
        await createFreeform(output, input)
      }
      else if (hasFiles) {
        await createFromFiles(output, input.files ?? [], input.project)
      }
      else if (input.message === undefined) {
        stopWith(output, USAGE_TEXT, 'invalid-input')
      }
      else {
        await createFromMessage(output, input, input.message)
      }
    })
  },
})

export const ISSUE_CREATE_COMMANDS: readonly CommandDefinition[] = [ISSUE_CREATE]
