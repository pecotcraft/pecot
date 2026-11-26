/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時ディレクトリのファイルだけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../scripts/github-surface/extract.js'
import type { CommandIo } from '../src/commands/registry.js'
import { issueSurfaceSchema } from '../src/domain/issue-surface.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import { GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../src/infra/github/issue-surface.js'
import { makeTemporaryDirectory } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'

const SDL = `
enum IssueFieldDataType { TEXT DATE }
input CreateIssueInput { title: String! }
`

const OPENAPI = { paths: { '/repos/{owner}/{repo}/issues': { post: { requestBody: { content: { 'application/json': { schema: { properties: { title: {}, body: {} } } } } } } } } }

function capture(): { io: CommandIo, out: string[], error: string[] } {
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
  return { io, out, error }
}

function stubSources(): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    return Promise.resolve(url === GRAPHQL_SCHEMA_URL ? new Response(SDL) : Response.json(OPENAPI))
  })
  return requested
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('extract.ts', () => {
  it.for([
    { name: '--out が無い', argv: [] },
    { name: '知らない引数がある', argv: ['--out', 'x.json', '--sdl', 'y'] },
  ])('$name と、usage を出して 2 で止まり、取りに行かない', async ({ argv }) => {
    const requested = stubSources()
    const { io, error } = capture()
    expect(await run(argv, io)).toBe(2)
    expect(error.join('')).toContain('usage: extract.ts --out <file> [--api-version <version>]')
    expect(requested).toEqual([])
  })

  it('--api-version が無いと、DEFAULT_API_VERSION の OpenAPI を取り、並べ替え済みの写しを書く', async () => {
    const requested = stubSources()
    const out = path.join(makeTemporaryDirectory(), 'surface.json')
    const { io } = capture()
    expect(await run(['--out', out], io)).toBe(0)
    expect(requested).toContain(restDescriptionUrl(DEFAULT_API_VERSION))
    const written = issueSurfaceSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    expect(written.sources.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(written).toEqual({
      sources: { graphql: GRAPHQL_SCHEMA_URL, rest: restDescriptionUrl(DEFAULT_API_VERSION), rest_api_version: DEFAULT_API_VERSION, fetched_at: written.sources.fetched_at },
      items: [
        'graphql:CreateIssueInput.title',
        'graphql:enum:IssueFieldDataType.DATE',
        'graphql:enum:IssueFieldDataType.TEXT',
        'rest:POST /repos/{owner}/{repo}/issues#body',
        'rest:POST /repos/{owner}/{repo}/issues#title',
      ],
    })
  })

  it('--api-version を渡すと、その版の OpenAPI を取り、写しの版に書く', async () => {
    const requested = stubSources()
    const out = path.join(makeTemporaryDirectory(), 'surface.json')
    const { io } = capture()
    expect(await run(['--out', out, '--api-version', '2026-03-10'], io)).toBe(0)
    expect(requested).toContain(restDescriptionUrl('2026-03-10'))
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ sources: { rest_api_version: '2026-03-10' } })
  })

  it('取りに行けないと、写しを書かずに例外を投げる', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 503, statusText: 'Service Unavailable' })))
    const out = path.join(makeTemporaryDirectory(), 'surface.json')
    await expect(run(['--out', out], capture().io)).rejects.toThrow(/failed: 503 Service Unavailable/u)
    expect(existsSync(out)).toBe(false)
  })
})
