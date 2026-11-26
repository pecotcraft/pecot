// GitHub の今のスキーマを写し（interface/github-issue-surface.json）と比べ、差があれば差の Issue を 1 件だけ置く。
// 使い方: tsx scripts/github-surface/drift.ts --repo <owner/repo> [--sdl <ファイル>] [--openapi <ファイル>] [--dry-run]
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { CommandExit } from '../../src/commands/command-definition.js'
import { createIssue, putOnBoard } from '../../src/commands/issue-board.js'
import { createOutput } from '../../src/commands/output.js'
import type { Output } from '../../src/commands/output.js'
import type { CommandIo } from '../../src/commands/registry.js'
import { loadTarget } from '../../src/commands/tracker-sync.js'
import { buildIssueSurfaceIssue, diffIssueSurface, extractIssueSurface, hasIssueSurfaceDifference, issueSurfaceSchema, planIssueSurfaceDrift } from '../../src/domain/issue-surface.js'
import type { IssueSurfaceIssue, IssueSurfaceSourceNames } from '../../src/domain/issue-surface.js'
import { parseJsonText } from '../../src/domain/json.js'
import type { JsonValue } from '../../src/domain/python-format.js'
import { DEFAULT_API_VERSION } from '../../src/infra/github/client.js'
import { GitHubClient } from '../../src/infra/github/index.js'
import { fetchGraphqlSchema, fetchRestDescription, GRAPHQL_SCHEMA_URL, listOpenIssues, restDescriptionUrl, rewriteIssue } from '../../src/infra/github/issue-surface.js'
import { requireNumber, requireString } from '../../src/infra/github/payload.js'

const USAGE = 'usage: drift.ts --repo <owner/repo> [--sdl <file>] [--openapi <file>] [--dry-run]'

const SURFACE_URL = new URL('../../../interface/github-issue-surface.json', import.meta.url)

const STANDARD_IO: CommandIo = {
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

interface Options {
  readonly owner: string
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
    const [, owner, repository] = /^([^/]+)\/([^/]+)$/u.exec(values.repo ?? '') ?? []
    return owner === undefined || repository === undefined ? undefined : { owner, repository, sdl: values.sdl, openapi: values.openapi, isDryRun: values['dry-run'] ?? false }
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
  const names = { graphql: options.sdl ?? GRAPHQL_SCHEMA_URL, rest: options.openapi ?? restDescriptionUrl(DEFAULT_API_VERSION), rest_api_version: DEFAULT_API_VERSION }
  return { sdl, openapi, names }
}

function printPlanned(io: CommandIo, issue: Readonly<IssueSurfaceIssue>, line: string): void {
  io.stdout(`title: ${issue.title}\nbody:\n${issue.body}${line}\n`)
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変
async function create(output: Readonly<Output>, io: CommandIo, client: GitHubClient, options: Readonly<Options>, issue: Readonly<IssueSurfaceIssue>): Promise<number> {
  let target
  try {
    target = loadTarget(output, `${options.owner}/${options.repository}`, undefined)
  }
  catch (error: unknown) {
    if (error instanceof CommandExit) return error.exitCode
    throw error
  }
  if (options.isDryRun) {
    printPlanned(io, issue, 'would create')
    return 0
  }
  const created = await createIssue(client, target.owner, target.repository, issue.title, issue.body, undefined)
  const number = requireNumber(created['number'], 'number')
  io.stdout(`created: ${requireString(created['html_url'], 'html_url')}\n`)
  const failures = await putOnBoard(output, client, target.config, target.owner, target.repository, number, { onlyIfEmpty: false })
  return failures > 0 ? 1 : 0
}

/**
今のスキーマを写しと比べ、差の Issue を作る・書き直す。引数の誤りは 2、ボードの列を書けなければ 1
*/
export async function run(argv: readonly string[], io: CommandIo = STANDARD_IO): Promise<number> {
  const output = createOutput(false, io)
  const options = optionsOf(argv)
  if (options === undefined) {
    output.error(USAGE)
    return 2
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのはこのファイルからの相対で決まる写し
  const snapshot = issueSurfaceSchema.parse(parseJsonText(readFileSync(SURFACE_URL, 'utf8')))
  const { sdl, openapi, names } = await sourcesOf(options)
  const diff = diffIssueSurface(snapshot.items, extractIssueSurface(sdl, openapi))
  // 差が無ければ、トークンを読むクライアントを作らず、Issue も読まない
  const client = hasIssueSurfaceDifference(diff) ? new GitHubClient({ diagnostics: output }) : undefined
  const plan = planIssueSurfaceDrift(diff, client === undefined ? [] : await listOpenIssues(client, options.owner, options.repository))
  if (client === undefined || plan.action === 'none') {
    io.stdout('no difference\n')
    return 0
  }
  const issue = buildIssueSurfaceIssue(diff, names)
  switch (plan.action) {
    case 'create': {
      return create(output, io, client, options, issue)
    }
    case 'unchanged':
    case 'update': {
      if (plan.others.length > 0) {
        const listed = plan.others.map(number => `#${String(number)}`).join(', ')
        output.warning(`multiple open issue surface Issues; using #${String(plan.number)} (lowest number) and leaving ${listed} open`)
      }
      if (plan.action === 'unchanged') {
        io.stdout(`unchanged: #${String(plan.number)}\n`)
        return 0
      }
      if (options.isDryRun) {
        printPlanned(io, issue, `would update #${String(plan.number)}`)
        return 0
      }
      await rewriteIssue(client, options.owner, options.repository, plan.number, issue.title, issue.body)
      io.stdout(`updated: #${String(plan.number)}\n`)
      return 0
    }
  }
}

// 起動したファイルかどうかを realpath で比べる（export-interface.ts と同じ）
const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2))
}
