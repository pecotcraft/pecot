import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_COMMANDS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { writeTree } from '../../src/tests/_helpers/temporary.js'
import type { ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult, RunningGithub } from '../_helpers/interface-case.js'
import {
  configText,
  addedToProject,
  blockedByAdded,
  blockedBySupported,
  blockedByUnsupported,
  createdIssue,
  EPIC_BODY,
  failedAddToProject,
  failedBlockedBy,
  failedIssueCreation,
  failedSubIssue,
  frontmatterFile,
  issueNodeId,
  ISSUE_URL_BASE,
  linkedRepositories,
  parentEpic,
  rawFrontmatterFile,
  setUpIssueProject,
  subIssueAdded,
  TASK_BODY,
  TASK_FRONTMATTER,
  updatedFields,
} from '../_helpers/issue-create-case.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec } from '../_helpers/prerequisites.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function create(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'create', ...argv], ISSUE_CREATE_COMMANDS)
}

// 親 Epic を持たない 1 件の投稿で、ファイル入力が通る応答（node_id はボードへの追加の側で取る）
function fileRules(): ResponseRule[] {
  return [linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1)]
}

// 親 Epic #3 に #3-02 がある。order 2 は重複、order 3 は空き
const EXISTING_SUB_ISSUE = { number: 9, state: 'OPEN', title: '#3-02: 先の子' }

const TEMPLATE_VIOLATION = /^error: the body does not follow the template .+\/templates\/issue\/task\.md\n {2}missing sections: /u

const PARENT = 'parent_epic: acme/demo/3'

// 型・リポジトリ・題だけを書いたタスクのファイル。extra の行は、そのままフロントマターに足す
function taskFile(title: string, ...extra: readonly string[]): string {
  return rawFrontmatterFile(['type: task', 'repository: acme/demo', `title: ${title}`, ...extra])
}

function blockedBy(...entries: readonly string[]): string[] {
  return ['blocked_by:', ...entries.map(entry => `  - issue: ${entry}`)]
}

function inRoot(root: string, ...names: readonly string[]): string[] {
  return names.map(name => path.join(root, name))
}

// 偽サーバが受けた GraphQL のうち、operation が合うものの変数。進行の欄への書き込みは、欄の ID を持つものに絞る
function variablesOf(github: RunningGithub, operation: string): readonly unknown[] {
  return github.requests().flatMap(request => request.type === 'graphql' && request.operation === operation ? [request.variables] : [])
}

function workflowWrites(github: RunningGithub): readonly unknown[] {
  return variablesOf(github, 'UpdateProjectItemField').filter(variables => JSON.stringify(variables).includes('PVTSSF_workflow'))
}

function postsOf(github: RunningGithub): readonly unknown[] {
  return github.requests().filter(request => request.type === 'rest' && request.method === 'POST' && request.path.endsWith('/issues'))
}

const OPEN_PREREQUISITE: IssueSpec = { number: 12, state: 'OPEN' }

const TASK_WITH_PARENT = { ...TASK_FRONTMATTER, parent_epic: 'acme/demo/3', order: '3' }

async function createTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_CREATE_COMMANDS, 'issue_create', argumentsOfTool)
}

const REJECTED_INPUTS = [
  { id: 'PW-ISSUE-CREATE-52', name: '前提が一括のどのファイルのキーにも当たらない', second: blockedBy('nope'), first: [], kind: 'invalid-input', expected: 'error: blocked_by in b.md refers to unknown key nope\n' },
  { id: 'PW-ISSUE-CREATE-52', name: '前提が輪になる', second: blockedBy('a'), first: blockedBy('b'), kind: 'invalid-input', expected: 'error: blocked_by forms a cycle: a -> b -> a\n' },
  { id: 'PW-ISSUE-CREATE-52', name: '前提が後ろのファイルを指す', second: [], first: blockedBy('b'), kind: 'invalid-input', expected: 'error: blocked_by in a.md refers to b, which comes later\n' },
  { id: 'PW-ISSUE-CREATE-52', name: '同じ前提を 2 回書く', second: [...blockedBy('a'), '  - issue: a'], first: [], kind: 'invalid-input', expected: 'error: blocked_by in b.md refers to a more than once\n' },
  { id: 'PW-ISSUE-CREATE-53', name: 'parallel を書く', second: ['parallel: true'], first: [], kind: 'content-invalid', expected: 'error: parallel is no longer supported in b.md. Remove it\n' },
  { id: 'PW-ISSUE-CREATE-53', name: 'parallel とほかの誤りを両方書く', second: ['parallel: true', 'labels: a'], first: [], kind: 'content-invalid', expected: 'error: parallel is no longer supported in b.md. Remove it\n' },
  { id: 'PW-ISSUE-CREATE-54', name: 'wait: merge に reason が無い', second: ['blocked_by:', '  - issue: a', '    wait: merge'], first: [], kind: 'content-invalid', expected: 'error: blocked_by in b.md needs reason for wait: merge\n' },
]

describe('issue create', () => {
  describe('ファイルから作る', () => {
    it('ファイルを 2 つ渡すと、渡した順に作って {{issue:key}} を前の番号に直し、ボードと親 Epic につなぎ、フラグを消す', async () => {
      const project = setUpIssueProject()
      const secondBody = TASK_BODY.replace('実現したい状態', '{{issue:first}} が終わってから進める。')
      writeTree(project.root, {
        'first.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '先に作る Issue', parent_epic: 'acme/demo/3', order: '2' }),
        'second.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '後に作る Issue', parent_epic: 'acme/demo/3', order: '3' }, secondBody),
      })
      const github = await startGithub([
        linkedRepositories(),
        parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-01: 先の子' }]),
        createdIssue(12),
        createdIssue(13),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(3, 2),
        addedToProject(2),
        updatedFields(2),
        subIssueAdded(),
        subIssueAdded(),
      ])

      // --type などのオプションは、ファイルのフロントマターの値に負ける
      const result = await create(path.join(project.root, 'first.md'), path.join(project.root, 'second.md'), '--type', 'epic', '--status', 'backlog')

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n${ISSUE_URL_BASE}/13\n`)
      expect(result.stderr).toBe(
        'created: Issue acme/demo/12 from first.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n'
        + 'created: Issue acme/demo/13 from second.md\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status ready\nadded: Issue acme/demo/13 as sub-issue of acme/demo/3\n',
      )
      const posts = github.requests().filter(request => request.type === 'rest')
      expect(posts).toMatchObject([
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-02: 先に作る Issue' } },
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-03: 後に作る Issue' } },
      ])
      expect(JSON.stringify(posts.at(1)?.body)).toContain('#12 が終わってから進める。')
    })

    it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルから作る', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      const github = await startGithub(fileRules())

      const result = await create(path.join(project.root, 'draft.md'), '-m', '使われない本文')

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      const post = github.requests().find(request => request.type === 'rest')
      expect(post).toMatchObject({ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY.trimEnd() } })
    })

    it('ボードへの追加に失敗したとき、warning の行と Issue の URL を出し、次のファイルへ進んで終了コード 0 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
      })
      await startGithub([
        linkedRepositories(),
        createdIssue(12),
        issueNodeId(12),
        failedAddToProject(),
        createdIssue(13),
        issueNodeId(13),
        addedToProject(),
        updatedFields(1),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n${ISSUE_URL_BASE}/13\n`)
      expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12 from a\.md\nwarning: could not add Issue acme\/demo\/12 to project: .+\ncreated: Issue acme\/demo\/13 from b\.md\nadded: Issue acme\/demo\/13 to project\nset: Issue acme\/demo\/13 status ready\n$/u)
    })

    it('ボードへの追加に失敗しても、親 Epic へつなぎ、Issue の URL を 1 回だけ出して終了コード 0 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), failedAddToProject(), issueNodeId(3), subIssueAdded()])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12 from a\.md\nwarning: could not add Issue acme\/demo\/12 to project: .+\nadded: Issue acme\/demo\/12 as sub-issue of acme\/demo\/3\n$/u)
    })

    it('欄の設定に失敗したとき、warning を出し、project activate の案内を添えて、終了コード 0 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), staleOptionUpdate(1)])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toBe([
        'created: Issue acme/demo/12 from draft.md',
        'added: Issue acme/demo/12 to project',
        `warning: could not set status ready of Issue acme/demo/12: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        '',
      ].join('\n'))
    })

    it('複数のファイルで欄の設定に失敗しても、project activate の案内は 1 回だけ出す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次') })
      await startGithub([linkedRepositories(), createdIssue(12), createdIssue(13), issueNodeId(12), issueNodeId(13), addedToProject(2), staleOptionUpdate(2)])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe([
        'created: Issue acme/demo/12 from a.md',
        'added: Issue acme/demo/12 to project',
        `warning: could not set status ready of Issue acme/demo/12: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        'created: Issue acme/demo/13 from b.md',
        'added: Issue acme/demo/13 to project',
        `warning: could not set status ready of Issue acme/demo/13: ${STALE_OPTION_TEXT}`,
        '',
      ].join('\n'))
    })

    it.for([
      { name: 'レート制限', respond: { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } }, expected: 'GraphQL rate limit error: ' },
      { name: '型の無い error', respond: { status: 200, body: { errors: [{ message: 'cannot write' }] } }, expected: 'GraphQL query error: ' },
      { name: '500', respond: { status: 500, body: { message: 'boom' } }, expected: 'GraphQL query error: ' },
    ])('$name で欄の設定に失敗したときは、warning だけを出し、ID を読み直す案内を添えない', async (row) => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭') })
      await startGithub([
        linkedRepositories(),
        createdIssue(12),
        issueNodeId(12),
        addedToProject(),
        { match: { operation: 'UpdateProjectItemField' }, times: 1, respond: row.respond },
      ])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toContain(`warning: could not set status ready of Issue acme/demo/12: ${row.expected}`)
      expect(result.stderr).not.toContain('hint:')
    })

    it('親 Epic へのつなぎに失敗したとき、Issue の URL を標準出力に、error の行を標準エラーに出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_WITH_PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1), issueNodeId(3), failedSubIssue()])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand\n$/u)
    })

    it('途中のファイルで作成に失敗したとき、後のファイルを処理せず、終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
        'c.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '3 件目' }),
      })
      const github = await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1), failedIssueCreation(403)])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/\nerror: could not create an Issue in acme\/demo: .+\n$/u)
      const posts = github.requests().filter(request => request.type === 'rest' && request.method === 'POST' && request.path === '/repos/acme/demo/issues')
      expect(posts).toHaveLength(2)
    })

    it('ファイルの本文がテンプレに合わないとき、テンプレのパスを 1 行目にした error を出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, '## 関係のない見出し\n\n本文\n') })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(TEMPLATE_VIOLATION)
    })

    it('-m の本文がテンプレに合わないとき、テンプレのパスを 1 行目にした error を出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', '## 関係のない見出し\n\n本文\n')

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(TEMPLATE_VIOLATION)
    })

    it('status が型の既定の値でないとき、error の行を出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_FRONTMATTER, status: 'active' }) })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: the status at creation for type \'task\' is only \'ready\' (given: active)\n  hint: move it to pending or another status on the board after creation\n')
    })

    it.for([
      { name: 'ファイルが無い', body: TASK_BODY, files: ['missing.md'], expected: /^error: file not found: .+\/missing\.md\n$/u },
      { name: '同じファイルを重ねて渡す', body: TASK_BODY, files: ['draft.md', 'draft.md'], expected: /^error: file specified more than once: .+\/draft\.md\n$/u },
      { name: '先のファイルを指さないプレースホルダがある', body: TASK_BODY.replace('実現したい状態', '{{issue:later}} の後'), files: ['draft.md'], expected: /^error: \{\{issue:later\}\} in draft\.md does not point to an earlier file/u },
    ])('$name とき、1 件も作らずに error の行を出して終了コード 1 で終わる', async (row) => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, row.body) })

      const result = await create(...row.files.map(file => path.join(project.root, file)))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(row.expected)
    })

    it.for([
      { name: 'フロントマターが無い', content: TASK_BODY, expected: /^error: frontmatter not found/u },
      { name: 'repository が owner/repo の形でない', content: frontmatterFile({ ...TASK_FRONTMATTER, repository: 'demo' }), expected: /^error: invalid repository format in the frontmatter: 'demo'\n$/u },
    ])('$name とき、error の行を出して終了コード 1 で終わる', async ({ content, expected }) => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': content })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(expected)
    })

    it('同じ親 Epic に同じ order の Issue があるとき、作らずに error の行を出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_WITH_PARENT, order: '2' }) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE])])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('error: Epic #3 already has an Issue with order=2 (OPEN)\n  #9 #3-02: 先の子\n  next available order: 3\n')
    })

    it('リポジトリがプロジェクトにつながっていないとき、error の行を出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([linkedRepositories(1, [])])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not linked to the project\n' })
    })

    it('親 Epic の形が誤っているとき、使い方のエラーを出して終了コード 2 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_WITH_PARENT, parent_epic: 'abc' }) })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^Usage: pecot issue create \[OPTIONS\] \[files\]\.\.\.\n/u)
      expect(result.stderr).toContain('Invalid value: could not resolve parent_epic')
    })
  })

  describe('-m で直接作る', () => {
    it('--title と --repo を付けて打つと、status を省けば型の既定の status を設定して Issue を 1 件作る', async () => {
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const result = await create('-t', '一覧に状態を出す', '-r', 'acme/demo', '-m', TASK_BODY)

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\n')
      const requests = github.requests()
      expect(requests.at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
      expect(requests.find(request => request.type === 'rest')).toMatchObject({ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY } })
    })

    it('--label・--parent-epic・--order を付けると、status を設定し、ラベルを付け、親 Epic のサブ Issue につなぐ', async () => {
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '-l', 'a', '--label', 'b', '--parent-epic', '3', '--order', '3')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n')
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ body: { title: '[Task] #3-03: 題', labels: ['a', 'b'] } })
    })

    it.for([
      { name: '--priority', argv: ['--priority', 'high'] },
      { name: '--size', argv: ['--size', 'm'] },
    ])('$name を付けると、知らないオプションとして、何も作らずに終了コード 2 で終わる', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-87')
      setUpIssueProject()
      const github = await startGithub([])

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, ...row.argv)

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(`No such option: ${row.name}`)
      expect(github.requests()).toEqual([])
    })

    it('--status が有効な値でないとき、有効な値を並べた error の行を出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '--status', 'doing')

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: invalid status: doing\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n' })
    })

    it('--status が有効な値で型の既定の値でないとき、error の行を出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '--status', 'backlog')

      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: the status at creation for type \'task\' is only \'ready\' (given: backlog)\n  hint: move it to pending or another status on the board after creation\n')
    })

    it('--title を渡していないとき、error の行を出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-r', 'acme/demo', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --title is required with --message\n' })
    })

    it('epic 以外で --repo を渡していないとき、error の行を出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --repo is required with --message\n' })
    })

    it('--repo が owner/repo の形でないとき、error の行を出して終了コード 2 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo/x', '-m', TASK_BODY)

      expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: invalid repository format: acme/demo/x\n  expected: owner/repo\n' })
    })

    it('作り先のリポを含む設定が 2 つで選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async () => {
      setUpIssueProject({ files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({}) } })

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    })

    it('作り先のリポを含む設定が無いとき、どの設定にも無いと出して終了コード 1 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/unknown', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/unknown is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
    })

    it('--project を付けると、作り先のリポを含む設定が 2 つでも、その設定で作る', async () => {
      setUpIssueProject({ files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({}) } })
      await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const result = await create('-t', '題', '-r', 'acme/demo', '--project', 'second', '-m', TASK_BODY)

      expect(result.code).toBe(0)
    })

    it('Epic を --repo なしで作るとき、.active が無くて設定の数が 2 つなら、候補と --project の案内を出して終了コード 1 で終わる', async () => {
      setUpIssueProject({ aggregation: 'acme/demo', files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({ aggregation: 'acme/demo' }) } })

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-m', EPIC_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project, and 2 project configs exist\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    })

    it('Epic を --repo なしで --project を付けて作ると、その設定の aggregation_repo に作る', async () => {
      setUpIssueProject({ aggregation: 'acme/demo', files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({ aggregation: 'acme/other', otherRepositories: ['other'] }) } })
      const github = await startGithub([linkedRepositories(1, ['demo', 'other']), createdIssue(12, { repository: 'other' }), addedToProject(), updatedFields(1)])

      const result = await create('-t', '大きな仕事', '--type', 'epic', '--project', 'second', '-m', EPIC_BODY)

      expect(result.code).toBe(0)
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ path: '/repos/acme/other/issues', body: { title: '[Epic] 大きな仕事' } })
    })

    it('Epic を --repo なしで作ると、aggregation_repo に作る', async () => {
      setUpIssueProject({ aggregation: 'acme/demo' })
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-m', EPIC_BODY)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status backlog\n')
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ path: '/repos/acme/demo/issues', body: { title: '[Epic] 大きな仕事' } })
    })

    it('aggregation_repo と違うリポジトリに Epic を作ると、warning の行を出して続ける', async () => {
      setUpIssueProject({ aggregation: 'acme/demo', otherRepositories: ['other'] })
      await startGithub([linkedRepositories(1, ['demo', 'other']), createdIssue(12, { repository: 'other' }), addedToProject(), updatedFields(1)])

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-r', 'acme/other', '-m', EPIC_BODY)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe(
        'warning: --repo acme/other differs from aggregation_repo (acme/demo)\n  continuing as an exception for an Epic in an implementation repo\n'
        + 'created: Issue acme/other/12\nadded: Issue acme/other/12 to project\nset: Issue acme/other/12 status backlog\n',
      )
    })

    it('Epic の作り先を決められないとき、error の行を出して終了コード 2 で終わる', async () => {
      setUpIssueProject()

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-m', EPIC_BODY)

      expect(result.code).toBe(2)
      expect(result.stderr).toBe('error: cannot decide where to create the Epic\n  declare aggregation_repo in the project config, or pass --repo\n')
    })
  })

  describe('引数がないとき', () => {
    it('ファイルと -m のどちらも渡していないとき、使い方を error の行に出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-33')
      setUpIssueProject()

      const result = await create()

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'error: missing arguments\n  direct posting: pecot issue create --title <TITLE> --repo owner/repo --message <BODY>\n'
        + '  free format: pecot issue create --freeform --repo owner/repo --message <BODY>\n'
        + '  from a file: pecot issue create <path>\n',
      )
    })
  })

  describe('前提と進め方', () => {
    const BASE = ISSUE_URL_BASE

    it.for(REJECTED_INPUTS)('$name とき、何も投稿せずに終了コード 1 で終わる', async (row, context) => {
      await verifies(context, row.id)
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', ...row.first),
        'b.md': taskFile('次', ...row.second),
      })

      const files = [path.join(project.root, 'a.md'), path.join(project.root, 'b.md')]
      const result = await create(...files)

      expect(result).toEqual({ code: 1, stdout: '', stderr: row.expected })
    })

    it('前提の既存の Issue を読めないとき、1 件も作らずに、読めなかった Issue を示す error を出して終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/99')) })
      await startGithub([linkedRepositories(), blockedBySupported(), { match: { operation: 'GetIssueNodeId' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'not found' }] } } }])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: blocked_by in a\.md refers to acme\/demo\/99, which could not be read: .+\n$/u)
    })

    it('前提のあるファイルを渡すと、前提を付けて Blocked に置き、通し番号を振り、スタックできる並びを出す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', PARENT),
        'b.md': taskFile('次', PARENT, ...blockedBy('a')),
      })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-02: 先の子' }, { number: 10, state: 'OPEN', title: '#3-18a: 枝の子' }]),
        createdIssue(12),
        createdIssue(13),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(3, 2),
        blockedByAdded(),
        addedToProject(2),
        updatedFields(2),
        subIssueAdded(),
        subIssueAdded(),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${BASE}/12\n${BASE}/13\n\nStackable chains:\n- #12 -> #13\n`)
      expect(result.stderr).toBe(
        'created: Issue acme/demo/12 from a.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n'
        + 'created: Issue acme/demo/13 from b.md\nadded: blocked-by #12 to #13\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status blocked\nadded: Issue acme/demo/13 as sub-issue of acme/demo/3\n',
      )
      const requests = github.requests()
      expect(requests.filter(request => request.type === 'rest')).toMatchObject([
        { body: { title: '[Task] #3-19: 先頭' } },
        { body: { title: '[Task] #3-20: 次' } },
      ])
      expect(variablesOf(github, 'AddBlockedBy')).toMatchObject([{ issueId: 'I_kwDO13', blockingIssueId: 'I_kwDO12' }])
      expect(workflowWrites(github)).toMatchObject([{ optionId: 'o3' }, { optionId: 'o7' }])
    })

    it('前提を持つ Issue の本文には、スタック不可の前提の節だけを書く', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', 'blocked_by:', '  - issue: a', '    wait: merge', '    reason: 既定のブランチから配られる'),
        'c.md': taskFile('最後', ...blockedBy('b')),
      })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13),
        createdIssue(14),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(14),
        blockedByAdded(2),
        addedToProject(3),
        updatedFields(3),
      ])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toContain('added: blocked-by #12 to #13\n')
      expect(result.stderr).toContain('added: blocked-by #13 to #14\n')
      const bodies = github.requests().filter(request => request.type === 'rest').map(request => JSON.stringify(request))
      expect(bodies.map(body => body.includes('## Waits for merge'))).toEqual([false, true, false])
      expect(bodies.at(1)).toContain('- #12: 既定のブランチから配られる')
    })

    it('前提が済んだ既存の Issue だけを待つとき、Blocked で作ってから Ready へ動かす', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        issueNodeId(12),
        createdIssue(13),
        blockedByAdded(),
        issueNodeId(13),
        addedToProject(),
        updatedFields(2),
        prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: [{ number: 12, state: 'CLOSED', branch: 'feat/12', pullRequests: [{ number: 5, state: 'MERGED', head: 'feat/12' }] }] }),
      ])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${BASE}/13\n`)
      expect(result.stderr).toBe(
        'created: Issue acme/demo/13 from a.md\nadded: blocked-by #12 to #13\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status blocked\nmoved: #13 Blocked -> Ready (startable)\n',
      )
      expect(workflowWrites(github)).toMatchObject([{ optionId: 'o7' }, { optionId: 'o3' }])
    })

    it('欄と列の直しがどちらも古い ID で書けないとき、project activate の案内を 1 回だけ出す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')), 'b.md': taskFile('次') })
      await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        issueNodeId(12),
        createdIssue(13),
        createdIssue(14),
        blockedByAdded(),
        issueNodeId(13),
        issueNodeId(14),
        addedToProject(2),
        updatedFields(1),
        staleOptionUpdate(2),
        prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: [{ number: 12, state: 'CLOSED', branch: 'feat/12', pullRequests: [{ number: 5, state: 'MERGED', head: 'feat/12' }] }] }),
      ])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe([
        'created: Issue acme/demo/13 from a.md',
        'added: blocked-by #12 to #13',
        'added: Issue acme/demo/13 to project',
        'set: Issue acme/demo/13 status blocked',
        `warning: could not move #13: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        'created: Issue acme/demo/14 from b.md',
        'added: Issue acme/demo/14 to project',
        `warning: could not set status ready of Issue acme/demo/14: ${STALE_OPTION_TEXT}`,
        '',
      ].join('\n'))
    })

    it('作成の応答に node_id が無いとき、ボードへ先に足して、その node ID で前提を付ける', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', ...blockedBy('a')),
      })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13, { withoutNodeId: true }),
        issueNodeId(12),
        issueNodeId(13),
        blockedByAdded(),
        addedToProject(2),
        updatedFields(2),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toContain('created: Issue acme/demo/13 from b.md\nadded: Issue acme/demo/13 to project\nadded: blocked-by #12 to #13\nset: Issue acme/demo/13 status blocked\n')
      const operations = github.requests().filter(request => request.type === 'graphql').map(request => request.operation)
      expect(operations.filter(operation => operation === 'AddToProject')).toHaveLength(2)
      expect(operations.indexOf('AddBlockedBy')).toBeGreaterThan(operations.lastIndexOf('AddToProject'))
    })

    it('前提を付けるのに失敗したとき、warning と付け直すコマンドを出し、Issue は残して全件を作り終え、終了コード 1 で終わる', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', 'blocked_by:', '  - issue: a', '    wait: merge', '    reason: 配られる'),
      })
      await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13),
        issueNodeId(12),
        issueNodeId(13),
        failedBlockedBy(),
        addedToProject(2),
        updatedFields(2),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`${BASE}/12\n${BASE}/13\n`)
      expect(result.stderr).toMatch(/\nwarning: could not add blocked-by #12 to #13: .+\nadded: Issue acme\/demo\/13 to project\n/u)
      expect(result.stderr).toMatch(/\nerror: could not add some blocked-by; add them again with:\n {2}pecot issue block acme\/demo\/13 --by acme\/demo\/12 --wait merge --reason '配られる'\n$/u)
    })

    it('ボードに Blocked の列が無いとき、前提のある Issue を Ready で作り、warning を 1 回だけ出す', async () => {
      const project = setUpIssueProject({ withoutBlockedColumn: true })
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', ...blockedBy('a')),
        'c.md': taskFile('最後', ...blockedBy('b')),
      })
      await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13),
        createdIssue(14),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(14),
        blockedByAdded(2),
        addedToProject(3),
        updatedFields(3),
      ])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(0)
      expect(result.stderr.split('warning: the board has no Blocked column')).toHaveLength(2)
      expect(result.stderr.match(/set: Issue acme\/demo\/\d+ status ready\n/gu)).toHaveLength(3)
    })

    it.for([
      { name: '既定のブランチの設定が無い', develop: { developBranch: undefined }, blockedBy: [OPEN_PREREQUISITE], expected: '' },
      { name: '読めた前提が付けた数に足りない', develop: {}, blockedBy: [], expected: 'warning: could not read all blocked-by of #13 yet; left it in Blocked\n' },
    ])('$name とき、Blocked のまま残す', async (row) => {
      const project = setUpIssueProject(row.develop)
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        issueNodeId(12),
        createdIssue(13),
        blockedByAdded(),
        issueNodeId(13),
        addedToProject(),
        updatedFields(1),
        prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: row.blockedBy }),
      ])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`created: Issue acme/demo/13 from a.md\nadded: blocked-by #12 to #13\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status blocked\n${row.expected}`)
      expect(github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toHaveLength(1)
    })

    const UNSUPPORTED = 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'

    it('依存関係に対応しないサーバで blocked_by を書いたとき、何も作らずに error を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-58')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
      const github = await startGithub([linkedRepositories(), blockedByUnsupported()])

      const files = inRoot(project.root, 'a.md', 'b.md')
      const result = await create(...files)

      expect(result).toEqual({ code: 1, stdout: '', stderr: `error: ${UNSUPPORTED}\n` })
      expect(github.requests().map(request => request.type === 'rest' ? request.method : request.operation)).toEqual(['GetLinkedRepositoriesUser', 'HasAddBlockedByInput'])
    })

    it('付け直すコマンドの --reason は、シェルに展開されないよう単一引用符で包む', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', 'blocked_by:', '  - issue: a', '    wait: merge', '    reason: "tick ` $(rm -rf x) it\'s"'),
      })
      await startGithub([linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), issueNodeId(12), issueNodeId(13), failedBlockedBy(), addedToProject(2), updatedFields(2)])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('pecot issue block acme/demo/13 --by acme/demo/12 --wait merge --reason \'tick ` $(rm -rf x) it\'\\\'\'s\'\n')
    })

    it('前提を 1 件付けられなくても、同じ Issue の残りの前提と、あとのファイルを作り終える', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', ...blockedBy('a')),
        'c.md': taskFile('3 番目', ...blockedBy('a', 'b')),
        'd.md': taskFile('最後'),
      })
      await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13),
        createdIssue(14),
        createdIssue(15),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(14),
        issueNodeId(15),
        failedBlockedBy(),
        blockedByAdded(2),
        addedToProject(4),
        updatedFields(4),
      ])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md', 'd.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe([12, 13, 14, 15].map(number => `${BASE}/${String(number)}\n`).join(''))
      expect(result.stderr.match(/warning: could not add blocked-by/gu)).toHaveLength(1)
      expect(result.stderr).toContain('added: blocked-by #12 to #14\nadded: blocked-by #13 to #14\n')
      expect(result.stderr).toContain('created: Issue acme/demo/15 from d.md\n')
      expect(result.stderr).toMatch(/\nerror: could not add some blocked-by; add them again with:\n {2}pecot issue block acme\/demo\/13 --by acme\/demo\/12\n$/u)
    })

    it('作成が途中で失敗したとき、作った Issue どうしの前提だけを付ける', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', ...blockedBy('a')),
        'c.md': taskFile('最後', ...blockedBy('b')),
      })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        createdIssue(12),
        createdIssue(13),
        failedIssueCreation(403),
        issueNodeId(12),
        issueNodeId(13),
        blockedByAdded(),
        addedToProject(2),
        updatedFields(2),
      ])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('added: blocked-by #12 to #13\n')
      expect(result.stderr).not.toContain('to #14')
      expect(variablesOf(github, 'AddBlockedBy')).toHaveLength(1)
    })

    it('列を書けなかったとき、前提の判定を読まず、列を動かさない', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      await startGithub([linkedRepositories(), blockedBySupported(), issueNodeId(12), createdIssue(13), blockedByAdded(), issueNodeId(13), addedToProject(), staleOptionUpdate()])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe([
        'created: Issue acme/demo/13 from a.md',
        'added: blocked-by #12 to #13',
        'added: Issue acme/demo/13 to project',
        `warning: could not set status blocked of Issue acme/demo/13: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        '',
      ].join('\n'))
      expect(result.stdout).toBe(`${BASE}/13\n\nStackable chains:\n- #12 -> #13\n`)
    })

    it('ファイルの作り先が別々のプロジェクトの設定に分かれると、1 件も作らずに終了コード 1 で終わる', async () => {
      const otherOnly = configText({}).replaceAll('"name": "demo"', '"name": "other"')
      const project = setUpIssueProject({ files: { '.pecot/config/projects/second.json': otherOnly } })
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': rawFrontmatterFile(['type: task', 'repository: acme/other', 'title: 別のリポ']),
      })
      const github = await startGithub([])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md'))

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: the files belong to different project configs: a.md (ghes.example.com_acme_board_acme), b.md (second)\n  post them separately\n' })
      expect(github.requests()).toEqual([])
    })

    it('一括の中で同じ親 Epic に同じ order を書いたファイルがあるとき、何も作らずに終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-57')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', PARENT, 'order: 4'),
        'b.md': taskFile('次', PARENT, 'order: 4'),
      })

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: order 4 is specified by more than one file: a.md, b.md\n' })
    })
  })

  describe('MCP の data', () => {
    const DIRECT = { title: '一覧に状態を出す', repo: 'acme/demo', message: TASK_BODY }

    it('message で作ると、作った Issue の番号・URL・書いた status を data.issues に返す', async () => {
      setUpIssueProject()
      await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await createTool(DIRECT)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issues: [{ owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready' }] })
    })

    it('親 Epic を付けて作ると、つないだ親の参照を data.issues の parent に返す', async () => {
      setUpIssueProject()
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ ...DIRECT, parent_epic: '3', order: 3 })

      expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready', parent: 'acme/demo/3' }])
    })

    it('前提の済んだ Issue を Blocked で作って Ready へ動かすと、data.issues の status を ready にする', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        issueNodeId(12),
        createdIssue(13),
        blockedByAdded(),
        issueNodeId(13),
        addedToProject(),
        updatedFields(2),
        prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: [{ number: 12, state: 'CLOSED', branch: 'feat/12', pullRequests: [{ number: 5, state: 'MERGED', head: 'feat/12' }] }] }),
      ])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

      expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'ready' }])
    })

    it('Blocked の ID が古くて列を書けないと、書けなかった列と案内を warnings に返し、data.issues に status を返さない', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-24')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      const github = await startGithub([
        linkedRepositories(),
        blockedBySupported(),
        issueNodeId(12),
        createdIssue(13),
        blockedByAdded(),
        issueNodeId(13),
        addedToProject(),
        staleOptionUpdate(),
      ])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

      expect(workflowWrites(github)).toEqual([expect.objectContaining({ optionId: 'o7' })])
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([
        `could not set status blocked of Issue acme/demo/13: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
      ])
      expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13` }])
    })

    it('途中のファイルで作成に失敗すると、作り終えた Issue を失敗の data.issues に残す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
      })
      await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1), failedIssueCreation(403)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready' }])
    })

    it('前提を付けられずに partial-failure で終わっても、作り終えた Issue をすべて data.issues に残す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
      await startGithub([linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), issueNodeId(12), issueNodeId(13), failedBlockedBy(), addedToProject(2), updatedFields(2)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'partial-failure' } })
      expect(outcome.structured['issues']).toEqual([
        { owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12`, status: 'ready' },
        { owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'blocked' },
      ])
    })
  })

  describe('MCP の呼び出し', () => {
    const DIRECT = { title: '一覧に状態を出す', repo: 'acme/demo', message: TASK_BODY }
    const ISSUE_12 = { owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12` }

    it('message の repo が owner/repo の形でないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-40')
      setUpIssueProject()

      const outcome = await createTool({ title: '題', repo: 'acme/demo/x', message: TASK_BODY })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid repository format: acme/demo/x\n  expected: owner/repo' })
    })

    it('ファイルを 2 つ渡すと、渡した順に作って {{issue:key}} を前の番号に直し、ボードと親 Epic につなぎ、issues に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-04')
      await verifies(context, 'PW-ISSUE-CREATE-08')
      await verifies(context, 'PW-ISSUE-CREATE-09')
      await verifies(context, 'PW-ISSUE-CREATE-10')
      await verifies(context, 'PW-ISSUE-CREATE-11')
      await verifies(context, 'PW-ISSUE-CREATE-13')
      await verifies(context, 'PW-ISSUE-CREATE-17')
      await verifies(context, 'PW-ISSUE-CREATE-18')
      await verifies(context, 'PW-ISSUE-CREATE-19')
      await verifies(context, 'PW-ISSUE-CREATE-20')
      const project = setUpIssueProject()
      const secondBody = TASK_BODY.replace('実現したい状態', '{{issue:first}} が終わってから進める。')
      writeTree(project.root, {
        'first.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '先に作る Issue', parent_epic: 'acme/demo/3', order: '2' }),
        'second.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '後に作る Issue', parent_epic: 'acme/demo/3', order: '3' }, secondBody),
      })
      const github = await startGithub([
        linkedRepositories(),
        parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-01: 先の子' }]),
        createdIssue(12),
        createdIssue(13),
        issueNodeId(12),
        issueNodeId(13),
        issueNodeId(3, 2),
        addedToProject(2),
        updatedFields(2),
        subIssueAdded(),
        subIssueAdded(),
      ])

      const outcome = await createTool({ files: inRoot(project.root, 'first.md', 'second.md'), type: 'epic', status: 'backlog' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issues: [
          { ...ISSUE_12, status: 'ready', parent: 'acme/demo/3' },
          { owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'ready', parent: 'acme/demo/3' },
        ],
      })
      expect(postsOf(github)).toMatchObject([
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-02: 先に作る Issue' } },
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-03: 後に作る Issue' } },
      ])
      expect(JSON.stringify(postsOf(github).at(1))).toContain('#12 が終わってから進める。')
      expect(variablesOf(github, 'UpdateProjectItemField')).toMatchObject([{ fieldId: 'PVTSSF_workflow', optionId: 'o3' }, { fieldId: 'PVTSSF_workflow', optionId: 'o3' }])
    })

    it('フロントマターに旧い priority・size があっても、読み捨てて作り、ボードには status だけを設定する', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-88')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', 'priority: high', 'size: s'),
        'b.md': taskFile('次', 'priority: urgent', 'size: ""'),
      })
      const github = await startGithub([linkedRepositories(), createdIssue(12), createdIssue(13), issueNodeId(12), issueNodeId(13), addedToProject(2), updatedFields(2)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issues: [
          { ...ISSUE_12, status: 'ready' },
          { owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'ready' },
        ],
      })
      expect(variablesOf(github, 'UpdateProjectItemField')).toMatchObject([{ fieldId: 'PVTSSF_workflow', optionId: 'o3' }, { fieldId: 'PVTSSF_workflow', optionId: 'o3' }])
    })

    it.for([
      { name: 'priority', arguments_: { priority: 'high' } },
      { name: 'size', arguments_: { size: 'm' } },
    ])('$name を渡すと、無い入力として止まり、Issue を作らない', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-87')
      setUpIssueProject()
      const github = await startGithub([])

      const outcome = await createTool({ ...DIRECT, ...row.arguments_ })

      expect(outcome.isError).toBe(true)
      expect(JSON.stringify(outcome)).toContain(row.name)
      expect(github.requests()).toEqual([])
    })

    it('files と message を一緒に渡すと、message の本文を使わずにファイルから作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-07')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      const github = await startGithub(fileRules())

      const outcome = await createTool({ files: inRoot(project.root, 'draft.md'), message: '使われない本文' })

      expect(outcome.structured['issues']).toEqual([{ ...ISSUE_12, status: 'ready' }])
      expect(postsOf(github)).toMatchObject([{ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY.trimEnd() } }])
    })

    it('ボードへの追加に失敗したとき、warnings に入れ、作った Issue を issues に入れて次のファイルへ進む', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-21')
      await verifies(context, 'PW-ISSUE-CREATE-22')
      await verifies(context, 'PW-ISSUE-CREATE-23')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
      })
      await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), failedAddToProject(), createdIssue(13), issueNodeId(13), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['issues']).toEqual([ISSUE_12, { owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'ready' }])
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not add Issue acme\/demo\/12 to project: /u)])
    })

    it('ボードへの追加に失敗しても、親 Epic へつなぎ、warnings に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-21')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), failedAddToProject(), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['issues']).toEqual([{ ...ISSUE_12, parent: 'acme/demo/3' }])
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not add Issue acme\/demo\/12 to project: /u)])
    })

    it('欄の設定に失敗したとき、失敗を warnings へ入れ、project_activate の案内を添えて、次のファイルの欄を設定する', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-24')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次') })
      const github = await startGithub([linkedRepositories(), createdIssue(12), createdIssue(13), issueNodeId(12), issueNodeId(13), addedToProject(2), staleOptionUpdate(1), updatedFields(1)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([
        `could not set status ready of Issue acme/demo/12: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
      ])
      expect(variablesOf(github, 'UpdateProjectItemField')).toHaveLength(2)
    })

    it('500 で欄の設定に失敗したときは、warnings に入れ、ID を読み直す案内を添えない', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-24')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭') })
      await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), { match: { operation: 'UpdateProjectItemField' }, times: 1, respond: { status: 500, body: { message: 'boom' } } }])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not set status ready of Issue acme\/demo\/12: GraphQL query error: /u)])
      expect(JSON.stringify(outcome.structured['warnings'])).not.toContain('hint:')
    })

    it('親 Epic へのつなぎに失敗したとき、作った Issue を issues に入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-25')
      await verifies(context, 'PW-ISSUE-CREATE-26')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_WITH_PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1), issueNodeId(3), failedSubIssue()])

      const outcome = await createTool({ files: inRoot(project.root, 'draft.md') })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['issues']).toEqual([{ ...ISSUE_12, status: 'ready' }])
      expect(outcome.structured['detail']).toMatch(/^could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand$/u)
    })

    it('途中のファイルで作成に失敗したとき、後のファイルを処理せず、作り終えた Issue を残して失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-27')
      await verifies(context, 'PW-ISSUE-CREATE-28')
      await verifies(context, 'PW-ISSUE-CREATE-39')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
        'c.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '3 件目' }),
      })
      const github = await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(1), failedIssueCreation(403)])

      const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(outcome.structured['detail']).toMatch(/^could not create an Issue in acme\/demo: /u)
      expect(outcome.structured['issues']).toEqual([{ ...ISSUE_12, status: 'ready' }])
      expect(postsOf(github)).toHaveLength(2)
    })

    it.for([
      { name: 'ファイル', arguments_: (root: string): Record<string, unknown> => ({ files: inRoot(root, 'draft.md') }) },
      { name: 'message', arguments_: (): Record<string, unknown> => ({ title: '題', repo: 'acme/demo', message: '## 関係のない見出し\n\n本文\n' }) },
    ])('$name の本文がテンプレに合わないとき、kind が content-invalid の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-29')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, '## 関係のない見出し\n\n本文\n') })

      const outcome = await createTool(row.arguments_(project.root))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('content-invalid')
      expect(outcome.structured['detail']).toMatch(/^the body does not follow the template .+\/templates\/issue\/task\.md\n {2}missing sections: /u)
    })

    it.for([
      { name: 'ファイルの status', arguments_: (root: string): Record<string, unknown> => ({ files: inRoot(root, 'draft.md') }), given: 'active' },
      { name: 'message の status', arguments_: (): Record<string, unknown> => ({ ...DIRECT, status: 'backlog' }), given: 'backlog' },
    ])('$name が型の既定の値でないとき、kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-30')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_FRONTMATTER, status: 'active' }) })

      const outcome = await createTool(row.arguments_(project.root))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: `the status at creation for type 'task' is only 'ready' (given: ${row.given})\n  hint: move it to pending or another status on the board after creation` })
    })

    it.for([
      { name: 'ファイルが無い', body: TASK_BODY, files: ['missing.md'], detail: /^file not found: .+\/missing\.md$/u },
      { name: '同じファイルを重ねて渡す', body: TASK_BODY, files: ['draft.md', 'draft.md'], detail: /^file specified more than once: .+\/draft\.md$/u },
      { name: '先のファイルを指さないプレースホルダがある', body: TASK_BODY.replace('実現したい状態', '{{issue:later}} の後'), files: ['draft.md'], detail: /^\{\{issue:later\}\} in draft\.md does not point to an earlier file/u },
    ])('$name とき、1 件も作らずに失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-34')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, row.body) })
      const github = await startGithub([])

      const outcome = await createTool({ files: inRoot(project.root, ...row.files) })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toMatch(row.detail)
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'フロントマターが無い', content: TASK_BODY, detail: /^frontmatter not found/u },
      { name: 'repository が owner/repo の形でない', content: frontmatterFile({ ...TASK_FRONTMATTER, repository: 'demo' }), detail: /^invalid repository format in the frontmatter: 'demo'$/u },
    ])('$name とき、kind が content-invalid の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-35')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': row.content })

      const outcome = await createTool({ files: inRoot(project.root, 'draft.md') })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('content-invalid')
      expect(outcome.structured['detail']).toMatch(row.detail)
    })

    it('同じ親 Epic に同じ order の Issue があるとき、作らずに kind が order-conflict の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-36')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_WITH_PARENT, order: '2' }) })
      const github = await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE])])

      const outcome = await createTool({ files: inRoot(project.root, 'draft.md') })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'order-conflict', detail: 'Epic #3 already has an Issue with order=2 (OPEN)\n  #9 #3-02: 先の子\n  next available order: 3' })
      expect(postsOf(github)).toEqual([])
    })

    it('リポジトリがプロジェクトにつながっていないとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-37')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([linkedRepositories(1, [])])

      const outcome = await createTool({ files: inRoot(project.root, 'draft.md') })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not linked to the project' })
    })

    it('parent_epic の形が誤っているとき、受け付ける形を detail に入れて、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-COMMON-28')
      await verifies(context, 'PW-ISSUE-CREATE-43')
      setUpIssueProject()

      const outcome = await createTool({ ...DIRECT, parent_epic: 'abc' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('could not resolve parent_epic: invalid reference: abc')
      expect(outcome.structured['detail']).toContain('- full: \'owner/repo/N\'')
      expect(outcome.structured['detail']).not.toMatch(/Usage:|[╭│╰]/u)
    })

    it('message に title と repo を渡すと、status を省けば型の既定の status を設定して Issue を 1 件作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-05')
      await verifies(context, 'PW-ISSUE-CREATE-12')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await createTool(DIRECT)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'ready' }] })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
      expect(postsOf(github)).toMatchObject([{ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY } }])
    })

    it('label・parent_epic・order を渡すと、status を設定し、ラベルを付け、親 Epic のサブ Issue につなぐ', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-11')
      await verifies(context, 'PW-ISSUE-CREATE-13')
      await verifies(context, 'PW-ISSUE-CREATE-19')
      await verifies(context, 'PW-ISSUE-CREATE-20')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

      const outcome = await createTool({ title: '題', repo: 'acme/demo', message: TASK_BODY, label: ['a', 'b'], parent_epic: '3', order: 3 })

      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'ready', parent: 'acme/demo/3' }] })
      expect(postsOf(github)).toMatchObject([{ body: { title: '[Task] #3-03: 題', labels: ['a', 'b'] } }])
      expect(variablesOf(github, 'UpdateProjectItemField')).toMatchObject([{ fieldId: 'PVTSSF_workflow', optionId: 'o3' }])
    })

    it('message の status が有効な値でないとき、有効な値を並べた detail を入れて、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-44')
      setUpIssueProject()

      const outcome = await createTool({ ...DIRECT, status: 'doing' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid status: doing\n  valid values: backlog/pending/blocked/ready/active/in_review/archived' })
    })

    it.for([
      { name: 'title が無い', id: 'PW-ISSUE-CREATE-31', arguments_: { repo: 'acme/demo', message: TASK_BODY }, detail: 'title is required with message' },
      { name: 'epic 以外で repo が無い', id: 'PW-ISSUE-CREATE-32', arguments_: { title: '題', message: TASK_BODY }, detail: 'repo is required with message' },
    ])('message で $name とき、kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      setUpIssueProject()

      const outcome = await createTool(row.arguments_)

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: row.detail })
    })

    it('作り先のリポを含む設定が 2 つで選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-38')
      setUpIssueProject({ files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({}) } })

      const outcome = await createTool(DIRECT)

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('作り先のリポを含む設定が無いとき、どの設定にも無いことと設定の名前の一覧を detail に入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-74')
      setUpIssueProject()

      const outcome = await createTool({ ...DIRECT, repo: 'acme/unknown' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/unknown is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、作り先のリポを含む設定が 2 つでも、その設定で作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-75')
      setUpIssueProject({ files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({}) } })
      await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ ...DIRECT, project: 'second' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'ready' }] })
    })

    it('Epic を repo なしで作るとき、.active が無くて設定の数が 2 つなら、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-76')
      setUpIssueProject({ aggregation: 'acme/demo', files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({ aggregation: 'acme/demo' }) } })

      const outcome = await createTool({ title: '大きな仕事', type: 'epic', message: EPIC_BODY })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'no active project, and 2 project configs exist\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('Epic を repo なしで project を付けて作ると、その設定の aggregation_repo に作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-77')
      setUpIssueProject({ aggregation: 'acme/demo', files: { '.pecot/config/projects/.active': '', '.pecot/config/projects/second.json': configText({ aggregation: 'acme/other', otherRepositories: ['other'] }) } })
      const github = await startGithub([linkedRepositories(1, ['demo', 'other']), createdIssue(12, { repository: 'other' }), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ title: '大きな仕事', type: 'epic', project: 'second', message: EPIC_BODY })

      expect(outcome.isError).toBe(false)
      expect(postsOf(github)).toMatchObject([{ path: '/repos/acme/other/issues', body: { title: '[Epic] 大きな仕事' } }])
    })

    it('Epic を repo なしで作ると、aggregation_repo に作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-14')
      setUpIssueProject({ aggregation: 'acme/demo' })
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ title: '大きな仕事', type: 'epic', message: EPIC_BODY })

      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'backlog' }] })
      expect(postsOf(github)).toMatchObject([{ path: '/repos/acme/demo/issues', body: { title: '[Epic] 大きな仕事' } }])
    })

    it('aggregation_repo と違うリポジトリに Epic を作ると、warnings に入れて続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-15')
      setUpIssueProject({ aggregation: 'acme/demo', otherRepositories: ['other'] })
      await startGithub([linkedRepositories(1, ['demo', 'other']), createdIssue(12, { repository: 'other' }), addedToProject(), updatedFields(1)])

      const outcome = await createTool({ title: '大きな仕事', type: 'epic', repo: 'acme/other', message: EPIC_BODY })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual(['repo: "acme/other" differs from aggregation_repo (acme/demo)\n  continuing as an exception for an Epic in an implementation repo'])
    })

    it('Epic の作り先を決められないとき、kind が repo-setting-missing の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-42')
      setUpIssueProject()

      const outcome = await createTool({ title: '大きな仕事', type: 'epic', message: EPIC_BODY })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-setting-missing', detail: 'cannot decide where to create the Epic\n  declare aggregation_repo in the project config, or pass repo' })
    })

    it('files と message のどちらも渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-33')
      setUpIssueProject()

      const outcome = await createTool({})

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toMatch(/^missing arguments\n/u)
    })

    describe('前提と進め方', () => {
      it.for(REJECTED_INPUTS)('$name とき、何も作らずに失敗を返す', async (row, context) => {
        await verifies(context, row.id)
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭', ...row.first), 'b.md': taskFile('次', ...row.second) })

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured).toEqual({ kind: row.kind, detail: row.expected.replace(/^error: /u, '').trimEnd() })
      })

      it('前提の既存の Issue を読めないとき、1 件も作らずに、読めなかった Issue を示す失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-52')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/99')) })
        const github = await startGithub([linkedRepositories(), blockedBySupported(), { match: { operation: 'GetIssueNodeId' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'not found' }] } } }])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured['detail']).toMatch(/^blocked_by in a\.md refers to acme\/demo\/99, which could not be read: /u)
        expect(postsOf(github)).toEqual([])
      })

      it('前提のあるファイルを渡すと、前提を付けて Blocked に置き、通し番号を振り、スタックできる並びを stackableChains に返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-46')
        await verifies(context, 'PW-ISSUE-CREATE-47')
        await verifies(context, 'PW-ISSUE-CREATE-49')
        await verifies(context, 'PW-ISSUE-CREATE-56')
        const project = setUpIssueProject()
        writeTree(project.root, {
          'a.md': taskFile('先頭', PARENT),
          'b.md': taskFile('次', PARENT, ...blockedBy('a')),
        })
        const github = await startGithub([
          linkedRepositories(),
          blockedBySupported(),
          parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-02: 先の子' }, { number: 10, state: 'OPEN', title: '#3-18a: 枝の子' }]),
          createdIssue(12),
          createdIssue(13),
          issueNodeId(12),
          issueNodeId(13),
          issueNodeId(3, 2),
          blockedByAdded(),
          addedToProject(2),
          updatedFields(2),
          subIssueAdded(),
          subIssueAdded(),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.structured).toEqual({
          issues: [
            { ...ISSUE_12, status: 'ready', parent: 'acme/demo/3' },
            { owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'blocked', parent: 'acme/demo/3' },
          ],
          stackableChains: [['#12', '#13']],
        })
        expect(postsOf(github)).toMatchObject([{ body: { title: '[Task] #3-19: 先頭' } }, { body: { title: '[Task] #3-20: 次' } }])
        expect(variablesOf(github, 'AddBlockedBy')).toMatchObject([{ issueId: 'I_kwDO13', blockingIssueId: 'I_kwDO12' }])
        expect(workflowWrites(github)).toMatchObject([{ optionId: 'o3' }, { optionId: 'o7' }])
      })

      it('wait が merge の前提を付けると、その前提と reason を本文の Waits for merge の節に書く', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-50')
        const project = setUpIssueProject()
        writeTree(project.root, {
          'a.md': taskFile('先頭'),
          'b.md': taskFile('次', 'blocked_by:', '  - issue: a', '    wait: merge', '    reason: 既定のブランチから配られる'),
          'c.md': taskFile('最後', ...blockedBy('b')),
        })
        const github = await startGithub([
          linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), createdIssue(14),
          issueNodeId(12), issueNodeId(13), issueNodeId(14), blockedByAdded(2), addedToProject(3), updatedFields(3),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

        expect(outcome.isError).toBe(false)
        const bodies = postsOf(github).map(request => JSON.stringify(request))
        expect(bodies.map(body => body.includes('## Waits for merge'))).toEqual([false, true, false])
        expect(bodies.at(1)).toContain('- #12: 既定のブランチから配られる')
      })

      it('作成の応答に node_id が無いとき、ボードへ先に足して、その node ID で前提を付ける', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-46')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
        const github = await startGithub([
          linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13, { withoutNodeId: true }),
          issueNodeId(12), issueNodeId(13), blockedByAdded(), addedToProject(2), updatedFields(2),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.isError).toBe(false)
        const operations = github.requests().filter(request => request.type === 'graphql').map(request => request.operation)
        expect(operations.filter(operation => operation === 'AddToProject')).toHaveLength(2)
        expect(operations.indexOf('AddBlockedBy')).toBeGreaterThan(operations.lastIndexOf('AddToProject'))
      })

      it('前提を付けるのに失敗したとき、warnings に入れ、detail に付け直す issue_block の呼び方を入れて、kind が partial-failure の失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-51')
        const project = setUpIssueProject()
        writeTree(project.root, {
          'a.md': taskFile('先頭'),
          'b.md': taskFile('次', 'blocked_by:', '  - issue: a', '    wait: merge', '    reason: 配られる'),
          'c.md': taskFile('最後'),
        })
        await startGithub([
          linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), createdIssue(14),
          issueNodeId(12), issueNodeId(13), issueNodeId(14), failedBlockedBy(), addedToProject(3), updatedFields(3),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('partial-failure')
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not add blocked-by #12 to #13: /u)])
        const hint = 'issue_block with issue_ref: "acme/demo/13", by: "acme/demo/12", wait: "merge", reason: "配られる"'
        expect(outcome.structured['detail']).toBe(`could not add some blocked-by; add them again with:\n  ${hint}`)
        expect(outcome.structured['issues']).toHaveLength(3)
      })

      it('前提のあるタスクを作るとき、ボードに Blocked の列が無ければ、Ready に置いて warnings に 1 回だけ入れる', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-47')
        const project = setUpIssueProject({ withoutBlockedColumn: true })
        writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')), 'c.md': taskFile('最後', ...blockedBy('b')) })
        await startGithub([
          linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), createdIssue(14),
          issueNodeId(12), issueNodeId(13), issueNodeId(14), blockedByAdded(2), addedToProject(3), updatedFields(3),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

        expect(outcome.isError).toBe(false)
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^the board has no Blocked column/u)])
        expect(outcome.structured['issues']).toMatchObject([{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }])
      })

      it('既存の Issue を前提にした Issue を作ると、前提が済んでいれば Ready の列へ動かす', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-48')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
        const github = await startGithub([
          linkedRepositories(), blockedBySupported(), issueNodeId(12), createdIssue(13), blockedByAdded(), issueNodeId(13), addedToProject(), updatedFields(2),
          prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: [{ number: 12, state: 'CLOSED', branch: 'feat/12', pullRequests: [{ number: 5, state: 'MERGED', head: 'feat/12' }] }] }),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

        expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'ready' }])
        expect(workflowWrites(github)).toMatchObject([{ optionId: 'o7' }, { optionId: 'o3' }])
      })

      it('既存の Issue を前提にした Issue を作り、読めた前提が付けた数に足りないとき、Blocked のまま残す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-48')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
        const github = await startGithub([
          linkedRepositories(), blockedBySupported(), issueNodeId(12), createdIssue(13), blockedByAdded(), issueNodeId(13), addedToProject(), updatedFields(1),
          prerequisitesRule({ number: 13, column: 'Blocked', blockedBy: [] }),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md') })

        expect(outcome.structured['issues']).toEqual([{ owner: 'acme', repository: 'demo', number: 13, url: `${ISSUE_URL_BASE}/13`, status: 'blocked' }])
        expect(outcome.structured['warnings']).toEqual(['could not read all blocked-by of #13 yet; left it in Blocked'])
        expect(workflowWrites(github)).toHaveLength(1)
      })

      it('同じ親 Epic に同じ order を書いたファイルが一括の中に 2 つあるとき、何も作らずに kind が order-conflict の失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-57')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭', PARENT, 'order: 4'), 'b.md': taskFile('次', PARENT, 'order: 4') })

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured).toEqual({ kind: 'order-conflict', detail: 'order 4 is specified by more than one file: a.md, b.md' })
      })

      it('依存関係に対応しないサーバで blocked_by を書いたとき、何も作らずに kind が dependency-rejected の失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-58')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
        const github = await startGithub([linkedRepositories(), blockedByUnsupported()])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required' })
        expect(postsOf(github)).toEqual([])
      })

      it('作成が途中で失敗したとき、作った Issue どうしの前提だけを付けて失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-59')
        const project = setUpIssueProject()
        writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')), 'c.md': taskFile('最後', ...blockedBy('b')) })
        const github = await startGithub([
          linkedRepositories(), blockedBySupported(), createdIssue(12), createdIssue(13), failedIssueCreation(403),
          issueNodeId(12), issueNodeId(13), blockedByAdded(), addedToProject(2), updatedFields(2),
        ])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

        expect(outcome.isError).toBe(true)
        expect(variablesOf(github, 'AddBlockedBy')).toMatchObject([{ issueId: 'I_kwDO13', blockingIssueId: 'I_kwDO12' }])
      })

      it('ファイルの作り先が別々のプロジェクトの設定に分かれると、ファイルと設定の名前を detail に入れ、1 件も作らずに失敗を返す', async (context) => {
        await verifies(context, 'PW-ISSUE-CREATE-78')
        const otherOnly = configText({}).replaceAll('"name": "demo"', '"name": "other"')
        const project = setUpIssueProject({ files: { '.pecot/config/projects/second.json': otherOnly } })
        writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': rawFrontmatterFile(['type: task', 'repository: acme/other', 'title: 別のリポ']) })
        const github = await startGithub([])

        const outcome = await createTool({ files: inRoot(project.root, 'a.md', 'b.md') })

        expect(outcome.isError).toBe(true)
        expect(outcome.structured['detail']).toBe('the files belong to different project configs: a.md (ghes.example.com_acme_board_acme), b.md (second)\n  post them separately')
        expect(github.requests()).toEqual([])
      })
    })
  })
})
