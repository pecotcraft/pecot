/* eslint-disable unicorn/no-null -- JSON の null を確かめる */
/* eslint-disable unicorn/consistent-function-scoping -- 補助は、使う describe の近くに置く */
import { describe, expect, it } from 'vitest'

import { ISSUE_SHOW_COMMANDS } from '../../src/commands/issue-show.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import type { RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { attributeRules, boardValue, issueAttributesData, issueFieldsProbeRule } from '../_helpers/attributes.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function read(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'show', ...argv], ISSUE_SHOW_COMMANDS)
}

function slimRequests(github: Readonly<RunningGithub>): readonly RecordedRequest[] {
  return github.requests().filter(request => request.type === 'graphql' && request.operation === 'GetIssueSlim')
}

interface IssueFields {
  readonly number?: number
  readonly title?: string
  readonly body?: string
  readonly parent?: unknown
  readonly comments?: { readonly totalCount: number, readonly nodes: readonly unknown[] }
  readonly subIssues?: readonly unknown[]
  readonly branches?: readonly string[]
  readonly timeline?: readonly unknown[]
  readonly blockedByCount?: number
  readonly state?: string
}

/**
GetIssueSlim の 200 の応答
*/
function issueRule(fields: Readonly<IssueFields> = {}): ResponseRule {
  const { number = 7, state = 'OPEN', title = '見本の Issue', body = '本文の 1 行目\n', parent, comments = { totalCount: 0, nodes: [] }, subIssues = [], branches = [], timeline = [], blockedByCount } = fields
  const issue = {
    number,
    state,
    title,
    body,
    comments,
    parent,
    subIssues: { nodes: subIssues },
    linkedBranches: { nodes: branches.map(name => ({ ref: { name } })) },
    timelineItems: { nodes: timeline },
    ...blockedByCount !== undefined && { blockedBy: { totalCount: blockedByCount } },
  }
  return { match: { operation: 'GetIssueSlim' }, respond: { status: 200, body: { data: { repository: { issue } } } }, times: 1 }
}

function withoutDevelopBranch(): string {
  const fields = { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } } }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields }
  return `${JSON.stringify({ host: 'ghes.example.com', owner: 'acme', project, repositories: [{ owner: 'acme', name: 'demo' }] }, undefined, 2)}\n`
}

const HEAD = '## #7 見本の Issue\n\n**State:** OPEN\n\n'
const BODY = '---\n\n本文の 1 行目\n'

describe('issue show', () => {
  it('Issue の参照を渡すと、見出し・状態・本文を Markdown で標準出力に出す', async () => {
    setUpProject()
    const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${HEAD}${BODY}`, stderr: '' })
    expect(slimRequests(github)).toMatchObject([{ type: 'graphql', operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 5 } }])
  })

  it.for([
    { name: '同じリポジトリの親', parent: { number: 3, title: '親の Epic', state: 'OPEN', repository: { name: 'demo', owner: { login: 'acme' } } }, line: '**Parent:** #3 親の Epic (OPEN)', reference: 'acme/demo/3' },
    { name: '別のリポジトリの親', parent: { number: 3, title: '親の Epic', state: 'CLOSED', repository: { name: 'other', owner: { login: 'acme' } } }, line: '**Parent:** acme/other#3 親の Epic (CLOSED)', reference: 'acme/other/3' },
  ])('$name がある Issue を読むと、親 Issue と、Attributes の節に parent を出す', async ({ parent, line, reference }) => {
    setUpProject()
    await startGithub([prerequisitesRule({ number: 7 }), issueRule({ parent }), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}${line}\n\n**Attributes:**\n  - parent: ${reference}\n\n${BODY}`)
  })

  it('リンクされたブランチがある Issue を読むと、そのブランチを出す', async () => {
    setUpProject()
    await startGithub([prerequisitesRule({ number: 7 }), issueRule({ branches: ['feat/7', 'fix/7'] }), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Branches:**\n  - \`feat/7\`\n  - \`fix/7\`\n\n${BODY}`)
  })

  it('リンクされた PR がある Issue を読むと、重複を除いた PR を出す', async () => {
    setUpProject()
    const timeline = [
      { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
      { source: { number: 12, title: '不具合の修正', state: 'OPEN' } },
      { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
    ]
    await startGithub([prerequisitesRule({ number: 7 }), issueRule({ timeline }), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Linked PRs:**\n  - #11 機能の追加 (MERGED)\n  - #12 不具合の修正 (OPEN)\n\n${BODY}`)
  })

  it('sub-issue がある Issue を読むと、sub-issue を出す', async () => {
    setUpProject()
    await startGithub([prerequisitesRule({ number: 7 }), issueRule({ subIssues: [{ number: 8, state: 'OPEN', title: '子の Issue' }, { number: 9, state: 'CLOSED', title: '終えた子' }] }), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Sub-issues:**\n  - #8 子の Issue (OPEN)\n  - #9 終えた子 (CLOSED)\n\n${BODY}`)
  })

  it('コメントがある Issue を読むと、--comment-limit 件までのコメントを件数と一緒に出す', async () => {
    setUpProject()
    const comments = {
      totalCount: 3,
      nodes: [
        { author: { login: 'reviewer' }, createdAt: '2026-01-02T03:04:05Z', body: '1 件目' },
        { author: undefined, createdAt: '2026-02-03T00:00:00Z', body: '2 件目' },
      ],
    }
    const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule({ comments }), ...attributeRules()])

    const result = await read('acme/demo/7', '--comment-limit', '2')

    expect(result.stdout).toBe(
      '## #7 見本の Issue\n\n**State:** OPEN | **Comments:** 3\n\n'
      + `${BODY}\n\n\n### Comments (2/3)\n\n`
      + '---\n\n**@reviewer** - 2026-01-02\n\n1 件目\n\n'
      + '---\n\n**@ghost** - 2026-02-03\n\n2 件目\n',
    )
    expect(slimRequests(github)).toMatchObject([{ variables: { commentLimit: 2 } }])
  })

  it('--comment-limit 0 を渡すと、コメントを出さない', async () => {
    setUpProject()
    const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule({ comments: { totalCount: 4, nodes: [] } }), ...attributeRules()])

    const result = await read('acme/demo/7', '-c', '0')

    expect(result.stdout).toBe(`## #7 見本の Issue\n\n**State:** OPEN | **Comments:** 4\n\n${BODY}`)
    expect(slimRequests(github)).toMatchObject([{ variables: { commentLimit: 0 } }])
  })

  it('--json を渡すと、同じ内容を JSON で標準出力に出す', async () => {
    setUpProject()
    await startGithub([prerequisitesRule({ number: 7 }), issueRule({
      comments: { totalCount: 1, nodes: [{ author: { login: 'reviewer' }, createdAt: '2026-01-02T03:04:05Z', body: 'コメントの本文' }] },
      subIssues: [{ number: 8, state: 'OPEN', title: '子の Issue' }],
      branches: ['feat/7'],
    }), ...attributeRules()])

    const result = await read('acme/demo/7', '--json')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${JSON.stringify({
      number: 7,
      state: 'OPEN',
      title: '見本の Issue',
      body: '本文の 1 行目\n',
      comments: { total_count: 1, nodes: [{ author: 'reviewer', created_at: '2026-01-02T03:04:05Z', body: 'コメントの本文' }] },

      parent: null,
      sub_issues: [{ number: 8, state: 'OPEN', title: '子の Issue' }],
      linked_branches: ['feat/7'],
      linked_prs: [],
      owner: 'acme',
      repo: 'demo',
      blockedBy: [],
      readiness: { kind: 'startable', stackOn: null, reason: null, text: 'startable' },
      attributes: [],
      unsupported: [],
    }, undefined, 2)}\n`)
  })

  it('短い形 N の参照を --repo で補って読む', async () => {
    setUpProject()
    const github = await startGithub([issueRule({ number: 5 }), prerequisitesRule({ number: 5 }), ...attributeRules()])

    const result = await runInProcess(['--repo', 'acme/demo', 'issue', 'show', '5'], ISSUE_SHOW_COMMANDS)

    expect(result.code).toBe(0)
    expect(slimRequests(github)).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
  })

  it('短い形 N の参照を --repo なしで渡すと、git の remote で補って読む', async () => {
    setUpProject()
    const repository = enterGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
    const github = await startGithub([issueRule({ number: 5 }), prerequisitesRule({ number: 5 }), ...attributeRules()])

    const result = await read('5')

    expect(result.code).toBe(0)
    expect(slimRequests(github)).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
  })

  it('短い形 N の参照を --repo なしで渡し、remote の URL から owner/repo を読めないと、短い形の案内と理由を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-COMMON-22')
    setUpProject()
    const repository = enterGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', '/srv/git/demo.git'])

    const result = await read('5')

    expect(result.code).toBe(2)
    expect(result.stderr).toBe([
      'error: the short form \'N\' needs a base_repo: pass --repo <owner/repo> or use the full form \'owner/repo/N\'',
      '  could not read the repository from the URL of the Git remote origin',
      '',
    ].join('\n'))
  })

  it.for([
    { name: '参照が owner/repo/N の形でない', reference: 'invalid-format' },
    { name: '参照が # で始まる', reference: '#5' },
  ])('Issue の参照の形が誤っている（$name）とき、API を呼ばずに終了コード 2 で終わる', async ({ reference }) => {
    setUpProject()
    const github = await startGithub([])

    const result = await read(reference)

    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: `error: invalid reference: ${reference}\n  accepted forms:\n    - full: 'owner/repo/N'\n    - short: 'N' (with a base repository)\n`,
    })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: '上限を超える 21', limit: '21', message: '21 is not in the range 0<=x<=20.' },
    { name: '下限を下回る -1', limit: '-1', message: '-1 is not in the range 0<=x<=20.' },
    { name: '整数でない -0.5', limit: '-0.5', message: '\'-0.5\' is not a valid int range.' },
    { name: '数でない many', limit: 'many', message: '\'many\' is not a valid int range.' },
  ])('--comment-limit が $name のとき、API を呼ばずに終了コード 2 で終わる', async ({ limit, message }) => {
    setUpProject()
    const github = await startGithub([])

    const result = await read('acme/demo/7', `--comment-limit=${limit}`)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`│ Invalid value for '--comment-limit' / '-c': ${message}`)
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    makeAmbiguous(setUpProject())
    const github = await startGithub([])

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async () => {
    setUpProject({ repositories: ['other'] })

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async () => {
    makeAmbiguous(setUpProject())
    await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules()])

    const result = await read('acme/demo/7', '--project', SECOND_PROJECT)

    expect(result).toEqual({ code: 0, stdout: `${HEAD}${BODY}`, stderr: '' })
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で読む', async () => {
    removeActive(setUpProject())
    await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules()])

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${HEAD}${BODY}`, stderr: '' })
  })

  it.for([
    { name: 'HTTP 401', rule: { status: 401, body: { message: 'Bad credentials' } } },
    { name: 'HTTP 404', rule: { status: 404, body: { message: 'Not Found' } } },
    { name: 'HTTP 500', rule: { status: 500, body: { message: 'failure' } } },
  ])('GitHub API が $name を返したとき、終了コード 1 で終わる', async ({ rule }) => {
    setUpProject()
    await startGithub([{ match: { operation: 'GetIssueSlim' }, respond: rule, times: 1 }])

    const result = await read('acme/demo/7')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not read Issue acme\/demo\/7: /u)
  })

  it('Issue が無くて GitHub API が 200 と GraphQL の errors を返したとき、その内容を添えて終了コード 1 で終わる', async () => {
    setUpProject()
    const errors = [{ type: 'NOT_FOUND', path: ['repository', 'issue'], locations: [{ line: 3, column: 5 }], message: 'Could not resolve to an Issue with the number of 7.' }]

    const data = { repository: { issue: null } }
    await startGithub([{ match: { operation: 'GetIssueSlim' }, respond: { status: 200, body: { data, errors } }, times: 1 }])

    const result = await read('acme/demo/7')

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: could not read Issue acme/demo/7: GraphQL query error: '
        + '{\'type\': \'NOT_FOUND\', \'path\': [\'repository\', \'issue\'], \'locations\': [{\'line\': 3, \'column\': 5}], '
        + '\'message\': \'Could not resolve to an Issue with the number of 7.\'}\n',
    })
  })

  it('MCP のツールで Issue が無くて GraphQL の errors が NOT_FOUND のとき、kind を github-not-found にし、CLI と同じ行と終了コードを返す', async (context) => {
    await verifies(context, 'PW-ISSUE-SHOW-13')
    setUpProject()
    const errors = [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue with the number of 7.' }]
    const rule: ResponseRule = { match: { operation: 'GetIssueSlim' }, respond: { status: 200, body: { data: { repository: { issue: null } }, errors } }, times: 2 }
    await startGithub([rule])

    const cli = await read('acme/demo/7')
    const outcome = await callToolOnce(ISSUE_SHOW_COMMANDS, 'issue_show', { issue_ref: 'acme/demo/7' })
    expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-not-found', detail: cli.stderr.replace(/^error: /u, '').replace(/\n+$/u, '') } })
    expect(outcome).not.toHaveProperty('stderr')
    expect(cli.code).toBe(1)
  })
  describe('MCP の data', () => {
    async function show(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
      return await callToolOnce(ISSUE_SHOW_COMMANDS, 'issue_show', argumentsOfTool)
    }

    const parent = { number: 3, title: '親の Epic', state: 'OPEN', repository: { name: 'demo', owner: { login: 'acme' } } }
    const subIssues = [{ number: 8, state: 'OPEN', title: '子の Issue' }, { number: 9, state: 'CLOSED', title: '済んだ子' }]

    it('json を付けずに読むと、--json と同じ中身を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-01')
      await verifies(context, 'PW-ISSUE-SHOW-02')
      await verifies(context, 'PW-ISSUE-SHOW-05')
      await verifies(context, 'PW-ISSUE-SHOW-15')
      setUpProject()
      const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule({ parent, subIssues }), prerequisitesRule({ number: 7 }), issueRule({ parent, subIssues }), ...attributeRules({}, 2)])

      const outcome = await show({ issue_ref: 'acme/demo/7' })
      const cli = await read('acme/demo/7', '--json')

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual(JSON.parse(cli.stdout))
      expect(outcome.structured).toMatchObject({
        parent: { number: 3, title: '親の Epic', state: 'OPEN', owner: 'acme', repo: 'demo' },
        sub_issues: subIssues,
        readiness: { kind: 'startable' },
      })
      expect(outcome.structured).toMatchObject({ number: 7, title: '見本の Issue', state: 'OPEN', body: '本文の 1 行目\n', blockedBy: [] })
      expect(slimRequests(github)[0]).toMatchObject({ variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 5 } })
    })

    it('json を付けて読んでも、付けないときと同じ data を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-08')
      setUpProject()
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules({}, 2)])

      const plain = await show({ issue_ref: 'acme/demo/7' })
      const withJson = await show({ issue_ref: 'acme/demo/7', json: true })

      expect(withJson.structured).toEqual(plain.structured)
    })

    it('前提のある Issue を読むと、blockedBy と blocked の判定を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-14')
      await verifies(context, 'PW-ISSUE-SHOW-17')
      setUpProject()
      const blockedBy = [{ number: 4, title: '待つ前提' }]
      await startGithub([issueRule(), prerequisitesRule({ number: 7, blockedBy, body: '## Waits for merge\n- #4: 公開後に確かめる\n' }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toMatchObject({
        blockedBy: [{ number: 4, repository: 'acme/demo', state: 'OPEN', wait: 'merge', reason: '公開後に確かめる' }],
        readiness: { kind: 'blocked', stackOn: null, reason: 'waits-merge', text: 'blocked by #4 (waits for merge)' },
      })
    })

    it('前提を読めないと、blockedBy と readiness を null にし、warning を data.warnings に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-18')
      setUpProject()
      await startGithub([issueRule(), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }, ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ number: 7, title: '見本の Issue', blockedBy: null, readiness: null })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not read blocked-by of #7: /u)])
    })

    it('リンクされたブランチと PR がある Issue を読むと、ブランチを linked_branches に、重複を除いた PR を linked_prs に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-03')
      await verifies(context, 'PW-ISSUE-SHOW-04')
      setUpProject()
      const timeline = [
        { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
        { source: { number: 12, title: '不具合の修正', state: 'OPEN' } },
        { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
      ]
      await startGithub([prerequisitesRule({ number: 7 }), issueRule({ branches: ['feat/7', 'fix/7'], timeline }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toMatchObject({
        linked_branches: ['feat/7', 'fix/7'],
        linked_prs: [{ number: 11, title: '機能の追加', state: 'MERGED' }, { number: 12, title: '不具合の修正', state: 'OPEN' }],
      })
    })

    it('別のリポジトリの親がある Issue を読むと、親のリポジトリを parent に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-02')
      setUpProject()
      const other = { number: 3, title: '親の Epic', state: 'CLOSED', repository: { name: 'other', owner: { login: 'acme' } } }
      await startGithub([prerequisitesRule({ number: 7 }), issueRule({ parent: other }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured['parent']).toEqual({ number: 3, title: '親の Epic', state: 'CLOSED', owner: 'acme', repo: 'other' })
    })

    it('コメントがある Issue を読むと、comment_limit 件までのコメントを comments に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-06')
      setUpProject()
      const comments = {
        totalCount: 3,
        nodes: [
          { author: { login: 'reviewer' }, createdAt: '2026-01-02T03:04:05Z', body: '1 件目' },
          { author: undefined, createdAt: '2026-02-03T00:00:00Z', body: '2 件目' },
        ],
      }
      const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule({ comments }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7', comment_limit: 2 })

      expect(outcome.structured['comments']).toEqual({
        total_count: 3,
        nodes: [
          { author: 'reviewer', created_at: '2026-01-02T03:04:05Z', body: '1 件目' },
          { author: 'ghost', created_at: '2026-02-03T00:00:00Z', body: '2 件目' },
        ],
      })
      expect(slimRequests(github)).toMatchObject([{ variables: { commentLimit: 2 } }])
    })

    it('comment_limit に 0 を渡すと、コメントを返さない', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-07')
      setUpProject()
      const github = await startGithub([prerequisitesRule({ number: 7 }), issueRule({ comments: { totalCount: 4, nodes: [] } }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7', comment_limit: 0 })

      expect(outcome.structured['comments']).toEqual({ total_count: 4, nodes: [] })
      expect(slimRequests(github)).toMatchObject([{ variables: { commentLimit: 0 } }])
    })

    it('短い形 N の参照を repo で補って読む', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-09')
      setUpProject()
      const github = await startGithub([issueRule({ number: 5 }), prerequisitesRule({ number: 5 }), ...attributeRules()])

      const outcome = await show({ issue_ref: '5', repo: 'acme/demo' })

      expect(outcome.isError).toBe(false)
      expect(slimRequests(github)).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
    })

    it('短い形 N の参照を repo なしで渡すと、git の remote で補って読む', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-09')
      setUpProject()
      const repository = enterGitRepository()
      gitForTest(repository, ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
      const github = await startGithub([issueRule({ number: 5 }), prerequisitesRule({ number: 5 }), ...attributeRules()])

      const outcome = await show({ issue_ref: '5' })

      expect(outcome.isError).toBe(false)
      expect(slimRequests(github)).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
    })

    it.for([
      { name: '参照が owner/repo/N の形でない', reference: 'invalid-format' },
      { name: '参照が # で始まる', reference: '#5' },
    ])('Issue の参照の形が誤っている（$name）とき、API を呼ばずに kind が invalid-input の失敗を返す', async ({ reference }, context) => {
      await verifies(context, 'PW-ISSUE-SHOW-10')
      setUpProject()
      const github = await startGithub([])

      const outcome = await show({ issue_ref: reference })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: `invalid reference: ${reference}\n  accepted forms:\n    - full: 'owner/repo/N'\n    - short: 'N' (with a base repository)` })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: '上限を超える 21', limit: 21 },
      { name: '下限を下回る -1', limit: -1 },
    ])('comment_limit が $name のとき、API を呼ばずに kind が invalid-input の失敗を返す', async ({ limit }, context) => {
      await verifies(context, 'PW-ISSUE-SHOW-11')
      setUpProject()
      const github = await startGithub([])

      const outcome = await show({ issue_ref: 'acme/demo/7', comment_limit: limit })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-12')
      makeAmbiguous(setUpProject())
      const github = await startGithub([])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-23')
      setUpProject({ repositories: ['other'] })

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-24')
      makeAmbiguous(setUpProject())
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ number: 7, title: '見本の Issue' })
    })

    it.for([
      { name: 'HTTP 401', rule: { status: 401, body: { message: 'Bad credentials' } } },
      { name: 'HTTP 404', rule: { status: 404, body: { message: 'Not Found' } } },
      { name: 'HTTP 500', rule: { status: 500, body: { message: 'failure' } } },
    ])('GitHub API が $name を返したとき、失敗を返す', async ({ rule }, context) => {
      await verifies(context, 'PW-ISSUE-SHOW-13')
      setUpProject()
      await startGithub([{ match: { operation: 'GetIssueSlim' }, respond: rule, times: 1 }])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toMatch(/^could not read Issue acme\/demo\/7: /u)
    })
  })

  describe('前提（blocked by）', () => {
    const dependent = (extra: Partial<Parameters<typeof prerequisitesRule>[0]> = {}): Parameters<typeof prerequisitesRule>[0] => ({
      number: 7,
      blockedBy: [
        { number: 3, title: 'Base', column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30 }] },
        { number: 4, title: '待つ前提' },
      ],
      body: '本文\n\n## Waits for merge\n- #4: 公開後に確かめる\n',
      ...extra,
    })

    it('前提がある Issue を読むと、Parent の下に Blocked by と Readiness の 2 行を出す', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule(dependent()), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      const [blockedBy, readiness] = [
        '**Blocked by:** #3 Base (OPEN, in review), #4 待つ前提 (OPEN, wait: merge — 公開後に確かめる)',
        '**Readiness:** blocked by #3, #4 (waits for merge)',
      ]
      expect(result.stdout).toBe(`${HEAD}${blockedBy}\n${readiness}\n\n**Attributes:**\n  - blocked_by: acme/demo/3, acme/demo/4\n\n${BODY}`)
      expect(result.stderr).toBe('')
    })

    it('前提が無い Issue を読むと、2 行を出さない', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule({ number: 7 }), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.stdout).toBe(`${HEAD}${BODY}`)
    })

    it('本文の節にあって blocked by に無い Issue があると、warning を出して読み続ける', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule(dependent({ body: '## Waits for merge\n- #4: 理由\n- #9: 外した前提\n' })), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: Waits for merge of #7 lists #9, which is not a blocked-by of it\n')
      expect(result.stdout).toContain('**Readiness:** blocked by #3, #4 (waits for merge)')
    })

    it('本文の節が読めないと、warning を出し、前提をすべて merge 待ちにする', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule(dependent({ body: '## Waits for merge\n\nbroken\n' })), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.stderr).toMatch(/^warning: Waits for merge of #7 is malformed: .+\n$/u)
      expect(result.stdout).toContain('#3 Base (OPEN, wait: merge)')
    })

    it('--json を渡すと、blockedBy と readiness を足す', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule(dependent()), ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      const output: unknown = JSON.parse(result.stdout)
      expect(output).toMatchObject({
        blockedBy: [
          { number: 3, repository: 'acme/demo', state: 'OPEN', wait: 'stack', reason: null },
          { number: 4, repository: 'acme/demo', state: 'OPEN', wait: 'merge', reason: '公開後に確かめる' },
        ],
        readiness: { kind: 'blocked', stackOn: null, reason: 'waits-merge', text: 'blocked by #3, #4 (waits for merge)' },
      })
    })

    it('前提を読めないと、warning を出し、今までの出力に 2 行を足さない', async () => {
      setUpProject()
      await startGithub([issueRule(), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }, ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${HEAD}${BODY}`)
      expect(result.stderr).toMatch(/^warning: could not read blocked-by of #7: GraphQL query error: Server error '500/u)
    })

    it('前提を読めないとき、--json は blockedBy と readiness を null にする', async () => {
      setUpProject()
      await startGithub([issueRule(), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }, ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      expect(JSON.parse(result.stdout)).toMatchObject({ blockedBy: null, readiness: null })
    })

    it('依存関係に対応しない GHES では、warning を出し、今までの出力に 2 行を足さない', async () => {
      setUpProject()
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      await startGithub([issueRule(), unsupported, ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n')
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 7, title: '見本の Issue', blockedBy: null, readiness: null })
    })

    it('develop_branch が無いリポジトリで済んでいない前提があると、前提を出し、Readiness を unknown にする', async () => {
      setUpProject({ files: { '.pecot/config/projects/ghes.example.com_acme_board_acme.json': withoutDevelopBranch() } })
      await startGithub([issueRule(), prerequisitesRule(dependent()), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: could not judge readiness of #7: develop_branch is not set for acme/demo\n')
      const lines = [
        '**Blocked by:** #3 Base (OPEN, in review), #4 待つ前提 (OPEN, wait: merge — 公開後に確かめる)',
        '**Readiness:** unknown (develop_branch is not set for acme/demo)',
      ]
      expect(result.stdout).toBe(`${HEAD}${lines.join('\n')}\n\n**Attributes:**\n  - blocked_by: acme/demo/3, acme/demo/4\n\n${BODY}`)
    })

    it('develop_branch が無いとき、--json は前提を出し、readiness を null にする', async () => {
      setUpProject({ files: { '.pecot/config/projects/ghes.example.com_acme_board_acme.json': withoutDevelopBranch() } })
      await startGithub([issueRule(), prerequisitesRule(dependent()), ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      expect(JSON.parse(result.stdout)).toMatchObject({
        blockedBy: [{ number: 3, wait: 'stack' }, { number: 4, wait: 'merge' }],
        readiness: null,
      })
    })

    it('base を引き足す API が失敗すると、warning を出し、前提と Readiness: unknown を出して止まらない', async () => {
      setUpProject()
      const diverged = { number: 7, blockedBy: [{ number: 3, title: 'Base', column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, base: 'feat/2' }] }] }
      await startGithub([issueRule(), prerequisitesRule(diverged), { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }, ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      expect(result.stderr).toMatch(/^warning: could not judge readiness of #7: GraphQL query error: Server error '500/u)
      expect(result.stdout).toContain('**Blocked by:** #3 Base (OPEN, in review)\n**Readiness:** unknown (GraphQL query error')
    })

    it('前提の件数が 0 の Issue を読むと、前提を読まずに startable を出す', async () => {
      setUpProject()
      const github = await startGithub([issueRule({ blockedByCount: 0 }), ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      expect(JSON.parse(result.stdout)).toMatchObject({ blockedBy: [], readiness: { kind: 'startable', text: 'startable' } })
      expect(github.requests().map(request => request.type === 'graphql' ? request.operation : '')).toEqual(['GetIssueSlim', 'HasIssueFields', 'GetIssueAttributes'])
    })

    it('閉じた前提は、Blocked by の行に CLOSED で出す', async () => {
      setUpProject()
      await startGithub([issueRule(), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, state: 'CLOSED', title: 'Base' }] }), ...attributeRules()])

      const result = await read('acme/demo/7')

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/\*\*Blocked by:\*\* #3 Base \(CLOSED, [^)]+\)\n/u)
    })

    it('前提の件数が 0 で sub-issue を持つ閉じた Issue を読むと、Epic として readiness を null にする', async () => {
      setUpProject()
      await startGithub([issueRule({ blockedByCount: 0, state: 'CLOSED', subIssues: [{ number: 8, state: 'OPEN', title: '子の Issue' }] }), ...attributeRules()])

      const result = await read('acme/demo/7', '--json')

      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'CLOSED', blockedBy: [], readiness: null })
    })

    describe('MCP の呼び出し', () => {
      async function show(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
        return await callToolOnce(ISSUE_SHOW_COMMANDS, 'issue_show', argumentsOfTool)
      }

      it.for([
        { name: '節にあって blocked by に無い Issue がある', body: '## Waits for merge\n- #4: 理由\n- #9: 外した前提\n', warning: /^Waits for merge of #7 lists #9, which is not a blocked-by of it$/u, wait: 'stack' },
        { name: '節が読めない', body: '## Waits for merge\n\nbroken\n', warning: /^Waits for merge of #7 is malformed: .+$/u, wait: 'merge' },
      ])('本文の $name とき、warnings に入れて読み続ける', async (row, context) => {
        await verifies(context, 'PW-ISSUE-SHOW-16')
        setUpProject()
        await startGithub([issueRule(), prerequisitesRule(dependent({ body: row.body })), ...attributeRules()])

        const outcome = await show({ issue_ref: 'acme/demo/7' })

        expect(outcome.isError).toBe(false)
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(row.warning)])
        expect(outcome.structured['blockedBy']).toMatchObject([{ number: 3, wait: row.wait }, { number: 4, wait: 'merge' }])
      })

      it('develop_branch が無いリポジトリで済んでいない前提があると、blockedBy に前提を入れ、readiness を null にして warnings に入れる', async (context) => {
        await verifies(context, 'PW-ISSUE-SHOW-19')
        setUpProject({ files: { '.pecot/config/projects/ghes.example.com_acme_board_acme.json': withoutDevelopBranch() } })
        await startGithub([issueRule(), prerequisitesRule(dependent()), ...attributeRules()])

        const outcome = await show({ issue_ref: 'acme/demo/7' })

        expect(outcome.structured).toMatchObject({ blockedBy: [{ number: 3, wait: 'stack' }, { number: 4, wait: 'merge' }], readiness: null })
        expect(outcome.structured['warnings']).toEqual(['could not judge readiness of #7: develop_branch is not set for acme/demo'])
      })

      it('base を引き足す API が失敗すると、warnings に入れ、blockedBy に前提を入れて readiness を null にする', async (context) => {
        await verifies(context, 'PW-ISSUE-SHOW-20')
        setUpProject()
        const diverged = { number: 7, blockedBy: [{ number: 3, title: 'Base', column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, base: 'feat/2' }] }] }
        await startGithub([issueRule(), prerequisitesRule(diverged), { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }, ...attributeRules()])

        const outcome = await show({ issue_ref: 'acme/demo/7' })

        expect(outcome.isError).toBe(false)
        expect(outcome.structured).toMatchObject({ blockedBy: [{ number: 3 }], readiness: null })
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not judge readiness of #7: GraphQL query error: Server error '500/u)])
      })

      it('依存関係に対応しない GHES では、warnings に入れ、blockedBy と readiness を null にする', async (context) => {
        await verifies(context, 'PW-ISSUE-SHOW-21')
        setUpProject()
        const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
        await startGithub([issueRule(), unsupported, ...attributeRules()])

        const outcome = await show({ issue_ref: 'acme/demo/7' })

        expect(outcome.isError).toBe(false)
        expect(outcome.structured).toMatchObject({ number: 7, blockedBy: null, readiness: null })
        expect(outcome.structured['warnings']).toEqual(['could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'])
      })

      it('前提の件数が 0 の Issue を読むと、前提を読まずに startable を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-SHOW-22')
        setUpProject()
        const github = await startGithub([issueRule({ blockedByCount: 0 }), ...attributeRules()])

        const outcome = await show({ issue_ref: 'acme/demo/7' })

        expect(outcome.structured).toMatchObject({ blockedBy: [], readiness: { kind: 'startable', text: 'startable' } })
        expect(github.requests().map(request => request.type === 'graphql' ? request.operation : '')).toEqual(['GetIssueSlim', 'HasIssueFields', 'GetIssueAttributes'])
      })
    })
  })

  describe('機能（attributes）', () => {
    async function show(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
      return await callToolOnce(ISSUE_SHOW_COMMANDS, 'issue_show', argumentsOfTool)
    }

    const FILLED = {
      assignees: ['alice'],
      milestone: 'v1',
      issueType: 'Task',
      labels: ['bug', 'docs'],
      issueFieldValues: [{ __typename: 'IssueFieldSingleSelectValue', field: { name: 'Priority', dataType: 'SINGLE_SELECT' }, name: 'High' }],
      fieldValues: [
        boardValue('ProjectV2ItemFieldSingleSelectValue', 'Area', 'SINGLE_SELECT', { name: 'cli' }),
        boardValue('ProjectV2ItemFieldNumberValue', 'Estimate', 'NUMBER', { number: 2.5 }),
        boardValue('ProjectV2ItemFieldDateValue', 'Due', 'DATE', { date: '2026-12-01' }),
      ],
    }

    it('値の入っている機能がある Issue を読むと、ボード・Issue fields・組み込みの値を attributes に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-25')
      setUpProject()
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules(FILLED)])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['attributes']).toStrictEqual([
        { name: 'Area', source: 'project', kind: 'single_select', value: 'cli' },
        { name: 'Estimate', source: 'project', kind: 'number', value: 2.5 },
        { name: 'Due', source: 'project', kind: 'date', value: '2026-12-01' },
        { name: 'Priority', source: 'issue_field', kind: 'single_select', value: 'High' },
        { name: 'assignees', source: 'issue', kind: 'users', value: ['alice'] },
        { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
        { name: 'type', source: 'issue', kind: 'issue_type', value: 'Task' },
        { name: 'labels', source: 'issue', kind: 'labels', value: ['bug', 'docs'] },
      ])
      expect(outcome.structured['unsupported']).toStrictEqual([])
    })

    it('親と前提がある Issue を読むと、parent と blocked_by を owner/repo/N の形で attributes に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-26')
      setUpProject()
      const parent = { number: 3, title: '親の Epic', state: 'OPEN', repository: { name: 'other', owner: { login: 'acme' } } }
      const blockedBy = [{ number: 4, title: '前提' }, { number: 5, repo: 'other', title: '別のリポの前提' }]
      await startGithub([issueRule({ parent }), prerequisitesRule({ number: 7, blockedBy }), ...attributeRules()])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured['attributes']).toStrictEqual([
        { name: 'parent', source: 'issue', kind: 'issue_ref', value: 'acme/other/3' },
        { name: 'blocked_by', source: 'issue', kind: 'issue_refs', value: ['acme/demo/4', 'acme/other/5'] },
      ])
    })

    it('Issue field を写したボードの値と組み込みの機能を写すボードの値を、source が project の値に入れない', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-27')
      setUpProject()
      const fieldValues = [
        { __typename: 'ProjectV2ItemIssueFieldValue', field: { id: 'F_priority', name: 'Priority', dataType: 'SINGLE_SELECT', isIssueField: true } },
        boardValue('ProjectV2ItemFieldUserValue', 'Assignees', 'ASSIGNEES', { users: { nodes: [{ login: 'alice' }] } }),
        boardValue('ProjectV2ItemFieldTextValue', 'Title', 'TITLE', { text: '見本の Issue' }),
      ]
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules({ fieldValues })])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toMatchObject({ attributes: [], unsupported: [] })
    })

    it('pecot が扱えない種類の値があると、名前と GitHub の種類を unsupported に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-28')
      setUpProject()
      const fieldValues = [boardValue('ProjectV2ItemFieldPeopleValue', 'Reviewer group', 'PEOPLE', {})]
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules({ fieldValues })])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toMatchObject({ attributes: [], unsupported: [{ name: 'Reviewer group', source: 'project', github_type: 'PEOPLE' }] })
    })

    it('ボードの値を読めない部分エラーでは、warnings に入れ、読めた値を attributes に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-29')
      setUpProject()
      const data = issueAttributesData({ milestone: 'v1' })
      const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['repository', 'issue', 'projectItems'], message: 'Your token has not been granted the required scopes' }]
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), issueFieldsProbeRule(), { match: { operation: 'GetIssueAttributes' }, respond: { status: 200, body: { data, errors } }, times: 1 }])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['attributes']).toStrictEqual([{ name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' }])
      expect(outcome.structured['warnings']).toStrictEqual(['could not read the board fields of acme/demo/7: Your token has not been granted the required scopes'])
    })

    it('機能の値を読む要求が失敗すると、warnings に入れ、attributes と unsupported を null にしてほかの項目を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-30')
      setUpProject()
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), issueFieldsProbeRule(), { match: { operation: 'GetIssueAttributes' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await show({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ number: 7, title: '見本の Issue', readiness: { kind: 'startable' }, attributes: null, unsupported: null })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not read the attributes of acme\/demo\/7: /u)])
    })

    it('値の入っている機能がある Issue を json なしで読むと、ヘッダの後に Attributes の節を出す', async (context) => {
      await verifies(context, 'PW-ISSUE-SHOW-31')
      setUpProject()
      const fieldValues = [boardValue('ProjectV2ItemFieldPeopleValue', 'Reviewer group', 'PEOPLE', {})]
      await startGithub([prerequisitesRule({ number: 7 }), issueRule(), ...attributeRules({ ...FILLED, fieldValues: [...FILLED.fieldValues, ...fieldValues] })])

      const result = await read('acme/demo/7')

      const lines = [
        '**Attributes:**',
        '  - Area: cli',
        '  - Estimate: 2.5',
        '  - Due: 2026-12-01',
        '  - Priority: High',
        '  - assignees: alice',
        '  - milestone: v1',
        '  - type: Task',
        '  - labels: bug, docs',
        '  - Reviewer group: unsupported (PEOPLE)',
      ]
      expect(result).toEqual({ code: 0, stdout: `${HEAD}${lines.join('\n')}\n\n${BODY}`, stderr: '' })
    })
  })
})
