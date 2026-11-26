/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのは一時ディレクトリと写しのファイルだけ */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../scripts/github-surface/drift.js'
import type { CommandIo } from '../src/commands/registry.js'
import { diffIssueSurface, issueSurfaceSchema } from '../src/domain/issue-surface.js'
import { renderTrackerBody, SURFACE_LABEL } from '../src/domain/issue-surface-tracker.js'
import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory, writeTree } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../src/infra/github/issue-surface.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import type { RecordedRequest, ResponseRule } from '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { setUpProject, startGithub } from './_helpers/interface-case.js'
import { boardRules, createdTracker, freezeClock, issueListRule, WORKFLOW_FIELD } from './_helpers/tracker-sync-case.js'

useIsolatedEnvironment()

const SURFACE_URL = new URL('../../interface/github-issue-surface.json', import.meta.url)
const SNAPSHOT = issueSurfaceSchema.parse(JSON.parse(readFileSync(SURFACE_URL, 'utf8')))
const ADDED = 'graphql:enum:IssueFieldDataType.CUJ708A'
const ADDED_B = 'graphql:enum:IssueFieldDataType.CUJ708B'
const ISSUES_PATH = '/repos/acme/demo/issues'
const REST_PREFIX = 'rest:POST /repos/{owner}/{repo}/issues#'

function pushTo(groups: Map<string, string[]>, key: string, value: string): void {
  groups.set(key, [...groups.get(key) ?? [], value])
}

// 写しの id の集合から、extractIssueSurface がちょうどその集合を返す SDL を組む
function sdlOf(ids: readonly string[]): string {
  const enums = new Map<string, string[]>()
  const inputs = new Map<string, string[]>()
  const mutations: string[] = []
  for (const id of ids) {
    if (id.startsWith('graphql:enum:')) {
      const [type = '', value = ''] = id.slice('graphql:enum:'.length).split('.', 2)
      pushTo(enums, type, value)
    }
    else if (id.startsWith('graphql:mutation:')) {
      mutations.push(id.slice('graphql:mutation:'.length))
    }
    else if (id.startsWith('graphql:')) {
      const [type = '', field = ''] = id.slice('graphql:'.length).split('.', 2)
      pushTo(inputs, type, field)
    }
  }
  return [
    'directive @possibleTypes(concreteTypes: [String!]!, abstractType: String) on INPUT_FIELD_DEFINITION | ARGUMENT_DEFINITION',
    'type Issue { id: ID! }',
    ...[...enums].map(([type, values]) => `enum ${type} { ${values.join(' ')} }`),
    ...[...inputs].map(([type, fields]) => `input ${type} { ${fields.map(field => `${field}: String`).join(' ')} }`),
    ...mutations.map(name => `input Drift_${name}Input { issueId: ID! @possibleTypes(concreteTypes: ["Issue"]) }`),
    `type Mutation { ${mutations.map(name => `${name}(input: Drift_${name}Input!): Issue`).join(' ')} }`,
  ].join('\n')
}

function openapiOf(ids: readonly string[]): string {
  const properties = Object.fromEntries(ids.filter(id => id.startsWith(REST_PREFIX)).map(id => [id.slice(REST_PREFIX.length), {}]))
  return JSON.stringify({ paths: { '/repos/{owner}/{repo}/issues': { post: { requestBody: { content: { 'application/json': { schema: { properties } } } } } } } })
}

interface Sources {
  readonly sdl: string
  readonly openapi: string
}

function writeSources(ids: readonly string[]): Sources {
  const directory = makeTemporaryDirectory('pecot-drift-')
  writeTree(directory, { 'schema.graphql': sdlOf(ids), 'openapi.json': openapiOf(ids) })
  return { sdl: path.join(directory, 'schema.graphql'), openapi: path.join(directory, 'openapi.json') }
}

function argvOf(sources: Readonly<Sources>, ...rest: readonly string[]): string[] {
  return ['--repo', 'acme/demo', '--sdl', sources.sdl, '--openapi', sources.openapi, ...rest]
}

interface Captured {
  readonly io: CommandIo
  readonly stdout: () => string
  readonly stderr: () => string
}

function capture(): Captured {
  const out: string[] = []
  const error: string[] = []
  const io: CommandIo = {
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      error.push(text)
    },
  }
  return { io, stdout: () => out.join(''), stderr: () => error.join('') }
}

// GitHub の API（偽サーバ）への要求はそのまま通し、どこへ取りに行ったかを残す
function recordFetch(responses: ReadonlyMap<string, string> = new Map()): string[] {
  const requested: string[] = []
  const realFetch = fetch
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- fetch の型に合わせる
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const text = responses.get(url)
    if (text !== undefined) {
      requested.push(url)
      return new Response(text)
    }
    if (!url.startsWith('http://127.0.0.1:')) requested.push(url)
    return realFetch(input, init)
  })
  return requested
}

beforeEach(() => {
  setUpProject({ host: 'github.com' })
  // github.com のトークンの変数は、setUpProject の組む名前と違う
  setEnvironment({ PECOT_GITHUB_COM_TOKEN: 'dummy-token' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const TITLE = '[Tracker] GitHub issue surface — 2026-11-09'

function trackers(...issues: readonly JsonObject[]): ResponseRule {
  return issueListRule(SURFACE_LABEL, issues)
}

function trackerIssue(number: number, body: string, state = 'open'): JsonObject {
  return { number, state, body }
}

function bodyOf(ids: readonly string[], sources: Readonly<Sources>, existing?: string): string {
  const names = { graphql: sources.sdl, rest: sources.openapi }
  return renderTrackerBody(diffIssueSurface(SNAPSHOT.items, ids), names, existing)
}

function patched(body: unknown): ResponseRule {
  return { match: { method: 'PATCH', path: `${ISSUES_PATH}/5`, body }, respond: { status: 200, body: { number: 5 } }, times: 1 }
}

// REST の書き込み（Issue の作成・本文・状態）
function restWrites(requests: readonly RecordedRequest[]): readonly RecordedRequest[] {
  return requests.filter(request => request.type === 'rest' && request.method !== 'GET')
}

const CHANGED = [...SNAPSHOT.items, ADDED]

describe('drift.ts', () => {
  beforeEach(() => {
    freezeClock()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.for([
    { name: '--repo が無い', argv: [] },
    { name: '--repo が owner/repo の形でない', argv: ['--repo', 'acme'] },
    { name: '--repo の owner が空', argv: ['--repo', '/demo'] },
    { name: '知らない引数がある', argv: ['--repo', 'acme/demo', '--out', 'x'] },
  ])('$name と、usage を出して 2 で止まり、取りに行かない', async ({ argv }) => {
    const requested = recordFetch()
    const { io, stderr } = capture()
    expect(await run(argv, io)).toBe(2)
    expect(stderr()).toBe('error: usage: drift.ts --repo <owner/repo> [--sdl <file>] [--openapi <file>] [--dry-run]\n')
    expect(requested).toEqual([])
  })

  it('--sdl と --openapi を渡し、差と開いた Tracker が無いと、スキーマを取りに行かず、Tracker を作らない', async () => {
    const requested = recordFetch()
    const github = await startGithub([trackers()])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(SNAPSHOT.items))
    expect(await run(argv, io)).toBe(0)
    expect(stderr()).toBe('skipped: Tracker creation\n')
    expect(requested).toEqual([])
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--sdl だけを省くと、SDL だけを公開スキーマから取り、OpenAPI はファイルから読む', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const requested = recordFetch(new Map([[GRAPHQL_SCHEMA_URL, readFileSync(sources.sdl, 'utf8')]]))
    await startGithub([trackers()])
    const { io } = capture()
    expect(await run(['--repo', 'acme/demo', '--openapi', sources.openapi], io)).toBe(0)
    expect(requested).toEqual([GRAPHQL_SCHEMA_URL])
  })

  it('--openapi だけを省くと、DEFAULT_API_VERSION の版の OpenAPI だけを取りに行く', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const rest = restDescriptionUrl(DEFAULT_API_VERSION)
    const requested = recordFetch(new Map([[rest, readFileSync(sources.openapi, 'utf8')]]))
    await startGithub([trackers()])
    const { io } = capture()
    expect(await run(['--repo', 'acme/demo', '--sdl', sources.sdl], io)).toBe(0)
    expect(requested).toEqual([rest])
  })

  it('差があって開いた Tracker が無いと、ラベル付きの Tracker を作ってボードの Backlog に載せる', async () => {
    const sources = writeSources(CHANGED)
    const listing = trackers(trackerIssue(3, bodyOf(CHANGED, sources), 'closed'))
    const github = await startGithub([listing, createdTracker(12), ...boardRules(12, { onlyIfEmpty: false })])
    const { io, stdout, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stdout()).toBe('')
    expect(stderr()).toContain(`created: Tracker "${TITLE}"\n`)
    expect(stderr()).not.toContain('error: ')
    const [created] = restWrites(github.requests())
    expect(created).toMatchObject({ method: 'POST', path: ISSUES_PATH, body: { title: TITLE, body: bodyOf(CHANGED, sources), labels: [SURFACE_LABEL] } })
    expect(JSON.stringify(created)).toContain(`- \`${ADDED}\``)
  })

  it('作った Tracker のボードの列を書けないと、error の行を出して 1 で止まる', async () => {
    const rules = boardRules(12, { onlyIfEmpty: false }).filter(rule => rule.match.operation !== 'UpdateProjectItemField')
    await startGithub([
      trackers(),
      createdTracker(12),
      ...rules,
      { match: { operation: 'UpdateProjectItemField', variables: { fieldId: WORKFLOW_FIELD } }, respond: { status: 200, body: { errors: [{ message: 'boom' }] } }, times: 1 },
    ])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/error: could not set status backlog of Tracker #12:/u)
  })

  it('差があり、開いた Tracker の一覧が同じだと、本文を書かずに unchanged の行を出す', async () => {
    const sources = writeSources(CHANGED)
    const listing = trackers(trackerIssue(5, bodyOf(CHANGED, sources)))
    const github = await startGithub([listing, ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('unchanged: Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('差が変わると、開いた Tracker の一覧の間だけを書き直し、外の文を残す', async () => {
    const sources = writeSources(CHANGED)
    const existing = `人が足した文。\n\n${bodyOf(CHANGED, sources)}`
    const changed = [...CHANGED, ADDED_B]
    const changedSources = writeSources(changed)
    const expected = bodyOf(changed, changedSources, existing)
    const github = await startGithub([trackers(trackerIssue(5, existing)), patched({ body: expected }), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
    const { io, stderr } = capture()
    const argv = argvOf(changedSources)
    expect(await run(argv, io)).toBe(0)
    expect(stderr()).toBe('updated: Tracker #5 body\n')
    expect(expected).toContain('人が足した文。')
    expect(expected).toContain(`- \`${ADDED_B}\``)
    expect(restWrites(github.requests())).toHaveLength(1)
  })

  it('差が無くなると、開いた Tracker の一覧を none に書き直してから閉じる', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const existing = bodyOf(CHANGED, sources)
    const github = await startGithub([trackers(trackerIssue(5, existing)), patched({ body: bodyOf(SNAPSHOT.items, sources, existing) }), patched({ state: 'closed', state_reason: 'completed' })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('updated: Tracker #5 body\nclosed: Tracker #5\n')
    expect(restWrites(github.requests())).toHaveLength(2)
  })

  it('開いた Tracker が 2 件以上あると、番号の最も小さいものを使い、ほかを警告に挙げる', async () => {
    const sources = writeSources(CHANGED)
    const body = bodyOf(CHANGED, sources)
    const github = await startGithub([trackers(trackerIssue(9, body), trackerIssue(5, body), trackerIssue(7, body)), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('warning: multiple open Trackers; using #5 (lowest number) and leaving #7, #9 open\nunchanged: Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('開いた Tracker の一覧の印が 1 組でないと、書き込まずに error の行を出して 1 で止まる', async () => {
    const github = await startGithub([trackers(trackerIssue(5, '<!-- pecot-issue-surface: tracker -->\n'))])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: Tracker #5: cannot rewrite the list/u)
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--dry-run で作るときは、書き込まずに作る予定の行を出す', async () => {
    const github = await startGithub([trackers()])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED), '--dry-run')
    expect(await run(argv, io)).toBe(0)
    expect(stderr()).toBe(`dry-run: would create Tracker "${TITLE}"\n`)
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--dry-run で差が無くなったときは、書き込まずに書き直しと閉じる予定の行を出す', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const listing = trackers(trackerIssue(5, bodyOf(CHANGED, sources)))
    const github = await startGithub([listing])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources, '--dry-run'), io)).toBe(0)
    expect(stderr()).toBe('dry-run: would update Tracker #5 body\ndry-run: would close Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('Tracker の一覧を読めないと、error の行を出して 1 で止まる', async () => {
    await startGithub([issueListRule(SURFACE_LABEL, [], 500)])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: Tracker: /u)
  })

  it('ボードの設定が見つからないと、Tracker を読まずに error の行を出して 1 で止まる', async () => {
    setUpProject({ host: 'github.com', repositories: ['other'] })
    const github = await startGithub([])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: /u)
    expect(github.requests()).toEqual([])
  })
})
