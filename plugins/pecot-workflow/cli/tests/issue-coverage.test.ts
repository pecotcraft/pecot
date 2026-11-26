/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは interface/ の 2 つのファイルだけ */
// 写し（interface/github-issue-surface.json）の全項目が、担保の一覧（interface/issue-coverage.yaml）にあることを確かめる。
// 落ちたときの直し方は CONTRIBUTING.md の「4. GitHub の Issue の機能の写しと担保の一覧」
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { COMMANDS } from '../src/commands/registry.js'
import { ATTRIBUTE_HANDLERS } from '@pecot/workflow-core/domain/attributes.js'
import type { IssueCoverage } from '../src/domain/issue-surface.js'
import { checkIssueCoverage, issueCoverageSchema, issueSurfaceSchema } from '../src/domain/issue-surface.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'

const INTERFACE = path.resolve(import.meta.dirname, '../../interface')

function readInterface(name: string): string {
  return readFileSync(path.join(INTERFACE, name), 'utf8')
}

const surface = issueSurfaceSchema.parse(JSON.parse(readInterface('github-issue-surface.json')))
const coverage = issueCoverageSchema.parse(parseYaml(readInterface('issue-coverage.yaml')))

const HANDLERS = Object.keys(ATTRIBUTE_HANDLERS)
const TOOLS = COMMANDS.map(command => command.toolName)

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function problemsOf(changed: Readonly<IssueCoverage>): string[] {
  return checkIssueCoverage(surface.items, changed, HANDLERS, TOOLS)
}

const firstSupported = coverage.items.find(entry => entry.status === 'supported')
const firstExcluded = coverage.items.find(entry => entry.status === 'excluded')

describe('issue-coverage.yaml', () => {
  it('写しの全項目が一覧にあり、supported の handler・tool が CLI にあり、excluded に理由がある', () => {
    expect(problemsOf(coverage)).toEqual([])
  })

  it('写しの REST の版が、pecot が REST に送る DEFAULT_API_VERSION と同じ', () => {
    expect(surface.sources.rest_api_version).toBe(DEFAULT_API_VERSION)
  })

  it('一覧から supported の項目を 1 つ消すと、その id を挙げて落ちる', () => {
    expect(firstSupported).toBeDefined()
    const id = firstSupported?.id ?? ''
    const changed = { items: coverage.items.filter(entry => entry.id !== id) }
    expect(problemsOf(changed)).toEqual([`${id}: not in issue-coverage.yaml`])
  })

  it('写しに無い id を一覧に足すと、その id を挙げて落ちる', () => {
    const id = 'graphql:mutation:noSuchIssueMutation'
    const changed = { items: [...coverage.items, { id, status: 'excluded', reason: 'test' } satisfies IssueCoverage['items'][number]] }
    expect(problemsOf(changed)).toEqual([`${id}: not in github-issue-surface.json`])
  })

  it('excluded の項目の reason を消すと、その id を挙げて落ちる', () => {
    expect(firstExcluded).toBeDefined()
    const id = firstExcluded?.id ?? ''
    const changed = { items: coverage.items.map(entry => entry.id === id ? { id, status: entry.status } : entry) }
    expect(problemsOf(changed)).toEqual([`${id}: excluded needs a reason`])
  })
})
