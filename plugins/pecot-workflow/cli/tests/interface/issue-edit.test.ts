/* eslint-disable unicorn/no-null -- JSON の null を確かめる */
import { describe, expect, it } from 'vitest'

import { ISSUE_EDIT_TOOLS } from '../../src/commands/issue-edit.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { boardValue, connectionPage, definitionsData, issueAttributesData, issueFieldsProbeRule } from '../_helpers/attributes.js'
import type { DefinitionsSpec, IssueAttributesSpec } from '../_helpers/attributes.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const AREA_CLI = boardValue('ProjectV2ItemFieldSingleSelectValue', 'Area', 'SINGLE_SELECT', { name: 'cli' })

function valuesRule(data: Readonly<Record<string, unknown>>): ResponseRule {
  return { match: { operation: 'GetIssueAttributes', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data } }, times: 1 }
}

function definitionsRule(body: unknown): ResponseRule {
  return { match: { operation: 'GetIssueAttributeDefinitions', variables: { owner: 'acme', repo: 'demo', projectId: 'PVT_1' } }, respond: { status: 200, body }, times: 1 }
}

/**
今の値と定義を読む 3 つの要求の応答。既定の Issue は、ボードの Area が cli で、ほかの値が無い
*/
function readRules(values?: Readonly<IssueAttributesSpec>, definitions: Readonly<DefinitionsSpec> = {}): readonly ResponseRule[] {
  return [issueFieldsProbeRule(true, 2), valuesRule(issueAttributesData(values ?? { fieldValues: [AREA_CLI] })), definitionsRule({ data: definitionsData(definitions) })]
}

function assignable(login: string, status = 204): ResponseRule {
  return { match: { method: 'GET', path: `/repos/acme/demo/assignees/${login}` }, respond: { status }, times: 1 }
}

function patched(body: Readonly<Record<string, unknown>>): ResponseRule {
  return { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 200, body: { number: 7, assignees: [], labels: [], milestone: null, type: null, ...body } }, times: 1 }
}

function fieldValuesAdded(status = 200): ResponseRule {
  const body = status === 200 ? [] : { message: 'Resource not accessible by integration' }
  return { match: { method: 'POST', path: '/repos/acme/demo/issues/7/issue-field-values' }, respond: { status, body }, times: 1 }
}

function fieldValueDeleted(status = 204): ResponseRule {
  const respond = status === 204 ? { status } : { status, body: { message: 'Not Found' } }
  return { match: { method: 'DELETE', path: `/repos/acme/demo/issues/7/issue-field-values/103` }, respond, times: 1 }
}

function boardWritten(times = 1): ResponseRule {
  return { match: { operation: 'UpdateProjectItemFieldValue' }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } } }, times }
}

function boardCleared(): ResponseRule {
  return { match: { operation: 'ClearProjectItemField' }, respond: { status: 200, body: { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } } }, times: 1 }
}

async function edit(attributes: readonly unknown[]): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_EDIT_TOOLS, 'issue_edit', { issue_ref: 'acme/demo/7', attributes })
}

function writesOf(github: Readonly<RunningGithub>): readonly RecordedRequest[] {
  return github.requests().filter(request => request.type === 'rest' ? request.method !== 'GET' : request.operation === 'UpdateProjectItemFieldValue' || request.operation === 'ClearProjectItemField')
}

describe('issue_edit', () => {
  describe('書く', () => {
    it('attributes を渡すと、変えた値を Markdown の箇条書きで標準出力に出し、変えた機能を set の行に出す', async () => {
      await explains('`issue_edit` の基本の動作のテストです。`attributes` を渡した場合に、変えた値を Markdown の箇条書きで標準出力へ出力し、変えた機能を `set` の行として出力することを確認します。')
      setUpProject()
      await startGithub([...readRules(), boardWritten()])

      const result = await runInProcess('issue_edit', { issue_ref: 'acme/demo/7', attributes: [{ name: 'Area', value: 'docs' }] }, ISSUE_EDIT_TOOLS)

      expect(result).toEqual({ code: 0, stdout: '- Area: cli -> docs\n', stderr: 'set: Issue acme/demo/7 Area\n' })
    })

    it('attributes に値を渡すと、名前で引いた機能に値を書き、changed に前と後の値を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-01')
      await verifies(context, 'PW-ISSUE-EDIT-04')
      await explains('MCP ツール `issue_edit` の基本の動作のテストです。`attributes` に値を渡した場合に、名前で選んだ機能へ値を書き、`changed` に変更前と変更後の値を返すことを確認します。')
      setUpProject()
      const github = await startGithub([
        ...readRules(),
        assignable('octocat'),
        patched({ assignees: [{ login: 'octocat' }], milestone: { title: 'v1', number: 3 }, type: { name: 'Bug' } }),
        fieldValuesAdded(),
        boardWritten(2),
      ])

      const outcome = await edit([
        { name: 'Area', value: 'docs' },
        { name: 'Sprint', value: '2026-11-16' },
        { name: 'Effort', value: 3 },
        { name: 'type', value: 'Bug' },
        { name: 'assignees', value: ['octocat'] },
        { name: 'milestone', value: 'v1' },
      ])

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toStrictEqual({
        changed: [
          { name: 'type', source: 'issue', before: null, after: 'Bug' },
          { name: 'assignees', source: 'issue', before: null, after: ['octocat'] },
          { name: 'milestone', source: 'issue', before: null, after: 'v1' },
          { name: 'Effort', source: 'issue_field', before: null, after: 3 },
          { name: 'Area', source: 'project', before: 'cli', after: 'docs' },
          { name: 'Sprint', source: 'project', before: null, after: 'Sprint 2' },
        ],
        errors: [],
        failed: [],
      })
      expect(writesOf(github)).toMatchObject([
        { type: 'rest', method: 'PATCH', body: { type: 'Bug', assignees: ['octocat'], milestone: 3 } },
        { type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/issue-field-values', body: { issue_field_values: [{ field_id: 103, value: 3 }] } },
        { type: 'graphql', variables: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_area', value: { singleSelectOptionId: 'O_docs' } } },
        { type: 'graphql', variables: { fieldId: 'F_sprint', value: { iterationId: 'I_2' } } },
      ])
    })

    it('value に null を渡すと、その機能の値を外し、changed の after を null にする', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-02')
      await explains('MCP ツール `issue_edit` の値を外すテストです。`value` に `null` を渡した場合に、その機能の値を外し、`changed` の `after` を `null` で返すことを確認します。')
      setUpProject()
      const issueFieldValues = [{ __typename: 'IssueFieldNumberValue', field: { name: 'Effort', dataType: 'NUMBER' }, numberValue: 5 }]
      const github = await startGithub([...readRules({ fieldValues: [AREA_CLI], milestone: 'v1', issueFieldValues }), patched({}), fieldValueDeleted(), boardCleared()])

      const outcome = await edit([{ name: 'Area', value: null }, { name: 'Effort', value: null }, { name: 'milestone', value: null }])

      expect(outcome.structured).toStrictEqual({
        changed: [
          { name: 'milestone', source: 'issue', before: 'v1', after: null },
          { name: 'Effort', source: 'issue_field', before: 5, after: null },
          { name: 'Area', source: 'project', before: 'cli', after: null },
        ],
        errors: [],
        failed: [],
      })
      expect(writesOf(github)).toMatchObject([
        { type: 'rest', method: 'PATCH', body: { milestone: null } },
        { type: 'rest', method: 'DELETE' },
        { type: 'graphql', operation: 'ClearProjectItemField', variables: { fieldId: 'F_area' } },
      ])
    })

    it('外す Issue field の値が書く前に消えていると、DELETE の 404 を変化なしとして changed に入れない', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-02')
      await explains('MCP ツール `issue_edit` の Issue field の値を外すテストです。外す値が書き込みの前に消えていて `DELETE` が 404 を返した場合に、変化なしとして扱い、`changed` に入れないことを確認します。')
      setUpProject()
      const issueFieldValues = [{ __typename: 'IssueFieldNumberValue', field: { name: 'Effort', dataType: 'NUMBER' }, numberValue: 5 }]
      await startGithub([...readRules({ fieldValues: [AREA_CLI], issueFieldValues }), fieldValueDeleted(404)])

      const outcome = await edit([{ name: 'Effort', value: null }])

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toStrictEqual({ changed: [], errors: [], failed: [] })
    })

    it('今の値と同じ値を渡すと、書かずに、changed にも入れない。ラベルは順序が違っても同じ値として扱う', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-03')
      await explains('MCP ツール `issue_edit` の変更なしのテストです。今の値と同じ値を渡した場合に、何も書かず、`changed` にも入れず、ラベルは並びが違っても同じ値として扱うことを確認します。')
      setUpProject()
      const definitions = { labels: connectionPage([{ name: 'bug' }, { name: 'docs' }]) }
      const github = await startGithub(readRules({ fieldValues: [AREA_CLI], labels: ['bug', 'docs'] }, definitions))

      const outcome = await edit([{ name: 'Area', value: 'cli' }, { name: 'labels', value: ['docs', 'bug'] }])

      expect(outcome.structured).toStrictEqual({ changed: [], errors: [], failed: [] })
      expect(writesOf(github)).toStrictEqual([])
    })
  })

  describe('検証して止める', () => {
    it('値が 1 つでも定義に合わないと、何も書かずに、合わないものをすべて errors に入れて invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-05')
      await verifies(context, 'PW-ISSUE-EDIT-06')
      await verifies(context, 'PW-ISSUE-EDIT-09')
      await explains('MCP ツール `issue_edit` の値の検証のテストです。定義に合わない値が 1 つでもある場合に、何も書かず、合わない値をすべて `errors` に入れて `kind` が `invalid-input` の失敗を返すことを確認します。')
      setUpProject()
      const github = await startGithub([...readRules(), assignable('ghost', 404)])

      const outcome = await edit([
        { name: 'Area', value: 'docs' },
        { name: 'Effort', value: 'big' },
        { name: 'Aera', value: 'cli' },
        { name: 'assignees', value: ['ghost'] },
      ])

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['errors']).toMatchObject([
        { code: 'invalid_value', name: 'Effort', source: 'issue_field', value: 'big' },
        { code: 'unknown_attribute', name: 'Aera', candidates: ['Area'] },
        { code: 'invalid_value', name: 'assignees', source: 'issue', value: ['ghost'] },
      ])
      expect(writesOf(github)).toStrictEqual([])
    })

    it('同じ名前が複数の source にあり source を渡していないと、ambiguous_attribute にし、候補の source を sources に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-07')
      await explains('MCP ツール `issue_edit` の機能の名前の検証のテストです。同じ名前が複数の source にあり source を渡していない場合に、`ambiguous_attribute` を返し、候補の source を `sources` に入れることを確認します。')
      setUpProject()
      const fields = [{ id: 'F_effort', name: 'Effort', dataType: 'NUMBER', isIssueField: false }]
      await startGithub(readRules({}, { fields }))

      const outcome = await edit([{ name: 'Effort', value: 3 }])

      expect(outcome.structured['errors']).toMatchObject([{ code: 'ambiguous_attribute', name: 'Effort', sources: ['project', 'issue_field'] }])
    })

    it.for([
      { name: '進行の欄', attribute: 'pecot-workflow-acme', value: 'Ready' },
      { name: '組み込みの Status', attribute: 'Status', value: 'Done' },
    ])('$name を渡すと、read_only_attribute にし、board_move を使うよう hint に入れる', async ({ attribute, value }, context) => {
      await verifies(context, 'PW-ISSUE-EDIT-08')
      await explains('MCP ツール `issue_edit` の読み取り専用の機能のテストです。進行の欄と組み込みの `Status` を渡した場合に、`read_only_attribute` を返し、`board_move` の使用を `hint` で案内することを確認します。')
      setUpProject()
      await startGithub(readRules())

      const outcome = await edit([{ name: attribute, value }])

      expect(outcome.structured['errors']).toMatchObject([{ code: 'read_only_attribute', name: attribute, source: 'project' }])
      expect(JSON.stringify(outcome.structured['errors'])).toContain('board_move')
    })

    it('Issue が設定のボードに存在しないのにボードのフィールドを渡すと、not_on_board にし、board_add を使うよう hint に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-10')
      await explains('MCP ツール `issue_edit` のボードのフィールドのテストです。設定のボードが Issue を持たない場合に、`not_on_board` を返し、`board_add` の使用を `hint` で案内することを確認します。')
      setUpProject()
      await startGithub(readRules({ isOnBoard: false }))

      const outcome = await edit([{ name: 'Area', value: 'docs' }])

      expect(outcome.structured['errors']).toMatchObject([{ code: 'not_on_board', name: 'Area', source: 'project' }])
      expect(JSON.stringify(outcome.structured['errors'])).toContain('board_add')
    })

    it('機能の定義を読めなかった source の名前を渡すと、unreadable_attribute にし、読めなかった理由を hint に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-11')
      await explains('MCP ツール `issue_edit` の機能の定義のテストです。定義を読めなかった source の名前を渡した場合に、`unreadable_attribute` を返し、読めなかった理由を `hint` に入れることを確認します。')
      setUpProject()
      const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issueFields'], message: 'Resource not accessible by integration' }]
      await startGithub([issueFieldsProbeRule(true, 2), valuesRule(issueAttributesData()), definitionsRule({ data: definitionsData({ issueFields: null }), errors })])

      const outcome = await edit([{ name: 'Effort', value: 3 }])

      expect(outcome.structured['errors']).toMatchObject([{ code: 'unreadable_attribute', name: 'Effort', source: 'issue_field' }])
      expect(JSON.stringify(outcome.structured['errors'])).toContain('Resource not accessible by integration')
    })
  })

  describe('書けなかった機能', () => {
    it('Issue fields の書き込みを GitHub が拒むと、ほかの機能を書き続け、GitHub の理由を failed に入れて partial-failure の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-12')
      await explains('MCP ツール `issue_edit` の Issue fields の書き込みが失敗した場合のテストです。GitHub が書き込みを拒んだ場合に、ほかの機能は書き続け、GitHub の理由を `failed` に入れて `partial-failure` の失敗を返すことを確認します。')
      setUpProject()
      const github = await startGithub([...readRules(), fieldValuesAdded(403), boardWritten()])

      const outcome = await edit([{ name: 'Effort', value: 3 }, { name: 'Area', value: 'docs' }])

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({
        kind: 'partial-failure',
        changed: [{ name: 'Area', source: 'project', before: 'cli', after: 'docs' }],
        failed: [{ name: 'Effort', source: 'issue_field' }],
      })
      expect(JSON.stringify(outcome.structured['failed'])).toContain('Resource not accessible by integration')
      expect(writesOf(github)).toHaveLength(2)
    })

    it('GitHub が組み込みの機能の値を捨てると、その機能を failed に入れて partial-failure の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-13')
      await explains('MCP ツール `issue_edit` の組み込みの機能の書き込みのテストです。GitHub が値を捨てた場合に、その機能を `failed` に入れて `partial-failure` の失敗を返すことを確認します。')
      setUpProject()
      await startGithub([...readRules(), patched({})])

      const outcome = await edit([{ name: 'type', value: 'Bug' }])

      expect(outcome.structured).toMatchObject({
        kind: 'partial-failure',
        changed: [],
        failed: [{ name: 'type', source: 'issue', reason: 'GitHub dropped the value (writing it needs push access to the repository)' }],
      })
    })
  })

  describe('失敗', () => {
    it('対象のリポを含む設定が存在しないと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-14')
      await explains('MCP ツール `issue_edit` のプロジェクトの登録を検証するテストです。対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      setUpProject({ repositories: ['other'] })

      const outcome = await edit([{ name: 'Area', value: 'docs' }])

      expect(outcome.structured['kind']).toBe('repo-not-in-project')
    })

    it('GitHub API がエラーを返すと、kind が github-api の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-EDIT-15')
      await explains('MCP ツール `issue_edit` の GitHub API のエラーのテストです。GitHub API がエラーを返した場合に、`kind` が `github-api` の失敗を返すことを確認します。')
      setUpProject()
      await startGithub([issueFieldsProbeRule(), { match: { operation: 'GetIssueAttributes' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await edit([{ name: 'Area', value: 'docs' }])

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not edit the attributes of Issue acme\/demo\/7: /u)
    })
  })
})
