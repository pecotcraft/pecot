/* eslint-disable unicorn/no-null -- JSON の null を確かめる */
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_TOOLS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import type { RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { BOARD_FIELDS_WITH_LANE, definitionRules, definitionsData, issueFieldsProbeRule } from '../_helpers/attributes.js'
import { addedToProject, ISSUE_URL_BASE, issueNodeId, linkedRepositories, parentLane, rawFrontmatterFile, setUpIssueProject, subIssueAdded, TASK_BODY, updatedFields } from '../_helpers/issue-create-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const DIRECT = { title: '一覧に状態を出す', repo: 'acme/demo', message: TASK_BODY }

async function createTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_CREATE_TOOLS, 'issue_create', argumentsOfTool)
}

/**
起票の応答。values は応答の Issue に入れる組み込みの値
*/
function created(values: Readonly<Record<string, unknown>> = {}): ResponseRule {
  const body = { number: 12, node_id: 'I_kwDO12', html_url: `${ISSUE_URL_BASE}/12`, assignees: [], labels: [], milestone: null, type: null, ...values }
  return { match: { method: 'POST', path: '/repos/acme/demo/issues' }, respond: { status: 201, body }, times: 1 }
}

function assignable(login: string): ResponseRule {
  return { match: { method: 'GET', path: `/repos/acme/demo/assignees/${login}` }, respond: { status: 204 }, times: 1 }
}

function fieldValuesAdded(status = 200): ResponseRule {
  const body = status === 200 ? [] : { message: 'Resource not accessible by integration' }
  return { match: { method: 'POST', path: '/repos/acme/demo/issues/12/issue-field-values' }, respond: { status, body }, times: 1 }
}

function boardWritten(): ResponseRule {
  return { match: { operation: 'UpdateProjectItemFieldValue' }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } } }, times: 1 }
}

function attributeLines(...entries: readonly (readonly [string, string])[]): string[] {
  return ['attributes:', ...entries.flatMap(([name, value]) => [`  - name: ${name}`, `    value: ${value}`])]
}

function taskFile(title: string, ...extra: readonly string[]): string {
  return rawFrontmatterFile(['type: task', 'repository: acme/demo', `title: ${title}`, 'status: ready', ...extra])
}

function operations(github: Readonly<RunningGithub>): readonly string[] {
  return github.requests().map(request => request.type === 'rest' ? `${request.method} ${request.path}` : request.operation)
}

function issuePosts(github: Readonly<RunningGithub>): readonly RecordedRequest[] {
  return github.requests().filter(request => request.type === 'rest' && request.method === 'POST' && request.path === '/repos/acme/demo/issues')
}

function laneDefinitions(): readonly ResponseRule[] {
  return definitionRules({ fields: BOARD_FIELDS_WITH_LANE })
}

// ボードのフィールドへの書き込みの要求の variables
function laneWrites(github: Readonly<RunningGithub>): readonly unknown[] {
  return github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemFieldValue').map(request => request.type === 'graphql' ? request.variables : undefined)
}

function laneWrite(optionId: string): Record<string, unknown> {
  return { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_lane', value: { singleSelectOptionId: optionId } }
}

describe('issue_create', () => {
  describe('attributes', () => {
    it('attributes を付けて呼ぶと、組み込みを起票の要求で送り、Issue fields を起票の後で、ボードのフィールドをボードへ追加した後で書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-79')
      await explains('MCP ツール `issue_create` の `attributes` のテストです。`attributes` を付けた場合に、組み込みの機能は起票の要求で送り、Issue fields は起票の後で、ボードのフィールドはボードへ追加した後で書くことを確認します。')
      setUpIssueProject()
      const github = await startGithub([
        linkedRepositories(),
        ...definitionRules(),
        assignable('octocat'),
        created({ assignees: [{ login: 'octocat' }], milestone: { title: 'v1', number: 3 }, type: { name: 'Bug' } }),
        addedToProject(),
        updatedFields(1),
        fieldValuesAdded(),
        boardWritten(),
      ])

      const outcome = await createTool({
        ...DIRECT,
        attributes: [
          { name: 'Area', value: 'docs' },
          { name: 'Effort', value: 3 },
          { name: 'type', value: 'Bug' },
          { name: 'assignees', value: ['octocat'] },
          { name: 'milestone', value: 'v1' },
        ],
      })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toStrictEqual({ issues: [{ owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready' }] })
      expect(operations(github)).toStrictEqual([
        'GetLinkedRepositoriesUser',
        'HasIssueFields',
        'GetIssueAttributeDefinitions',
        'GET /repos/acme/demo/assignees/octocat',
        'POST /repos/acme/demo/issues',
        'AddToProject',
        'UpdateProjectItemField',
        'POST /repos/acme/demo/issues/12/issue-field-values',
        'UpdateProjectItemFieldValue',
      ])
      expect(issuePosts(github)).toMatchObject([{ body: { title: '[Task] 一覧に状態を出す', type: 'Bug', assignees: ['octocat'], milestone: 3 } }])
      expect(github.requests().at(-2)).toMatchObject({ body: { issue_field_values: [{ field_id: 103, value: 3 }] } })
      expect(github.requests().at(-1)).toMatchObject({ variables: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_area', value: { singleSelectOptionId: 'O_docs' } } })
    })

    it('フロントマターに attributes があると、そのファイルから作る Issue に値を書き、set の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-80')
      await explains('`issue_create` のフロントマターの `attributes` のテストです。フロントマターに `attributes` がある場合に、そのファイルから作る Issue へ値を書き、`set` の行として出力することを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...attributeLines(['Area', 'docs'], ['Effort', '3'])) })
      const github = await startGithub([linkedRepositories(), ...definitionRules(), created(), issueNodeId(12), addedToProject(), updatedFields(1), fieldValuesAdded(), boardWritten()])

      const result = await runInProcess('issue_create', { files: [path.join(project.root, 'a.md')] }, ISSUE_CREATE_TOOLS)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12 from a.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nset: Issue acme/demo/12 Effort, Area\n')
      expect(operations(github)).toContain('UpdateProjectItemFieldValue')
    })

    it('一括のファイルの値が 1 つでも定義に合わないと、どの Issue も作らずに、合わないものをすべて errors に入れて invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-81')
      await explains('MCP ツール `issue_create` の `files` の値の検証のテストです。一括のファイルの値が 1 つでも定義と合わない場合に、どの Issue も作らず、合わない値をすべて `errors` へ入れて `invalid-input` の失敗を返すことを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', ...attributeLines(['Area', 'docs'])),
        'b.md': taskFile('次', ...attributeLines(['Area', 'web'], ['Aera', 'cli'])),
      })
      const github = await startGithub([linkedRepositories(), ...definitionRules()])

      const outcome = await createTool({ files: [path.join(project.root, 'a.md'), path.join(project.root, 'b.md')] })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({
        kind: 'invalid-input',
        issues: [],
        errors: [
          { file: 'b.md', code: 'invalid_value', name: 'Area', source: 'project', value: 'web' },
          { file: 'b.md', code: 'unknown_attribute', name: 'Aera', candidates: ['Area'] },
        ],
      })
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('attributes を省いて呼ぶと、機能の定義を読まずに、今までと同じ要求で Issue を作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-82')
      await explains('MCP ツール `issue_create` の `attributes` を省いた場合のテストです。`attributes` を省いた場合に、機能の定義は読まず、従来と同じ要求で Issue を作ることを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), created(), addedToProject(), updatedFields(1)])

      const outcome = await createTool(DIRECT)

      expect(outcome.isError).toBe(false)
      expect(operations(github)).toStrictEqual(['GetLinkedRepositoriesUser', 'POST /repos/acme/demo/issues', 'AddToProject', 'UpdateProjectItemField'])
      expect(issuePosts(github).map(request => request.type === 'rest' ? request.body : undefined)).toStrictEqual([{ title: '[Task] 一覧に状態を出す', body: TASK_BODY }])
    })

    it('Issue fields と組み込みの機能を書けないと、その機能と理由を failed と warnings に入れ、ほかの機能を書いて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-83')
      await explains('MCP ツール `issue_create` の書き込みが失敗した場合のテストです。Issue fields や組み込みの機能を書けなかった場合に、その機能と理由を `failed` と `warnings` に入れ、ほかの機能は書いて成功を返すことを確認します。')
      setUpIssueProject()
      await startGithub([linkedRepositories(), ...definitionRules(), created(), addedToProject(), updatedFields(1), fieldValuesAdded(403), boardWritten()])

      const outcome = await createTool({ ...DIRECT, attributes: [{ name: 'Effort', value: 3 }, { name: 'type', value: 'Bug' }, { name: 'Area', value: 'docs' }] })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['failed']).toMatchObject([
        { issue: 'acme/demo/12', name: 'type', source: 'issue', reason: 'GitHub dropped the value (writing it needs push access to the repository)' },
        { issue: 'acme/demo/12', name: 'Effort', source: 'issue_field' },
      ])
      expect(JSON.stringify(outcome.structured['failed'])).toContain('Resource not accessible by integration')
      expect(outcome.structured['warnings']).toHaveLength(2)
    })

    it('label と attributes の labels を両方渡すと、Issue を作らずに、ambiguous_attribute を errors に入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-84')
      await explains('MCP ツール `issue_create` の `label` の検証のテストです。`label` と `attributes` の `labels` を両方渡した場合に、Issue は作らず、`ambiguous_attribute` を `errors` に入れて失敗を返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...definitionRules()])

      const outcome = await createTool({ ...DIRECT, label: ['bug'], attributes: [{ name: 'labels', value: ['bug'] }] })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'invalid-input', errors: [{ code: 'ambiguous_attribute', name: 'labels', source: 'issue' }] })
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('フロントマターに labels と attributes の labels を両方書くと、Issue を作らずに ambiguous_attribute を file 付きで返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-84')
      await explains('MCP ツール `issue_create` の `files` の検証のテストです。フロントマターで `labels` と `attributes` の `labels` を両方書いた場合に、Issue は作らず、`file` 付きの `ambiguous_attribute` を返すことを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', 'labels: [bug]', 'attributes:', '  - name: labels', '    value: [bug]') })
      const github = await startGithub([linkedRepositories(), ...definitionRules()])

      const outcome = await createTool({ files: [path.join(project.root, 'a.md')] })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'invalid-input', errors: [{ file: 'a.md', code: 'ambiguous_attribute', name: 'labels', source: 'issue' }] })
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('attributes を files と一緒に渡すと、invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-85')
      await explains('MCP ツール `issue_create` の引数の検証のテストです。`attributes` と `files` を両方渡した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭') })
      await startGithub([])

      const outcome = await createTool({ files: [path.join(project.root, 'a.md')], attributes: [{ name: 'Area', value: 'docs' }] })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })

    it('value が null の機能は、書き込まずに除く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-86')
      await explains('MCP ツール `issue_create` の `attributes` のテストです。`value` が `null` の機能を渡した場合に、書き込まずに除き、失敗にも入れないことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...definitionRules(), created(), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ ...DIRECT, attributes: [{ name: 'Area', value: null }, { name: 'milestone', value: null }] })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['failed']).toBeUndefined()
      expect(operations(github)).not.toContain('UpdateProjectItemFieldValue')
      expect(issuePosts(github)).toMatchObject([{ body: { title: '[Task] 一覧に状態を出す' } }])
      expect(JSON.stringify(issuePosts(github))).not.toContain('milestone')
    })
  })

  describe('lane', () => {
    const PARENT = { parent_epic: 'acme/demo/3' }

    it('lane を付けて呼ぶと、Issue を作り、ボードの pecot-lane にその値を書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-89')
      await explains('MCP ツール `issue_create` の `lane` のテストです。`lane` を付けた場合に、Issue を作り、ボードの `pecot-lane` にその値を書くことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...laneDefinitions(), created(), addedToProject(), updatedFields(1), boardWritten()])

      const outcome = await createTool({ ...DIRECT, lane: 'docs' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toStrictEqual({ issues: [{ owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready' }] })
      expect(laneWrites(github)).toMatchObject([laneWrite('O_lane_docs')])
    })

    it('lane が選択肢と大文字と小文字で違うと、Issue を作らずに、invalid_value と取りうる値を errors に入れて invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-89')
      await verifies(context, 'PW-ISSUE-CREATE-90')
      await explains('MCP ツール `issue_create` の `lane` の検証のテストです。`lane` が選択肢と大文字小文字だけ違う場合に、Issue は作らず、`invalid_value` と取りうる値を `errors` に入れて `invalid-input` の失敗を返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...laneDefinitions()])

      const outcome = await createTool({ ...DIRECT, lane: 'Docs' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'invalid-input', issues: [], errors: [{ code: 'invalid_value', name: 'pecot-lane', source: 'project', value: 'Docs', expected: 'one of: cli, docs' }] })
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('lane と attributes の pecot-lane を両方渡すと、Issue を作らずに、ambiguous_attribute を 1 件だけ errors に入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-91')
      await explains('MCP ツール `issue_create` の `lane` の検証のテストです。`lane` と `attributes` の `pecot-lane` を両方渡した場合に、Issue は作らず、`ambiguous_attribute` を 1 件だけ返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...laneDefinitions()])

      const outcome = await createTool({ ...DIRECT, lane: 'docs', attributes: [{ name: 'pecot-lane', value: 'cli' }] })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['errors']).toStrictEqual([{ code: 'ambiguous_attribute', name: 'pecot-lane', source: 'project', hint: 'the lane is given both as lane and as the pecot-lane attribute; give it in one place' }])
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('parent_epic を付けて lane を省くと、親の Epic の pecot-lane の値を書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-92')
      await explains('MCP ツール `issue_create` の `parent_epic` のテストです。`parent_epic` を付けて `lane` を省いた場合に、親の Epic の `pecot-lane` の値を書くことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentLane(3, 'cli'), ...laneDefinitions(), created(), addedToProject(), updatedFields(1), boardWritten(), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ ...DIRECT, ...PARENT })

      expect(outcome.isError).toBe(false)
      expect(github.requests().find(request => request.type === 'graphql' && request.operation === 'GetIssueLane')).toMatchObject({ variables: { owner: 'acme', repo: 'demo', number: 3, laneFieldName: 'pecot-lane' } })
      expect(laneWrites(github)).toMatchObject([laneWrite('O_lane_cli')])
    })

    it('Issue fields を読めないリポでも、親の Epic の値を引き継いで起票し、warnings に Issue fields の 1 行だけを入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-92')
      await explains('MCP ツール `issue_create` の Issue fields を読めない場合のテストです。Issue fields を読めないリポジトリでも、親の Epic の値を引き継いで起票し、`warnings` へ Issue fields の 1 行だけを入れることを確認します。')
      setUpIssueProject()
      const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issueFields'], message: 'Resource not accessible by integration' }]
      const unreadableIssueFields: ResponseRule = { match: { operation: 'GetIssueAttributeDefinitions' }, respond: { status: 200, body: { data: definitionsData({ fields: BOARD_FIELDS_WITH_LANE, issueFields: null }), errors } }, times: 1 }
      const github = await startGithub([linkedRepositories(), parentLane(3, 'cli'), issueFieldsProbeRule(), unreadableIssueFields, created(), addedToProject(), updatedFields(1), boardWritten(), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ ...DIRECT, ...PARENT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual(['could not read the Issue fields of acme/demo: Resource not accessible by integration'])
      expect(laneWrites(github)).toMatchObject([laneWrite('O_lane_cli')])
    })

    it('parent_epic と lane を付けると、親の値を読まずに lane の値を書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-92')
      await explains('MCP ツール `issue_create` の `lane` と `parent_epic` のテストです。`parent_epic` と `lane` を両方付けた場合に、親の値は読まず、`lane` の値を書くことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...laneDefinitions(), created(), addedToProject(), updatedFields(1), boardWritten(), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ ...DIRECT, ...PARENT, lane: 'docs' })

      expect(outcome.isError).toBe(false)
      expect(operations(github)).not.toContain('GetIssueLane')
      expect(laneWrites(github)).toMatchObject([laneWrite('O_lane_docs')])
    })

    it('親の Epic に pecot-lane の値が存在しないと、機能の定義を読まずに、pecot-lane を書かない', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-92')
      await explains('MCP ツール `issue_create` の `parent_epic` のテストです。親の Epic に `pecot-lane` の値が存在しない場合に、機能の定義は読まず、`pecot-lane` を書かないことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentLane(3), created(), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ ...DIRECT, ...PARENT })

      expect(outcome.isError).toBe(false)
      expect(operations(github)).not.toContain('GetIssueAttributeDefinitions')
      expect(laneWrites(github)).toStrictEqual([])
    })

    it('ボードに single select の pecot-lane が存在しないと、lane を書かずに Issue を作り、warnings に入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-93')
      await explains('MCP ツール `issue_create` の `lane` のテストです。ボードに single select の `pecot-lane` が存在しない場合に、`lane` は書かずに Issue を作り、理由を `warnings` に入れて成功を返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...definitionRules(), created(), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ ...DIRECT, lane: 'docs' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual(['the board has no single select field pecot-lane; Issues will be created without a lane'])
      expect(issuePosts(github)).toHaveLength(1)
      expect(laneWrites(github)).toStrictEqual([])
    })

    it('フロントマターに lane があると、そのファイルから作る Issue に値を書き、set の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-94')
      await explains('`issue_create` のフロントマターの `lane` のテストです。フロントマターに `lane` がある場合に、そのファイルから作る Issue へ値を書き、`set` の行として出力することを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', 'lane: docs') })
      const github = await startGithub([linkedRepositories(), ...laneDefinitions(), created(), issueNodeId(12), addedToProject(), updatedFields(1), boardWritten()])

      const result = await runInProcess('issue_create', { files: [path.join(project.root, 'a.md')] }, ISSUE_CREATE_TOOLS)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12 from a.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nset: Issue acme/demo/12 pecot-lane\n')
      expect(laneWrites(github)).toMatchObject([laneWrite('O_lane_docs')])
    })

    it('lane を files と一緒に渡すと、invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-95')
      await explains('MCP ツール `issue_create` の引数の検証のテストです。`lane` と `files` を両方渡した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭') })
      await startGithub([])

      const outcome = await createTool({ files: [path.join(project.root, 'a.md')], lane: 'docs' })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })
  })
})
