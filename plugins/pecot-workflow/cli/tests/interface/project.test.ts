/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 読み取りの JSON は readonly にしない */
/* eslint-disable unicorn/consistent-function-scoping -- 補助は、使う describe の近くに置く */
/* eslint-disable unicorn/no-unnecessary-parameters -- 補助の引数を、行ごとにそろえる */
/* eslint-disable unicorn/no-null -- 読み取りと設定の JSON の null を使う */
// project の 7 個のツールのうち 6 個（PW-PROJECT-*）の振る舞いを、ツールをプロセス内で呼んで確かめる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { explains } from '../_helpers/explains.js'
import { step } from '../_helpers/step.js'
import { verifies } from '../_helpers/verifies.js'
import { CONFIG_FILE as LEGACY_CONFIG_FILE, DEFAULT_HOST, projectConfig, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const PROJECTS_DIRECTORY = '.pecot/config/projects'
const ACTIVE_FILE = `${PROJECTS_DIRECTORY}/.active`
const CONFIG_FILE = `${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_1.json`
const NO_ACTIVE = 'error: no active project\n  call project_activate with project: <PROJECT>\n'
const WORKFLOW_NAMES = ['Backlog', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']
const WORKFLOW_NAMES_WITH_BLOCKED = ['Backlog', 'Blocked', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']
const STATUS_NAMES = ['Todo', 'In Progress', 'Done']

type Json = Record<string, unknown>

// 公式の GitHub MCP の読み取り（projects_get・projects_list）の形
const readField = (id: number, nodeId: string, name: string, names?: readonly string[]): Json => ({
  id,
  node_id: nodeId,
  name,
  data_type: names === undefined ? 'title' : 'single_select',
  ...names !== undefined && { options: names.map((option, index) => ({ id: `o${String(index + 1)}`, name: { raw: option } })) },
})
const TITLE_READ = readField(1, 'PVTF_title', 'Title')
const workflowRead = (names: readonly string[] = WORKFLOW_NAMES, name = 'pecot-status'): Json => readField(456, 'PVTSSF_workflow', name, names)
const statusRead = (names: readonly string[] = STATUS_NAMES): Json => readField(789, 'PVTSSF_status', 'Status', names)
const fieldsRead = (fields: Json[] = [TITLE_READ, workflowRead(), statusRead()], hasNextPage = false): Json => ({ fields: { fields, pageInfo: { hasNextPage } } })
const projectRead = (title: string, number = 1): Json => ({ id: number, node_id: `PVT_${String(number)}`, number, title, owner: { login: 'acme' } })
const listProjectsRead = (titles: readonly string[], hasNextPage = false): Json => ({ projects: { projects: titles.map((title, index) => projectRead(title, index + 1)), pageInfo: { hasNextPage } } })
const boardReads = (fields: Json = fieldsRead()): Json => ({ project: { project: projectRead('board') }, fields, views: { views: { views: [{ number: 1, name: 'View 1' }] } } })
const boardWith = (...fields: Json[]): Json => boardReads(fieldsRead(fields))

// 動かす補助

const GHES: Partial<CommandRun> = { remote: { host: DEFAULT_HOST }, configFile: CONFIG_FILE }

async function run(name: string, input: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}): Promise<CommandResult> {
  return await runCommand({ tool: name, arguments: input, ...GHES, ...extra })
}

function asJson(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  return Object.fromEntries(Object.entries(value))
}

function savedConfig(result: Readonly<Pick<CommandResult, 'read'>>, file = CONFIG_FILE): Json {
  const text = result.read(file)
  if (text === undefined) throw new Error(`no such file: ${file}`)
  return asJson(JSON.parse(text))
}

function workflowOptions(result: Readonly<CommandResult>): Json {
  const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
  return asJson(asJson(fields['workflow'])['options'])
}

function repositoryEntries(result: Readonly<CommandResult>): Json[] {
  const entries = savedConfig(result)['repositories']
  return Array.isArray(entries) ? entries.map(entry => asJson(entry)) : []
}

function repositoriesOf(result: Readonly<Pick<CommandResult, 'read'>>, file = CONFIG_FILE): unknown {
  return savedConfig(result, file)['repositories']
}

const configPathOf = (result: Readonly<CommandResult>): string => path.join(result.directory, CONFIG_FILE)

// MCP の data の共通の用意
const CONFIG_NAME = path.parse(CONFIG_FILE).name
const OTHER_NAME = `${DEFAULT_HOST}_acme_other_acme`
const otherFile = { [`${PROJECTS_DIRECTORY}/${OTHER_NAME}.json`]: `${JSON.stringify(projectConfig(), undefined, 2)}\n` }
const tool = async (name: string, toolArguments: Record<string, unknown>, extra: Partial<CommandRun> = {}): ReturnType<typeof runTool> =>
  await runTool({ tool: name, arguments: toolArguments, ...GHES, ...extra })
const withAggregation = (value?: string): Partial<CommandRun> => ({ config: projectConfig(value === undefined ? {} : { extra: { aggregation_repo: value } }) })
// 移行の前の形（進行の欄の旧い名前と、旧い名前の設定ファイル）
const LEGACY_FIELD = 'pecot-workflow-acme'
const LEGACY_NAME = path.parse(LEGACY_CONFIG_FILE).name
const legacyConfig: Partial<CommandRun> = { config: projectConfig({ extra: { workflow_suffix: 'acme' } }), configFile: LEGACY_CONFIG_FILE }
// 廃止した fields.priority・fields.size を足した、旧い形の設定
function withOldFields(saved: Json): Json {
  const project = asJson(saved['project'])
  const oldFields = { priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } }, size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } } }
  return { ...saved, project: { ...project, fields: { ...asJson(project['fields']), ...oldFields } } }
}
const movedNote = (name: string): string => `warning: the project config is now named ${name}\n  use this name for the project input and the PECOT_REVIEW_PROJECT variable\n`
// 設定ファイルに書いた board_url
const boardUrlOf = (result: Readonly<Pick<CommandResult, 'read'>>): unknown => asJson(savedConfig(result)['project'])['board_url']

describe('project_list', () => {
  const other = { [`${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`]: `${JSON.stringify(projectConfig(), undefined, 2)}\n` }

  it('設定ファイルがあると、ファイル名の順に 1 行ずつ出す', async () => {
    await explains('`project_list` の出力のテストです。設定ファイルが存在する場合は、ファイル名の順に 1 行ずつ標準出力へ出力することを確認します。')
    const result = await run('project_list', {}, { files: other })
    await step('一覧の出力を比べる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`=== Projects ===\n  ${DEFAULT_HOST}_acme_1 [ACTIVE]\n  ${DEFAULT_HOST}_acme_other_acme\n`)
      expect(result.stderr).toBe('')
    })
  })

  it('アクティブなプロジェクトの設定ファイルの行の末尾に、[ACTIVE] を付ける', async () => {
    await explains('`project_list` のアクティブなプロジェクトの表示のテストです。アクティブなプロジェクトの設定ファイルの行の末尾にだけ、`[ACTIVE]` を付けることを確認します。')
    const result = await run('project_list', {}, { files: other })
    const lines = result.stdout.split('\n')
    await step('アクティブの印を確かめる', () => {
      expect(lines.filter(line => line.endsWith('[ACTIVE]'))).toEqual([`  ${DEFAULT_HOST}_acme_1 [ACTIVE]`])
    })
  })

  it('設定ファイルが 1 つも存在しないと、none の行を出す', async () => {
    await explains('`project_list` の設定ファイルが存在しない場合のテストです。設定ファイルが 1 つも存在しない場合は、`none` の行を出力して終了コード 0 で終わることを確認します。')
    const result = await run('project_list', {}, { config: false })
    await step('設定が無いときの出力を比べる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('=== Projects ===\n  none\n')
    })
  })

  describe('MCP の data', () => {
    it('設定ファイルがあると、ファイル名の順で projects に並べ、アクティブな設定の active を true にする', async (context) => {
      await verifies(context, 'PW-PROJECT-LIST-01')
      await verifies(context, 'PW-PROJECT-LIST-02')
      await explains('`project_list` の MCP の結果のテストです。設定ファイルが存在する場合は、ファイル名の順に `projects` へ並べ、アクティブな設定の `active` を `true` にすることを確認します。')
      const result = await tool('project_list', {}, { files: otherFile })
      await step('structuredContent の projects を比べる', () => {
        expect(result.structured).toEqual({ projects: [{ name: CONFIG_NAME, active: true, owner: 'acme', project_number: 1 }, { name: OTHER_NAME, active: false, owner: 'acme', project_number: 1 }] })
      })
    })

    it('設定が 1 つも存在しないと projects を空の配列で返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LIST-03')
      await explains('`project_list` の MCP の結果のテストです。設定ファイルが 1 つも存在しない場合は、`projects` を空の配列で返すことを確認します。')
      const result = await tool('project_list', {}, { config: false })
      await step('空の projects を比べる', () => {
        expect(result.structured).toEqual({ projects: [] })
      })
    })
  })
})

describe('project_activate', () => {
  const NAME = path.parse(CONFIG_FILE).name
  const reference = (project: string, reads: Json = boardReads()): Readonly<Record<string, unknown>> => ({ project, host: DEFAULT_HOST, owner: 'acme', owner_type: 'user', reads })
  const activateByNumber = async (extra: Partial<CommandRun> = {}, reads: Json = boardReads()): Promise<CommandResult> =>
    await run('project_activate', reference('1', reads), { config: false, ...extra })
  const existing = (repositories: Json[], extra: Json = {}): Partial<CommandRun> => ({ config: projectConfig({ repositories, extra }) })
  const byTitle = (titles: readonly string[], hasNextPage = false): Json => ({ ...boardReads(), project: undefined, projects: [listProjectsRead(titles, hasNextPage)] })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトの設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-04')
    await explains('`project_activate` の設定ファイルの作成のテストです。プロジェクトの番号か名前と、公式の GitHub MCP で読んだボードを渡した場合は、同じ内容の設定ファイルを作成し、標準エラーに `created` の行を出力することを確認します。')
    const byNumber = await activateByNumber()
    await step('作った設定ファイルと標準エラーを確かめる', () => {
      expect(byNumber.code).toBe(0)
      expect(byNumber.stderr).toBe(`created: config file ${configPathOf(byNumber)}\nset: active project to ${NAME}\n`)
      expect(savedConfig(byNumber)).toMatchObject({ host: DEFAULT_HOST, owner: 'acme', project: { number: 1, id: 'PVT_1' }, repositories: [] })
    })
    const byName = await run('project_activate', reference('board', byTitle(['board'])), { config: false })
    await step('名前で作った設定を、番号で作ったものと比べる', () => {
      expect(byName.code).toBe(0)
      expect(byName.read(CONFIG_FILE)).toBe(byNumber.read(CONFIG_FILE))
    })
  })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトをアクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-05')
    await explains('`project_activate` のアクティブな設定のテストです。プロジェクトの番号か名前を指定した場合は、そのプロジェクトの設定ファイルをアクティブにすることを確認します。')
    const result = await activateByNumber()
    await step('アクティブな設定ファイルを確かめる', () => {
      expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })
  })

  it('設定ファイルのパスかファイル名を渡すと、host を渡さなくても設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-06')
    await explains('`project_activate` の設定ファイルの指定のテストです。設定ファイルのパスかファイル名を指定した場合は、`host` と `owner` を省略しても設定ファイルの値で同期することを確認します。')
    const result = await run('project_activate', { project: NAME, reads: boardReads() })
    await step('更新の標準エラーを確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`updated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
    })
    const filePath = path.join(PROJECTS_DIRECTORY, path.basename(CONFIG_FILE))
    const byPath = await run('project_activate', { project: filePath, reads: boardReads() })
    await step('ファイルのパスで同期し直した結果を確かめる', () => {
      expect(byPath.code).toBe(0)
    })
  })

  it('同期した中身が既存の設定ファイルと同じだと、書き換えずに change を unchanged にし、アクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-25')
    await explains('`project_activate` の同期した内容が既存の設定ファイルと同じ場合のテストです。設定ファイルを書き換えず、`change` を `unchanged` にして、アクティブにすることを確認します。')
    const first = await activateByNumber()
    const again = await activateByNumber({ config: savedConfig(first) })
    await step('同じ内容の同期の結果を確かめる', () => {
      expect(again.code).toBe(0)
      expect(again.stderr).toBe(`set: active project to ${NAME}\n`)
      expect(again.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
      expect(again.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })
    const data = await tool('project_activate', reference('1'), { config: savedConfig(first) })
    await step('同期し直した change が unchanged であることを確かめる', () => {
      expect(data.structured).toMatchObject({ change: 'unchanged', project: NAME })
    })
  })

  it('設定ファイルに fields.priority・fields.size が残っていると、ボードと同じ内容でも update で書き直し、2 つのキーを消す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-28')
    await explains('`project_activate` の古い `fields.priority` と `fields.size` のテストです。設定ファイルにこの 2 つのキーが残っている場合は、ボードと同じ内容でも `update` で書き直してキーを削除することを確認します。')
    const first = await activateByNumber()
    const again = await activateByNumber({ config: withOldFields(savedConfig(first)) })
    await step('旧い欄を消した同期の結果を確かめる', () => {
      expect(again.code).toBe(0)
      expect(again.stderr).toBe(`updated: config file ${configPathOf(again)}\nset: active project to ${NAME}\n`)
      expect(again.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
    })
    const data = await tool('project_activate', reference('1'), { config: withOldFields(savedConfig(first)) })
    await step('同期し直した change が update であることを確かめる', () => {
      expect(data.structured).toMatchObject({ change: 'update', project: NAME })
    })
  })

  it('pecot-status と旧い名前の進行の欄が両方あるボードでも、pecot-status の欄で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-24')
    await explains('`project_activate` の進行の欄のテストです。`pecot-status` と旧い名前の進行の欄が両方ある場合でも、`pecot-status` の欄で同期することを確認します。')
    const legacy = readField(455, 'PVTSSF_legacy', LEGACY_FIELD, WORKFLOW_NAMES)
    const result = await run('project_activate', { project: NAME, reads: boardWith(TITLE_READ, legacy, workflowRead(), statusRead()) })
    await step('pecot-status の欄で同期した設定を確かめる', () => {
      expect(result.code).toBe(0)
      expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_workflow' } } } })
      expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })
  })

  it('旧い名前の進行の欄だけがあるボードも、初期化済みとして同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-27')
    await explains('`project_activate` の旧い名前の進行の欄のテストです。旧い名前の進行の欄だけがあるボードの場合は、初期化済みとして同期することを確認します。')
    const result = await activateByNumber({}, boardWith(TITLE_READ, workflowRead(WORKFLOW_NAMES, LEGACY_FIELD), statusRead()))
    await step('旧い名前の欄で同期した設定を確かめる', () => {
      expect(result.code).toBe(0)
      expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_workflow' } } } })
    })
  })

  it('旧い名前の設定ファイルを渡すと、新しい名前に移し、アクティブな設定を新しい名前にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-26')
    await explains('`project_activate` の旧い名前の設定ファイルのテストです。旧い名前の設定ファイルを指定した場合は、新しい名前へ移動し、アクティブな設定も新しい名前にすることを確認します。')
    const result = await run('project_activate', { project: LEGACY_NAME, reads: boardReads() }, legacyConfig)
    await step('設定ファイルの移行の標準エラーを確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`moved: config file ${path.join(result.directory, LEGACY_CONFIG_FILE)} to ${configPathOf(result)}\n${movedNote(NAME)}updated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
      expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
      expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、登録したリポジトリと、その branches・changelog_file・packages・release_type を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-08')
    await explains('`project_activate` の既存の設定の引き継ぎのテストです。既存の設定ファイルがあるプロジェクトを同期した場合は、ボードのリンクを読まずに、登録したリポジトリとその `branches` や `packages` などを引き継ぐことを確認します。')
    const kept = { owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'rel', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }], release_type: 'multi' }
    const withLog = { owner: 'acme', name: 'logged', changelog_file: 'docs/CHANGELOG.md', release_type: 'nx' }
    const result = await activateByNumber(existing([kept, withLog]))
    await step('引き継いだリポジトリの設定を確かめる', () => {
      expect(result.code).toBe(0)
      expect(repositoriesOf(result)).toEqual([kept, withLog])
    })
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、aggregation_repo を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-09')
    await explains('`project_activate` の `aggregation_repo` の引き継ぎのテストです。既存の設定ファイルがあるプロジェクトを同期した場合は、`aggregation_repo` を引き継ぐことを確認します。')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }], { aggregation_repo: 'acme/roadmap' }))
    await step('引き継いだ aggregation_repo を確かめる', () => {
      expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
    })
  })

  it('owner_type で、board_url を個人のボードか organization のボードの URL にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-29')
    await explains('`project_activate` の `owner_type` のテストです。`owner_type` が `user` なら `/users/`、`org` なら `/orgs/` の `board_url` を書き、最初のビューを開く URL にすることを確認します。')
    const user = await activateByNumber()
    await step('個人のボードの board_url を確かめる', () => {
      expect(boardUrlOf(user)).toMatch(/^https:\/\/ghes\.example\.com\/users\/acme\/projects\/1\/views\/1\?/u)
    })
    const org = await run('project_activate', { ...reference('1'), owner_type: 'org' }, { config: false })
    await step('organization のボードの board_url を確かめる', () => {
      expect(org.code).toBe(0)
      expect(boardUrlOf(org)).toMatch(/^https:\/\/ghes\.example\.com\/orgs\/acme\/projects\/1\/views\/1\?/u)
    })
  })

  it('reads.views を渡さないと、board_url をビューを指さないボードの URL にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-29')
    await explains('`project_activate` の `reads.views` を省略した場合のテストです。`board_url` をビューの番号を含まないボードの URL にすることを確認します。')
    const result = await activateByNumber({}, { ...boardReads(), views: undefined })
    await step('ビューを指さない board_url を確かめる', () => {
      expect(result.code).toBe(0)
      expect(boardUrlOf(result)).toMatch(/^https:\/\/ghes\.example\.com\/users\/acme\/projects\/1\?/u)
    })
  })

  it('host が要る場面で渡していないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の `host` が不足している場合のテストです。`host` が必要な場面で指定していない場合は、使い方を示すエラーを標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', { project: '1' }, { config: false })
    await step('host が無いときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('error: host is required\n  example: project_activate with project: "1", host: "github.com", owner: "example-org", owner_type: "org"\n  example: project_activate with project: "ghes.example.com_example-org_1"\n')
    })
  })

  it('名前で指定したプロジェクトが list_projects の結果に無いと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の名前で指定したプロジェクトが存在しない場合のテストです。読んだボードの一覧に無い場合は、一覧の名前を添えたエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', reference('Non Existent', byTitle(['Other Project'])), { config: false })
    await step('名前が無いときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: project not found: Non Existent\n  available projects:\n  - Other Project\n')
    })
    const more = await run('project_activate', reference('Non Existent', byTitle(['Other Project'], true)), { config: false })
    await step('続きのページがあるときの標準エラーを確かめる', () => {
      expect(more.stderr).toBe('error: project not found: Non Existent\n  available projects:\n  - Other Project\n  the last page of list_projects has a next page; read it with after and add it to reads.projects\n')
    })
  })

  it('指定したプロジェクトが初期化されていないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の初期化されていないプロジェクトのテストです。指定したプロジェクトに進行の欄が無い場合は、`project_check` の実行を案内して終了コード 1 で終わり、設定ファイルを作らないことを確認します。')
    const result = await activateByNumber({}, boardWith(TITLE_READ, statusRead()))
    await step('初期化されていないときの標準エラーと設定ファイルを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: project "board" has no pecot-status field\n  required field: pecot-status (Backlog/Pending/Ready/Active/In Review/Archived)\n  call project_check with method: "fields", owner: "acme", project: 1 and apply the changes it asks for with the project-fields operation of github-ops, then project_activate with project: "1", owner: "acme" to read the board into the project config\n')
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })
  })

  it('要る読み取りを reads に渡していないと、読み方を添えて終了コード 1 で終わる', async () => {
    await explains('`project_activate` の読み取りが不足している場合のテストです。ボードか欄の読み取りを渡していない場合は、公式の GitHub MCP での読み方をエラーに添え、終了コード 1 で終わることを確認します。')
    const noProject = await activateByNumber({}, { ...boardReads(), project: undefined })
    await step('project の読み取りが無いときの標準エラーを確かめる', () => {
      expect(noProject.code).toBe(1)
      expect(noProject.stderr).toBe('error: read the board with projects_get (method get_project, owner acme, project_number 1) and pass its result as reads.project\n')
    })
    const noFields = await activateByNumber({}, { ...boardReads(), fields: undefined })
    await step('欄の読み取りが無いときの標準エラーを確かめる', () => {
      expect(noFields.stderr).toBe('error: read the fields of project #1 with projects_list (method list_project_fields) and pass its result as reads.fields\n')
      expect(noFields.read(CONFIG_FILE)).toBeUndefined()
    })
  })

  it('渡した設定ファイルを読めないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の読み込めない設定ファイルのテストです。指定した設定ファイルを読み込めない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', { project: 'broken' }, { config: false, files: { [`${PROJECTS_DIRECTORY}/broken.json`]: '{ not json' } })
    await step('設定ファイルを読めないときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: could not load config file broken\.json: /u)
    })
  })

  it('host が渡した設定ファイルの host と違うと、warning の行を標準エラーに出す', async () => {
    await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。`host` が設定ファイルの host と異なる場合は、`warning` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_activate', { project: NAME, host: 'github.com', reads: boardReads() })
    await step('host の食い違いの警告を確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`warning: host: "github.com" differs from the config file host (${DEFAULT_HOST})\n  using the config file host\nupdated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
    })
  })

  it('host が渡した設定ファイルの host と違うと、設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-18')
    await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。設定ファイルの host を使って同期し、保存する host と `board_url` も設定ファイルの host のままであることを確認します。')
    const result = await run('project_activate', { project: NAME, host: 'github.com', reads: boardReads() })
    await step('設定ファイルの host で同期した設定を確かめる', () => {
      expect(result.code).toBe(0)
      expect(savedConfig(result)['host']).toBe(DEFAULT_HOST)
      expect(boardUrlOf(result)).toMatch(/^https:\/\/ghes\.example\.com\/users\/acme\/projects\/1\//u)
    })
  })

  it('Blocked が存在しないボードでも同期が通り、設定ファイルに blocked のキーを書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-19')
    await explains('`project_activate` の Blocked を持たないボードのテストです。Blocked の選択肢が存在しないボードでも同期が成功し、設定ファイルに `blocked` のキーを書かないことを確認します。')
    const result = await activateByNumber()
    await step('blocked のキーを書かない設定を確かめる', () => {
      expect(result.code).toBe(0)
      const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
      expect(asJson(fields['workflow'])['options']).not.toHaveProperty('blocked')
      expect(asJson(savedConfig(result)['project'])['board_url']).not.toContain('Blocked')
      expect(fields['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2' } })
    })
  })

  it('Blocked・In Progress・Needs Attention があるボードを同期すると、その id を設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    await explains('`project_activate` の Blocked を持つボードのテストです。`Blocked` や `In Progress` や `Needs Attention` の選択肢があるボードを同期した場合は、その id を設定ファイルに書くことを確認します。')
    const result = await activateByNumber({}, boardWith(TITLE_READ, workflowRead(WORKFLOW_NAMES_WITH_BLOCKED), statusRead([...STATUS_NAMES, 'Needs Attention'])))
    await step('追加の欄の id を書いた設定を確かめる', () => {
      expect(result.code).toBe(0)
      const saved = asJson(asJson(savedConfig(result)['project'])['fields'])
      expect(asJson(saved['workflow'])['options']).toMatchObject({ blocked: 'o2', ready: 'o4' })
      expect(saved['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2', needs_attention: 'o4' } })
      expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
    })
  })

  it('ボードの値が小文字の blocked でも、設定ファイルに id を書き、board_url の絞り込みに Blocked を含める', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    await explains('`project_activate` の小文字の `blocked` のテストです。ボードの選択肢が小文字の `blocked` でも、設定ファイルに id を書き、`board_url` の絞り込みに `Blocked` を含めることを確認します。')
    const names = WORKFLOW_NAMES_WITH_BLOCKED.map(name => name === 'Blocked' ? 'blocked' : name)
    const result = await activateByNumber({}, boardWith(TITLE_READ, workflowRead(names)))
    await step('小文字の blocked の id と board_url を確かめる', () => {
      expect(result.code).toBe(0)
      expect(workflowOptions(result)).toHaveProperty('blocked', 'o2')
      expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
    })
  })

  it('Status のフィールドが存在しないボードを同期すると、fields.status を書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-21')
    await explains('`project_activate` の Status のフィールドのテストです。Status のフィールドが存在しないボードを同期した場合は、設定ファイルに `fields.status` を書かないことを確認します。')
    const result = await activateByNumber({}, boardWith(TITLE_READ, workflowRead()))
    await step('fields.status を書かない設定を確かめる', () => {
      expect(result.code).toBe(0)
      const saved = asJson(savedConfig(result)['project'])
      expect(asJson(saved['fields'])).not.toHaveProperty('status')
    })
  })

  it('必須の値（Blocked を除く 6 つ）が欠けたボードを同期すると、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の必須の選択肢が不足しているボードのテストです。Blocked を除く必須の選択肢が不足している場合は、不足している名前を標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await activateByNumber({}, boardWith(TITLE_READ, workflowRead(['Backlog', 'Blocked']), statusRead()))
    await step('欠けた値の標準エラーと設定ファイルを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('pecot-status field is missing options: Pending, Ready, Active, In Review, Archived')
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })
  })

  describe('MCP の data', () => {
    it('アクティブにした設定の名前・パス・change を返す', async () => {
      await explains('`project_activate` の結果のテストです。設定をアクティブにした場合は、結果に設定の名前とパスと `change` を含めることを確認します。')
      const result = await tool('project_activate', reference('1'), { config: false })
      const configPath = path.join(result.directory, CONFIG_FILE)
      await step('create の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ project: CONFIG_NAME, configPath, change: 'create', config_moved: null })
      })
    })

    it('旧い名前の設定ファイルを新しい名前に移すと、移した元と先を config_moved に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-26')
      await explains('`project_activate` の旧い名前の設定ファイルのテストです。旧い名前の設定ファイルを新しい名前へ移動した場合は、移動の元と先を `config_moved` に含めることを確認します。')
      const result = await tool('project_activate', reference('1'), legacyConfig)
      await step('移行した設定の structuredContent を比べる', () => {
        expect(result.structured).toMatchObject({ project: CONFIG_NAME, config_moved: { from: path.basename(LEGACY_CONFIG_FILE), to: path.basename(CONFIG_FILE) } })
        expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
      })
    })

    it('設定ファイルがあると change を update にする', async () => {
      await explains('`project_activate` の `change` のテストです。設定ファイルが既に存在する場合は、`change` を `update` にすることを確認します。')
      const result = await tool('project_activate', reference('1'))
      await step('update の structuredContent を比べる', () => {
        expect(result.structured).toMatchObject({ project: CONFIG_NAME, change: 'update' })
      })
    })

    it('host が要る場面で渡していないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-12')
      await explains('`project_activate` の `host` が不足している場合のテストです。`host` が必要な場面で指定していない場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_activate', { project: '1' }, { config: false })
      await step('host が無いときの失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
        expect(result.structured['detail']).toMatch(/^host is required/u)
      })
    })

    it('名前で指定したプロジェクトが list_projects の結果に無いと、kind が project-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-13')
      await explains('`project_activate` の名前で指定したプロジェクトが存在しない場合のテストです。読んだボードの一覧に無い場合は、`kind` が `project-not-found` の失敗を返すことを確認します。')
      const result = await tool('project_activate', reference('Non Existent', byTitle(['Other Project'])), { config: false })
      await step('project-not-found の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'project-not-found' } })
        expect(result.structured['detail']).toMatch(/^project not found: Non Existent\n/u)
      })
    })

    it('指定したプロジェクトが初期化されていないと、kind が not-initialized の失敗を返し、project_check を案内する', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-14')
      await explains('`project_activate` の初期化されていないプロジェクトのテストです。プロジェクトに進行の欄が無い場合は、`kind` が `not-initialized` の失敗を返し、`project_check` を案内することを確認します。')
      const reads = boardWith(TITLE_READ, statusRead())
      const result = await tool('project_activate', reference('1', reads), { config: false })
      await step('not-initialized の失敗と案内を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
        expect(result.structured['detail']).toContain('project_check with method: "fields"')
        expect(result.read(CONFIG_FILE)).toBeUndefined()
      })
    })

    it('要る読み取りが無いか、欄の一覧に続きのページがあると、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-30')
      await explains('`project_activate` の読み取りのテストです。ボードの読み取りが無い場合と、欄の一覧に続きのページがある場合は、`invalid-input` の失敗を返し、設定ファイルを作らないことを確認します。')
      const noProject = await tool('project_activate', reference('1', { ...boardReads(), project: undefined }), { config: false })
      await step('読み取りが無いときの invalid-input の失敗を確かめる', () => {
        expect(noProject).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      })
      const reads = boardReads(fieldsRead([TITLE_READ, workflowRead()], true))
      const nextPage = await tool('project_activate', reference('1', reads), { config: false })
      await step('続きのページがあるときの invalid-input の失敗を確かめる', () => {
        expect(nextPage).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
        expect(nextPage.structured['detail']).toMatch(/^list_project_fields in reads\.fields has a next page/u)
        expect(nextPage.read(CONFIG_FILE)).toBeUndefined()
      })
    })

    it('reads の形が公式の GitHub MCP の結果と違うと、kind が github-mcp-shape の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-31')
      await explains('`project_activate` の読み取りの形のテストです。欄の一覧が配列でない場合と、単一選択の欄に `node_id` が無い場合は、`kind` が `github-mcp-shape` の失敗を返すことを確認します。')
      const notList = await tool('project_activate', reference('1', { ...boardReads(), fields: { fields: { fields: 'none' } } }), { config: false })
      await step('欄の一覧が配列でないときの失敗を確かめる', () => {
        expect(notList).toMatchObject({ isError: true, structured: { kind: 'github-mcp-shape' } })
      })
      const withoutNodeId = { ...workflowRead(), node_id: undefined }
      const noNodeId = await tool('project_activate', reference('1', boardWith(TITLE_READ, withoutNodeId)), { config: false })
      await step('node_id が無いときの失敗を確かめる', () => {
        expect(noNodeId).toMatchObject({ isError: true, structured: { kind: 'github-mcp-shape', detail: 'the result of projects_list in reads.fields has no node_id for field pecot-status' } })
      })
    })

    it('owner の種類が分からないと、kind が invalid-input の失敗を返し、owner_type を案内する', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-29')
      await explains('`project_activate` の `owner_type` のテストです。入力と読み取りのどちらでも個人か organization かが分からない場合は、`invalid-input` の失敗を返し、`owner_type` を案内することを確認します。')
      const result = await tool('project_activate', { ...reference('1'), owner_type: undefined }, { config: false })
      await step('owner の種類が分からないときの失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input', detail: 'cannot tell whether acme is a user or an organization\n  pass owner_type, the value given to projects_get' } })
      })
    })

    it('渡した設定ファイルを読めないと、kind が config-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-16')
      await explains('`project_activate` の読み込めない設定ファイルのテストです。指定した設定ファイルを読み込めない場合は、`kind` が `config-invalid` の失敗を返すことを確認します。')
      const result = await tool('project_activate', { project: 'broken' }, { config: false, files: { [`${PROJECTS_DIRECTORY}/broken.json`]: '{ not json' } })
      await step('config-invalid の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      })
    })

    it('host が渡した設定ファイルの host と違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-17')
      await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。異なる `host` を指定した場合は、`warnings` に警告を 1 件含めることを確認します。')
      const result = await tool('project_activate', { project: CONFIG_NAME, host: 'github.com', reads: boardReads() })
      await step('host の食い違いの warnings を確かめる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual([`host: "github.com" differs from the config file host (${DEFAULT_HOST})\n  using the config file host`])
      })
    })

    it('進行の欄に必須の値が欠けていると、kind が not-initialized の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-22')
      await explains('`project_activate` の必須の選択肢が不足しているボードのテストです。進行の欄の必須の選択肢が不足している場合は、`kind` が `not-initialized` の失敗を返すことを確認します。')
      const reads = boardWith(TITLE_READ, workflowRead(['Backlog', 'Blocked']))
      const result = await tool('project_activate', reference('1', reads), { config: false })
      await step('not-initialized の失敗と設定ファイルを確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
        expect(result.read(CONFIG_FILE)).toBeUndefined()
      })
    })
  })
})

describe('project_link', () => {
  const demo = { owner: 'acme', name: 'demo', develop_branch: 'main' }
  const withRepository = (...repositories: Json[]): Partial<CommandRun> => ({ config: projectConfig({ repositories }) })
  const setRepository = async (input: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}): Promise<CommandResult> => await run('project_link', input, extra)

  it('未登録のリポジトリを渡すと、ボードへのリンクの要求を送らずに設定ファイルへ足す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-01')
    await explains('`project_link` の未登録のリポジトリのテストです。未登録のリポジトリを指定した場合は、設定ファイルに追加することを確認します。')
    const result = await setRepository({ repo: 'acme/other' })
    await step('追加したリポジトリを確かめる', () => {
      expect(result.code).toBe(0)
      expect(repositoriesOf(result)).toEqual([demo, { owner: 'acme', name: 'other' }])
    })
  })

  it('未登録のリポジトリを足すと、渡したオプションの値を設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-02')
    await explains('`project_link` の設定ファイルへの追加のテストです。未登録のリポジトリを追加した場合は、指定したオプションの値を含めて設定ファイルに書くことを確認します。')
    const result = await setRepository({ repo: 'acme/other', develop_branch: 'dev', release_type: 'nx' })
    await step('追加したリポジトリと標準エラーを確かめる', () => {
      expect(repositoriesOf(result)).toEqual([demo, { owner: 'acme', name: 'other', develop_branch: 'dev', release_type: 'nx' }])
      expect(result.stderr).toBe(`added: acme/other to ${configPathOf(result)}\n`)
    })
  })

  it('登録済みのリポジトリを渡すと、渡したオプションの値だけを更新する', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-03')
    await explains('`project_link` の登録済みのリポジトリのテストです。登録済みのリポジトリを指定した場合は、指定したオプションの値だけを更新することを確認します。')
    const result = await setRepository({ repo: 'acme/demo', develop_branch: 'dev' }, withRepository({ ...demo, release_branch: 'release' }))
    await step('更新したリポジトリを確かめる', () => {
      expect(result.code).toBe(0)
      expect(repositoriesOf(result)).toEqual([{ owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'release' }])
      expect(result.stderr).toBe(`updated: acme/demo in ${configPathOf(result)}\n`)
    })
  })

  it('登録済みのリポジトリに package を渡すと、packages を置き換える', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-04')
    await explains('`project_link` の `package` のテストです。登録済みのリポジトリに `package` を指定した場合は、`packages` を指定した内容へ置き換えることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a/CHANGELOG.md', 'b:b/CHANGELOG.md'] }, withRepository({ ...demo, packages: [{ name: 'old', changelog: 'old.md' }] }))
    await step('packages を置き換えた設定を確かめる', () => {
      expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }, { name: 'b', changelog: 'b/CHANGELOG.md' }] }])
    })
  })

  it('登録済みのリポジトリに package を渡すと、changelog_file を消す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-05')
    await explains('`project_link` の `package` のテストです。登録済みのリポジトリに `package` を指定した場合は、`changelog_file` を削除して `packages` を設定することを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a/CHANGELOG.md'] }, withRepository({ ...demo, changelog_file: 'CHANGELOG.md' }))
    const [entry] = repositoryEntries(result)
    await step('changelog_file が消えたことを確かめる', () => {
      expect(entry).not.toHaveProperty('changelog_file')
      expect(entry).toHaveProperty('packages')
    })
  })

  it('登録済みのリポジトリに clear_packages を付けると、packages を消す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-06')
    await explains('`project_link` の `clear_packages` のテストです。登録済みのリポジトリに `clear_packages` を指定した場合は、`packages` を削除することを確認します。')
    const result = await setRepository({ repo: 'acme/demo', clear_packages: true }, withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    await step('packages が消えたことを確かめる', () => {
      expect(result.code).toBe(0)
      expect(repositoriesOf(result)).toEqual([demo])
    })
  })

  it('package と changelog_file を一緒に渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のオプションの組み合わせのテストです。`package` と `changelog_file` を同時に指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a.md'], changelog_file: 'C.md' })
    await step('package と changelog_file の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: package and changelog_file cannot be used together\n')
    })
  })

  it('package と clear_packages を一緒に渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のオプションの組み合わせのテストです。`package` と `clear_packages` を同時に指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a.md'], clear_packages: true })
    await step('package と clear_packages の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: package and clear_packages: true cannot be used together\n')
    })
  })

  it('package が NAME:PATH の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `package` の形式のテストです。`package` が `NAME:PATH` の形式でない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['nocolon'] })
    await step('package の書式の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: give package: <NAME:PATH>: \'nocolon\'\n')
    })
  })

  it('package の NAME が重なると、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `package` の名前のテストです。`package` の `NAME` が重複している場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['foo:a.md', 'foo:b.md'] })
    await step('package の重複の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: package NAME is duplicated: \'foo\'\n')
    })
  })

  it('未登録のリポジトリに不正な package の名前を渡すと、設定ファイルを書き換えずに終了コード 1 で終わる', async () => {
    await explains('`project_link` の不正な `package` の名前のテストです。未登録のリポジトリに不正な名前を指定した場合は、設定ファイルを書き換えずに終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/new', package: ['bad name:p'] })
    await step('標準エラーのエラー行を確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: /u)
      expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(projectConfig())
    })
  })

  it('リポジトリの所有者がプロジェクトの所有者と違うと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のリポジトリの所有者のテストです。リポジトリの所有者がプロジェクトの所有者と異なる場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'different-owner/repo' })
    await step('owner の食い違いの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: repository owner different-owner differs from project owner acme\n  GitHub Projects V2 links only repositories of the project owner\n')
    })
  })

  it('リポジトリが owner/repo の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のリポジトリの指定形式のテストです。リポジトリが `owner/repo` の形式でない場合は、例を添えたエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'justname' })
    await step('リポジトリの書式の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: give the repository as owner/repo\n  example: project_link with repo: "example-org/my-repo"\n')
    })
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo' }, { config: false })
    await step('アクティブなプロジェクトが無いときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })
  })

  it('release_type が single・multi・nx のどれでもないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `release_type` のテストです。`single`・`multi`・`nx` のいずれにも該当しない値を指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', release_type: 'bogus' })
    await step('release_type の標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: release_type must be one of [\'multi\', \'nx\', \'single\'] (got: \'bogus\')\n')
    })
  })

  it('packages を持つリポジトリに changelog_file を渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `packages` を持つリポジトリのテストです。`packages` を持つリポジトリに `changelog_file` を指定した場合は、エラーを出力して終了コード 1 で終わり、設定ファイルを書き換えないことを確認します。')
    const result = await setRepository({ repo: 'acme/demo', changelog_file: 'C.md' }, withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    await step('packages が残っているときの標準エラーと設定を確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: this repository has packages set\n  call with clear_packages: true before switching to changelog_file\n')
      expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }])
    })
  })

  describe('MCP の data', () => {
    it('リポジトリ・プロジェクト番号・change・設定ファイルのパスを返す', async () => {
      await explains('`project_link` の結果のテストです。未登録のリポジトリを追加した場合は、結果にリポジトリとプロジェクト番号と `change` と設定ファイルのパスを含めることを確認します。')
      const result = await tool('project_link', { repo: 'acme/other' })
      const configPath = path.join(result.directory, CONFIG_FILE)
      await step('create の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ repository: 'acme/other', projectNumber: 1, change: 'create', configPath })
      })
    })

    it('登録済みのリポジトリだと change を update にする', async () => {
      await explains('`project_link` の `change` のテストです。登録済みのリポジトリを指定した場合は、`change` を `update` にすることを確認します。')
      const result = await tool('project_link', { repo: 'acme/demo', develop_branch: 'dev' })
      await step('update の structuredContent を比べる', () => {
        expect(result.structured).toMatchObject({ repository: 'acme/demo', change: 'update' })
      })
    })

    it.for([
      { name: 'package と changelog_file を一緒に渡す', input: { package: ['a:a.md'], changelog_file: 'C.md' }, id: 'PW-PROJECT-LINK-09' },
      { name: 'package と clear_packages を一緒に渡す', input: { package: ['a:a.md'], clear_packages: true }, id: 'PW-PROJECT-LINK-10' },
      { name: 'package の要素が NAME:PATH の形でない', input: { package: ['nocolon'] }, id: 'PW-PROJECT-LINK-11' },
      { name: 'package の NAME が重なる', input: { package: ['foo:a.md', 'foo:b.md'] }, id: 'PW-PROJECT-LINK-12' },
      { name: 'release_type が single・multi・nx のどれでもない', input: { release_type: 'bogus' }, id: 'PW-PROJECT-LINK-16' },
    ])('$name と、kind が invalid-input の失敗を返す', async ({ name, input, id }, context) => {
      await verifies(context, id)
      await explains(`\`project_link\` の不正な入力のテストです。条件が「${name}」の場合は、\`kind\` が \`invalid-input\` の失敗を返し、設定ファイルを書き換えないことを確認します。`)
      const result = await tool('project_link', { repo: 'acme/demo', ...input })
      await step('invalid-input の失敗と設定ファイルを確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
        expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(projectConfig())
      })
    })

    it('リポジトリの所有者がプロジェクトの所有者と違うと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-13')
      await explains('`project_link` のリポジトリの所有者のテストです。リポジトリの所有者がプロジェクトの所有者と異なる場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'different-owner/repo' })
      await step('owner の食い違いの失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
        expect(result.structured['detail']).toContain('repository owner different-owner differs from project owner acme')
      })
    })

    it('リポジトリが owner/repo の形でないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-14')
      await explains('`project_link` のリポジトリの指定形式のテストです。リポジトリが `owner/repo` の形式でない場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'justname' })
      await step('リポジトリの書式の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-15')
      await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'acme/demo' }, { config: false })
      await step('no-active-project の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      })
    })

    it('packages を持つリポジトリに changelog_file を渡すと、kind が invalid-input の失敗を返し、設定ファイルを書き換えない', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-17')
      await explains('`project_link` の `packages` を持つリポジトリのテストです。`packages` を持つリポジトリに `changelog_file` を指定した場合は、`kind` が `invalid-input` の失敗を返し、設定ファイルを書き換えないことを確認します。')
      const packaged = { ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }
      const result = await tool('project_link', { repo: 'acme/demo', changelog_file: 'C.md' }, withRepository(packaged))
      await step('invalid-input の失敗と packages が残ることを確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
        expect(repositoriesOf(result)).toEqual([packaged])
      })
    })
  })
})

describe('project_set', () => {
  const withAggregation = (value?: string): Partial<CommandRun> => ({ config: projectConfig(value === undefined ? {} : { extra: { aggregation_repo: value } }) })
  const set = async (input: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}): Promise<CommandResult> => await run('project_set', { key: 'aggregation_repo', ...input }, extra)

  it('未設定の状態で値を渡すと、設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-SET-01')
    await explains('`project_set` の `aggregation_repo` のテストです。未設定の状態で値を指定した場合は、設定ファイルに `aggregation_repo` を書くことを確認します。')
    const result = await set({ value: 'acme/roadmap' })
    await step('設定した aggregation_repo を確かめる', () => {
      expect(result.code).toBe(0)
      expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
    })
  })

  it('未設定の状態で値を渡すと、set の行を標準エラーに出す', async () => {
    await explains('`project_set` の標準エラーのテストです。未設定の状態で値を指定した場合は、標準出力に何も出力せず、`set` の行を標準エラーへ出力することを確認します。')
    const result = await set({ value: 'acme/roadmap' })
    await step('設定の標準エラーを確かめる', () => {
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('set: aggregation_repo to acme/roadmap\n')
    })
  })

  it('既にある値と同じ値を渡すと、unchanged の行を標準エラーに出す', async () => {
    await explains('`project_set` の同じ値のテストです。既に設定している値と同じ値を指定した場合は、`unchanged` の行を標準エラーへ出力することを確認します。')
    const result = await set({ value: 'acme/roadmap' }, withAggregation('acme/roadmap'))
    await step('変わらないときの標準エラーを確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('unchanged: aggregation_repo acme/roadmap\n')
    })
  })

  it('既にある値と違う値を渡すと、上書きの warning の行を標準エラーに出す', async () => {
    await explains('`project_set` の上書きのテストです。既に設定している値と異なる値を指定した場合は、上書きの `warning` の行を標準エラーへ出力し、新しい値を書くことを確認します。')
    const result = await set({ value: 'acme/new' }, withAggregation('acme/roadmap'))
    await step('上書きの警告と設定を確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\n  pass yes: true to omit this hint\nset: aggregation_repo to acme/new\n')
      expect(savedConfig(result)['aggregation_repo']).toBe('acme/new')
    })
  })

  it('yes を付けて上書きすると、warning の行から確認の案内を省く', async () => {
    await explains('`project_set` の `yes` のテストです。`yes` を指定して上書きした場合は、`warning` の行から確認の案内を省略することを確認します。')
    const result = await set({ value: 'acme/new', yes: true }, withAggregation('acme/roadmap'))
    await step('yes で上書きした標準エラーを確かめる', () => {
      expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\nset: aggregation_repo to acme/new\n')
    })
  })

  it('値が owner/repo の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_set` の値の形式のテストです。値が `owner/repo` の形式でない場合は、エラーを出力して終了コード 1 で終わり、設定ファイルに書かないことを確認します。')
    const result = await set({ value: 'roadmap' })
    await step('書式の標準エラーと設定を確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: give aggregation_repo as owner/repo: \'roadmap\'\n')
      expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
    })
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await set({ value: 'acme/roadmap' }, { config: false })
    await step('アクティブなプロジェクトが無いときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })
  })

  describe('MCP の data', () => {
    it('未設定のキーに書くと change を create にして、previous を返さず、書いた設定ファイルのパスを configPath に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-02')
      await explains('`project_set` の結果のテストです。未設定のキーに書き込んだ場合は、`change` を `create` にし、`previous` を含めず、`configPath` に設定ファイルのパスを含めることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' })
      const configPath = path.join(result.directory, CONFIG_FILE)
      await step('create の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap', change: 'create', configPath })
      })
    })

    it('別の値に上書きすると、change を update にして previous を返し、上書きの知らせを warnings に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-04')
      await explains('`project_set` の上書きのテストです。別の値で上書きした場合は、`change` を `update` にし、`previous` と上書きの警告を結果に含めることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/new' }, withAggregation('acme/roadmap'))
      await step('上書きの structuredContent と警告を比べる', () => {
        expect(result.structured).toMatchObject({ key: 'aggregation_repo', value: 'acme/new', previous: 'acme/roadmap', change: 'update', configPath: path.join(result.directory, CONFIG_FILE) })
        expect(result.structured['warnings']).toEqual(['overwriting aggregation_repo: acme/roadmap -> acme/new\n  pass yes: true to omit this hint'])
      })
    })

    it('yes を付けて上書きすると、上書きの知らせから確認の案内を省く', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-05')
      await explains('`project_set` の `yes` のテストです。`yes` を指定して上書きした場合は、上書きの警告から確認の案内を省略することを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/new', yes: true }, withAggregation('acme/roadmap'))
      await step('確認の案内を省いた警告を比べる', () => {
        expect(result.structured['warnings']).toEqual(['overwriting aggregation_repo: acme/roadmap -> acme/new'])
      })
    })

    it('値が owner/repo の形でないと、kind が invalid-input の失敗を返し、設定ファイルを書かない', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-06')
      await explains('`project_set` の値の形式のテストです。値が `owner/repo` の形式でない場合は、`kind` が `invalid-input` の失敗を返し、設定ファイルに書かないことを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'roadmap' })
      await step('invalid-input の失敗と設定を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input', detail: 'give aggregation_repo as owner/repo: \'roadmap\'' } })
        expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
      })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-07')
      await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' }, { config: false })
      await step('no-active-project の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-08')
      await explains('`project_set` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_set', { key: 'foo', value: 'acme/roadmap' })
      await step('invalid-input の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      })
    })

    it('同じ値だと change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-03')
      await explains('`project_set` の同じ値のテストです。既に設定している値と同じ値を指定した場合は、`change` を `unchanged` にすることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' }, withAggregation('acme/roadmap'))
      await step('変わらない structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap', previous: 'acme/roadmap', change: 'unchanged', configPath: path.join(result.directory, CONFIG_FILE) })
      })
    })
  })
})

describe('project_unset', () => {
  const configured = { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) }

  it('値を設定していると、設定ファイルから消す', async (context) => {
    await verifies(context, 'PW-PROJECT-UNSET-01')
    await explains('`project_unset` の `aggregation_repo` のテストです。値を設定している場合は、設定ファイルから `aggregation_repo` を削除することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, configured)
    await step('消した aggregation_repo を確かめる', () => {
      expect(result.code).toBe(0)
      expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
    })
  })

  it('値を設定していると、removed の行を標準エラーに出す', async () => {
    await explains('`project_unset` の標準エラーのテストです。値を設定している場合は、標準出力に何も出力せず、`removed` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, configured)
    await step('消した標準エラーを確かめる', () => {
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('removed: aggregation_repo (was acme/roadmap)\n')
    })
  })

  it('未設定だと、unchanged の行を標準エラーに出す', async () => {
    await explains('`project_unset` の未設定の場合のテストです。値が未設定の場合は、`unchanged` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' })
    await step('変わらないときの標準エラーを確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('unchanged: aggregation_repo (not set)\n')
    })
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, { config: false })
    await step('アクティブなプロジェクトが無いときの標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })
  })

  describe('MCP の data', () => {
    it('値を消すと change を delete にして、消した値を previous に、書いた設定ファイルのパスを configPath に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-02')
      await explains('`project_unset` の結果のテストです。値を削除した場合は、`change` を `delete` にし、削除した値を `previous` に、設定ファイルのパスを `configPath` に含めることを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' }, withAggregation('acme/roadmap'))
      await step('delete の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo', previous: 'acme/roadmap', change: 'delete', configPath: path.join(result.directory, CONFIG_FILE) })
      })
    })

    it('未設定だと change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-03')
      await explains('`project_unset` の未設定の場合のテストです。値が未設定の場合は、`change` を `unchanged` にすることを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' })
      await step('unchanged の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo', change: 'unchanged', configPath: path.join(result.directory, CONFIG_FILE) })
      })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-04')
      await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' }, { config: false })
      await step('no-active-project の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-05')
      await explains('`project_set` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_unset', { key: 'foo' })
      await step('invalid-input の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      })
    })
  })
})

describe('project_get', () => {
  it('値を設定していると、その値を標準出力に出す', async () => {
    await explains('`project_get` の値の出力のテストです。値を設定している場合は、その値を標準出力へ出力することを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' }, { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
    await step('aggregation_repo の標準出力を確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('acme/roadmap\n')
    })
  })

  it('未設定だと、none を標準出力に出す', async () => {
    await explains('`project_get` の未設定の場合のテストです。値が未設定の場合は、`none` を標準出力へ出力することを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' })
    await step('未設定の標準出力を確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('none\n')
    })
  })

  it('key を省くと、アクティブなプロジェクトと登録したリポジトリの要約を 1 行ずつ出す', async (context) => {
    await verifies(context, 'PW-PROJECT-GET-05')
    await explains('`project_get` の `key` を省略した場合のテストです。プロジェクトの名前と host と番号、`aggregation_repo`、リポジトリごとのブランチとリリースの方法を標準出力へ出力することを確認します。')
    const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main', release_branch: 'release' }, { owner: 'acme', name: 'mono', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }] }]
    const result = await run('project_get', {}, { config: projectConfig({ repositories, extra: { aggregation_repo: 'acme/roadmap' } }) })
    await step('全体の標準出力を比べる', () => {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`project: ${CONFIG_NAME} (${DEFAULT_HOST}, acme #1)\naggregation_repo: acme/roadmap\nrepositories:\n- acme/demo (develop: main, release: release), release_type: single\n- acme/mono, release_type: multi\n`)
    })
    const empty = await run('project_get', {}, { config: projectConfig({ repositories: [] }) })
    await step('空のときの標準出力を比べる', () => {
      expect(empty.stdout).toBe(`project: ${CONFIG_NAME} (${DEFAULT_HOST}, acme #1)\naggregation_repo: none\nrepositories:\n- none\n`)
    })
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' }, { config: false })
    await step('アクティブなプロジェクトが無いときの標準出力と標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(NO_ACTIVE)
    })
  })

  describe('MCP の data', () => {
    it('値があると key と value を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-01')
      await explains('`project_get` の結果のテストです。値を設定している場合は、結果に `key` と `value` を含めることを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' }, withAggregation('acme/roadmap'))
      await step('値の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap' })
      })
    })

    it('値が未設定だと value を返さない', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-02')
      await explains('`project_get` の未設定の場合のテストです。値が未設定の場合は、結果に `value` を含めないことを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' })
      await step('未設定の structuredContent を比べる', () => {
        expect(result.structured).toEqual({ key: 'aggregation_repo' })
      })
    })

    it('key を省くと、project と repositories に要約を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-05')
      await explains('`project_get` の `key` を省略した場合の結果のテストです。`project` にプロジェクトの要約を、`repositories` にリポジトリごとのブランチとリリースの方法を含めることを確認します。')
      const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main', changelog_file: 'docs/CHANGELOG.md' }, { owner: 'acme', name: 'mono', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }], release_type: 'nx' }]
      const result = await tool('project_get', {}, { config: projectConfig({ repositories }) })
      await step('全体の structuredContent を比べる', () => {
        expect(result.structured).toEqual({
          project: { name: CONFIG_NAME, host: DEFAULT_HOST, owner: 'acme', number: 1, aggregation_repo: null },
          repositories: [
            { full_name: 'acme/demo', develop_branch: 'main', release_branch: null, release_type: 'single', packages: [], changelog_file: 'docs/CHANGELOG.md' },
            { full_name: 'acme/mono', develop_branch: null, release_branch: null, release_type: 'nx', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }] },
          ],
        })
      })
    })

    it('key を省いてアクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-03')
      await explains('`project_get` の `key` を省略した場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_get', {}, { config: false })
      await step('no-active-project の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-03')
      await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' }, { config: false })
      await step('no-active-project の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-04')
      await explains('`project_set` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_get', { key: 'foo' })
      await step('invalid-input の失敗を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      })
    })
  })
})
