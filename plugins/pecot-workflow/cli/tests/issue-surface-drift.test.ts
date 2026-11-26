/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのは一時ディレクトリと写しのファイルだけ */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../scripts/github-surface/drift.js'
import type { CommandIo } from '../src/commands/registry.js'
import { diffIssueSurface, issueSurfaceMarker, issueSurfaceSchema } from '../src/domain/issue-surface.js'
import { JSON_NULL } from '../src/domain/json-null.js'
import { setEnvironment, useIsolatedEnvironment } from '../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory, writeTree } from '../src/tests/_helpers/temporary.js'
import { GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../src/infra/github/issue-surface.js'
import { DEFAULT_API_VERSION } from '../src/infra/github/client.js'
import type { RecordedRequest, ResponseRule } from './fake-github/server.js'
import { isRecord } from './parity/baseline.js'
import { setUpProject, startGithub } from './_helpers/interface-case.js'
import { boardRules, WORKFLOW_FIELD } from './_helpers/tracker-sync-case.js'

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

const LIST_OPERATION = 'ListOpenIssueBodies'

function openIssues(nodes: readonly unknown[]): ResponseRule {
  const data = { repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: JSON_NULL } } } }
  return { match: { operation: LIST_OPERATION, variables: { owner: 'acme', repo: 'demo' } }, respond: { status: 200, body: { data } }, times: 1 }
}

// 開いた Issue の一覧の読み出しを除いた要求
function writes(requests: readonly RecordedRequest[]): readonly RecordedRequest[] {
  return requests.filter(request => request.type === 'graphql' ? request.operation !== LIST_OPERATION : request.method !== 'GET')
}

const CHANGED = [...SNAPSHOT.items, ADDED]
const MARKER = issueSurfaceMarker(diffIssueSurface(SNAPSHOT.items, CHANGED))
const OTHER_MARKER = issueSurfaceMarker(diffIssueSurface(SNAPSHOT.items, [...CHANGED, ADDED_B]))

describe('drift.ts', () => {
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

  it('--sdl と --openapi を渡して差が無いと、スキーマを取りに行かず、Issue も読まずに no difference を出す', async () => {
    const requested = recordFetch()
    const github = await startGithub([])
    const { io, stdout } = capture()
    const argv = argvOf(writeSources(SNAPSHOT.items))
    expect(await run(argv, io)).toBe(0)
    expect(stdout()).toBe('no difference\n')
    expect(requested).toEqual([])
    expect(github.requests()).toEqual([])
  })

  it('--sdl だけを省くと、SDL だけを公開スキーマから取り、OpenAPI はファイルから読む', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const requested = recordFetch(new Map([[GRAPHQL_SCHEMA_URL, readFileSync(sources.sdl, 'utf8')]]))
    const { io, stdout } = capture()
    expect(await run(['--repo', 'acme/demo', '--openapi', sources.openapi], io)).toBe(0)
    expect(stdout()).toBe('no difference\n')
    expect(requested).toEqual([GRAPHQL_SCHEMA_URL])
  })

  it('--openapi だけを省くと、DEFAULT_API_VERSION の版の OpenAPI だけを取りに行く', async () => {
    const sources = writeSources(SNAPSHOT.items)
    const rest = restDescriptionUrl(DEFAULT_API_VERSION)
    const requested = recordFetch(new Map([[rest, readFileSync(sources.openapi, 'utf8')]]))
    const { io, stdout } = capture()
    expect(await run(['--repo', 'acme/demo', '--sdl', sources.sdl], io)).toBe(0)
    expect(stdout()).toBe('no difference\n')
    expect(requested).toEqual([rest])
  })

  it('差があり開いた差の Issue が無いと、Issue を作ってボードの Backlog に載せ、created に URL を出す', async () => {
    const requested = recordFetch()
    const sources = writeSources(CHANGED)
    const github = await startGithub([
      openIssues([{ number: 1, body: JSON_NULL }, { number: 2, body: 'ほかの Issue' }]),
      { match: { method: 'POST', path: ISSUES_PATH }, respond: { status: 201, body: { number: 12, html_url: 'https://github.com/acme/demo/issues/12' } }, times: 1 },
      ...boardRules(12, { onlyIfEmpty: false }),
    ])
    const { io, stdout, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stdout()).toBe('created: https://github.com/acme/demo/issues/12\n')
    expect(stderr()).toBe('')
    expect(requested).toEqual([])
    const created = github.requests().find(request => request.type === 'rest' && request.method === 'POST')
    const sent = created?.type === 'rest' && isRecord(created.body) ? created.body : {}
    expect(sent['title']).toBe('GitHub の Issue の機能に差がある: 1 件増・0 件減')
    const body = typeof sent['body'] === 'string' ? sent['body'] : ''
    expect(body).toContain(`- \`${ADDED}\``)
    expect(body).toContain(`- SDL: ${sources.sdl}\n- OpenAPI: ${sources.openapi}\n- REST の版: ${DEFAULT_API_VERSION}`)
    expect(body.endsWith(`\n${MARKER}\n`)).toBe(true)
  })

  it('作った Issue のボードの列を書けないと、created を出した後に error の行を出して 1 で止まる', async () => {
    const rules = boardRules(12, { onlyIfEmpty: false }).filter(rule => rule.match.operation !== 'UpdateProjectItemField')
    await startGithub([
      openIssues([]),
      { match: { method: 'POST', path: ISSUES_PATH }, respond: { status: 201, body: { number: 12, html_url: 'https://github.com/acme/demo/issues/12' } }, times: 1 },
      ...rules,
      { match: { operation: 'UpdateProjectItemField', variables: { fieldId: WORKFLOW_FIELD } }, respond: { status: 200, body: { errors: [{ message: 'boom' }] } }, times: 1 },
    ])
    const { io, stdout, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stdout()).toBe('created: https://github.com/acme/demo/issues/12\n')
    expect(stderr()).toMatch(/^error: could not set status backlog of Tracker #12: /u)
  })

  it('差があり、開いた差の Issue の印が同じだと、書き込まずに unchanged を出す', async () => {
    const github = await startGithub([openIssues([{ number: 5, body: `本文\n\n${MARKER}\n` }])])
    const { io, stdout } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(0)
    expect(stdout()).toBe('unchanged: #5\n')
    expect(writes(github.requests())).toEqual([])
  })

  it('差があり、開いた差の Issue の印が違うと、その Issue の題と本文を書き直し、updated を出す', async () => {
    const github = await startGithub([
      openIssues([{ number: 5, body: `本文\n\n${MARKER}\n` }]),
      { match: { method: 'PATCH', path: `${ISSUES_PATH}/5` }, respond: { status: 200, body: { number: 5 } }, times: 1 },
    ])
    const { io, stdout } = capture()
    const argv = argvOf(writeSources([...CHANGED, ADDED_B]))
    expect(await run(argv, io)).toBe(0)
    expect(stdout()).toBe('updated: #5\n')
    const [patched] = writes(github.requests())
    expect(patched).toMatchObject({ method: 'PATCH', path: `${ISSUES_PATH}/5`, body: { title: 'GitHub の Issue の機能に差がある: 2 件増・0 件減' } })
    expect(JSON.stringify(patched)).toContain(OTHER_MARKER)
  })

  it('開いた差の Issue が 2 件以上あると、番号の最も小さいものを使い、ほかを警告に挙げる', async () => {
    const github = await startGithub([openIssues([{ number: 9, body: OTHER_MARKER }, { number: 5, body: MARKER }, { number: 7, body: MARKER }])])
    const { io, stdout, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(0)
    expect(stdout()).toBe('unchanged: #5\n')
    expect(stderr()).toBe('warning: multiple open issue surface Issues; using #5 (lowest number) and leaving #7, #9 open\n')
    expect(writes(github.requests())).toEqual([])
  })

  it('--dry-run で作るときは、書き込まずに題・本文・印を出し、最後の行を would create にする', async () => {
    const github = await startGithub([openIssues([])])
    const { io, stdout } = capture()
    const argv = argvOf(writeSources(CHANGED), '--dry-run')
    expect(await run(argv, io)).toBe(0)
    const lines = stdout().split('\n')
    expect(lines.slice(0, 2)).toEqual(['title: GitHub の Issue の機能に差がある: 1 件増・0 件減', 'body:'])
    expect(stdout()).toContain(`- \`${ADDED}\``)
    expect(lines.slice(-3)).toEqual([MARKER, 'would create', ''])
    expect(writes(github.requests())).toEqual([])
  })

  it('--dry-run で書き直すときは、書き込まずに新しい題・本文・印を出し、最後の行を would update にする', async () => {
    const github = await startGithub([openIssues([{ number: 5, body: MARKER }])])
    const { io, stdout } = capture()
    const argv = argvOf(writeSources([...CHANGED, ADDED_B]), '--dry-run')
    expect(await run(argv, io)).toBe(0)
    const lines = stdout().split('\n')
    expect(lines[0]).toBe('title: GitHub の Issue の機能に差がある: 2 件増・0 件減')
    expect(lines.slice(-3)).toEqual([OTHER_MARKER, 'would update #5', ''])
    expect(writes(github.requests())).toEqual([])
  })

  it('作るときにボードの設定が見つからないと、Issue を作らずに error の行を出して 1 で止まる', async () => {
    setUpProject({ host: 'github.com', repositories: ['other'] })
    const github = await startGithub([openIssues([])])
    const { io, stdout, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/^error: /u)
    expect(writes(github.requests())).toEqual([])
  })
})
