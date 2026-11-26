/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
import { describe, expect, it } from 'vitest'

import { ISSUE_ATTRIBUTES_COMMANDS } from '../../src/commands/issue-attributes.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { connectionPage, definitionRules, definitionsData, issueFieldsProbeRule } from '../_helpers/attributes.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

// 作業ディレクトリの remote を acme/demo にする。テストを動かすリポの remote と食い違う警告を出さないため
function setUp(options: Readonly<{ repositories?: readonly string[] }> = {}): void {
  setUpProject(options)
  gitForTest(enterGitRepository(), ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
}

const REPOSITORY_ARGUMENTS: Readonly<Record<string, unknown>> = { repo: 'acme/demo' }

async function attributes(argumentsOfTool: Readonly<Record<string, unknown>> = REPOSITORY_ARGUMENTS): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_ATTRIBUTES_COMMANDS, 'issue_attributes', argumentsOfTool)
}

function pageWithMore(nodes: readonly unknown[], cursor: string): Record<string, unknown> {
  return { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function definitionList(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  const list: unknown = outcome.structured['attributes']
  return Array.isArray(list) ? list.filter(item => isRecord(item)) : []
}

function definitionsOf(outcome: Readonly<ToolOutcome>, source: string): readonly Readonly<Record<string, unknown>>[] {
  return definitionList(outcome).filter(item => item['source'] === source)
}

function operations(github: Readonly<RunningGithub>): readonly string[] {
  return github.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

function respond(operation: string, body: unknown): ResponseRule {
  return { match: { operation }, respond: { status: 200, body }, times: 1 }
}

const MARKDOWN = [
  '- Title (project, unsupported (TITLE))',
  '- Status (project, single_select, read-only): Todo, Done',
  '- pecot-workflow-acme (project, single_select, read-only): Ready',
  '- Area (project, single_select): cli, docs',
  '- Sprint (project, iteration): Sprint 2 (2026-11-16)',
  '- Priority (issue_field, single_select): High, Low',
  '- Effort (issue_field, number)',
  '- assignees (issue, users)',
  '- milestone (issue, milestone): v1',
  '- type (issue, issue_type): Bug, Task',
  '- labels (issue, labels): bug',
  '- parent (issue, issue_ref, read-only)',
  '- blocked_by (issue, issue_refs, read-only)',
  '',
].join('\n')

describe('issue attributes', () => {
  it('呼ぶと、機能の定義を 1 行ずつの Markdown の箇条書きで標準出力に出す', async () => {
    setUp()
    const github = await startGithub(definitionRules())

    const result = await runInProcess(['--repo', 'acme/demo', 'issue', 'attributes'], ISSUE_ATTRIBUTES_COMMANDS)

    expect(result).toEqual({ code: 0, stdout: MARKDOWN, stderr: '' })
    expect(github.requests()).toMatchObject([
      { operation: 'HasIssueFields' },
      { operation: 'GetIssueAttributeDefinitions', variables: { owner: 'acme', repo: 'demo', projectId: 'PVT_1' } },
    ])
  })

  it('--json を渡すと、MCP の結果と同じ attributes と unsupported を JSON で出す', async () => {
    setUp()
    await startGithub([...definitionRules(), ...definitionRules()])

    const result = await runInProcess(['--repo', 'acme/demo', 'issue', 'attributes', '--json'], ISSUE_ATTRIBUTES_COMMANDS)
    const outcome = await attributes()

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toStrictEqual(outcome.structured)
  })

  describe('MCP の呼び出し', () => {
    it('呼ぶと、ボードのフィールドを source が project の定義にし、選択肢と Iteration の開始日を options に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-01')
      setUp()
      await startGithub(definitionRules())

      const outcome = await attributes()

      expect(outcome.isError).toBe(false)
      expect(definitionsOf(outcome, 'project')).toStrictEqual([
        { name: 'Title', source: 'project', kind: 'unsupported', writable: false, unsupported_reason: 'TITLE' },
        { name: 'Status', source: 'project', kind: 'single_select', options: [{ name: 'Todo' }, { name: 'Done' }], writable: false },
        { name: 'pecot-workflow-acme', source: 'project', kind: 'single_select', options: [{ name: 'Ready' }], writable: false },
        { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli' }, { name: 'docs' }], writable: true },
        { name: 'Sprint', source: 'project', kind: 'iteration', options: [{ name: 'Sprint 2', start_date: '2026-11-16' }], writable: true },
      ])
    })

    it('呼ぶと、リポの Issue fields を source が issue_field の定義にする', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-02')
      setUp()
      await startGithub(definitionRules())

      const outcome = await attributes()

      expect(definitionsOf(outcome, 'issue_field')).toStrictEqual([
        { name: 'Priority', source: 'issue_field', kind: 'single_select', options: [{ name: 'High' }, { name: 'Low' }], writable: true },
        { name: 'Effort', source: 'issue_field', kind: 'number', writable: true },
      ])
    })

    it('呼ぶと、組み込みの機能を source が issue の定義にし、マイルストーン・Issue type・ラベルを options に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-03')
      setUp()
      await startGithub(definitionRules())

      const outcome = await attributes()

      expect(definitionsOf(outcome, 'issue')).toStrictEqual([
        { name: 'assignees', source: 'issue', kind: 'users', writable: true },
        { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1' }], writable: true },
        { name: 'type', source: 'issue', kind: 'issue_type', options: [{ name: 'Bug' }, { name: 'Task' }], writable: true },
        { name: 'labels', source: 'issue', kind: 'labels', options: [{ name: 'bug' }], writable: true },
        { name: 'parent', source: 'issue', kind: 'issue_ref', writable: false },
        { name: 'blocked_by', source: 'issue', kind: 'issue_refs', writable: false },
      ])
    })

    it('組み込みの機能を写すボードのフィールドと Issue field を写したボードのフィールドを、source が project の定義に入れない', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-04')
      setUp()
      await startGithub(definitionRules())

      const outcome = await attributes()

      const names = definitionsOf(outcome, 'project').map(item => item['name'])
      expect(names).not.toContain('Assignees')
      expect(names).not.toContain('Priority')
    })

    it('進行の欄・組み込みの Status・parent・blocked_by を、writable が false の定義にする', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-05')
      setUp()
      await startGithub(definitionRules())

      const outcome = await attributes()

      const readOnly = definitionList(outcome).filter(item => item['writable'] === false && item['kind'] !== 'unsupported').map(item => item['name'])
      expect(readOnly).toStrictEqual(['Status', 'pecot-workflow-acme', 'parent', 'blocked_by'])
    })

    it('GitHub が計算するフィールドと知らない種類のフィールドを、unsupported の定義にし、unsupported にも入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-06')
      setUp()
      const fields = [
        { id: 'F_progress', name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS', isIssueField: false },
        { id: 'F_people', name: 'Reviewer group', dataType: 'PEOPLE', isIssueField: false },
      ]
      await startGithub(definitionRules({ fields, issueFields: [{ name: 'Owner', dataType: 'USER' }] }))

      const outcome = await attributes()

      expect(outcome.structured['attributes']).toEqual(expect.arrayContaining([
        { name: 'Sub-issues progress', source: 'project', kind: 'unsupported', writable: false, unsupported_reason: 'SUB_ISSUES_PROGRESS' },
        { name: 'Reviewer group', source: 'project', kind: 'unsupported', writable: false, unsupported_reason: 'PEOPLE' },
        { name: 'Owner', source: 'issue_field', kind: 'unsupported', writable: false, unsupported_reason: 'USER' },
      ]))
      expect(outcome.structured['unsupported']).toStrictEqual([
        { name: 'Sub-issues progress', source: 'project', github_type: 'SUB_ISSUES_PROGRESS' },
        { name: 'Reviewer group', source: 'project', github_type: 'PEOPLE' },
        { name: 'Owner', source: 'issue_field', github_type: 'USER' },
      ])
    })

    it('Issue fields を読めない部分エラーでは、warnings に入れ、ほかの定義を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-07')
      setUp()
      const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issueFields'], message: 'Resource not accessible by integration' }]
      await startGithub([issueFieldsProbeRule(), respond('GetIssueAttributeDefinitions', { data: definitionsData({ issueFields: null }), errors })])

      const outcome = await attributes()

      expect(outcome.isError).toBe(false)
      expect(definitionsOf(outcome, 'issue_field')).toStrictEqual([])
      expect(definitionsOf(outcome, 'project')).not.toStrictEqual([])
      expect(outcome.structured['warnings']).toStrictEqual(['could not read the Issue fields of acme/demo: Resource not accessible by integration'])
    })

    it('ボードを読めない部分エラーでは、warnings に入れ、リポの定義を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-07')
      setUp()
      const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['project'], message: 'Your token has not been granted the required scopes' }]
      await startGithub([issueFieldsProbeRule(), respond('GetIssueAttributeDefinitions', { data: { ...definitionsData(), project: null }, errors })])

      const outcome = await attributes()

      expect(outcome.isError).toBe(false)
      expect(definitionsOf(outcome, 'project')).toStrictEqual([])
      expect(definitionsOf(outcome, 'issue')).not.toStrictEqual([])
      expect(outcome.structured['warnings']).toStrictEqual(['could not read the fields of the board: Your token has not been granted the required scopes'])
    })

    it('Issue fields の無い GitHub Enterprise Server では、Issue fields と type を除いた定義を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-08')
      setUp()
      const data = { project: { fields: connectionPage([]) }, repository: { labels: connectionPage([]), milestones: connectionPage([]) } }
      const github = await startGithub([issueFieldsProbeRule(false), respond('GetIssueAttributeDefinitionsWithoutIssueFields', { data })])

      const outcome = await attributes()

      expect(definitionList(outcome).map(item => item['name'])).toStrictEqual(['assignees', 'milestone', 'labels', 'parent', 'blocked_by'])
      expect(operations(github)).toStrictEqual(['HasIssueFields', 'GetIssueAttributeDefinitionsWithoutIssueFields'])
    })

    it('ラベルとマイルストーンに続きのページがあると、続きも読んで options に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-09')
      setUp()
      const github = await startGithub([
        ...definitionRules({ labels: pageWithMore([{ name: 'bug' }], 'L1'), milestones: pageWithMore([{ title: 'v1' }], 'M1') }),
        respond('GetRepositoryLabelsPage', { data: { repository: { labels: connectionPage([{ name: 'docs' }]) } } }),
        respond('GetRepositoryMilestonesPage', { data: { repository: { milestones: connectionPage([{ title: 'v2' }]) } } }),
      ])

      const outcome = await attributes()

      expect(definitionsOf(outcome, 'issue')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'labels', options: [{ name: 'bug' }, { name: 'docs' }] }),
        expect.objectContaining({ name: 'milestone', options: [{ name: 'v1' }, { name: 'v2' }] }),
      ]))
      expect(github.requests().slice(2)).toMatchObject([
        { operation: 'GetRepositoryLabelsPage', variables: { owner: 'acme', repo: 'demo', after: 'L1' } },
        { operation: 'GetRepositoryMilestonesPage', variables: { owner: 'acme', repo: 'demo', after: 'M1' } },
      ])
    })

    it('json を付けて呼んでも、付けないときと同じ結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-10')
      setUp()
      await startGithub([...definitionRules(), ...definitionRules()])

      const plain = await attributes()
      const json = await attributes({ repo: 'acme/demo', json: true })

      expect(json.structured).toStrictEqual(plain.structured)
    })

    it.for([
      { name: 'repo を渡す', withRepo: true },
      { name: 'repo を省く', withRepo: false },
    ])('$name と、そのリポの定義を読む', async ({ withRepo }, context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-11')
      setUp()
      const github = await startGithub(definitionRules())

      const outcome = await attributes(withRepo ? { repo: 'acme/demo' } : {})

      expect(outcome.isError).toBe(false)
      expect(github.requests()).toMatchObject([{ operation: 'HasIssueFields' }, { variables: { owner: 'acme', repo: 'demo' } }])
    })

    it('repo を省いて git の remote のリポを読めないと、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-12')
      setUpProject()
      enterGitRepository()
      const github = await startGithub([])

      const outcome = await attributes({})

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('git-unresolved')
      expect(github.requests()).toStrictEqual([])
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-13')
      setUp({ repositories: ['other'] })

      const outcome = await attributes()

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toStrictEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('GitHub API がエラーを返すと、kind が github-api の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-ATTRIBUTES-14')
      setUp()
      await startGithub([issueFieldsProbeRule(), { match: { operation: 'GetIssueAttributeDefinitions' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await attributes()

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not read the attributes of acme\/demo: /u)
    })
  })
})
