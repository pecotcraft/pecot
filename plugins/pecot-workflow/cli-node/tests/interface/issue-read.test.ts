import { describe, expect, it } from 'vitest'

import { ISSUE_READ_COMMANDS } from '../../src/commands/issue-read.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import type { ResponseRule } from '../fake-github/server.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function read(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'read', ...argv], ISSUE_READ_COMMANDS)
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
}

/**
GetIssueSlim の 200 の応答
*/
function issueRule(fields: Readonly<IssueFields> = {}): ResponseRule {
  const { number = 7, title = '見本の Issue', body = '本文の 1 行目\n', parent, comments = { totalCount: 0, nodes: [] }, subIssues = [], branches = [], timeline = [] } = fields
  const issue = {
    number,
    state: 'OPEN',
    title,
    body,
    comments,
    parent,
    subIssues: { nodes: subIssues },
    linkedBranches: { nodes: branches.map(name => ({ ref: { name } })) },
    timelineItems: { nodes: timeline },
  }
  return { match: { operation: 'GetIssueSlim' }, respond: { status: 200, body: { data: { repository: { issue } } } }, times: 1 }
}

const HEAD = '## #7 見本の Issue\n\n**State:** OPEN\n\n'
const BODY = '---\n\n本文の 1 行目\n'

describe('issue read', () => {
  it('Issue の参照を渡すと、見出し・状態・本文を Markdown で標準出力に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-01')
    setUpProject()
    const github = await startGithub([issueRule()])

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${HEAD}${BODY}`, stderr: '' })
    expect(github.requests()).toMatchObject([{ type: 'graphql', operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 5 } }])
  })

  it.for([
    { name: '同じリポジトリの親', parent: { number: 3, title: '親の Epic', state: 'OPEN', repository: { name: 'demo', owner: { login: 'acme' } } }, line: '**Parent:** #3 親の Epic (OPEN)' },
    { name: '別のリポジトリの親', parent: { number: 3, title: '親の Epic', state: 'CLOSED', repository: { name: 'other', owner: { login: 'acme' } } }, line: '**Parent:** acme/other#3 親の Epic (CLOSED)' },
  ])('$name がある Issue を読むと、親 Issue を出す', async ({ parent, line }, context) => {
    await verifies(context, 'PW-ISSUE-READ-02')
    setUpProject()
    await startGithub([issueRule({ parent })])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}${line}\n\n${BODY}`)
  })

  it('リンクされたブランチがある Issue を読むと、そのブランチを出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-03')
    setUpProject()
    await startGithub([issueRule({ branches: ['feat/7', 'fix/7'] })])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Branches:**\n  - \`feat/7\`\n  - \`fix/7\`\n\n${BODY}`)
  })

  it('リンクされた PR がある Issue を読むと、重複を除いた PR を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-04')
    setUpProject()
    const timeline = [
      { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
      { source: { number: 12, title: '不具合の修正', state: 'OPEN' } },
      { subject: { number: 11, title: '機能の追加', state: 'MERGED' } },
    ]
    await startGithub([issueRule({ timeline })])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Linked PRs:**\n  - #11 機能の追加 (MERGED)\n  - #12 不具合の修正 (OPEN)\n\n${BODY}`)
  })

  it('sub-issue がある Issue を読むと、sub-issue を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-05')
    setUpProject()
    await startGithub([issueRule({ subIssues: [{ number: 8, state: 'OPEN', title: '子の Issue' }, { number: 9, state: 'CLOSED', title: '終えた子' }] })])

    const result = await read('acme/demo/7')

    expect(result.stdout).toBe(`${HEAD}**Sub-issues:**\n  - #8 子の Issue (OPEN)\n  - #9 終えた子 (CLOSED)\n\n${BODY}`)
  })

  it('コメントがある Issue を読むと、--comment-limit 件までのコメントを件数と一緒に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-06')
    setUpProject()
    const comments = {
      totalCount: 3,
      nodes: [
        { author: { login: 'reviewer' }, createdAt: '2026-01-02T03:04:05Z', body: '1 件目' },
        { author: undefined, createdAt: '2026-02-03T00:00:00Z', body: '2 件目' },
      ],
    }
    const github = await startGithub([issueRule({ comments })])

    const result = await read('acme/demo/7', '--comment-limit', '2')

    expect(result.stdout).toBe(
      '## #7 見本の Issue\n\n**State:** OPEN | **Comments:** 3\n\n'
      + `${BODY}\n\n\n### Comments (2/3)\n\n`
      + '---\n\n**@reviewer** - 2026-01-02\n\n1 件目\n\n'
      + '---\n\n**@ghost** - 2026-02-03\n\n2 件目\n',
    )
    expect(github.requests()).toMatchObject([{ variables: { commentLimit: 2 } }])
  })

  it('--comment-limit 0 を渡すと、コメントを出さない', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-07')
    setUpProject()
    const github = await startGithub([issueRule({ comments: { totalCount: 4, nodes: [] } })])

    const result = await read('acme/demo/7', '-c', '0')

    expect(result.stdout).toBe(`## #7 見本の Issue\n\n**State:** OPEN | **Comments:** 4\n\n${BODY}`)
    expect(github.requests()).toMatchObject([{ variables: { commentLimit: 0 } }])
  })

  it('--json を渡すと、同じ内容を JSON で標準出力に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-08')
    setUpProject()
    await startGithub([issueRule({
      comments: { totalCount: 1, nodes: [{ author: { login: 'reviewer' }, createdAt: '2026-01-02T03:04:05Z', body: 'コメントの本文' }] },
      subIssues: [{ number: 8, state: 'OPEN', title: '子の Issue' }],
      branches: ['feat/7'],
    })])

    const result = await read('acme/demo/7', '--json')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${JSON.stringify({
      number: 7,
      state: 'OPEN',
      title: '見本の Issue',
      body: '本文の 1 行目\n',
      comments: { total_count: 1, nodes: [{ author: 'reviewer', created_at: '2026-01-02T03:04:05Z', body: 'コメントの本文' }] },
      // eslint-disable-next-line unicorn/no-null -- JSON の null
      parent: null,
      sub_issues: [{ number: 8, state: 'OPEN', title: '子の Issue' }],
      linked_branches: ['feat/7'],
      linked_prs: [],
      owner: 'acme',
      repo: 'demo',
    }, undefined, 2)}\n`)
  })

  it('短い形 N の参照を --repo で補って読む', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-09')
    setUpProject()
    const github = await startGithub([issueRule({ number: 5 })])

    const result = await runInProcess(['--repo', 'acme/demo', 'issue', 'read', '5'], ISSUE_READ_COMMANDS)

    expect(result.code).toBe(0)
    expect(github.requests()).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
  })

  it('短い形 N の参照を --repo なしで渡すと、git の remote で補って読む', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-09')
    setUpProject()
    const repository = enterGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
    const github = await startGithub([issueRule({ number: 5 })])

    const result = await read('5')

    expect(result.code).toBe(0)
    expect(github.requests()).toMatchObject([{ variables: { owner: 'acme', repo: 'demo', number: 5 } }])
  })

  it.for([
    { name: '参照が owner/repo/N の形でない', reference: 'invalid-format' },
    { name: '参照が # で始まる', reference: '#5' },
  ])('Issue の参照の形が誤っている（$name）とき、API を呼ばずに終了コード 2 で終わる', async ({ reference }, context) => {
    await verifies(context, 'PW-ISSUE-READ-10')
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
  ])('--comment-limit が $name のとき、API を呼ばずに終了コード 2 で終わる', async ({ limit, message }, context) => {
    await verifies(context, 'PW-ISSUE-READ-11')
    setUpProject()
    const github = await startGithub([])

    const result = await read('acme/demo/7', `--comment-limit=${limit}`)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`│ Invalid value for '--comment-limit' / '-c': ${message}`)
    expect(github.requests()).toEqual([])
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-12')
    enterGitRepository()

    const result = await read('acme/demo/7')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it.for([
    { name: 'HTTP 401', rule: { status: 401, body: { message: 'Bad credentials' } } },
    { name: 'HTTP 404', rule: { status: 404, body: { message: 'Not Found' } } },
    { name: 'HTTP 500', rule: { status: 500, body: { message: 'failure' } } },
  ])('GitHub API が $name を返したとき、終了コード 1 で終わる', async ({ rule }, context) => {
    await verifies(context, 'PW-ISSUE-READ-13')
    setUpProject()
    await startGithub([{ match: { operation: 'GetIssueSlim' }, respond: rule, times: 1 }])

    const result = await read('acme/demo/7')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not read Issue acme\/demo\/7: /u)
  })

  it('Issue が無くて GitHub API が 200 と GraphQL の errors を返したとき、その内容を添えて終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-READ-13')
    setUpProject()
    const errors = [{ type: 'NOT_FOUND', path: ['repository', 'issue'], locations: [{ line: 3, column: 5 }], message: 'Could not resolve to an Issue with the number of 7.' }]
    // eslint-disable-next-line unicorn/no-null -- GitHub は無い Issue を null で返す
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
})
