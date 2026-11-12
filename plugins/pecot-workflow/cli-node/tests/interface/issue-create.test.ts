/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_COMMANDS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { writeTree } from '../../src/tests/_helpers/temporary.js'
import type { ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import {
  addedToProject,
  createdIssue,
  EPIC_BODY,
  failedAddToProject,
  failedIssueCreation,
  failedSubIssue,
  frontmatterFile,
  issueNodeId,
  ISSUE_URL_BASE,
  linkedRepositories,
  parentEpic,
  setUpIssueProject,
  subIssueAdded,
  TASK_BODY,
  TASK_FRONTMATTER,
  updatedFields,
} from '../_helpers/issue-create-case.js'
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
        linkedRepositories(2),
        parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-01: 先の子' }], 2),
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
        linkedRepositories(2),
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
      expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n$/u)
    })

    it('途中のファイルで作成に失敗したとき、後のファイルを処理せず、終了コード 1 で終わり、免除のフラグを残す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-27')
      await verifies(context, 'PW-ISSUE-CREATE-28')
      await verifies(context, 'PW-ISSUE-CREATE-39')
      const project = setUpIssueProject({ files: PENDING_FLAGS })
      writeTree(project.root, { 'a.md': frontmatterFile(TASK_FRONTMATTER), 'b.md': frontmatterFile(TASK_FRONTMATTER) })
      await startGithub([linkedRepositories(), failedIssueCreation(403)])

      const result = await create(path.join(project.root, 'a.md'), path.join(project.root, 'b.md'))

      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: could not create an Issue in acme\/demo: .+\n$/u)
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
      expect(result.stderr).toBe('error: Epic #3 already has an Issue with order=2 (OPEN)\n  #9 #3-02: 先の子\n  next available order: 1\n')
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

      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: invalid status: doing\n  valid values: backlog/pending/ready/active/in_review/archived\n' })
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
})
