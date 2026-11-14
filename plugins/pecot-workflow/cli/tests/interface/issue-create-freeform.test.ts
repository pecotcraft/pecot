/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_COMMANDS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import {
  addedToProject,
  createdIssue,
  failedAddToProject,
  failedSubIssue,
  issueNodeId,
  ISSUE_URL_BASE,
  linkedRepositories,
  setUpIssueProject,
  subIssueAdded,
  updatedFields,
} from '../_helpers/issue-create-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const PENDING_FLAGS = { '.pecot/state/issue-pending': '1\n', '.pecot/state/issue-create-slash-pending': '1\n' }
const MESSAGE = '一覧の状態列を直す'
const FOOTER = 'issue create の freeform で起票（テンプレ検証スキップ）'

async function freeform(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'create', '--freeform', ...argv], ISSUE_CREATE_COMMANDS)
}

function hasFile(root: string, relative: string): boolean {
  return existsSync(path.join(root, relative))
}

describe('issue create', () => {
  it('メッセージとリポジトリを渡すと、テンプレートに照らさず Issue を 1 件作り、ボードに足して欄を設定し、URL を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-60')
    await verifies(context, 'PW-ISSUE-CREATE-62')
    await verifies(context, 'PW-ISSUE-CREATE-64')
    const project = setUpIssueProject({ files: PENDING_FLAGS })
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await freeform('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready, priority medium, size s\n')
    const post = github.requests().find(request => request.type === 'rest')
    expect(post).toMatchObject({ body: { title: `[Task] ${MESSAGE}` } })
    expect(post?.type === 'rest' ? JSON.stringify(post.body) : '').toContain(`${MESSAGE}\\n\\n<!-- ${FOOTER}`)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(true)
    expect(hasFile(project.root, '.pecot/state/issue-pending')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/issue-create-slash-pending')).toBe(false)
  })

  it('長いメッセージを渡すと、先頭 50 文字の連続する空白を 1 つにしたものを type の接頭辞つきの題にする', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-61')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])
    const message = `先頭の   行\n次の行 ${'あ'.repeat(60)}`

    const result = await freeform('-m', message, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    const post = github.requests().find(request => request.type === 'rest')
    const expectedTitle = `[Task] 先頭の 行 次の行 ${'あ'.repeat(50 - '先頭の   行\n次の行 '.length)}`
    expect(post).toMatchObject({ body: { title: expectedTitle } })
    const sent = post?.type === 'rest' ? JSON.stringify(post.body) : ''
    expect(sent).toContain(String.raw`先頭の   行\n次の行 ${'あ'.repeat(60)}\n\n<!-- ${FOOTER}`)
  })

  it('Epic に --parent-epic を付けると、warning の行を出して親につなぎ、欄は backlog と medium だけで size を付けず、quick のフラグを作らない', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-62')
    await verifies(context, 'PW-ISSUE-CREATE-63')
    await verifies(context, 'PW-ISSUE-CREATE-64')
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(2), issueNodeId(3), subIssueAdded()])

    const result = await freeform('-m', MESSAGE, '-r', 'acme/demo', '--type', 'epic', '--parent-epic', '3')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe(
      'warning: giving a parent Epic to an Epic is not recommended\ncreated: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status backlog, priority medium\n'
      + 'added: Issue acme/demo/12 as sub-issue of acme/demo/3\n',
    )
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
  })

  it('--priority と --size を渡すと、既定の medium・s の代わりにその値を設定する', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-73')
    setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await freeform('-m', MESSAGE, '-r', 'acme/demo', '--priority', 'high', '--size', 'm')

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready, priority high, size m\n')
  })

  it('ボードへの追加に失敗したとき、warning の行と Issue の URL を出し、欄の設定をせず、quick のフラグを作らずに終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-65')
    await verifies(context, 'PW-ISSUE-CREATE-74')
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), failedAddToProject()])

    const result = await freeform('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12\nwarning: could not add Issue acme\/demo\/12 to project: .+\n$/u)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
  })

  it('親 Epic へのつなぎに失敗したとき、Issue の URL を標準出力に出して終了コード 1 で終わり、作成の直後に pending のフラグを消している', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-66')
    await verifies(context, 'PW-ISSUE-CREATE-75')
    const project = setUpIssueProject({ files: PENDING_FLAGS })
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3), issueNodeId(3), failedSubIssue()])

    const result = await freeform('-m', MESSAGE, '-r', 'acme/demo', '--parent-epic', '3')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand\n$/u)
    expect(hasFile(project.root, '.pecot/state/issue-pending')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/issue-create-slash-pending')).toBe(false)
  })

  it.for([
    { name: '無い', argv: ['-r', 'acme/demo'] },
    { name: '空白だけ', argv: ['-m', '  \n ', '-r', 'acme/demo'] },
  ])('--message が $name とき、error の行を出して終了コード 2 で終わる', async (row, context) => {
    await verifies(context, 'PW-ISSUE-CREATE-67')
    setUpIssueProject()

    const result = await freeform(...row.argv)

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --message is required with --freeform\n' })
  })

  it('--repo が無いとき、error の行を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-68')
    setUpIssueProject()

    const result = await freeform('-m', MESSAGE)

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --repo is required with --freeform\n' })
  })

  it.for([
    { name: '--prepare', argv: ['--prepare', '-m', MESSAGE, '-r', 'acme/demo'] },
    { name: 'ファイル', argv: ['-m', MESSAGE, '-r', 'acme/demo', 'a.md'] },
    { name: '--title', argv: ['-m', MESSAGE, '-r', 'acme/demo', '-t', '題'] },
  ])('$name と一緒に打ったとき、何も作らずに終了コード 2 で終わる', async (row, context) => {
    await verifies(context, 'PW-ISSUE-CREATE-69')
    setUpIssueProject()

    const result = await freeform(...row.argv)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: --freeform cannot be used with --prepare, --files or --title\n')
  })
})
