/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_COMMANDS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { writeTree } from '../../src/tests/_helpers/temporary.js'
import type { ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult, RunningGithub } from '../_helpers/interface-case.js'
import {
  addedToProject,
  blockedByAdded,
  blockedBySupported,
  blockedByUnsupported,
  createdIssue,
  EPIC_BODY,
  failedAddToProject,
  failedBlockedBy,
  failedFieldUpdate,
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
  subIssuesPage,
  TASK_BODY,
  TASK_FRONTMATTER,
  updatedFields,
} from '../_helpers/issue-create-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec } from '../_helpers/prerequisites.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const PENDING_FLAGS = { '.pecot/state/issue-pending': '1\n', '.pecot/state/issue-create-slash-pending': '1\n' }

async function create(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'create', ...argv], ISSUE_CREATE_COMMANDS)
}

function hasFlag(root: string, name: string): boolean {
  return existsSync(path.join(root, '.pecot/state', name))
}

// 親 Epic を持たない 1 件の投稿で、ファイル入力が通る応答（node_id はボードへの追加の側で取る）
function fileRules(number = 12): ResponseRule[] {
  return [linkedRepositories(), createdIssue(number), issueNodeId(number), addedToProject(), updatedFields(3)]
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

const OPEN_PREREQUISITE: IssueSpec = { number: 12, state: 'OPEN' }

const TASK_WITH_PARENT = { ...TASK_FRONTMATTER, parent_epic: 'acme/demo/3', order: '3' }

describe('issue create', () => {
  describe('--prepare', () => {
    it('--template と --repo を渡すと、リポジトリを入れたテンプレのコピーを出力ディレクトリに書き、そのパスを標準出力に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-01')
      await verifies(context, 'PW-ISSUE-CREATE-02')
      await verifies(context, 'PW-ISSUE-CREATE-16')
      const project = setUpIssueProject()

      const result = await create('--prepare', '--template', 'bug', '--repo', 'acme/demo')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      const written = result.stdout.trimEnd()
      expect(written.startsWith(`${project.root}/.pecot/tmp/output/`)).toBe(true)
      expect(written).toMatch(/\/issue-bug-\d{8}-\d{6}\.md$/u)
      expect(result.stdout.endsWith('\n')).toBe(true)
      const content = readFileSync(written, 'utf8')
      expect(content).toContain('repository: acme/demo')
      expect(content).not.toContain('repository: ""')
    })

    it('--suffix を渡すと、コピーのファイル名の末尾に suffix を付ける', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-03')
      setUpIssueProject()

      const result = await create('-p', '--template', 'task', '-r', 'acme/demo', '--suffix', 'part-a')

      expect(result.code).toBe(0)
      expect(result.stdout.trimEnd()).toMatch(/\/issue-task-\d{8}-\d{6}-part-a\.md$/u)
    })

    it('ファイルを一緒に渡すと、Issue を作らずにテンプレのコピーだけを書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-06')
      setUpIssueProject()

      const result = await create('--prepare', '--template', 'task', '--repo', 'acme/demo', '/no/such/file.md')

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/issue-task-\d{8}-\d{6}\.md\n$/u)
      expect(result.stderr).toBe('')
    })

    it('epic 以外で --repo を渡していないとき、error の行を出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-41')
      setUpIssueProject()

      const result = await create('--prepare', '--template', 'task')

      expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --repo owner/repo is required with --template task|bug|tracker|task-implement\n' })
    })

    it('--repo が owner/repo の形でないとき、error の行を出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-40')
      setUpIssueProject()

      const result = await create('--prepare', '--template', 'task', '--repo', 'acme')

      expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: invalid repository format: acme\n  expected: owner/repo\n' })
    })
  })

  describe('ファイルから作る', () => {
    it('ファイルを 2 つ渡すと、渡した順に作って {{issue:key}} を前の番号に直し、ボードと親 Epic につなぎ、フラグを消す', async (context) => {
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
      const project = setUpIssueProject({ files: PENDING_FLAGS })
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
        updatedFields(6),
        subIssueAdded(),
        subIssueAdded(),
      ])

      // --type などのオプションは、ファイルのフロントマターの値に負ける
      const result = await create(path.join(project.root, 'first.md'), path.join(project.root, 'second.md'), '--type', 'epic', '--status', 'backlog', '--priority', 'low')

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n${ISSUE_URL_BASE}/13\n`)
      expect(result.stderr).toBe(
        'created: Issue acme/demo/12 from first.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready, priority high, size s\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n'
        + 'created: Issue acme/demo/13 from second.md\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status ready, priority high, size s\nadded: Issue acme/demo/13 as sub-issue of acme/demo/3\n',
      )
      const posts = github.requests().filter(request => request.type === 'rest')
      expect(posts).toMatchObject([
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-02: 先に作る Issue' } },
        { method: 'POST', path: '/repos/acme/demo/issues', body: { title: '[Task] #3-03: 後に作る Issue' } },
      ])
      expect(JSON.stringify(posts.at(1)?.body)).toContain('#12 が終わってから進める。')
      expect(hasFlag(project.root, 'issue-pending')).toBe(false)
      expect(hasFlag(project.root, 'issue-create-slash-pending')).toBe(false)
    })

    it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルから作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-07')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      const github = await startGithub(fileRules())

      const result = await create(path.join(project.root, 'draft.md'), '-m', '使われない本文')

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      const post = github.requests().find(request => request.type === 'rest')
      expect(post).toMatchObject({ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY.trimEnd() } })
    })

    it('ボードへの追加に失敗したとき、warning の行と Issue の URL を出し、次のファイルへ進んで終了コード 0 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-21')
      await verifies(context, 'PW-ISSUE-CREATE-22')
      await verifies(context, 'PW-ISSUE-CREATE-23')
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
        updatedFields(3),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n${ISSUE_URL_BASE}/13\n`)
      expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12 from a\.md\nwarning: could not add Issue acme\/demo\/12 to project: .+\ncreated: Issue acme\/demo\/13 from b\.md\nadded: Issue acme\/demo\/13 to project\nset: Issue acme\/demo\/13 status ready, priority high, size s\n$/u)
    })

    it('ボードへの追加に失敗しても、親 Epic へつなぎ、Issue の URL を 1 回だけ出して終了コード 0 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-21')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), failedAddToProject(), issueNodeId(3), subIssueAdded()])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12 from a\.md\nwarning: could not add Issue acme\/demo\/12 to project: .+\nadded: Issue acme\/demo\/12 as sub-issue of acme\/demo\/3\n$/u)
    })

    it('欄の設定に失敗したとき、失敗を出さずに残りの欄を設定して続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-24')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([
        linkedRepositories(),
        createdIssue(12),
        issueNodeId(12),
        addedToProject(),
        { match: { operation: 'UpdateProjectItemField' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'cannot set' }] } } },
        updatedFields(2),
      ])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toBe('created: Issue acme/demo/12 from draft.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 priority high, size s\n')
    })

    it('親 Epic へのつなぎに失敗したとき、Issue の URL を標準出力に、error の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-25')
      await verifies(context, 'PW-ISSUE-CREATE-26')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_WITH_PARENT) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(3), issueNodeId(3), failedSubIssue()])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand\n$/u)
    })

    it('途中のファイルで作成に失敗したとき、後のファイルを処理せず、終了コード 1 で終わり、免除のフラグを残す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-27')
      await verifies(context, 'PW-ISSUE-CREATE-28')
      await verifies(context, 'PW-ISSUE-CREATE-39')
      const project = setUpIssueProject({ files: PENDING_FLAGS })
      writeTree(project.root, {
        'a.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '1 件目' }),
        'b.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '2 件目' }),
        'c.md': frontmatterFile({ ...TASK_FRONTMATTER, title: '3 件目' }),
      })
      const github = await startGithub([linkedRepositories(), createdIssue(12), issueNodeId(12), addedToProject(), updatedFields(3), failedIssueCreation(403)])

      const result = await create(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toMatch(/\nerror: could not create an Issue in acme\/demo: .+\n$/u)
      const posts = github.requests().filter(request => request.type === 'rest' && request.method === 'POST' && request.path === '/repos/acme/demo/issues')
      expect(posts).toHaveLength(2)
      expect(hasFlag(project.root, 'issue-create-slash-pending')).toBe(true)
    })

    it('ファイルの本文がテンプレに合わないとき、テンプレのパスを 1 行目にした error を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-29')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, '## 関係のない見出し\n\n本文\n') })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(TEMPLATE_VIOLATION)
    })

    it('-m の本文がテンプレに合わないとき、テンプレのパスを 1 行目にした error を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-29')
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', '## 関係のない見出し\n\n本文\n')

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(TEMPLATE_VIOLATION)
    })

    it('status が型の既定の値でないとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-30')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_FRONTMATTER, status: 'active' }) })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: the status at creation for type \'task\' is only \'ready\' (given: active)\n  hint: move it to pending or another status on the board after creation\n')
    })

    it.for([
      { id: 'PW-ISSUE-CREATE-34', name: 'ファイルが無い', body: TASK_BODY, files: ['missing.md'], expected: /^error: file not found: .+\/missing\.md\n$/u },
      { id: 'PW-ISSUE-CREATE-34', name: '同じファイルを重ねて渡す', body: TASK_BODY, files: ['draft.md', 'draft.md'], expected: /^error: file specified more than once: .+\/draft\.md\n$/u },
      { id: 'PW-ISSUE-CREATE-34', name: '先のファイルを指さないプレースホルダがある', body: TASK_BODY.replace('実現したい状態', '{{issue:later}} の後'), files: ['draft.md'], expected: /^error: \{\{issue:later\}\} in draft\.md does not point to an earlier file/u },
    ])('$name とき、1 件も作らずに error の行を出して終了コード 1 で終わる', async (row, context) => {
      await verifies(context, row.id)
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER, row.body) })

      const result = await create(...row.files.map(file => path.join(project.root, file)))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(row.expected)
    })

    it.for([
      { id: 'PW-ISSUE-CREATE-35', name: 'フロントマターが無い', content: TASK_BODY, expected: /^error: frontmatter not found/u },
      { id: 'PW-ISSUE-CREATE-35', name: 'repository が owner/repo の形でない', content: frontmatterFile({ ...TASK_FRONTMATTER, repository: 'demo' }), expected: /^error: invalid repository format in the frontmatter: 'demo'\n$/u },
    ])('$name とき、error の行を出して終了コード 1 で終わる', async ({ id, content, expected }, context) => {
      await verifies(context, id)
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': content })

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(expected)
    })

    it('同じ親 Epic に同じ order の Issue があるとき、作らずに error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-36')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile({ ...TASK_WITH_PARENT, order: '2' }) })
      await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE])])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('error: Epic #3 already has an Issue with order=2 (OPEN)\n  #9 #3-02: 先の子\n  next available order: 3\n')
    })

    it('リポジトリがプロジェクトにつながっていないとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-37')
      const project = setUpIssueProject()
      writeTree(project.root, { 'draft.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([linkedRepositories(1, [])])

      const result = await create(path.join(project.root, 'draft.md'))

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not linked to the project\n' })
    })

    it('親 Epic の形が誤っているとき、使い方のエラーを出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-43')
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
    it('--title と --repo を付けて打つと、status を省けば型の既定の status を設定して Issue を 1 件作り、フラグを消す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-05')
      await verifies(context, 'PW-ISSUE-CREATE-12')
      const project = setUpIssueProject({ files: PENDING_FLAGS })
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const result = await create('-t', '一覧に状態を出す', '-r', 'acme/demo', '-m', TASK_BODY)

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\n')
      const requests = github.requests()
      expect(requests.at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
      expect(requests.find(request => request.type === 'rest')).toMatchObject({ body: { title: '[Task] 一覧に状態を出す', body: TASK_BODY } })
      expect(hasFlag(project.root, 'issue-pending')).toBe(false)
      expect(hasFlag(project.root, 'issue-create-slash-pending')).toBe(false)
    })

    it('--priority・--size・--label・--parent-epic・--order を付けると、欄を設定し、ラベルを付け、親 Epic のサブ Issue につなぐ', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-13')
      await verifies(context, 'PW-ISSUE-CREATE-20')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentEpic(3, [EXISTING_SUB_ISSUE]), createdIssue(12), addedToProject(), updatedFields(3), issueNodeId(3), subIssueAdded()])

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '--priority', 'high', '--size', 'm', '-l', 'a', '--label', 'b', '--parent-epic', '3', '--order', '3')

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready, priority high, size m\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n')
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ body: { title: '[Task] #3-03: 題', labels: ['a', 'b'] } })
    })

    it('--status が有効な値でないとき、有効な値を並べた error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-44')
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '--status', 'doing')

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: invalid status: doing\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n' })
    })

    it('--status が有効な値で型の既定の値でないとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-30')
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY, '--status', 'backlog')

      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: the status at creation for type \'task\' is only \'ready\' (given: backlog)\n  hint: move it to pending or another status on the board after creation\n')
    })

    it('--title を渡していないとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-31')
      setUpIssueProject()

      const result = await create('-r', 'acme/demo', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: -t (title) is required with -m\n' })
    })

    it('epic 以外で --repo を渡していないとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-32')
      setUpIssueProject()

      const result = await create('-t', '題', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: -r (repository) is required with -m\n' })
    })

    it('--repo が owner/repo の形でないとき、error の行を出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-40')
      setUpIssueProject()

      const result = await create('-t', '題', '-r', 'acme/demo/x', '-m', TASK_BODY)

      expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: invalid repository format: acme/demo/x\n  expected: owner/repo\n' })
    })

    it('アクティブなプロジェクトが無いとき、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-38')
      setUpIssueProject({ files: { '.pecot/config/projects/.active': '' } })

      const result = await create('-t', '題', '-r', 'acme/demo', '-m', TASK_BODY)

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
    })

    it('Epic を --repo なしで作ると、aggregation_repo に作る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-14')
      setUpIssueProject({ aggregation: 'acme/demo' })
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-m', EPIC_BODY)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status backlog\n')
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ path: '/repos/acme/demo/issues', body: { title: '[Epic] 大きな仕事' } })
    })

    it('aggregation_repo と違うリポジトリに Epic を作ると、warning の行を出して続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-15')
      setUpIssueProject({ aggregation: 'acme/demo' })
      await startGithub([linkedRepositories(1, ['demo', 'other']), createdIssue(12, { repository: 'other' }), addedToProject(), updatedFields(1)])

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-r', 'acme/other', '-m', EPIC_BODY)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe(
        'warning: --repo acme/other differs from aggregation_repo (acme/demo)\n  continuing as an exception for an Epic in an implementation repo\n'
        + 'created: Issue acme/other/12\nadded: Issue acme/other/12 to project\nset: Issue acme/other/12 status backlog\n',
      )
    })

    it('Epic の作り先を決められないとき、error の行を出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-42')
      setUpIssueProject()

      const result = await create('-t', '大きな仕事', '--type', 'epic', '-m', EPIC_BODY)

      expect(result.code).toBe(2)
      expect(result.stderr).toBe('error: cannot decide where to create the Epic\n  declare aggregation_repo in the project config, or pass --repo\n')
    })
  })

  describe('引数がないとき', () => {
    it('--prepare・ファイル・-m のどれも渡していないとき、使い方を error の行に出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-33')
      setUpIssueProject()

      const result = await create()

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'error: missing arguments\n  direct posting: pecot issue create -t "TITLE" -r owner/repo -m "BODY"\n'
        + '  prepare a template: pecot issue create --prepare --template task --repo owner/repo\n  from a file: pecot issue create <path>\n',
      )
    })
  })

  describe('前提と進め方', () => {
    const BASE = ISSUE_URL_BASE

    // 親 Epic #3 の下に 4 つのファイルを、番号を省いて置く。前提は 1 → 2 → 3 の鎖と、3 のマージを待つ 4 番目
    function chainFiles(root: string): string[] {
      writeTree(root, {
        'a.md': taskFile('先頭', PARENT),
        'b.md': taskFile('2 番目', PARENT, ...blockedBy('a')),
        'c.md': taskFile('3 番目', PARENT, ...blockedBy('b')),
        'd.md': taskFile('4 番目', PARENT, 'blocked_by:', '  - issue: c', '    wait: merge', '    reason: 既定のブランチから配られる'),
      })
      return inRoot(root, 'a.md', 'b.md', 'c.md', 'd.md')
    }

    it('--plan を付けると、投稿せずに進め方の表と積める並びを標準出力に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-45')
      const project = setUpIssueProject()
      const files = chainFiles(project.root)
      const github = await startGithub([linkedRepositories(), blockedBySupported(), parentEpic(3, [EXISTING_SUB_ISSUE])])

      const result = await create('--plan', ...files)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe([
        '| File | Number | Blocked by | Approach |',
        '|---|---|---|---|',
        '| a | 3 | - | alone |',
        '| b | 4 | a | stack on a |',
        '| c | 5 | b | stack on b |',
        '| d | 6 | c (merge) | wait for merge of c |',
        '',
        'Stackable chains:',
        '- a -> b -> c',
        '',
      ].join('\n'))
      expect(github.requests().map(request => request.type === 'rest' ? request.method : request.operation)).toEqual(['GetLinkedRepositoriesUser', 'HasAddBlockedByInput', 'GetIssueSlim'])
    })

    it.for([
      { name: '-m と一緒に打った', argv: ['--plan', '-t', '題', '-r', 'acme/demo', '-m', TASK_BODY] },
      { name: '--prepare と一緒に打った', argv: ['--plan', '--prepare', '--template', 'task', '--repo', 'acme/demo'] },
      { name: 'ファイルを渡さずに打った', argv: ['--plan'] },
    ])('--plan を $name とき、何も投稿せずに終了コード 2 で終わる', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-55')
      setUpIssueProject()

      const result = await create(...row.argv)

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: --plan /u)
    })

    const REJECTED_INPUTS = [
      { id: 'PW-ISSUE-CREATE-52', name: '前提が一括のどのファイルのキーにも当たらない', second: blockedBy('nope'), first: [], expected: 'error: blocked_by in b.md refers to unknown key nope\n' },
      { id: 'PW-ISSUE-CREATE-52', name: '前提が輪になる', second: blockedBy('a'), first: blockedBy('b'), expected: 'error: blocked_by forms a cycle: a -> b -> a\n' },
      { id: 'PW-ISSUE-CREATE-52', name: '前提が後ろのファイルを指す', second: [], first: blockedBy('b'), expected: 'error: blocked_by in a.md refers to b, which comes later\n' },
      { id: 'PW-ISSUE-CREATE-52', name: '同じ前提を 2 回書く', second: [...blockedBy('a'), '  - issue: a'], first: [], expected: 'error: blocked_by in b.md refers to a more than once\n' },
      { id: 'PW-ISSUE-CREATE-53', name: 'parallel を書く', second: ['parallel: true'], first: [], expected: 'error: parallel is no longer supported in b.md. Remove it\n' },
      { id: 'PW-ISSUE-CREATE-53', name: 'parallel とほかの誤りを両方書く', second: ['parallel: true', 'size: zzz'], first: [], expected: 'error: parallel is no longer supported in b.md. Remove it\n' },
      { id: 'PW-ISSUE-CREATE-54', name: 'wait: merge に reason が無い', second: ['blocked_by:', '  - issue: a', '    wait: merge'], first: [], expected: 'error: blocked_by in b.md needs reason for wait: merge\n' },
    ].flatMap(row => [{ ...row, isPlan: false }, { ...row, isPlan: true }])

    it.for(REJECTED_INPUTS)('$name とき（--plan: $isPlan）、何も投稿せずに終了コード 1 で終わる', async (row, context) => {
      await verifies(context, row.id)
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', ...row.first),
        'b.md': taskFile('次', ...row.second),
      })

      const files = [path.join(project.root, 'a.md'), path.join(project.root, 'b.md')]
      const result = await create(...row.isPlan ? ['--plan', ...files] : files)

      expect(result).toEqual({ code: 1, stdout: '', stderr: row.expected })
    })

    it('前提の既存の Issue を読めないとき、1 件も作らずに、読めなかった Issue を示す error を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-52')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/99')) })
      await startGithub([linkedRepositories(), blockedBySupported(), { match: { operation: 'GetIssueNodeId' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'not found' }] } } }])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: blocked_by in a\.md refers to acme\/demo\/99, which could not be read: .+\n$/u)
    })

    it('前提のあるファイルを渡すと、前提を付けて Blocked に置き、通し番号を振り、積める並びを出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-46')
      await verifies(context, 'PW-ISSUE-CREATE-47')
      await verifies(context, 'PW-ISSUE-CREATE-49')
      await verifies(context, 'PW-ISSUE-CREATE-56')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', PARENT, 'priority: high', 'size: s'),
        'b.md': taskFile('次', PARENT, 'priority: high', 'size: s', ...blockedBy('a')),
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
        updatedFields(6),
        subIssueAdded(),
        subIssueAdded(),
      ])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${BASE}/12\n${BASE}/13\n\nStackable chains:\n- #12 -> #13\n`)
      expect(result.stderr).toBe(
        'created: Issue acme/demo/12 from a.md\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready, priority high, size s\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n'
        + 'created: Issue acme/demo/13 from b.md\nadded: blocked-by #12 to #13\nadded: Issue acme/demo/13 to project\nset: Issue acme/demo/13 status blocked, priority high, size s\nadded: Issue acme/demo/13 as sub-issue of acme/demo/3\n',
      )
      const requests = github.requests()
      expect(requests.filter(request => request.type === 'rest')).toMatchObject([
        { body: { title: '[Task] #3-19: 先頭' } },
        { body: { title: '[Task] #3-20: 次' } },
      ])
      expect(variablesOf(github, 'AddBlockedBy')).toMatchObject([{ issueId: 'I_kwDO13', blockingIssueId: 'I_kwDO12' }])
      expect(workflowWrites(github)).toMatchObject([{ optionId: 'o3' }, { optionId: 'o7' }])
    })

    it('前提を持つ Issue の本文には、マージを待つ前提の節だけを書く', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-50')
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

    it('前提が済んだ既存の Issue だけを待つとき、Blocked で作ってから Ready へ動かす', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-48')
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

    it('作成の応答に node_id が無いとき、ボードへ先に足して、その node ID で前提を付ける', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-46')
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

    it('前提を付けるのに失敗したとき、warning と付け直すコマンドを出し、Issue は残して全件を作り終え、免除のフラグを消して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-51')
      const project = setUpIssueProject({ files: PENDING_FLAGS })
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
      expect(hasFlag(project.root, 'issue-create-slash-pending')).toBe(false)
    })

    it('ボードに Blocked の列が無いとき、前提のある Issue を Ready で作り、warning を 1 回だけ出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-47')
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

    it('ボードに Blocked の列が無いとき、--plan ではこれからの動きとして warning を 1 回だけ出す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-47')
      const project = setUpIssueProject({ withoutBlockedColumn: true })
      writeTree(project.root, {
        'a.md': taskFile('先頭'),
        'b.md': taskFile('次', ...blockedBy('a')),
        'c.md': taskFile('最後', ...blockedBy('b')),
      })
      await startGithub([linkedRepositories(), blockedBySupported()])

      const result = await create('--plan', ...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: the board has no Blocked column; Issues with blocked-by will be created in Ready\n')
    })

    it.for([
      { name: '既定のブランチの設定が無い', develop: { developBranch: undefined }, blockedBy: [OPEN_PREREQUISITE], expected: '' },
      { name: '読めた前提が付けた数に足りない', develop: {}, blockedBy: [], expected: 'warning: could not read all blocked-by of #13 yet; left it in Blocked\n' },
    ])('$name とき、Blocked のまま残す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-48')
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

    it.for([{ isPlan: false }, { isPlan: true }])('依存関係に対応しないサーバで blocked_by を書いたとき（--plan: $isPlan）、何も作らずに error を出して終了コード 1 で終わる', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-58')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
      const github = await startGithub([linkedRepositories(), blockedByUnsupported()])

      const files = inRoot(project.root, 'a.md', 'b.md')
      const result = await create(...row.isPlan ? ['--plan', ...files] : files)

      expect(result).toEqual({ code: 1, stdout: '', stderr: `error: ${UNSUPPORTED}\n` })
      expect(github.requests().map(request => request.type === 'rest' ? request.method : request.operation)).toEqual(['GetLinkedRepositoriesUser', 'HasAddBlockedByInput'])
    })

    it('付け直すコマンドの --reason は、シェルに展開されないよう単一引用符で包む', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-51')
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

    it('前提を 1 件付けられなくても、同じ Issue の残りの前提と、あとのファイルを作り終える', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-51')
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

    it('作成が途中で失敗したとき、作った Issue どうしの前提だけを付け、免除のフラグを残す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-59')
      const project = setUpIssueProject({ files: PENDING_FLAGS })
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
      expect(hasFlag(project.root, 'issue-create-slash-pending')).toBe(true)
    })

    it('列を書けなかったとき、前提の判定を読まず、列を動かさない', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-48')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')) })
      await startGithub([linkedRepositories(), blockedBySupported(), issueNodeId(12), createdIssue(13), blockedByAdded(), issueNodeId(13), addedToProject(), failedFieldUpdate()])

      const result = await create(path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('created: Issue acme/demo/13 from a.md\nadded: blocked-by #12 to #13\nadded: Issue acme/demo/13 to project\n')
      expect(result.stdout).toBe(`${BASE}/13\n\nStackable chains:\n- #12 -> #13\n`)
    })

    it('既存の Issue の表記は、一括の先頭のファイルのリポジトリを基準にそろえる', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-45')
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')),
        'b.md': rawFrontmatterFile(['type: task', 'repository: acme/other', 'title: 別のリポ', ...blockedBy('acme/demo/12')]),
        'c.md': taskFile('最後', ...blockedBy('acme/other/7')),
      })
      await startGithub([linkedRepositories(1, ['demo', 'other']), blockedBySupported(), issueNodeId(12), issueNodeId(7, 1, 'other')])

      const result = await create('--plan', ...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe([
        '| File | Number | Blocked by | Approach |',
        '|---|---|---|---|',
        '| a | - | #12 | stack on #12 |',
        '| b | - | #12 | stack on #12 |',
        '| c | - | acme/other#7 | stack on acme/other#7 |',
        '',
        'Stackable chains:',
        '- #12 -> a',
        '- #12 -> b',
        '- acme/other#7 -> c',
        '',
      ].join('\n'))
    })

    it('親 Epic のサブ Issue が複数のページにわたっても、全ページの最大の次の番号を振る', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-49')
      const project = setUpIssueProject()
      writeTree(project.root, { 'a.md': taskFile('先頭', PARENT) })
      await startGithub([
        linkedRepositories(),
        parentEpic(3, [EXISTING_SUB_ISSUE], 1, 'cursor1'),
        subIssuesPage([{ number: 30, state: 'OPEN', title: '#3-21: 2 ページ目の子' }]),
      ])

      const result = await create('--plan', path.join(project.root, 'a.md'))

      expect(result.code).toBe(0)
      expect(result.stdout).toBe('| File | Number | Blocked by | Approach |\n|---|---|---|---|\n| a | 22 | - | alone |\n')
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
})
