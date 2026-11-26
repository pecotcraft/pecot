/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時ディレクトリ配下だけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
// 書き込むコマンドの dry_run。読むだけの要求を送り、書く操作は `dry-run: would` の行にして、何も書かずに 0 で終わる
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { compareStrings } from '../../../tests/parity/baseline.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../../../tests/_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../../../tests/_helpers/command-harness.js'
import { commentFileContent, MERGE_DIFF_BODY } from '../../../tests/_helpers/issue-comment-case.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { prerequisitesRule } from '../../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const SESSION_TITLE = '.pecot/state/.pecot-session-title'
const BOARD_URL = `https://${DEFAULT_HOST}/users/acme/projects/1`
// ボードの持ち主と番号で付けた設定ファイルの名前
const BOARD_CONFIG_FILE = `.pecot/config/projects/${DEFAULT_HOST}_acme_1.json`

const STATE = '.pecot/state'
const SEEDED_STATE: Readonly<Record<string, string>> = {
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
  { id: 'PVTSSF_workflow', name: 'pecot-status', databaseId: 456, options: options(['Backlog', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']) },
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
  it('board add に dry_run を渡すと、Issue を読むだけで、足す操作と Status の設定を予行の行として表示する', async () => {
    await explains('`board add` を dry-run で実行した場合のテストです。Issue の読み取りだけを行い、ボードへの追加と Status の設定を、`dry-run: would` で始まる予行の行として表示することを確認します。')
    const result = await dryRun(['board', 'add', 'acme/demo/7', '-n'], [linked('demo'), issueNode()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId'])
    expect(result.stderr).toBe('dry-run: would add Issue acme/demo/7 to project\ndry-run: would set Issue acme/demo/7 status ready\n')
  })

  it('board move に dry_run を渡すと、ボードの項目を読むだけで、Status の設定を予行の行として表示する', async () => {
    await explains('`board move` を dry-run で実行した場合のテストです。ボードの項目の読み取りだけを行い、Status の設定を予行の行として表示することを確認します。')
    const result = await dryRun(['board', 'move', 'acme/demo/7', 'active', '--dry-run'], [linked('demo'), projectItem(false)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems'])
    expect(result.stderr).toBe('dry-run: would set Issue acme/demo/7 status active\n')
  })
})

describe('issue', () => {
  it('issue reopen に dry_run を渡すと、アーカイブ済みの項目でも書かずに、開き直し・アーカイブの解除・Status・コメントを予行の行として表示する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-21')
    await explains('アーカイブ済みの項目に対して `issue reopen` を dry-run で実行した場合のテストです。何も書き込まず、開き直し・アーカイブの解除・Status の設定・コメントの投稿を、予行の行として表示することを確認します。')
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
    await explains('ファイルを指定した `issue comment` を dry-run で実行した場合のテストです。コメントを投稿せず、ファイルに `comment_url` も書き込まず、予行の行だけを表示することを確認します。')
    const content = commentFileContent()
    const result = await dryRun(['issue', 'comment', 'note.md', '-n'], [linked('demo')], { files: { 'note.md': content } })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create comment on acme/demo/7\ndry-run: would set comment_url in note.md\n')
    expect(result.read('note.md')).toBe(content)
  })

  it('issue comment の -m に dry_run を渡すと、コメントを投稿せず、予行の行だけ表示する', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-29')
    await explains('`-m` で本文を指定した `issue comment` を dry-run で実行した場合のテストです。コメントを投稿せず、`dry-run: would create comment on acme/demo/7` の行だけを表示することを確認します。')
    const result = await dryRun(['issue', 'comment', '-t', 'merge-diff', '-i', 'acme/demo/7', '-m', MERGE_DIFF_BODY, '-n'], [])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create comment on acme/demo/7\n')
  })
})

describe('project', () => {
  it('project create に dry_run を渡すと、既にあるかを読むだけで、プロジェクトの作成だけを予行の行として表示する', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-11')
    await explains('`project create` を dry-run で実行した場合のテストです。プロジェクトが既にあるかを読み取るだけで、プロジェクトの作成だけを予行の行として表示することを確認します。')
    const github = [graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects()]
    const result = await dryRun(['project', 'create', 'acme', 'board', '-h', DEFAULT_HOST, '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe('dry-run: would create project board for acme\n')
  })

  it('project init に dry_run を渡すと、存在しないフィールドの作成を予行の行として表示し、設定ファイルを書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-16')
    await explains('`project init` を dry-run で実行した場合のテストです。存在しないフィールドの作成と選択肢の追加を予行の行として表示し、設定ファイルを書き込まないことを確認します。')
    const github = [listProjects(projectNode()), projectFields([{ id: 'PVTSSF_status', name: 'Status', options: options(['Todo']) }])]
    const result = await dryRun(['project', 'init', 'acme', 'board', '-h', DEFAULT_HOST, '-n'], github, { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would create field pecot-status',
      'dry-run: would skip field pecot-lane (no lanes given)',
      'warning: field pecot-lane was not created because no lanes were given',
      '  choose the lanes (the areas of work, such as plugins, teams or services) and pass them with --lanes',
      'dry-run: would add option Needs Attention to field Status',
      '',
    ].join('\n'))
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('project init に dry_run を渡し、フィールドが揃っていれば、選択肢の追加だけを予行の行として表示する', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-17')
    await explains('フィールドがそろったボードに対して `project init` を dry-run で実行した場合のテストです。既存のフィールドを skip の行として表示し、不足している選択肢の追加を予行の行として表示することを確認します。')
    const github = [listProjects(projectNode()), projectFields(standardFields())]
    const before = `${JSON.stringify(projectConfig(), undefined, 2)}\n`
    const result = await dryRun(['project', 'init', 'acme', 'board', '-h', DEFAULT_HOST, '-n'], github, { configFile: BOARD_CONFIG_FILE })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would skip field pecot-status (already exists)',
      'dry-run: would skip field pecot-lane (no lanes given)',
      'warning: field pecot-lane was not created because no lanes were given',
      '  choose the lanes (the areas of work, such as plugins, teams or services) and pass them with --lanes',
      'dry-run: would add option Blocked to field pecot-status',
      'dry-run: would add option Needs Attention to field Status',
      '',
    ].join('\n'))
    expect(result.read(BOARD_CONFIG_FILE)).toBe(before)
  })

  it('project init に dry_run と lanes を渡すと、pecot-lane と Lanes のビューの作成を予行の行として表示し、何も書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-52')
    await explains('`--lanes` を指定して `project init` を dry-run で実行した場合のテストです。`pecot-lane` フィールドと `Lanes` ビューの作成を予行の行として表示し、フィールドの作成要求を送らず、設定ファイルを変更しないことを確認します。')
    const viewTarget = graphqlRule('GetProjectViewTarget', { repositoryOwner: { __typename: 'User', databaseId: 9, projectV2: { url: BOARD_URL, views: { nodes: [{ number: 1, name: 'View 1' }] }, fields: { nodes: [{ databaseId: 456, name: 'pecot-status' }] } } } })
    const github = [listProjects(projectNode()), projectFields(standardFields()), viewTarget]
    const before = `${JSON.stringify(projectConfig(), undefined, 2)}\n`
    const result = await dryRun(['project', 'init', 'acme', 'board', '-h', DEFAULT_HOST, '--lanes', 'cli', '-n'], github, { configFile: BOARD_CONFIG_FILE })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would skip field pecot-status (already exists)',
      'dry-run: would create field pecot-lane',
      'dry-run: would add option Blocked to field pecot-status',
      'dry-run: would add option Needs Attention to field Status',
      'dry-run: would create view Lanes',
      '',
    ].join('\n'))
    expect(requestLabels(result.requests)).not.toContain('CreateProjectField')
    expect(result.read(BOARD_CONFIG_FILE)).toBe(before)
  })

  it('project activate に dry_run を渡すと、設定ファイルとアクティブの切り替えを予行の行として表示し、何も書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-23')
    await explains('`project activate` を dry-run で実行した場合のテストです。アクティブなプロジェクトの切り替えを予行の行として表示し、設定ファイルを変更しないことを確認します。')
    const github = [projectFields(standardFields()), listProjects(projectNode()), projectFields(standardFields()), linked('demo')]
    const result = await dryRun(['project', 'activate', path.basename(BOARD_CONFIG_FILE), '-n'], github, { configFile: BOARD_CONFIG_FILE })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('dry-run: would set active project to ghes.example.com_acme_1\n')
    expect(result.read(BOARD_CONFIG_FILE)).toBe(`${JSON.stringify(projectConfig(), undefined, 2)}\n`)
  })

  it('project activate に dry_run を渡すと、旧い名前の設定ファイルを指しても、アクティブなプロジェクトの記録と設定ファイルが変わらない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-23')
    await explains('旧い名前の設定ファイルを指定して `project activate` を dry-run で実行した場合のテストです。設定ファイルの移動を予行の行として表示し、アクティブなプロジェクトの記録と設定ファイルは変更しないことを確認します。')
    const other = 'ghes.example.com_acme_other_acme.json'
    const otherContent = `${JSON.stringify(projectConfig(), undefined, 2)}\n`
    const github = [projectFields(standardFields()), listProjects(projectNode()), projectFields(standardFields()), linked('demo')]
    const result = await dryRun(['project', 'activate', other, '-n'], github, { configFile: BOARD_CONFIG_FILE, files: { [`.pecot/config/projects/${other}`]: otherContent } })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`dry-run: would move config file ${path.join(result.directory, '.pecot/config/projects', other)} to ${path.join(result.directory, BOARD_CONFIG_FILE)}\n`)
    expect(result.read('.pecot/config/projects/.active')).toBe(`${path.basename(BOARD_CONFIG_FILE)}\n`)
    expect(result.read(BOARD_CONFIG_FILE)).toBe(otherContent)
    expect(result.read(`.pecot/config/projects/${other}`)).toBe(otherContent)
    expect(Object.keys(snapshot(result.directory, '.pecot/config/projects'))).toEqual(['.active', path.basename(BOARD_CONFIG_FILE), other].toSorted(compareStrings))
  })

  it('project link に dry_run を渡すと、リンクの有無を読むだけで、リンクと設定ファイルへの追加を予行の行として表示する', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-18')
    await explains('`project link` を dry-run で実行した場合のテストです。リンクの有無を読み取るだけで、リンクの追加と設定ファイルへの追加を予行の行として表示し、設定ファイルは変更しないことを確認します。')
    const result = await dryRun(['project', 'link', 'acme/other', '-n'], [linked('demo')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser'])
    expect(result.stderr).toBe(`dry-run: would add acme/other to project #1\ndry-run: would add acme/other to ${path.join(result.directory, CONFIG_FILE)}\n`)
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(projectConfig(), undefined, 2)}\n`)
  })

  it('project set に dry_run を渡すと、上書きの警告を出さずに、前の値を添えた予行の行を表示する', async (context) => {
    await verifies(context, 'PW-PROJECT-SET-09')
    await explains('既に値がある設定に対して `project set` を dry-run で実行した場合のテストです。上書きの警告は表示せず、前の値 `acme/old` を添えた予行の行を表示し、設定ファイルは変更しないことを確認します。')
    const config = projectConfig({ extra: { aggregation_repo: 'acme/old' } })
    const result = await dryRun(['project', 'set', 'aggregation_repo', 'acme/hub', '-n'], [], { config })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would set aggregation_repo to acme/hub (was acme/old)\n')
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(config, undefined, 2)}\n`)
  })

  it('project unset に dry_run を渡すと、値を消さずに予行の行を表示する', async (context) => {
    await verifies(context, 'PW-PROJECT-UNSET-06')
    await explains('`project unset` を dry-run で実行した場合のテストです。値を削除せず、前の値 `acme/hub` を添えた予行の行を表示することを確認します。')
    const config = projectConfig({ extra: { aggregation_repo: 'acme/hub' } })
    const result = await dryRun(['project', 'unset', 'aggregation_repo', '-n'], [], { config })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would remove aggregation_repo (was acme/hub)\n')
    expect(result.read(CONFIG_FILE)).toBe(`${JSON.stringify(config, undefined, 2)}\n`)
  })
})

describe('session', () => {
  it('session start に dry_run を渡すと、作業対象のファイルと作業ディレクトリを作成しない', async (context) => {
    await verifies(context, 'PW-SESSION-START-36')
    await explains('`session start` を dry-run で実行した場合のテストです。作業対象の状態ファイルと、作業ディレクトリ `.pecot/work/7` が作成されないことを確認します。')
    const github = [linked('demo'), prerequisitesRule({ number: 7 }), issueNode(), restRule('GET', '/repos/acme/demo/git/ref/heads/main', 200, { object: { sha: '0123456789abcdef0123456789abcdef01234567' } })]
    const result = await dryRun(['session', 'start', 'acme/demo/7', 'feat', '-n'], github)
    expect(result.code).toBe(0)
    expect(snapshot(result.directory, STATE)).toEqual({})
    expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(false)
  })

  it('session start に dry_run を渡すと、前の作業対象のファイルが変わらない', async (context) => {
    await verifies(context, 'PW-SESSION-START-36')
    await explains('状態ファイルが既にある状態で `session start` を dry-run で実行した場合のテストです。前の作業の状態ファイル（`.pecot-base` と `.pecot-session-title`）の内容が変わらないことを確認します。')
    const github = [linked('demo'), prerequisitesRule({ number: 7 }), issueNode(), restRule('GET', '/repos/acme/demo/git/ref/heads/main', 200, { object: { sha: '0123456789abcdef0123456789abcdef01234567' } })]
    const result = await dryRun(['session', 'start', 'acme/demo/7', 'feat', '-n'], github, { files: SEEDED_STATE })
    expect(result.code).toBe(0)
    expect(snapshot(result.directory, STATE)).toEqual({ '.pecot-base': 'develop\n', '.pecot-session-title': '前の作業\n' })
  })

  it('session start に dry_run を渡すと、ベースの SHA まで読み、ブランチ・Status・作業対象を予行の行として表示する', async (context) => {
    await verifies(context, 'PW-SESSION-START-36')
    await explains('`session start` を dry-run で実行した場合のテストです。ベースブランチの SHA まで読み取り、ブランチの作成・Status の設定・作業ディレクトリの作成を予行の行として表示することを確認します。')
    const github = [linked('demo'), prerequisitesRule({ number: 7 }), issueNode(), restRule('GET', '/repos/acme/demo/git/ref/heads/main', 200, { object: { sha: '0123456789abcdef0123456789abcdef01234567' } })]
    const result = await dryRun(['session', 'start', 'acme/demo/7', 'feat', '-n'], github)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe([
      'dry-run: would create branch feat/7 in acme/demo from main',
      'dry-run: would set Issue acme/demo/7 status active',
      'dry-run: would create work directory .pecot/work/7/',
      '',
    ].join('\n'))
    expect(result.read(SESSION_TITLE)).toBeUndefined()
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
  it('worktree remove に dry_run を渡すと、worktree とブランチを残して予行の行を表示する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-26')
    await explains('`worktree remove` を dry-run で実行した場合のテストです。worktree とローカルのブランチを残したまま、削除の予行の行を表示することを確認します。')
    const { repository, worktree } = projectWithWorktree()
    const result = await dryRun(['worktree', 'remove', 'wt1', '-D', repository, '-n'], [], { environment: { DEVCONTAINER: '1' } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would remove worktree wt1\ndry-run: would delete local branch wt1\n')
    expect(existsSync(worktree)).toBe(true)
    expect(gitForTest(repository, ['branch', '--list', '--format=%(refname:short)', 'wt1']).trim()).toBe('wt1')
  })

  it('worktree init に dry_run を渡すと、設定ファイルを書かずに予行の行を表示する', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-19')
    await explains('`worktree init` を dry-run で実行した場合のテストです。設定ファイルと ignore ファイルを書き込まず、作成の予行の行を表示することを確認します。')
    const { repository } = projectWithWorktree()
    const result = await dryRun(['worktree', 'init', '-D', repository, '-n'], [], { environment: { DEVCONTAINER: '1' } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe([
      `dry-run: would create worktree config ${path.join(repository, '.pecot/config/worktree-config.json')}`,
      `dry-run: would create worktree ignore file ${path.join(repository, '.pecot/config/.worktreeignore')}`,
      '',
    ].join('\n'))
    expect(existsSync(path.join(repository, '.pecot/config/worktree-config.json'))).toBe(false)
    expect(existsSync(path.join(repository, '.pecot/config/.worktreeignore'))).toBe(false)
  })
})
