/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時ディレクトリ配下だけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
// 書き込むコマンドの dry_run。読むだけの要求を送り、書く操作は `dry-run: would` の行にして、何も書かずに 0 で終わる
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { compareStrings } from '../../../tests/parity/baseline.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../../../tests/_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../../../tests/_helpers/command-harness.js'
import { commentFileContent, MERGE_DIFF_BODY } from '../../../tests/_helpers/issue-comment-case.js'
import { TASK_BODY } from '../../../tests/_helpers/issue-create-case.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { prerequisitesRule } from '../../../tests/_helpers/prerequisites.js'
import { issueResponse } from '../../../tests/_helpers/session-case.js'
import type { ResponseRule } from '../../../tests/fake-github/server.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const ACTIVE = '.pecot/state/.pecot-active'
const OUTPUT_DIRECTORY = '.pecot/tmp/output'
const BOARD_URL = `https://${DEFAULT_HOST}/users/acme/projects/1`

const STATE = '.pecot/state'
const SEEDED_STATE: Readonly<Record<string, string>> = {
  [`${STATE}/.pecot-active`]: 'acme/demo/1\n',
  [`${STATE}/.pecot-base`]: 'develop\n',
  [`${STATE}/.pecot-session-title`]: '前の作業\n',
}

/*
ディレクトリ配下のファイルの、相対パスと中身（相対パスの順）。無ければ空
*/
function snapshot(directory: string, relative: string): Record<string, string> {
  const root = path.join(directory, relative)
  if (!existsSync(root)) return {}
  const entries = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(path.relative(root, entry.parentPath), entry.name))
    .toSorted(compareStrings)
  return Object.fromEntries(entries.map(name => [name, readFileSync(path.join(root, name), 'utf8')]))
}

const linked = (...names: readonly string[]): ResponseRule => graphqlRule('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: names.map(name => ({ owner: { login: 'acme' }, name })) } } } })
const issueNode = (): ResponseRule => graphqlRule('GetIssueNodeId', { repository: { issue: { id: 'I_7', title: '見本の Issue' } } })
const projectItem = (isArchived: boolean): ResponseRule => graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived, project: { id: 'PVT_1' } }] } } } })
const projectNode = (): Json => ({ number: 1, title: 'board', url: BOARD_URL, id: 'PVT_1' })
const listProjects = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectsUser', { user: { projectsV2: { nodes } } })
const options = (names: readonly string[]): Json[] => names.map((name, index) => ({ id: `o${String(index + 1)}`, name, color: 'GRAY', description: name }))
const standardFields = (): Json[] => [
  { id: 'PVTSSF_workflow', name: 'pecot-workflow-acme', databaseId: 456, options: options(['Backlog', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']) },
  { id: 'PVTSSF_priority', name: 'pecot-priority', options: options(['High', 'Medium', 'Low']) },
  { id: 'PVTSSF_size', name: 'pecot-size', options: options(['XS', 'S', 'M', 'L']) },
  { id: 'PVTSSF_status', name: 'Status', options: options(['Todo', 'In Progress', 'Done']) },
]
const projectFields = (fields: Json[]): ResponseRule => graphqlRule('GetProjectFieldsUser', { user: { projectV2: { id: 'PVT_1', title: 'board', url: BOARD_URL, views: { nodes: [{ number: 1 }] }, fields: { nodes: fields } } } })

async function dryRun(argv: readonly string[], github: readonly ResponseRule[], extra: Partial<CommandRun> = {}): Promise<CommandResult> {
  return await runCommand({ argv, github, remote: { host: DEFAULT_HOST }, ...extra })
}

function expectClean(result: Readonly<CommandResult>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

describe('board', () => {
  it('board add に dry_run を渡すと、Issue を読むだけで、足す操作と Status の設定を予行の行に出す', async (context) => {
    await verifies(context, 'PW-BOARD-ADD-19')
    const result = await dryRun(['board', 'add', 'acme/demo/7', '-n'], [linked('demo'), issueNode()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId'])
    expect(result.stderr).toBe('dry-run: would add Issue acme/demo/7 to project\ndry-run: would set Issue acme/demo/7 status ready\n')
  })

  it('board move に dry_run を渡すと、ボードの項目を読むだけで、Status の設定を予行の行に出す', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-15')
    const result = await dryRun(['board', 'move', 'acme/demo/7', 'active', '--dry-run'], [linked('demo'), projectItem(false)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems'])
    expect(result.stderr).toBe('dry-run: would set Issue acme/demo/7 status active\n')
  })
})

describe('issue', () => {
  it('issue reopen に dry_run を渡すと、アーカイブ済みの項目でも書かずに、開き直し・アーカイブの解除・Status・コメントを予行の行に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-21')
    const result = await dryRun(['issue', 'reopen', 'acme/demo/7', '-c', '理由', '-n'], [linked('demo'), projectItem(true)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems'])
    expect(result.stderr).toBe([
      'dry-run: would reopen Issue acme/demo/7',
      'dry-run: would update Issue acme/demo/7 unarchived on the board',
      'dry-run: would set Issue acme/demo/7 status ready',
      'dry-run: would create comment on acme/demo/7',
      '',
    ].join('\n'))
  })

  it('issue comment のファイルの形に dry_run を渡すと、コメントを投稿せず、ファイルに comment_url を書かない', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-28')
    const content = commentFileContent()
    const result = await dryRun(['issue', 'comment', 'note.md', '-n'], [linked('demo')], { files: { 'note.md': content } })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create comment on acme/demo/7\ndry-run: would set comment_url in note.md\n')
    expect(result.read('note.md')).toBe(content)
  })

  it('issue comment の -m に dry_run を渡すと、コメントを投稿せず、予行の行だけ出す', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-29')
    const result = await dryRun(['issue', 'comment', '-t', 'merge-diff', '-i', 'acme/demo/7', '-m', MERGE_DIFF_BODY, '-n'], [])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create comment on acme/demo/7\n')
  })

  it('issue comment の --prepare に dry_run を渡すと、テンプレートの写しを作らない', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-30')
    const result = await dryRun(['issue', 'comment', '--prepare', '-t', 'plan', '-n'], [])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`dry-run: would create comment template plan in ${path.join(result.directory, OUTPUT_DIRECTORY)}\n`)
    expect(existsSync(path.join(result.directory, OUTPUT_DIRECTORY)) ? readdirSync(path.join(result.directory, OUTPUT_DIRECTORY)) : []).toEqual([])
  })

  it('issue create の freeform に dry_run を渡すと、Issue を作らずに作成の予行の行だけ出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-71')
    const result = await dryRun(['issue', 'create', '--freeform', '-r', 'acme/demo', '-m', '一覧に 状態を 出す', '-n'], [linked('demo')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser'])
    expect(result.stderr).toBe('dry-run: would create Issue in acme/demo: [Task] 一覧に 状態を 出す\n')
  })

  it('issue create の freeform に dry_run を渡すと、.pecot-quick-mode を立てず、pending のフラグを残す', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-71')
    const pending = { [`${STATE}/issue-create-slash-pending`]: 'w-quick\n', [`${STATE}/issue-pending`]: '' }
    const result = await dryRun(['issue', 'create', '--freeform', '-r', 'acme/demo', '-m', '一覧に 状態を 出す', '-n'], [linked('demo')], { files: pending })
    expect(result.code).toBe(0)
    expect(Object.keys(snapshot(result.directory, STATE))).toEqual(['issue-create-slash-pending', 'issue-pending'])
    expect(result.read(`${STATE}/.pecot-quick-mode`)).toBeUndefined()
  })

  it('issue create の -m に dry_run を渡すと、Issue を作らずに作成の予行の行だけ出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-70')
    const result = await dryRun(['issue', 'create', '-t', '一覧に状態を出す', '-r', 'acme/demo', '-m', TASK_BODY, '-n'], [linked('demo')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create Issue in acme/demo: [Task] 一覧に状態を出す\n')
  })

  it('issue create の --prepare に dry_run を渡すと、テンプレートの写しを作らない', async (context) => {
    await verifies(context, 'PW-ISSUE-CREATE-72')
    const result = await dryRun(['issue', 'create', '--prepare', '-r', 'acme/demo', '-n'], [])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`dry-run: would create Issue template task in ${path.join(result.directory, OUTPUT_DIRECTORY)}\n`)
    expect(existsSync(path.join(result.directory, OUTPUT_DIRECTORY)) ? readdirSync(path.join(result.directory, OUTPUT_DIRECTORY)) : []).toEqual([])
  })
})

describe('project', () => {
  it('project create に dry_run を渡すと、既にあるかを読むだけで、プロジェクトの作成だけを予行の行に出す', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-11')
    const github = [graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects()]
    const result = await dryRun(['project', 'create', 'acme', 'board', '-h', DEFAULT_HOST, '-s', 'acme', '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create project board for acme\n')
  })

  it('project init に dry_run を渡すと、無いフィールドの作成を予行の行に出し、設定ファイルを書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-16')
    const github = [listProjects(projectNode()), projectFields([{ id: 'PVTSSF_status', name: 'Status', options: options(['Todo']) }])]
    const result = await dryRun(['project', 'init', 'acme', 'board', '-h', DEFAULT_HOST, '-s', 'acme', '-n'], github, { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would create field pecot-workflow-acme',
      'dry-run: would create field pecot-priority',
      'dry-run: would create field pecot-size',
      'dry-run: would add option Needs Attention to field Status',
      '',
    ].join('\n'))
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('project init に dry_run を渡し、フィールドが揃っていれば、選択肢の追加だけを予行の行に出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-17')
    const github = [listProjects(projectNode()), projectFields(standardFields())]
    const before = `${JSON.stringify(projectConfig(), undefined, 2)}\n`
    const result = await dryRun(['project', 'init', 'acme', 'board', '-h', DEFAULT_HOST, '-s', 'acme', '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would skip field pecot-workflow-acme (already exists)',
      'dry-run: would skip field pecot-priority (already exists)',
      'dry-run: would skip field pecot-size (already exists)',
      'dry-run: would add option Blocked to field pecot-workflow-acme',
      'dry-run: would add option Needs Attention to field Status',
      '',
    ].join('\n'))
    expect(result.read(CONFIG_FILE)).toBe(before)
  })

  it('project activate に dry_run を渡すと、設定ファイルとアクティブの切り替えを予行の行に出し、何も書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-23')
    const github = [projectFields(standardFields()), listProjects(projectNode()), projectFields(standardFields()), linked('demo')]
    const result = await dryRun(['project', 'activate', path.basename(CONFIG_FILE), '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('dry-run: would set active project to ghes.example.com_acme_board_acme\n')
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(projectConfig(), undefined, 2)}\n`)
  })

  it('project activate に dry_run を渡すと、別の設定ファイルを指しても、アクティブの印と設定ファイルが変わらない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-23')
    const other = 'ghes.example.com_acme_other_acme.json'
    const otherContent = `${JSON.stringify(projectConfig(), undefined, 2)}\n`
    const github = [projectFields(standardFields()), listProjects(projectNode()), projectFields(standardFields()), linked('demo')]
    const result = await dryRun(['project', 'activate', other, '-n'], github, { files: { [`.pecot/config/projects/${other}`]: otherContent } })
    expect(result.code).toBe(0)
    expect(result.read('.pecot/config/projects/.active')).toBe(`${path.basename(CONFIG_FILE)}\n`)
    expect(result.read(CONFIG_FILE)).toBe(otherContent)
    expect(result.read(`.pecot/config/projects/${other}`)).toBe(otherContent)
    expect(Object.keys(snapshot(result.directory, '.pecot/config/projects'))).toEqual(['.active', path.basename(CONFIG_FILE), other].toSorted(compareStrings))
  })

  it('project link に dry_run を渡すと、リンクの有無を読むだけで、リンクと設定ファイルへの追加を予行の行に出す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-18')
    const result = await dryRun(['project', 'link', 'acme/other', '-n'], [linked('demo')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser'])
    expect(result.stderr).toBe(`dry-run: would add acme/other to project #1\ndry-run: would add acme/other to ${path.join(result.directory, CONFIG_FILE)}\n`)
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(projectConfig(), undefined, 2)}\n`)
  })

  it('project set に dry_run を渡すと、上書きの警告を出さずに、前の値を添えた予行の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-SET-09')
    const config = projectConfig({ extra: { aggregation_repo: 'acme/old' } })
    const result = await dryRun(['project', 'set', 'aggregation_repo', 'acme/hub', '-n'], [], { config })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would set aggregation_repo to acme/hub (was acme/old)\n')
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(config, undefined, 2)}\n`)
  })

  it('project unset に dry_run を渡すと、値を消さずに予行の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-UNSET-06')
    const config = projectConfig({ extra: { aggregation_repo: 'acme/hub' } })
    const result = await dryRun(['project', 'unset', 'aggregation_repo', '-n'], [], { config })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would remove aggregation_repo (was acme/hub)\n')
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(config, undefined, 2)}\n`)
  })
})

describe('session', () => {
  it('session restore に dry_run を渡すと、作業対象を記録せずに予行の行を出す', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-23')
    const result = await dryRun(['session', 'restore', '-i', 'acme/demo/7', '-D', '.', '-n'], [issueResponse({ number: 7, title: '見本' })])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would set work target acme/demo/7\n')
    expect(result.read(ACTIVE)).toBeUndefined()
  })

  it('session restore に dry_run を渡すと、前の作業対象のファイルと作業ディレクトリが変わらない', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-23')
    const result = await dryRun(['session', 'restore', '-i', 'acme/demo/7', '-D', '.', '-n'], [issueResponse({ number: 7, title: '見本' })], { files: SEEDED_STATE })
    expect(result.code).toBe(0)
    expect(snapshot(result.directory, STATE)).toEqual({ '.pecot-active': 'acme/demo/1\n', '.pecot-base': 'develop\n', '.pecot-session-title': '前の作業\n' })
    expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(false)
  })

  it('session start に dry_run を渡すと、作業対象のファイルと作業ディレクトリができない', async (context) => {
    await verifies(context, 'PW-SESSION-START-36')
    const github = [linked('demo'), prerequisitesRule({ number: 7 }), issueNode(), restRule('GET', '/repos/acme/demo/git/ref/heads/main', 200, { object: { sha: '0123456789abcdef0123456789abcdef01234567' } })]
    const result = await dryRun(['session', 'start', 'acme/demo/7', 'feat', '-n'], github)
    expect(result.code).toBe(0)
    expect(snapshot(result.directory, STATE)).toEqual({})
    expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(false)
  })

  it('session start に dry_run を渡すと、ベースの SHA まで読み、ブランチ・Status・作業対象を予行の行に出す', async (context) => {
    await verifies(context, 'PW-SESSION-START-36')
    const github = [linked('demo'), prerequisitesRule({ number: 7 }), issueNode(), restRule('GET', '/repos/acme/demo/git/ref/heads/main', 200, { object: { sha: '0123456789abcdef0123456789abcdef01234567' } })]
    const result = await dryRun(['session', 'start', 'acme/demo/7', 'feat', '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would create branch feat/7 in acme/demo from main',
      'dry-run: would set Issue acme/demo/7 status active',
      'dry-run: would set work target acme/demo/7',
      '',
    ].join('\n'))
    expect(result.read(ACTIVE)).toBeUndefined()
  })
})

// <root>/base/demo と、ブランチ wt1 の <root>/wt1/demo
function projectWithWorktree(): { readonly repository: string, readonly worktree: string } {
  const root = makeTemporaryDirectory()
  const repository = createGitRepository(undefined, path.join(root, 'base', 'demo'))
  const worktree = path.join(root, 'wt1', 'demo')
  gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
  return { repository, worktree }
}

describe('worktree', () => {
  it('worktree remove に dry_run を渡すと、worktree とブランチを残して予行の行を出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-26')
    const { repository, worktree } = projectWithWorktree()
    const result = await dryRun(['worktree', 'remove', 'wt1', '-D', repository, '-n'], [], { environment: { DEVCONTAINER: '1' } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would remove worktree wt1\ndry-run: would delete local branch wt1\n')
    expect(existsSync(worktree)).toBe(true)
    expect(gitForTest(repository, ['branch', '--list', '--format=%(refname:short)', 'wt1']).trim()).toBe('wt1')
  })

  it('worktree init に dry_run を渡すと、設定ファイルを書かずに予行の行を出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-19')
    const { repository } = projectWithWorktree()
    const result = await dryRun(['worktree', 'init', '-D', repository, '-n'], [], { environment: { DEVCONTAINER: '1' } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe([
      `dry-run: would create worktree config ${path.join(repository, '.pecot/config/worktree-config.json')}`,
      `dry-run: would create worktree ignore file ${path.join(repository, '.pecot/config/.worktreeignore')}`,
      '',
    ].join('\n'))
    expect(existsSync(path.join(repository, '.pecot/config/worktree-config.json'))).toBe(false)
  })
})
