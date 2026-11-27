/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CREATE_TOOLS } from '../../src/commands/issue-create.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { ToolRunResult, RunningGithub } from '../_helpers/interface-case.js'
import {
  addedToProject,
  createdIssue,
  failedAddToProject,
  failedSubIssue,
  issueNodeId,
  ISSUE_URL_BASE,
  linkedRepositories,
  parentLane,
  setUpIssueProject,
  subIssueAdded,
  updatedFields,
} from '../_helpers/issue-create-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const MESSAGE = '一覧の状態列を直す'
const FOOTER = 'issue create の freeform で起票（テンプレ検証スキップ）'

async function freeform(arguments_: Readonly<Record<string, unknown>> = {}): Promise<ToolRunResult> {
  return await runInProcess('issue_create', { freeform: true, ...arguments_ }, ISSUE_CREATE_TOOLS)
}

function hasQuickMode(root: string): boolean {
  return existsSync(path.join(root, '.pecot/state/.pecot-quick-mode'))
}

const ISSUE_12 = { owner: 'acme', repository: 'demo', number: 12, url: `${ISSUE_URL_BASE}/12` }

async function freeformTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_CREATE_TOOLS, 'issue_create', { freeform: true, ...argumentsOfTool })
}

function sentBody(github: RunningGithub): string {
  const post = github.requests().find(request => request.type === 'rest')
  return post?.type === 'rest' ? JSON.stringify(post.body) : ''
}

function fieldWrites(github: RunningGithub): number {
  return github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField').length
}

describe('issue_create', () => {
  it('メッセージとリポジトリを渡すと、テンプレートの検証をせず Issue を 1 件作り、ボードへ追加して status を設定し、URL を出す', async () => {
    await explains('`issue_create` の `freeform` の基本の動作のテストです。メッセージとリポジトリを渡した場合に、テンプレートの検証はせずに Issue を 1 件作り、ボードへ追加して `status` を設定し、URL を標準出力へ出力することを確認します。')
    const project = setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

    const result = await freeform({ message: MESSAGE, repo: 'acme/demo' })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe('created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status ready\n')
    const post = github.requests().find(request => request.type === 'rest')
    expect(post).toMatchObject({ body: { title: `[Task] ${MESSAGE}` } })
    expect(post?.type === 'rest' ? JSON.stringify(post.body) : '').toContain(`${MESSAGE}\\n\\n<!-- ${FOOTER}`)
    expect(hasQuickMode(project.root)).toBe(false)
    expect(existsSync(path.join(project.root, '.pecot/state/.pecot-active'))).toBe(false)
  })

  it('label を付けると、Issue にそのラベルを付けて作る', async () => {
    await explains('`issue_create` の `freeform` の `label` のテストです。`label` を指定した場合に、そのラベルを付けて Issue を作ることを確認します。')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

    const result = await freeform({ message: MESSAGE, repo: 'acme/demo', label: ['bug'] })

    expect(result.code).toBe(0)
    expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ body: { title: `[Task] ${MESSAGE}`, labels: ['bug'] } })
  })

  it('複数行のメッセージを渡すと、1 行目の連続する空白を 1 つにしたものを type の接頭辞つきの題にし、本文にはメッセージの全体を入れる', async () => {
    await explains('`issue_create` の `freeform` の題の作り方のテストです。複数行のメッセージを渡した場合に、1 行目の連続する空白を 1 つにして `[Task]` の接頭辞を付けた題にし、本文にはメッセージの全体を入れることを確認します。')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])
    const message = `先頭の   行\n次の行 ${'あ'.repeat(60)}`

    const result = await freeform({ message: message, repo: 'acme/demo' })

    expect(result.code).toBe(0)
    const post = github.requests().find(request => request.type === 'rest')
    expect(post).toMatchObject({ body: { title: '[Task] 先頭の 行' } })
    const sent = post?.type === 'rest' ? JSON.stringify(post.body) : ''
    expect(sent).toContain(String.raw`先頭の   行\n次の行 ${'あ'.repeat(60)}\n\n<!-- ${FOOTER}`)
  })

  it('1 行目が 50 文字を超えるメッセージを渡すと、1 行目の先頭 50 文字の連続する空白を 1 つにしたものを題にする', async () => {
    await explains('`issue_create` の `freeform` の題の長さのテストです。1 行目が 50 文字を超える場合に、先頭 50 文字の連続する空白を 1 つにしたものを題にすることを確認します。')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])
    const message = `${'あ'.repeat(30)}   ${'い'.repeat(27)}\n2 行目`

    const result = await freeform({ message: message, repo: 'acme/demo' })

    expect(result.code).toBe(0)
    const post = github.requests().find(request => request.type === 'rest')
    expect(post).toMatchObject({ body: { title: `[Task] ${'あ'.repeat(30)} ${'い'.repeat(17)}` } })
  })

  it('Epic に parent_epic を付けると、warning の行を出して親につなぎ、欄は status backlog だけにする', async () => {
    await explains('`issue_create` の `freeform` の `parent_epic` のテストです。Epic に `parent_epic` を付けた場合に、warning の行を出力して親につなぎ、ボードの欄は `status` が `backlog` のものだけを書くことを確認します。')
    setUpIssueProject()
    await startGithub([linkedRepositories(), parentLane(3), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

    const result = await freeform({ message: MESSAGE, repo: 'acme/demo', type: 'epic', parent_epic: '3' })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe(
      'warning: giving a parent Epic to an Epic is not recommended\ncreated: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status backlog\n'
      + 'added: Issue acme/demo/12 as sub-issue of acme/demo/3\n',
    )
  })

  it('ボードへの追加に失敗したとき、warning の行と Issue の URL を出し、欄の設定をせず、終了コード 0 で終わる', async () => {
    await explains('`issue_create` の `freeform` のボードへの追加が失敗した場合のテストです。ボードへの追加が失敗した場合に、warning の行と Issue の URL を出力し、欄の設定は行わず、終了コード 0 で終わることを確認します。')
    setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), failedAddToProject()])

    const result = await freeform({ message: MESSAGE, repo: 'acme/demo' })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12\nwarning: could not add Issue acme\/demo\/12 to project: .+\n$/u)
  })

  it('親 Epic へのつなぎに失敗したとき、Issue の URL を標準出力に出して終了コード 1 で終わる', async () => {
    await explains('`issue_create` の `freeform` の親 Epic へのつなぎが失敗した場合のテストです。親 Epic へのつなぎが失敗した場合に、Issue の URL を標準出力へ出力して終了コード 1 で終わることを確認します。')
    setUpIssueProject()
    await startGithub([linkedRepositories(), parentLane(3), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), failedSubIssue()])

    const result = await freeform({ message: MESSAGE, repo: 'acme/demo', parent_epic: '3' })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand\n$/u)
  })

  it.for([
    { name: '渡されていない', input: { repo: 'acme/demo' } },
    { name: '空白だけ', input: { message: '  \n ', repo: 'acme/demo' } },
  ])('message が $name とき、error の行を出して終了コード 2 で終わる', async (row) => {
    await explains('`issue_create` の `freeform` の `message` の検証のテストです。`message` を渡さない場合と空白だけの場合に、`error` の行を出力して終了コード 2 で終わることを確認します。')
    setUpIssueProject()

    const result = await freeform(row.input)

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: message is required with freeform: true\n' })
  })

  it('repo を渡さないとき、error の行を出して終了コード 2 で終わる', async () => {
    await explains('`issue_create` の `freeform` の `repo` の検証のテストです。`repo` を渡さなかった場合に、`error` の行を出力して終了コード 2 で終わることを確認します。')
    setUpIssueProject()

    const result = await freeform({ message: MESSAGE })

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: repo is required with freeform: true\n' })
  })

  it.for([
    { name: 'ファイル', input: { files: ['a.md'], message: MESSAGE, repo: 'acme/demo' } },
    { name: 'title', input: { message: MESSAGE, repo: 'acme/demo', title: '題' } },
  ])('$name と一緒に渡したとき、何も作らずに終了コード 2 で終わる', async (row) => {
    await explains('`issue_create` の `freeform` の引数の検証のテストです。`freeform` をファイルや `title` と一緒に渡した場合は、何も作らず、終了コード 2 で終わることを確認します。')
    setUpIssueProject()

    const result = await freeform(row.input)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: freeform: true cannot be used with files or title\n')
  })

  describe('MCP の呼び出し', () => {
    it('message と repo を渡すと、テンプレートの検証をせず Issue を 1 件作り、status だけを既定の値にして issues に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-60')
      await verifies(context, 'PW-ISSUE-CREATE-62')
      await explains('MCP ツール `issue_create` の `freeform` の基本の動作のテストです。`message` と `repo` を渡した場合に、テンプレートの検証はせずに Issue を 1 件作り、`status` だけを既定の値にして `issues` に返すことを確認します。')
      const project = setUpIssueProject()
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await freeformTool({ message: MESSAGE, repo: 'acme/demo' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'ready' }] })
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ body: { title: `[Task] ${MESSAGE}` } })
      expect(sentBody(github)).toContain(`${MESSAGE}\\n\\n<!-- ${FOOTER}`)
      expect(fieldWrites(github)).toBe(1)
      expect(hasQuickMode(project.root)).toBe(false)
    })

    it.for([
      { name: '複数行', message: `先頭の   行\n次の行 ${'あ'.repeat(60)}`, title: '[Task] 先頭の 行' },
      { name: '1 行目が 50 文字を超える', message: `${'あ'.repeat(30)}   ${'い'.repeat(27)}\n2 行目`, title: `[Task] ${'あ'.repeat(30)} ${'い'.repeat(17)}` },
    ])('$name の message を渡すと、1 行目の先頭 50 文字の連続する空白を 1 つにしたものを接頭辞つきの題にする', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-61')
      await explains('MCP ツール `issue_create` の `freeform` の題の作り方のテストです。複数行の `message` と 1 行目が 50 文字を超える `message` を渡した場合に、先頭 50 文字の連続する空白を 1 つにして接頭辞を付けた題にすることを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

      const outcome = await freeformTool({ message: row.message, repo: 'acme/demo' })

      expect(outcome.isError).toBe(false)
      expect(github.requests().find(request => request.type === 'rest')).toMatchObject({ body: { title: row.title } })
    })

    it('Epic に parent_epic を付けると、親につないで warnings に入れ、欄は status backlog だけにする', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-62')
      await verifies(context, 'PW-ISSUE-CREATE-63')
      await explains('MCP ツール `issue_create` の `freeform` の `parent_epic` のテストです。Epic に `parent_epic` を付けた場合に、親につないで warning を `warnings` に入れ、ボードの欄は `status` が `backlog` のものだけを書くことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), parentLane(3), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), subIssueAdded()])

      const outcome = await freeformTool({ message: MESSAGE, repo: 'acme/demo', type: 'epic', parent_epic: '3' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issues: [{ ...ISSUE_12, status: 'backlog', parent: 'acme/demo/3' }], warnings: ['giving a parent Epic to an Epic is not recommended'] })
      expect(fieldWrites(github)).toBe(1)
    })

    it.for([
      { name: 'priority', arguments_: { priority: 'high' } },
      { name: 'size', arguments_: { size: 'm' } },
    ])('$name を渡すと、定義にない入力として止まり、Issue を作らない', async (row, context) => {
      await verifies(context, 'PW-ISSUE-CREATE-87')
      await explains('MCP ツール `issue_create` の `freeform` の引数の検証のテストです。`priority` や `size` を渡した場合に、定義にない入力として止まり、Issue を作らないことを確認します。')
      setUpIssueProject()
      const github = await startGithub([])

      const outcome = await freeformTool({ message: MESSAGE, repo: 'acme/demo', ...row.arguments_ })

      expect(outcome.isError).toBe(true)
      expect(JSON.stringify(outcome)).toContain(row.name)
      expect(github.requests()).toEqual([])
    })

    it('ボードへの追加に失敗したとき、warnings に入れ、欄の設定をせず、作った Issue を issues に入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-65')
      await explains('MCP ツール `issue_create` の `freeform` のボードへの追加が失敗した場合のテストです。ボードへの追加が失敗した場合に、warning を `warnings` に入れ、欄の設定は行わず、作った Issue を `issues` に入れて成功を返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([linkedRepositories(), createdIssue(12), failedAddToProject()])

      const outcome = await freeformTool({ message: MESSAGE, repo: 'acme/demo' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['issues']).toEqual([ISSUE_12])
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not add Issue acme\/demo\/12 to project: /u)])
      expect(fieldWrites(github)).toBe(0)
    })

    it('親 Epic へのつなぎに失敗したとき、作った Issue を issues に入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CREATE-66')
      await explains('MCP ツール `issue_create` の `freeform` の親 Epic へのつなぎが失敗した場合のテストです。つなぎが失敗した場合に、作った Issue を `issues` に入れて失敗を返すことを確認します。')
      setUpIssueProject()
      await startGithub([linkedRepositories(), parentLane(3), createdIssue(12), addedToProject(), updatedFields(1), issueNodeId(3), failedSubIssue()])

      const outcome = await freeformTool({ message: MESSAGE, repo: 'acme/demo', parent_epic: '3' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['issues']).toEqual([{ ...ISSUE_12, status: 'ready' }])
      expect(outcome.structured['detail']).toMatch(/^could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand$/u)
    })

    it.for([
      { name: 'message を渡していない', id: 'PW-ISSUE-CREATE-67', arguments_: { repo: 'acme/demo' }, detail: 'message is required with freeform: true' },
      { name: 'message が空白だけ', id: 'PW-ISSUE-CREATE-67', arguments_: { message: '  \n ', repo: 'acme/demo' }, detail: 'message is required with freeform: true' },
      { name: 'repo を渡していない', id: 'PW-ISSUE-CREATE-68', arguments_: { message: MESSAGE }, detail: 'repo is required with freeform: true' },
      { name: 'files と一緒に渡す', id: 'PW-ISSUE-CREATE-69', arguments_: { files: ['a.md'], message: MESSAGE, repo: 'acme/demo' }, detail: 'freeform: true cannot be used with files or title' },
      { name: 'title と一緒に渡す', id: 'PW-ISSUE-CREATE-69', arguments_: { title: '題', message: MESSAGE, repo: 'acme/demo' }, detail: 'freeform: true cannot be used with files or title' },
    ])('$name とき、何も作らずに kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      await explains('MCP ツール `issue_create` の `freeform` の引数の検証のテストです。`message` か `repo` を渡さない場合や `files` か `title` を併せて渡す場合に、何も作らず、`kind` が `invalid-input` の失敗を返すことを確認します。')
      setUpIssueProject()
      const github = await startGithub([])

      const outcome = await freeformTool(row.arguments_)

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: row.detail })
      expect(github.requests()).toEqual([])
    })
  })
})
