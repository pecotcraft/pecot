// GitHub の今のスキーマを写し（interface/github-issue-surface.json）と比べ、差を Tracker 1 件に書き直す。差が無くなれば Tracker を閉じる。
// 使い方: tsx scripts/github-surface/drift.ts --repo <owner/repo> [--sdl <ファイル>] [--openapi <ファイル>] [--dry-run]
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createIssue, putOnBoard } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import type { CommandIo } from '../../src/commands/registry.js'
import { apiErrorDetail, isBodyUnchanged, syncTargetOf, todayUtc, warnExtraTrackers } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import type { SyncTarget } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import { requireReleaseTargetRepository } from '@pecot/workflow-core/commands-shared/release-target.js'
import { diffIssueSurface, extractIssueSurface, hasIssueSurfaceDifference, issueSurfaceSchema } from '../../src/domain/issue-surface.js'
import type { IssueSurfaceDiff } from '../../src/domain/issue-surface.js'
import { buildTrackerTitle, IssueSurfaceTrackerError, renderTrackerBody, SURFACE_LABEL, TRACKER_PATTERN } from '../../src/domain/issue-surface-tracker.js'
import type { IssueSurfaceSourceNames } from '../../src/domain/issue-surface-tracker.js'
import { parseJsonText } from '@pecot/workflow-core/domain/json.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import { findTracker } from '@pecot/workflow-core/domain/tracker-body.js'
import type { TrackerIssue } from '@pecot/workflow-core/domain/tracker-body.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { fetchGraphqlSchema, fetchRestDescription, GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../../src/infra/github/issue-surface.js'
import { requireNumber } from '@pecot/workflow-core/infra/github/payload.js'

const USAGE = 'usage: drift.ts --repo <owner/repo> [--sdl <file>] [--openapi <file>] [--dry-run]'

const SURFACE_URL = new URL('../../../interface/github-issue-surface.json', import.meta.url)

const STANDARD_IO: CommandIo = {
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

interface Options {
  readonly repository: string
  readonly sdl: string | undefined
  readonly openapi: string | undefined
  readonly isDryRun: boolean
}

function optionsOf(argv: readonly string[]): Options | undefined {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { 'repo': { type: 'string' }, 'sdl': { type: 'string' }, 'openapi': { type: 'string' }, 'dry-run': { type: 'boolean' } },
      strict: true,
    })
    const repository = values.repo ?? ''
    return /^[^/]+\/[^/]+$/u.test(repository) ? { repository, sdl: values.sdl, openapi: values.openapi, isDryRun: values['dry-run'] ?? false } : undefined
  }
  catch {
    return undefined
  }
}

function readText(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読む先は引数で渡されたファイル
  return readFileSync(file, 'utf8')
}

async function sourcesOf(options: Readonly<Options>): Promise<{ sdl: string, openapi: JsonValue, names: IssueSurfaceSourceNames }> {
  const [sdl, openapi] = await Promise.all([
    options.sdl === undefined ? fetchGraphqlSchema() : readText(options.sdl),
    options.openapi === undefined ? fetchRestDescription(DEFAULT_API_VERSION) : parseJsonText(readText(options.openapi)),
  ])
  const names = { graphql: options.sdl ?? GRAPHQL_SCHEMA_URL, rest: options.openapi ?? restDescriptionUrl(DEFAULT_API_VERSION) }
  return { sdl, openapi, names }
}

interface SyncContext {
  readonly out: Readonly<Output>
  readonly client: GitHubClient
  readonly target: SyncTarget
  readonly diff: IssueSurfaceDiff
  readonly names: IssueSurfaceSourceNames
  readonly isDryRun: boolean
}

// 開いた Tracker が無いとき。差があれば作ってボードに載せる。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient を渡す
async function createTracker(context: Readonly<SyncContext>): Promise<number> {
  const { out, client, target, diff, names, isDryRun } = context
  if (!hasIssueSurfaceDifference(diff)) {
    settle(out, { verb: 'skip', target: 'Tracker creation' })
    return 0
  }
  const title = buildTrackerTitle(todayUtc(new Date()))
  const operation: Operation = { verb: 'create', target: `Tracker "${title}"` }
  out.planned(operation)
  if (isDryRun) return 0
  const issue = await createIssue(client, target.owner, target.repository, title, renderTrackerBody(diff, names), [SURFACE_LABEL])
  out.done(operation)
  return await putOnBoard(out, client, target.config, target.owner, target.repository, requireNumber(issue['number'], 'number'), { onlyIfEmpty: false })
}

// 開いた Tracker があるとき。一覧を書き直し、差が無くなっていれば閉じる。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient を渡す
async function rewriteTracker(context: Readonly<SyncContext>, tracker: Readonly<TrackerIssue>): Promise<number> {
  const { out, client, target, diff, names, isDryRun } = context
  const label = `Tracker #${String(tracker.number)}`
  let body
  try {
    body = renderTrackerBody(diff, names, tracker.body)
  }
  catch (error: unknown) {
    if (!(error instanceof IssueSurfaceTrackerError)) throw error
    out.error(`${label}: ${error.message}`)
    return 1
  }
  const isUnchanged = isBodyUnchanged(body, tracker.body)
  const rewrite: Operation = isUnchanged ? { verb: 'unchanged', target: label } : { verb: 'update', target: `${label} body` }
  const closing: Operation | undefined = hasIssueSurfaceDifference(diff) ? undefined : { verb: 'close', target: label }
  out.planned(rewrite)
  if (closing !== undefined) out.planned(closing)
  if (isDryRun) return 0
  if (!isUnchanged) await client.updateIssueBody(target.owner, target.repository, tracker.number, body)
  out.done(rewrite)
  if (closing !== undefined) {
    await client.closeIssue(target.owner, target.repository, tracker.number, 'completed')
    out.done(closing)
    return 0
  }
  // 作った後にボード登録が失敗した実行を直す。Status は空のときだけ入れる
  return await putOnBoard(out, client, target.config, target.owner, target.repository, tracker.number, { onlyIfEmpty: true })
}

async function sync(out: Readonly<Output>, options: Readonly<Options>, diff: Readonly<IssueSurfaceDiff>, names: Readonly<IssueSurfaceSourceNames>): Promise<number> {
  const target = syncTargetOf(out, requireReleaseTargetRepository(undefined, options.repository, out), undefined)
  const client = await makeClient(out, target.config)
  try {
    const issues = await client.listIssuesByLabel(target.owner, target.repository, SURFACE_LABEL)
    const { tracker, others } = findTracker(issues, TRACKER_PATTERN)
    warnExtraTrackers(out, tracker, others)
    const context: SyncContext = { out, client, target, diff, names, isDryRun: options.isDryRun }
    return tracker === undefined ? await createTracker(context) : await rewriteTracker(context, tracker)
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    out.error(`Tracker: ${detail}`)
    return 1
  }
}

/**
今のスキーマを写しと比べ、Tracker を作る・書き直す・閉じる。引数の誤りは 2、API の失敗とボードの列を書けなかったときは 1
*/
export async function run(argv: readonly string[], io: CommandIo = STANDARD_IO): Promise<number> {
  const options = optionsOf(argv)
  const out = createOutput(options?.isDryRun ?? false, io)
  if (options === undefined) {
    out.error(USAGE)
    return 2
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのはこのファイルからの相対で決まる写し
  const snapshot = issueSurfaceSchema.parse(parseJsonText(readFileSync(SURFACE_URL, 'utf8')))
  const { sdl, openapi, names } = await sourcesOf(options)
  const diff = diffIssueSurface(snapshot.items, extractIssueSurface(sdl, openapi))
  try {
    return await sync(out, options, diff, names)
  }
  catch (error: unknown) {
    if (error instanceof CommandExit) return error.exitCode
    throw error
  }
}

// 起動したファイルかどうかを realpath で比べる（export-interface.ts と同じ）
const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2))
}
