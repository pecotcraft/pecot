/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
// issue create --freeform。issue quick から移したタイトル・既定の欄・本文の末尾・フラグの振る舞い
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
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
  it('メッセージとリポジトリで起票し、priority medium・size s と型の既定の status を付け、quick のフラグを作る', async () => {
    const project = setUpIssueProject({ files: { '.pecot/state/issue-create-slash-pending': '1\n' } })
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await freeform('-m', MESSAGE, '--repo', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toContain('priority medium, size s')
    const created = github.requests().find(request => request.type === 'rest' && request.method === 'POST')
    const body = created?.type === 'rest' ? JSON.stringify(created.body) : ''
    expect(body).toContain('<!-- issue create の freeform で起票（テンプレ検証スキップ）')
    expect(body).toContain(`"title":"[Task] ${MESSAGE}"`)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(true)
    expect(hasFile(project.root, '.pecot/state/issue-create-slash-pending')).toBe(false)
    expect(github.requests().some(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/.pecot-active')).toBe(false)
  })

  it('長いメッセージは、先頭 50 文字の連続する空白を 1 つにしてタイトルにする', async () => {
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])
    const message = `${'あ'.repeat(10)}   \n\t${'い'.repeat(45)}`

    const result = await freeform('-m', message, '--repo', 'acme/demo')
    expect(result.code).toBe(0)
    const created = github.requests().find(request => request.type === 'rest' && request.method === 'POST')
    const body = created?.type === 'rest' ? created.body : undefined
    const title = typeof body === 'object' && body !== null && 'title' in body ? body.title : undefined
    expect(title).toBe(`[Task] ${'あ'.repeat(10)} ${'い'.repeat(35)}`)
  })

  it('Backlog に置く型（epic）は size を付けず、quick のフラグを作らない', async () => {
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(2)])

    const result = await freeform('-m', MESSAGE, '--repo', 'acme/demo', '--type', 'epic')

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('size')
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
  })

  it.for([
    { name: 'メッセージが無い', argv: ['--repo', 'acme/demo'], expected: 'error: --message is required with --freeform\n' },
    { name: 'メッセージが空白だけ', argv: ['-m', '  \n ', '--repo', 'acme/demo'], expected: 'error: --message is required with --freeform\n' },
    { name: 'リポジトリが無い', argv: ['-m', MESSAGE], expected: 'error: --repo is required with --freeform\n' },
    { name: '--title と併用', argv: ['-m', MESSAGE, '--repo', 'acme/demo', '--title', 't'], expected: 'error: --freeform cannot be used with --prepare, --files or --title\n' },
  ])('$name とき、GitHub を呼ばずに終了コード 2 で止まる', async ({ argv, expected }) => {
    setUpIssueProject()
    const github = await startGithub([])

    const result = await freeform(...argv)

    expect(result.code).toBe(2)
    expect(result.stderr).toBe(expected)
    expect(github.requests()).toEqual([])
  })
})

describe('issue create --dry-run', () => {
  it('ファイルと -m が無いと、引数の不足として止まる', async () => {
    setUpIssueProject()
    const result = await runInProcess(['issue', 'create', '--dry-run'], COMMANDS)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: missing arguments\n/u)
  })
})

describe('issue quick', () => {
  it('古い名前は、issue create --freeform を案内して終了コード 2 で止まる', async () => {
    setUpIssueProject()
    const result = await runInProcess(['issue', 'quick', '-m', MESSAGE, '-r', 'acme/demo'], COMMANDS)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('issue create --freeform')
  })
})
