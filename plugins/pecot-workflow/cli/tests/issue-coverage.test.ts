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
import { explains } from './_helpers/explains.js'

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
  it('写しの全項目が一覧にあり、supported の handler・tool が CLI にあり、excluded に理由がある', async () => {
    await explains('GitHub の Issue の機能の写しと、担保の一覧（`issue-coverage.yaml`）の整合性のテストです。現在の一覧を検証した結果、問題が 1 件も報告されないことを確認します。')
    expect(problemsOf(coverage)).toEqual([])
  })

  it('写しの REST の版が、pecot が REST に送る DEFAULT_API_VERSION と同じ', async () => {
    await explains('写しに記録した REST API の版のテストです。写しの `rest_api_version` が、pecot が REST の呼び出しに使う `DEFAULT_API_VERSION` と一致することを確認します。')
    expect(surface.sources.rest_api_version).toBe(DEFAULT_API_VERSION)
  })

  it('一覧から supported の項目を 1 つ消すと、その id を挙げて落ちる', async () => {
    await explains('一覧から項目を削除した場合の、検証エラーのテストです。`supported` の項目を 1 つ削除したときに、その id を挙げた `not in issue-coverage.yaml` のエラーだけが報告されることを確認します。')
    expect(firstSupported).toBeDefined()
    const id = firstSupported?.id ?? ''
    const changed = { items: coverage.items.filter(entry => entry.id !== id) }
    expect(problemsOf(changed)).toEqual([`${id}: not in issue-coverage.yaml`])
  })

  it('写しに存在しない id を一覧に追加すると、その id を挙げて落ちる', async () => {
    await explains('写しに存在しない項目を一覧へ追加した場合の、検証エラーのテストです。存在しない id を追加したときに、その id を挙げた `not in github-issue-surface.json` のエラーだけが報告されることを確認します。')
    const id = 'graphql:mutation:noSuchIssueMutation'
    const changed = { items: [...coverage.items, { id, status: 'excluded', reason: 'test' } satisfies IssueCoverage['items'][number]] }
    expect(problemsOf(changed)).toEqual([`${id}: not in github-issue-surface.json`])
  })

  it('excluded の項目の reason を消すと、その id を挙げて落ちる', async () => {
    await explains('`excluded` の項目から理由（`reason`）を削除した場合の、検証エラーのテストです。その id を挙げた `excluded needs a reason` のエラーだけが報告されることを確認します。')
    expect(firstExcluded).toBeDefined()
    const id = firstExcluded?.id ?? ''
    const changed = { items: coverage.items.map(entry => entry.id === id ? { id, status: entry.status } : entry) }
    expect(problemsOf(changed)).toEqual([`${id}: excluded needs a reason`])
  })
})
