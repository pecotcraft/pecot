/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
// issue create --freeform。issue quick から移したタイトル・既定の欄・本文の末尾・フラグの振る舞い
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../../../tests/_helpers/interface-case.js'
import type { CliResult } from '../../../tests/_helpers/interface-case.js'
import {
  addedToProject,
  createdIssue,
  ISSUE_URL_BASE,
  linkedRepositories,
  setUpIssueProject,
  updatedFields,
} from '../../../tests/_helpers/issue-create-case.js'
import { COMMANDS } from '../registry.js'

useIsolatedEnvironment()

const MESSAGE = '一覧の状態列を直す'

async function freeform(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'create', '--freeform', ...argv], COMMANDS)
}

function hasFile(root: string, relative: string): boolean {
  return existsSync(path.join(root, relative))
}

describe('issue create --freeform', () => {
  it('メッセージとリポジトリで起票し、型の既定の status だけを付け、.pecot-quick-mode を作らない', async () => {
    await explains('`issue create --freeform` で Issue を作成する場合のテストです。`-m` と `--repo` だけで起票し、型の既定の `status` の設定だけを行い、`.pecot-quick-mode` ファイル・ブランチ・アクティブの状態ファイルを作成しないことを確認します。')
    const project = setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

    const result = await freeform('-m', MESSAGE, '--repo', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toContain('set: Issue acme/demo/12 status ready\n')
    expect(github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toHaveLength(1)
    const created = github.requests().find(request => request.type === 'rest' && request.method === 'POST')
    const body = created?.type === 'rest' ? JSON.stringify(created.body) : ''
    expect(body).toContain('<!-- issue create の freeform で起票（テンプレ検証スキップ）')
    expect(body).toContain(`"title":"[Task] ${MESSAGE}"`)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
    expect(github.requests().some(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/.pecot-active')).toBe(false)
  })

  it.each([
    { name: '1 行目が短い複数行のメッセージは、1 行目だけ', message: `${'あ'.repeat(10)}   \n\t${'い'.repeat(45)}`, expected: 'あ'.repeat(10) },
    { name: '1 行目が 50 文字を超えると、50 文字で切って連続する空白を 1 つにする', message: `${'あ'.repeat(10)}   \t${'い'.repeat(45)}\n2 行目`, expected: `${'あ'.repeat(10)} ${'い'.repeat(36)}` },
    { name: '先頭の空行と空白は飛ばし、50 文字に数えない', message: `\n\n  ${'あ'.repeat(60)}\n2 行目`, expected: 'あ'.repeat(50) },
    { name: '\\r\\n の改行でも、1 行目だけ', message: '短い題\r\n2 行目', expected: '短い題' },
  ])('タイトルは、メッセージの 1 行目から作成する: $name', async ({ message, expected }) => {
    await explains('`--freeform` で作成する Issue のタイトルのテストです。メッセージの 1 行目から、先頭の空白を除いて 50 文字までに切り、連続する空白を 1 つにしたタイトルを作成することを確認します。')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

    const result = await freeform('-m', message, '--repo', 'acme/demo')
    expect(result.code).toBe(0)
    const created = github.requests().find(request => request.type === 'rest' && request.method === 'POST')
    const body = created?.type === 'rest' ? created.body : undefined
    const title = typeof body === 'object' && body !== null && 'title' in body ? body.title : undefined
    expect(title).toBe(`[Task] ${expected}`)
  })

  it('Backlog に置く型（epic）は、status backlog だけを付ける', async () => {
    await explains('`--type epic` を指定した `issue create --freeform` のテストです。Backlog に置く型の場合に、`status` を `backlog` に設定することを確認します。')
    setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(1)])

    const result = await freeform('-m', MESSAGE, '--repo', 'acme/demo', '--type', 'epic')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('set: Issue acme/demo/12 status backlog\n')
  })

  it.for([
    { name: 'メッセージが無い', argv: ['--repo', 'acme/demo'], expected: 'error: --message is required with --freeform\n' },
    { name: 'メッセージが空白だけ', argv: ['-m', '  \n ', '--repo', 'acme/demo'], expected: 'error: --message is required with --freeform\n' },
    { name: 'リポジトリが無い', argv: ['-m', MESSAGE], expected: 'error: --repo is required with --freeform\n' },
    { name: '--title と併用', argv: ['-m', MESSAGE, '--repo', 'acme/demo', '--title', 't'], expected: 'error: --freeform cannot be used with --files or --title\n' },
  ])('$name とき、GitHub を呼ばずに終了コード 2 で止まる', async ({ argv, expected }) => {
    await explains('`issue create --freeform` に誤った引数を渡した場合のテストです。メッセージやリポジトリの不足、`--title` との併用のどれでも、GitHub を呼ばず、終了コード `2` でエラーの文を表示して終了することを確認します。')
    setUpIssueProject()
    const github = await startGithub([])

    const result = await freeform(...argv)

    expect(result.code).toBe(2)
    expect(result.stderr).toBe(expected)
    expect(github.requests()).toEqual([])
  })
})

describe('issue create --dry-run', () => {
  it('ファイルと -m のどちらも指定しない場合は、引数の不足として終了コード 1 で止まる', async () => {
    await explains('引数を何も指定しない `issue create` のテストです。終了コード `1` で、`error: missing arguments` で始まるエラーの文を表示することを確認します。')
    setUpIssueProject()
    const result = await runInProcess(['issue', 'create'], COMMANDS)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: missing arguments\n/u)
  })
})
