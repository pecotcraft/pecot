/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// 設定ファイルの同期と、project の各コマンドが共有する判定。GitHub は偽サーバにする。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { setEnvironment } from '../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'
import type { JsonObject } from '../../domain/json.js'
import { GitHubAPIError } from '../../infra/github/errors.js'
import { graphqlData, rejection, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import type { Output } from '../output.js'
import {
  buildRepository,
  failApi,
  fieldNodesOf,
  hasWorkflowField,
  lastFieldNamed,
  missingRequiredOptions,
  placeProjectConfig,
  planWorkflowFieldOf,
  reportConfigMove,
  syncProjectConfig,
  textOf,
} from '../project-sync.js'
import type { SyncedProjectConfig } from '../project-sync.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

useFakeGithub()

type Json = JsonObject

const HOST = 'github.com'
const BOARD_URL = 'https://github.com/users/acme/projects/1'
const WORKFLOW_NAMES = ['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived']
const options = (names: readonly string[]): Json[] => names.map((name, index) => ({ id: `o${String(index + 1)}`, name }))

function workflowField(names: readonly string[] = WORKFLOW_NAMES, name = 'pecot-status'): Json {
  return { id: 'PVTSSF_workflow', name, databaseId: 456, options: options(names) }
}

const statusField: Json = { id: 'PVTSSF_status', name: 'Status', options: options(['Todo', 'In Progress', 'Done']) }

const listProjects = (...titles: readonly string[]): ReturnType<typeof graphqlData> => graphqlData('ListProjectsUser', { user: { projectsV2: { nodes: titles.map((title, index) => ({ number: index + 1, title, url: BOARD_URL, id: `PVT_${String(index + 1)}` })) } } })

function projectFields(fields: readonly Json[], views: readonly Json[] = [{ number: 1 }]): ReturnType<typeof graphqlData> {
  return graphqlData('GetProjectFieldsUser', { user: { projectV2: { id: 'PVT_1', title: 'board', url: BOARD_URL, views: { nodes: views }, fields: { nodes: fields } } } })
}

const linked = (...names: readonly string[]): ReturnType<typeof graphqlData> => graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: names.map(name => ({ owner: { login: 'acme' }, name })) } } } })

interface Captured {
  readonly io: CapturedIo
  readonly out: Output
}

function captured(isDryRun = false): Captured {
  const io = capture()
  return { io, out: createOutput(isDryRun, io) }
}

function useProjectRoot(): string {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  return path.join(root, '.pecot', 'config', 'projects')
}

function writeConfig(directory: string, fileName: string, data: Json): string {
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, fileName)
  writeFileSync(file, `${JSON.stringify(data, undefined, 2)}\n`)
  return file
}

function boardConfig(repositories: readonly Json[] = []): Json {
  return { host: HOST, owner: 'acme', project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: {} } } }, repositories }
}

interface SyncAgain {
  readonly second: SyncedProjectConfig
  readonly err: string
  readonly isActivated: boolean
}

// 同じボードを 2 回同期する。2 回目の前に、アクティブの設定を別のファイルに向けておく
async function syncTwice(extra: Readonly<{ activateIfUnchanged?: boolean, isDryRun?: boolean }>): Promise<SyncAgain> {
  const directory = useProjectRoot()
  const projects = graphqlData('ListProjectsUser', { user: { projectsV2: { nodes: [{ number: 1, title: 'board', url: BOARD_URL, id: 'PVT_1' }] } } }, 2)
  const fields = graphqlData('GetProjectFieldsUser', { user: { projectV2: { id: 'PVT_1', title: 'board', url: BOARD_URL, views: { nodes: [] }, fields: { nodes: [workflowField()] } } } }, 2)
  const { client } = await startClient([projects, fields, graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [] } } } }, 2)])
  await syncProjectConfig(captured().out, client, { owner: 'acme', name: 'board', host: HOST, skipIfUnchanged: true })
  const activeFile = path.join(directory, '.active')
  writeFileSync(activeFile, 'other.json\n')
  const { io, out } = captured(extra.isDryRun === true)
  const second = await syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST, skipIfUnchanged: true, ...extra })
  return { second: { ...second, configPath: path.basename(second.configPath) }, err: io.err.join('').replaceAll(directory, '<dir>'), isActivated: readFileSync(activeFile, 'utf8') !== 'other.json\n' }
}

describe('textOf', () => {
  it.for([
    { name: 'undefined', value: undefined, expected: 'None' },
    { name: '文字列', value: 'x', expected: 'x' },
    { name: '数', value: 3, expected: '3' },
    { name: '真偽', value: true, expected: 'True' },
  ])('$name を Python の str() と同じ文字列にする', ({ value, expected }) => {
    expect(textOf(value)).toBe(expected)
  })
})

describe('failApi', () => {
  it('状態コードがあれば添え、無ければ添えずに止める', () => {
    const withStatus = captured()
    expect(() => failApi(withStatus.out, 'read the board', new GitHubAPIError('boom', { statusCode: 502 }))).toThrow(CommandExit)
    const withoutStatus = captured()
    expect(() => failApi(withoutStatus.out, 'read the board', new GitHubAPIError('boom'))).toThrow(CommandExit)
    expect([withStatus.io.err.join(''), withoutStatus.io.err.join('')]).toEqual([
      'error: could not read the board (status 502): boom\n',
      'error: could not read the board: boom\n',
    ])
  })
})

describe('進行の欄の判定', () => {
  it('選択肢を持つフィールドの名前から、使う・改名する・作るを決める', () => {
    expect([
      planWorkflowFieldOf([workflowField()]),
      planWorkflowFieldOf([workflowField(WORKFLOW_NAMES, 'pecot-workflow-acme'), { name: 'Title' }]),
      planWorkflowFieldOf([{ name: 'Title' }, 'x']),
    ]).toEqual([
      { kind: 'current', use: 'pecot-status' },
      { kind: 'rename', from: 'pecot-workflow-acme', use: 'pecot-status' },
      { kind: 'create', use: 'pecot-status' },
    ])
  })

  it('今の名前か旧い名前の欄があるときだけ、進行の欄があるとする', () => {
    expect([
      hasWorkflowField([{ name: 'pecot-status' }]),
      hasWorkflowField([{ name: 'pecot-workflow-acme' }]),
      hasWorkflowField([{ name: 'Status' }, { name: 3 }]),
    ]).toEqual([true, true, false])
  })

  it('fields.nodes を取り、無ければ空にする', () => {
    expect([fieldNodesOf({ fields: { nodes: [{ name: 'a' }] } }), fieldNodesOf({})]).toEqual([[{ name: 'a' }], []])
  })

  it('同じ名前の選択肢を持つフィールドが複数あれば後のものを返し、選択肢の無いものは選ばない', () => {
    const later = { name: 'Status', options: [], id: 'later' }
    expect([
      lastFieldNamed([{ name: 'Status', options: [], id: 'first' }, later], 'Status'),
      lastFieldNamed([{ name: 'Status', id: 'plain' }], 'Status'),
    ]).toEqual([later, undefined])
  })

  it('必須の選択肢の欠けを、大文字と小文字を区別せずに要る順で返す', () => {
    expect([
      missingRequiredOptions({ options: options(['backlog', 'READY', 'Active']) }),
      missingRequiredOptions({ options: [{ id: 'x' }] }),
    ]).toEqual([
      ['Pending', 'In Review', 'Archived'],
      ['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived'],
    ])
  })
})

describe('buildRepository', () => {
  it('モデルの定義の順のキーで作る', () => {
    expect(Object.keys(buildRepository({ release_type: 'nx', name: 'r', owner: 'o' }))).toEqual(['owner', 'name', 'develop_branch', 'release_branch', 'changelog_file', 'packages', 'release_type'])
  })
})

describe('placeProjectConfig', () => {
  it('同じボードの旧い名前のファイルが 1 つなら、移す元にする', () => {
    const directory = useProjectRoot()
    writeConfig(directory, 'old.json', boardConfig())
    expect(placeProjectConfig(captured().out, { host: HOST, owner: 'acme', number: 1 })).toEqual({ configPath: path.join(directory, 'github.com_acme_1.json'), movedFrom: path.join(directory, 'old.json') })
  })

  it('同じボードの旧い名前のファイルが 2 つ以上なら、名前を並べて止める', () => {
    const directory = useProjectRoot()
    writeConfig(directory, 'a.json', boardConfig())
    writeConfig(directory, 'b.json', boardConfig())
    const { io, out } = captured()
    expect(() => placeProjectConfig(out, { host: HOST, owner: 'acme', number: 1 })).toThrow(CommandExit)
    expect(io.err.join('')).toBe('error: several config files point to project #1:\n  - a.json\n  - b.json\n  remove all but one, then run again; it is moved to github.com_acme_1.json\n')
  })
})

describe('reportConfigMove', () => {
  it('移す元が無ければ何も出さず、dry-run では予定の行で出す', () => {
    const none = captured()
    reportConfigMove(none.out, { configPath: '/p/new.json', movedFrom: undefined }, false)
    const planned = captured(true)
    reportConfigMove(planned.out, { configPath: '/p/new.json', movedFrom: '/p/old.json' }, true)
    expect([none.io.err.join(''), planned.io.err.join('')]).toEqual([
      '',
      'dry-run: would move config file /p/old.json to /p/new.json\nwarning: the project config is now named new\n  use this name for the project input and the PECOT_REVIEW_PROJECT variable\n',
    ])
  })
})

describe('syncProjectConfig', () => {
  it('設定ファイルが無ければ、ボードの値から作ってアクティブにする', async () => {
    const directory = useProjectRoot()
    const { client } = await startClient([listProjects('board'), projectFields([{ id: 'PVTF_title', name: 'Title' }, workflowField([...WORKFLOW_NAMES, 'Blocked']), statusField]), linked('demo', 'demo')])
    const { io, out } = captured()

    const result = await syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST })

    const configPath = path.join(directory, 'github.com_acme_1.json')
    expect(result).toEqual({ configPath, change: 'create', activeProject: 'github.com_acme_1', movedFrom: undefined })
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      host: HOST,
      owner: 'acme',
      project: {
        number: 1,
        id: 'PVT_1',
        board_url: `${BOARD_URL}/views/1?layout=board&verticalGroupedBy%5BcolumnId%5D=456&filterQuery=%20pecot-status%3APending%2CBacklog%2CBlocked%2CReady%2CActive%2CArchived%2C%22In%20Review%22`,
        fields: {
          workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o2', pending: 'o1', blocked: 'o7', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
          status: { id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2' } },
        },
      },
      repositories: [{ owner: 'acme', name: 'demo' }],
    })
    expect(readFileSync(path.join(directory, '.active'), 'utf8')).toBe('github.com_acme_1.json\n')
    expect(io.err.join('')).toBe(`created: config file ${configPath}\nset: active project to github.com_acme_1\n`)
  })

  it('ビューが無ければ、絞り込みだけの URL にし、既存の設定のリポジトリの順と値を残す', async () => {
    const directory = useProjectRoot()
    const configPath = writeConfig(directory, 'github.com_acme_1.json', { ...boardConfig([{ owner: 'acme', name: 'gone' }, { owner: 'acme', name: 'kept', develop_branch: 'develop' }]), aggregation_repo: 'acme/roadmap' })
    const { client } = await startClient([listProjects('board'), projectFields([workflowField()], []), linked('new', 'kept')])
    const { io, out } = captured()

    const result = await syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST })

    const saved: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    expect({ result, saved }).toEqual({
      result: { configPath, change: 'update', activeProject: 'github.com_acme_1', movedFrom: undefined },
      saved: {
        host: HOST,
        owner: 'acme',
        project: {
          number: 1,
          id: 'PVT_1',
          board_url: `${BOARD_URL}?filterQuery=%20pecot-status%3APending%2CBacklog%2CReady%2CActive%2CArchived%2C%22In%20Review%22`,
          fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o2', pending: 'o1', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } } },
        },
        repositories: [{ owner: 'acme', name: 'kept', develop_branch: 'develop' }, { owner: 'acme', name: 'new' }],
        aggregation_repo: 'acme/roadmap',
      },
    })
    expect(io.err.join('')).toBe(`updated: config file ${configPath}\nset: active project to github.com_acme_1\n`)
  })

  it('旧い名前の設定ファイルを新しい名前に移し、旧いファイルを消す', async () => {
    const directory = useProjectRoot()
    const old = writeConfig(directory, 'old.json', boardConfig([{ owner: 'acme', name: 'demo', release_branch: 'main' }]))
    const { client } = await startClient([listProjects('board'), projectFields([workflowField()]), linked('demo')])
    const { io, out } = captured()

    const result = await syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST })

    const configPath = path.join(directory, 'github.com_acme_1.json')
    const saved: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    expect({ result, oldExists: existsSync(old), saved }).toMatchObject({
      result: { configPath, change: 'update', activeProject: 'github.com_acme_1', movedFrom: old },
      oldExists: false,
      saved: { repositories: [{ owner: 'acme', name: 'demo', release_branch: 'main' }] },
    })
    expect(io.err.join('')).toBe([
      `moved: config file ${old} to ${configPath}`,
      'warning: the project config is now named github.com_acme_1',
      '  use this name for the project input and the PECOT_REVIEW_PROJECT variable',
      `updated: config file ${configPath}`,
      'set: active project to github.com_acme_1',
      '',
    ].join('\n'))
  })

  it('dry-run では書かず、予定の行を出す', async () => {
    const directory = useProjectRoot()
    const { client } = await startClient([listProjects('board'), projectFields([workflowField()]), linked()])
    const { io, out } = captured(true)

    const result = await syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST, isDryRun: true })

    const configPath = path.join(directory, 'github.com_acme_1.json')
    expect({ result, written: existsSync(configPath) }).toEqual({ result: { configPath, change: 'create', activeProject: 'github.com_acme_1', movedFrom: undefined }, written: false })
    expect(io.err.join('')).toBe(`dry-run: would create config file ${configPath}\ndry-run: would set active project to github.com_acme_1\n`)
  })

  describe('内容が同じとき', () => {
    it.for([
      { name: 'アクティブにしない', extra: {}, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: undefined, movedFrom: undefined }, err: '', isActivated: false } },
      { name: 'activateIfUnchanged でアクティブにする', extra: { activateIfUnchanged: true }, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: 'github.com_acme_1', movedFrom: undefined }, err: 'set: active project to github.com_acme_1\n', isActivated: true } },
      { name: 'dry-run では、アクティブにする予定を出す', extra: { activateIfUnchanged: true, isDryRun: true }, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: 'github.com_acme_1', movedFrom: undefined }, err: 'dry-run: would leave config file <dir>/github.com_acme_1.json unchanged\ndry-run: would set active project to github.com_acme_1\n', isActivated: false } },
    ])('設定ファイルを書かず、$name', async ({ extra, expected }) => {
      expect(await syncTwice(extra)).toEqual(expected)
    })
  })

  describe('止まるとき', () => {
    it.for([
      {
        name: '同じタイトルのプロジェクトが無い',
        rules: [listProjects('other')],
        message: 'error: project not found: board\n  available projects:\n  - other\n',
      },
      {
        name: 'プロジェクトのフィールドを読めない',
        rules: [listProjects('board'), graphqlData('GetProjectFieldsUser', { user: { projectV2: null } }), graphqlData('GetProjectFieldsOrg', { organization: { projectV2: null } })],
        message: 'error: could not read project fields: board\n',
      },
      {
        name: '進行の欄が無い',
        rules: [listProjects('board'), projectFields([statusField])],
        message: 'error: project "board" has no pecot-status field\n  required field: pecot-status (Backlog/Pending/Ready/Active/In Review/Archived)\n  run: pecot project init acme board --host github.com\n',
      },
      {
        name: '進行の欄の必須の選択肢が欠ける',
        rules: [listProjects('board'), projectFields([workflowField(['Backlog', 'Ready'])])],
        message: 'error: pecot-status field is missing options: Pending, Active, In Review, Archived\n  required options: Backlog / Pending / Ready / Active / In Review / Archived\n',
      },
    ])('$name なら、error の行を出して止める', async ({ rules, message }) => {
      useProjectRoot()
      const { client } = await startClient(rules)
      const { io, out } = captured()
      expect(await rejection(syncProjectConfig(out, client, { owner: 'acme', name: 'board', host: HOST }))).toBeInstanceOf(CommandExit)
      expect(io.err.join('')).toBe(message)
    })
  })
})
