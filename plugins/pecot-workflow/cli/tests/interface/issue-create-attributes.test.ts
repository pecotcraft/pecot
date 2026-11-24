/* eslint-disable unicorn/no-null -- JSON の null を確かめる */
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_COMMANDS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { writeTree } from '../../src/tests/_helpers/temporary.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { definitionRules } from '../_helpers/attributes.js'
import { addedToProject, ISSUE_URL_BASE, issueNodeId, linkedRepositories, rawFrontmatterFile, setUpIssueProject, TASK_BODY, updatedFields } from '../_helpers/issue-create-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const DIRECT = { title: '一覧に状態を出す', repo: 'acme/demo', message: TASK_BODY }

async function createTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_CREATE_COMMANDS, 'issue_create', argumentsOfTool)
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

describe('issue create', () => {
  describe('attributes', () => {
    it('attributes を付けて呼ぶと、組み込みを起票の要求で送り、Issue fields を起票の後で、ボードのフィールドをボードへ足した後で書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-79')
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
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...attributeLines(['Area', 'docs'], ['Effort', '3'])) })
      const github = await startGithub([linkedRepositories(), ...definitionRules(), created(), issueNodeId(12), addedToProject(), updatedFields(1), fieldValuesAdded(), boardWritten()])

      const result = await runInProcess(['issue', 'create', path.join(project.root, 'a.md')], ISSUE_CREATE_COMMANDS)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12 from a.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nset: Issue acme/demo/12 Effort, Area\n')
      expect(operations(github)).toContain('UpdateProjectItemFieldValue')
    })

    it('一括のファイルの値が 1 つでも定義に合わないと、どの Issue も作らずに、合わないものをすべて errors に入れて invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-81')
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
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), created(), addedToProject(), updatedFields(1)])

      const outcome = await createTool(DIRECT)

      expect(outcome.isError).toBe(false)
      expect(operations(github)).toStrictEqual(['GetLinkedRepositoriesUser', 'POST /repos/acme/demo/issues', 'AddToProject', 'UpdateProjectItemField'])
      expect(issuePosts(github).map(request => request.type === 'rest' ? request.body : undefined)).toStrictEqual([{ title: '[Task] 一覧に状態を出す', body: TASK_BODY }])
    })

    it('Issue fields と組み込みの機能を書けないと、その機能と理由を failed と warnings に入れ、ほかの機能を書いて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-83')
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
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), ...definitionRules()])

      const outcome = await createTool({ ...DIRECT, label: ['bug'], attributes: [{ name: 'labels', value: ['bug'] }] })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'invalid-input', errors: [{ code: 'ambiguous_attribute', name: 'labels', source: 'issue' }] })
      expect(issuePosts(github)).toStrictEqual([])
    })

    it('--attribute をファイルと一緒に渡すと、使い方の誤りで終了コード 2 を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-85')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭') })
      const github = await startGithub([])

      const result = await runInProcess(['issue', 'create', path.join(project.root, 'a.md'), '--attribute', '{"name":"Area","value":"docs"}'], ISSUE_CREATE_COMMANDS)

      expect(result.code).toBe(2)
      expect(result.stderr).toContain('cannot be used with')
      expect(github.requests()).toStrictEqual([])
    })

    it('value が null の機能は、書かずに飛ばす', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-86')
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
})
