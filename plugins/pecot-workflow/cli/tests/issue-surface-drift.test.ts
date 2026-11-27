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
import { boardRules, createdTracker, issueListRule, WORKFLOW_FIELD } from '../../../../libs/workflow-core/tests/_helpers/tracker-rules.js'
import { explains } from './_helpers/explains.js'

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
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T12:00:00Z') })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.for([
    { name: '--repo を指定しない', argv: [] },
    { name: '--repo が owner/repo の形式でない', argv: ['--repo', 'acme'] },
    { name: '--repo の owner が空', argv: ['--repo', '/demo'] },
    { name: '未定義の引数を指定する', argv: ['--repo', 'acme/demo', '--out', 'x'] },
  ])('$name と、usage を出力して終了コード 2 で終了し、スキーマを取得しない', async ({ argv }) => {
    await explains('`--repo` の指定が不正な場合と、未定義の引数を指定した場合の、`drift.ts` のテストです。どの場合も、使い方（usage）を標準エラーに出力して終了コード 2 で終了し、スキーマを取得しないことを確認します。')
    const requested = recordFetch()
    const { io, stderr } = capture()
    expect(await run(argv, io)).toBe(2)
    expect(stderr()).toBe('error: usage: drift.ts --repo <owner/repo> [--sdl <file>] [--openapi <file>] [--dry-run]\n')
    expect(requested).toEqual([])
  })

  it('--sdl と --openapi を指定し、差がなく開いた Tracker も存在しないと、スキーマを取得せず、Tracker を作成しない', async () => {
    await explains('`--sdl` と `--openapi` にファイルを指定し、写しとの差がなく、開いた Tracker も存在しない場合のテストです。スキーマを取得せず、Tracker を作成せずに、`skipped: Tracker creation` を出力することを確認します。')
    const requested = recordFetch()
    const github = await startGithub([trackers()])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(SNAPSHOT.items))
    expect(await run(argv, io)).toBe(0)
    expect(stderr()).toBe('skipped: Tracker creation\n')
    expect(requested).toEqual([])
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--sdl だけを省略すると、SDL だけを公開スキーマから取得し、OpenAPI はファイルから読み込む', async () => {
    await explains('`--sdl` だけを省略して実行した場合のテストです。GraphQL の SDL だけを公開スキーマの URL から取得し、OpenAPI は指定したファイルから読み込むことを確認します。')
    const sources = writeSources(SNAPSHOT.items)
    const requested = recordFetch(new Map([[GRAPHQL_SCHEMA_URL, readFileSync(sources.sdl, 'utf8')]]))
    await startGithub([trackers()])
    const { io } = capture()
    expect(await run(['--repo', 'acme/demo', '--openapi', sources.openapi], io)).toBe(0)
    expect(requested).toEqual([GRAPHQL_SCHEMA_URL])
  })

  it('--openapi だけを省略すると、DEFAULT_API_VERSION の版の OpenAPI だけを取得する', async () => {
    await explains('`--openapi` だけを省略して実行した場合のテストです。`DEFAULT_API_VERSION` の版の OpenAPI だけを取得し、SDL は取得しないことを確認します。')
    const sources = writeSources(SNAPSHOT.items)
    const rest = restDescriptionUrl(DEFAULT_API_VERSION)
    const requested = recordFetch(new Map([[rest, readFileSync(sources.openapi, 'utf8')]]))
    await startGithub([trackers()])
    const { io } = capture()
    expect(await run(['--repo', 'acme/demo', '--sdl', sources.sdl], io)).toBe(0)
    expect(requested).toEqual([rest])
  })

  it('差があって開いた Tracker が存在しないと、ラベル付きの Tracker を作成してボードの Backlog に載せる', async () => {
    await explains('写しとの差があり、開いた Tracker が存在しない場合のテストです。ラベル付きの Tracker を、差の項目を本文に含めて作成し、`created: Tracker` の行を出力することを確認します。')
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

  it('作成した Tracker のボードの列を設定できないと、error の行を出力して終了コード 1 で終了する', async () => {
    await explains('作成した Tracker のボード上の Status を設定できない場合のテストです。`error: could not set status backlog of Tracker #12` を出力して、終了コード 1 で終了することを確認します。')
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

  it('差があり、開いた Tracker の本文の一覧が現在の差と同じだと、本文を更新せずに unchanged の行を出力する', async () => {
    await explains('開いた Tracker の本文に記載した差の一覧が、現在の差と同じ場合のテストです。本文を更新せず、`unchanged: Tracker #5` を出力することを確認します。')
    const sources = writeSources(CHANGED)
    const listing = trackers(trackerIssue(5, bodyOf(CHANGED, sources)))
    const github = await startGithub([listing, ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('unchanged: Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('差が変わると、開いた Tracker の本文の一覧の部分だけを書き換え、前後の文を残す', async () => {
    await explains('開いた Tracker の本文に人の追記を含む状態で、差の内容が変わった場合のテストです。差の一覧の部分だけを書き換え、追記した文を残して本文を更新することを確認します。')
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

  it('差がなくなると、開いた Tracker の本文の一覧を none に書き換えてから閉じる', async () => {
    await explains('写しとの差がなくなった場合のテストです。開いた Tracker の本文の一覧を `none` に書き換えてから、その Tracker を閉じることを確認します。')
    const sources = writeSources(SNAPSHOT.items)
    const existing = bodyOf(CHANGED, sources)
    const github = await startGithub([trackers(trackerIssue(5, existing)), patched({ body: bodyOf(SNAPSHOT.items, sources, existing) }), patched({ state: 'closed', state_reason: 'completed' })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('updated: Tracker #5 body\nclosed: Tracker #5\n')
    expect(restWrites(github.requests())).toHaveLength(2)
  })

  it('開いた Tracker が 2 件以上あると、番号が最も小さいものを対象にし、ほかを警告に挙げる', async () => {
    await explains('開いた Tracker が 3 件ある場合のテストです。番号が最も小さい `#5` を対象にし、ほかの `#7` と `#9` を開いたままにして、警告を出力することを確認します。')
    const sources = writeSources(CHANGED)
    const body = bodyOf(CHANGED, sources)
    const github = await startGithub([trackers(trackerIssue(9, body), trackerIssue(5, body), trackerIssue(7, body)), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources), io)).toBe(0)
    expect(stderr()).toBe('warning: multiple open Trackers; using #5 (lowest number) and leaving #7, #9 open\nunchanged: Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('開いた Tracker の本文で一覧の範囲を示すコメントが 1 組そろっていないと、書き込まずに error の行を出力して終了コード 1 で終了する', async () => {
    await explains('開いた Tracker の本文で、一覧の範囲を示すコメントが 1 組そろっていない場合のテストです。書き込みを行わずに、`error: Tracker #5: cannot rewrite the list` で始まる行を出力して、終了コード 1 で終了することを確認します。')
    const github = await startGithub([trackers(trackerIssue(5, '<!-- pecot-issue-surface: tracker -->\n'))])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: Tracker #5: cannot rewrite the list/u)
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--dry-run で作成するときは、書き込まずに作成の予定の行を出力する', async () => {
    await explains('`--dry-run` を指定して、Tracker を作成する場合のテストです。書き込みを行わず、`dry-run: would create Tracker` の行を出力することを確認します。')
    const github = await startGithub([trackers()])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED), '--dry-run')
    expect(await run(argv, io)).toBe(0)
    expect(stderr()).toBe(`dry-run: would create Tracker "${TITLE}"\n`)
    expect(restWrites(github.requests())).toEqual([])
  })

  it('--dry-run で差がなくなったときは、書き込まずに更新と閉じる予定の行を出力する', async () => {
    await explains('`--dry-run` を指定して、写しとの差がなくなった場合のテストです。書き込みを行わず、本文の更新と Tracker を閉じる予定の行を出力することを確認します。')
    const sources = writeSources(SNAPSHOT.items)
    const listing = trackers(trackerIssue(5, bodyOf(CHANGED, sources)))
    const github = await startGithub([listing])
    const { io, stderr } = capture()
    expect(await run(argvOf(sources, '--dry-run'), io)).toBe(0)
    expect(stderr()).toBe('dry-run: would update Tracker #5 body\ndry-run: would close Tracker #5\n')
    expect(restWrites(github.requests())).toEqual([])
  })

  it('Tracker を検索できないと、error の行を出力して終了コード 1 で終了する', async () => {
    await explains('Tracker の検索が失敗する（HTTP 500 を返す）場合のテストです。`error: Tracker:` で始まる行を出力して、終了コード 1 で終了することを確認します。')
    await startGithub([issueListRule(SURFACE_LABEL, [], 500)])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: Tracker: /u)
  })

  it('ボードの設定が見つからないと、Tracker を検索せずに error の行を出力して終了コード 1 で終了する', async () => {
    await explains('対象のリポジトリ（`acme/demo`）がボードの設定に存在しない場合のテストです。GitHub へ要求を送らず、`error:` で始まる行を出力して、終了コード 1 で終了することを確認します。')
    setUpProject({ host: 'github.com', repositories: ['other'] })
    const github = await startGithub([])
    const { io, stderr } = capture()
    const argv = argvOf(writeSources(CHANGED))
    expect(await run(argv, io)).toBe(1)
    expect(stderr()).toMatch(/^error: /u)
    expect(github.requests()).toEqual([])
  })
})
