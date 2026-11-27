// github-ops の repo-settings・workflow-doctor・release-create を確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory, writeTree } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'
import type { ResponseRule } from '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../../_helpers/explains.js'
import { verifies } from '../../_helpers/verifies.js'
import { restRule } from '../../_helpers/github-rules.js'
import { runOperation, SHA } from '../../_helpers/github-ops-case.js'

useIsolatedEnvironment()

const REPO = '/repos/acme/demo'
const TEMPLATES = path.join(import.meta.dirname, '../../../templates')
// 雛形の版はリリースで上がるので、actions/package.json の版から求める
const RELEASE_TAG = `pecot-actions/v${/"version": "([^"]+)"/u.exec(readFileSync(path.join(import.meta.dirname, '../../../package.json'), 'utf8'))?.[1] ?? ''}`
const absent = (name: string): Record<string, unknown> => ({ path: `.github/workflows/${name}`, present: false })

const settingRules = (secrets: readonly string[], variables: readonly string[]): ResponseRule[] => [
  restRule('GET', REPO, 200, { default_branch: 'main', owner: { type: 'User' } }),
  restRule('GET', `${REPO}/actions/secrets`, 200, { total_count: secrets.length, secrets: secrets.map(name => ({ name })) }),
  restRule('GET', `${REPO}/actions/variables`, 200, { total_count: variables.length, variables: variables.map(name => ({ name, value: `${name}-value` })) }),
]

describe('github ops', () => {
  it('repo-settings は、マージ後にブランチを消す設定・既定のブランチ・持ち主の種類を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-12')
    await explains('`repo-settings` のテストです。リポの設定を読み、`delete_branch_on_merge`・既定のブランチ・持ち主の種類を、GitHub が返した値のまま返すことを確認します。')
    const result = await runOperation('repo-settings', {}, [restRule('GET', REPO, 200, { default_branch: 'trunk', delete_branch_on_merge: false, owner: { type: 'User' } })])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ delete_branch_on_merge: false, default_branch: 'trunk', owner_type: 'User' })
  })

  it('repo-settings で delete_branch_on_merge が返らないと、値の無い成功にせず github-auth を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-12')
    await explains('`repo-settings` の権限の不足のテストです。token に `contents: write` が無く、応答が `delete_branch_on_merge` を含まない場合に、成功にせず `github-auth` を返すことを確認します。')
    const result = await runOperation('repo-settings', {}, [restRule('GET', REPO, 200, { default_branch: 'main', owner: { type: 'User' } })])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-auth' } })
  })

  it('workflow-doctor は、secret と variable の名前と、置いたワークフローの雛形の目印を返し、値を返さない', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-13')
    await explains('`workflow-doctor` のテストです。secret と variable の名前を名前順で返し、checkout したワークフローの雛形の名前と action の参照を返すことを確認します。variable の値は返しません。')
    const workspace = makeTemporaryDirectory('github-ops-')
    writeTree(workspace, { '.github/workflows/pecot-board-sync.yml': readFileSync(path.join(TEMPLATES, 'pecot-board-sync.yml'), 'utf8') })
    const result = await runOperation('workflow-doctor', {}, settingRules(['ZED', 'ALPHA'], ['PECOT_PROJECT']), { environment: { GITHUB_WORKSPACE: workspace } })
    expect(result.code).toBe(0)
    expect(result.result).toEqual({
      secrets: { names: ['ALPHA', 'ZED'], complete: true },
      variables: { names: ['PECOT_PROJECT'], complete: true },
      workflows: [
        {
          path: '.github/workflows/pecot-board-sync.yml',
          present: true,
          template: 'board-sync',
          version: expect.any(Number),
          has_pecot_action_step: true,
          pecot_actions: [{ action: 'session-finish', tag: RELEASE_TAG }, { action: 'board-sync', tag: RELEASE_TAG }],
          npx_lines: [],
        },
        absent('pecot-review.yml'),
        absent('pecot-handoff.yml'),
        absent('pecot-auto.yml'),
        absent('pecot-github-ops.yml'),
      ],
    })
    expect(result.stdout).not.toContain('PECOT_PROJECT-value')
  })

  it('workflow-doctor で secret の一覧が読めないと、読めた名前を返し、complete を false にする', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-13')
    await explains('`workflow-doctor` の権限の不足のテストです。secret の一覧が 403 で読めない場合に、失敗にせず、secret の `complete` を false にして返すことを確認します。')
    const rules = [
      restRule('GET', REPO, 200, { default_branch: 'main', owner: { type: 'User' } }),
      restRule('GET', `${REPO}/actions/secrets`, 403, { message: 'Resource not accessible by integration' }),
      restRule('GET', `${REPO}/actions/variables`, 200, { total_count: 0, variables: [] }),
    ]
    const result = await runOperation('workflow-doctor', {}, rules, { environment: { GITHUB_WORKSPACE: makeTemporaryDirectory('github-ops-') } })
    expect(result.code).toBe(0)
    expect(result.result).toMatchObject({ secrets: { names: [], complete: false }, variables: { names: [], complete: true } })
  })

  it('release-create は、渡したタグ・commit・本文でリリースを作り、id とタグと URL を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-14')
    await explains('`release-create` のテストです。タグ・commit・本文を指定した場合に、その値でリリースを作成し、名前を省いたときはタグを名前に使い、`id`・タグ・URL を返すことを確認します。')
    const created = restRule('POST', `${REPO}/releases`, 201, { id: 9, tag_name: 'v1.2.0', html_url: 'https://github.com/acme/demo/releases/tag/v1.2.0' })
    const result = await runOperation('release-create', { tag: 'v1.2.0', sha: SHA, body: '## Changes\n\n- one' }, [created])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ id: 9, tag: 'v1.2.0', url: 'https://github.com/acme/demo/releases/tag/v1.2.0' })
    expect(result.github.requests()).toMatchObject([{ type: 'rest', method: 'POST', body: { tag_name: 'v1.2.0', name: 'v1.2.0', body: '## Changes\n\n- one', target_commitish: SHA, draft: false, prerelease: false } }])
  })

  it('release-create で sha が 40 桁の commit でないと、GitHub を呼ばずに invalid-input を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-14')
    await explains('`release-create` の入力のテストです。`sha` にブランチ名や短い commit を指定した場合に、リリースを作成せず、`invalid-input` を返すことを確認します。')
    const result = await runOperation('release-create', { tag: 'v1.2.0', sha: 'main', body: '' }, [])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
  })
})
