/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// 設定ファイルの同期と、project の各コマンドが共有する判定。ボードは読んだ結果を渡す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { setEnvironment } from '../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'
import type { JsonObject } from '../../domain/json.js'
import { GitHubAPIError } from '../../infra/github/errors.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import type { Output } from '../output.js'
import { buildRepository, failApi, fieldNodesOf, lastFieldNamed, missingRequiredOptions, placeProjectConfig, planWorkflowFieldOf, reportConfigMove, syncProjectConfig, textOf } from '../project-sync.js'
import type { BoardSnapshot, SyncedProjectConfig } from '../project-sync.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

type Json = JsonObject

const HOST = 'github.com'
const BOARD_URL = 'https://github.com/users/acme/projects/1'
const WORKFLOW_NAMES = ['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived']
const options = (names: readonly string[]): Json[] => names.map((name, index) => ({ id: `o${String(index + 1)}`, name }))

function workflowField(names: readonly string[] = WORKFLOW_NAMES, name = 'pecot-status'): Json {
  return { id: 'PVTSSF_workflow', name, databaseId: 456, options: options(names) }
}

const statusField: Json = { id: 'PVTSSF_status', name: 'Status', options: options(['Todo', 'In Progress', 'Done']) }

const FIRST_VIEW: Readonly<{ viewNumber?: number }> = { viewNumber: 1 }

function board(fields: readonly Json[], view: Readonly<{ viewNumber?: number }> = FIRST_VIEW): BoardSnapshot {
  return { id: 'PVT_1', number: 1, title: 'board', url: BOARD_URL, fields, viewNumber: view.viewNumber }
}

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
function syncTwice(extra: Readonly<{ activateIfUnchanged?: boolean, isDryRun?: boolean }>): SyncAgain {
  const directory = useProjectRoot()
  const read = board([workflowField()], {})
  syncProjectConfig(captured().out, read, { owner: 'acme', host: HOST, skipIfUnchanged: true })
  const activeFile = path.join(directory, '.active')
  writeFileSync(activeFile, 'other.json\n')
  const { io, out } = captured(extra.isDryRun === true)
  const second = syncProjectConfig(out, read, { owner: 'acme', host: HOST, skipIfUnchanged: true, ...extra })
  return { second: { ...second, configPath: path.basename(second.configPath) }, err: io.err.join('').replaceAll(directory, '<dir>'), isActivated: readFileSync(activeFile, 'utf8') !== 'other.json\n' }
}

describe('textOf', () => {
  it.for([
    { name: 'undefined', value: undefined, expected: 'None' },
    { name: '文字列', value: 'x', expected: 'x' },
    { name: '数', value: 3, expected: '3' },
    { name: '真偽値', value: true, expected: 'True' },
  ])('$name を指定すると、Python の str() と同じ文字列に変換する', async ({ name, value, expected }) => {
    await explains(`値を文字列に変換する関数（\`textOf\`）のテストです。${name}を指定した場合に、Python の \`str()\` と同じ文字列（\`${expected}\`）になることを確認します。`)
    stepSync('結果を確認する', () => {
      expect(textOf(value)).toBe(expected)
    })
  })
})

describe('failApi', () => {
  it('API のエラーに状態コードがある場合はメッセージに付け、ない場合は付けずに止める', async () => {
    await explains('API の失敗を報告して止める関数（`failApi`）のテストです。HTTP の状態コードを持つエラーでは `(status 502)` を付け、持たないエラーでは付けずに、`CommandExit` が発生することを確認します。')
    const withStatus = captured()
    stepSync('結果を確認する', () => {
      expect(() => failApi(withStatus.out, 'read the board', new GitHubAPIError('boom', { statusCode: 502 }))).toThrow(CommandExit)
    })
    const withoutStatus = captured()
    stepSync('結果を確認する', () => {
      expect(() => failApi(withoutStatus.out, 'read the board', new GitHubAPIError('boom'))).toThrow(CommandExit)
      expect([withStatus.io.err.join(''), withoutStatus.io.err.join('')]).toEqual([
        'error: could not read the board (status 502): boom\n',
        'error: could not read the board: boom\n',
      ])
    })
  })
})

describe('進行の欄の判定', () => {
  it('選択肢を持つフィールドの名前から、そのまま使う・改名する・新規に作成する、のいずれかを決める', async () => {
    await explains('ワークフローのフィールドの扱いを決める関数（`planWorkflowFieldOf`）のテストです。現在の名前のフィールドはそのまま使い、旧い名前のフィールドは改名し、どちらも存在しなければ新規に作成すると判定することを確認します。')
    stepSync('結果を確認する', () => {
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
  })

  it('fields.nodes を取り出し、存在しない場合は空の配列にする', async () => {
    await explains('プロジェクトからフィールドの一覧を取り出す関数（`fieldNodesOf`）のテストです。`fields.nodes` が存在する場合はその配列を返し、存在しない場合は空の配列を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect([fieldNodesOf({ fields: { nodes: [{ name: 'a' }] } }), fieldNodesOf({})]).toEqual([[{ name: 'a' }], []])
    })
  })

  it('同じ名前で選択肢を持つフィールドが複数ある場合は後のものを返し、選択肢を持たないフィールドは選ばない', async () => {
    await explains('名前でフィールドを探す関数（`lastFieldNamed`）のテストです。同じ名前で選択肢を持つフィールドが 2 つある場合は後のものを返し、選択肢を持たないフィールドは選ばず `undefined` を返すことを確認します。')
    const later = { name: 'Status', options: [], id: 'later' }
    stepSync('結果を確認する', () => {
      expect([
        lastFieldNamed([{ name: 'Status', options: [], id: 'first' }, later], 'Status'),
        lastFieldNamed([{ name: 'Status', id: 'plain' }], 'Status'),
      ]).toEqual([later, undefined])
    })
  })

  it('必須の選択肢の不足を、大文字と小文字を区別せず、必要な順に返す', async () => {
    await explains('不足している必須の選択肢を求める関数（`missingRequiredOptions`）のテストです。`backlog` や `READY` のように大文字と小文字が違う名前は存在するものとして扱い、不足分を必要な順に返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect([
        missingRequiredOptions({ options: options(['backlog', 'READY', 'Active']) }),
        missingRequiredOptions({ options: [{ id: 'x' }] }),
      ]).toEqual([
        ['Pending', 'In Review', 'Archived'],
        ['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived'],
      ])
    })
  })
})

describe('buildRepository', () => {
  it('リポジトリの設定は、モデルで定義した順のキーで作成する', async () => {
    await explains('リポジトリの設定を作成する関数（`buildRepository`）のテストです。渡した順序に関係なく、キーが `owner`・`name`・`develop_branch` など、モデルで定義した順序に並ぶことを確認します。')
    stepSync('結果を確認する', () => {
      expect(Object.keys(buildRepository({ release_type: 'nx', name: 'r', owner: 'o' }))).toEqual(['owner', 'name', 'develop_branch', 'release_branch', 'changelog_file', 'packages', 'release_type'])
    })
  })
})

describe('placeProjectConfig', () => {
  it('同じボードを指す旧い名前の設定ファイルが 1 つの場合は、移動元にする', async () => {
    await explains('設定ファイルの置き場所を決める関数（`placeProjectConfig`）のテストです。同じボードを指す旧い名前のファイルが 1 つだけの場合に、新しい名前（`github.com_acme_1.json`）への移動元として返すことを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    stepSync('設定のファイルを用意する', () => {
      writeConfig(directory, 'old.json', boardConfig())
    })
    stepSync('結果を確認する', () => {
      expect(placeProjectConfig(captured().out, { host: HOST, owner: 'acme', number: 1 })).toEqual({ configPath: path.join(directory, 'github.com_acme_1.json'), movedFrom: path.join(directory, 'old.json') })
    })
  })

  it('同じボードを指す旧い名前の設定ファイルが 2 つ以上の場合は、ファイル名を並べて止める', async () => {
    await explains('同じボードを指す設定ファイルが 2 つ存在する場合のテストです。移動元を決められないため、ファイル名を並べたエラーを表示し、`CommandExit` が発生することを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    stepSync('設定のファイルを用意する', () => {
      writeConfig(directory, 'a.json', boardConfig())
    })
    stepSync('設定のファイルを用意する', () => {
      writeConfig(directory, 'b.json', boardConfig())
    })
    const { io, out } = stepSync('出力の捕捉を用意する', () => captured())
    stepSync('結果を確認する', () => {
      expect(() => placeProjectConfig(out, { host: HOST, owner: 'acme', number: 1 })).toThrow(CommandExit)
      expect(io.err.join('')).toBe('error: several config files point to project #1:\n  - a.json\n  - b.json\n  remove all but one, then run again; it is moved to github.com_acme_1.json\n')
    })
  })
})

describe('reportConfigMove', () => {
  it('移動元が存在しない場合は何も表示せず、dry-run の場合は予定の行を表示する', async () => {
    await explains('設定ファイルの移動を報告する関数（`reportConfigMove`）のテストです。移動元が存在しない場合は何も表示せず、`dry-run` の場合は移動の予定と、新しい名前に関する警告を表示することを確認します。')
    const none = captured()
    stepSync('設定の移動を報告する', () => {
      reportConfigMove(none.out, { configPath: '/p/new.json', movedFrom: undefined }, false)
    })
    const planned = captured(true)
    stepSync('設定の移動を報告する', () => {
      reportConfigMove(planned.out, { configPath: '/p/new.json', movedFrom: '/p/old.json' }, true)
    })
    stepSync('結果を確認する', () => {
      expect([none.io.err.join(''), planned.io.err.join('')]).toEqual([
        '',
        'dry-run: would move config file /p/old.json to /p/new.json\nwarning: the project config is now named new\n  use this name for the project input and the PECOT_REVIEW_PROJECT variable\n',
      ])
    })
  })
})

describe('syncProjectConfig', () => {
  it('設定ファイルが存在しない場合は、読んだボードの値から作成してアクティブにする', async () => {
    await explains('プロジェクトの設定ファイルを同期する関数（`syncProjectConfig`）のテストです。設定ファイルが存在しない場合に、読んだボードのフィールド・選択肢から新規に作成し、リポジトリは空のまま、アクティブなプロジェクトに設定することを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    const { io, out } = stepSync('出力の捕捉を用意する', () => captured())
    const result = stepSync('プロジェクトの設定を同期する', () => syncProjectConfig(out, board([{ id: 'PVTF_title', name: 'Title' }, workflowField([...WORKFLOW_NAMES, 'Blocked']), statusField]), { owner: 'acme', host: HOST }))
    const configPath = path.join(directory, 'github.com_acme_1.json')
    stepSync('結果を確認する', () => {
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
        repositories: [],
      })
      expect(readFileSync(path.join(directory, '.active'), 'utf8')).toBe('github.com_acme_1.json\n')
      expect(io.err.join('')).toBe(`created: config file ${configPath}\nset: active project to github.com_acme_1\n`)
    })
  })

  it('ビューの番号が無い場合は、絞り込みだけの URL にし、既存の設定のリポジトリをそのまま引き継ぐ', async () => {
    await explains('ビューの番号を読めず、設定ファイルが既に存在する場合のテストです。URL は絞り込みだけの形になり、既存のリポジトリの順序と値と集約リポジトリがそのまま引き継がれることを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    const repositories = [{ owner: 'acme', name: 'kept', develop_branch: 'develop' }, { owner: 'acme', name: 'other' }]
    const configPath = stepSync('既存の設定ファイルを書く', () => writeConfig(directory, 'github.com_acme_1.json', { ...boardConfig(repositories), aggregation_repo: 'acme/roadmap' }))
    const { io, out } = stepSync('出力の捕捉を用意する', () => captured())
    const result = stepSync('プロジェクトの設定を同期する', () => syncProjectConfig(out, board([workflowField()], {}), { owner: 'acme', host: HOST }))
    const saved: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    stepSync('結果を確認する', () => {
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
          repositories,
          aggregation_repo: 'acme/roadmap',
        },
      })
      expect(io.err.join('')).toBe(`updated: config file ${configPath}\nset: active project to github.com_acme_1\n`)
    })
  })

  it('旧い名前の設定ファイルを新しい名前へ移動し、旧いファイルを削除する', async () => {
    await explains('旧い名前の設定ファイルが存在する場合のテストです。内容を新しい名前のファイルへ移して旧いファイルを削除し、移動と警告のメッセージを表示することを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    const old = stepSync('旧い名前の設定ファイルを書く', () => writeConfig(directory, 'old.json', boardConfig([{ owner: 'acme', name: 'demo', release_branch: 'main' }])))
    const { io, out } = stepSync('出力の捕捉を用意する', () => captured())
    const result = stepSync('プロジェクトの設定を同期する', () => syncProjectConfig(out, board([workflowField()]), { owner: 'acme', host: HOST }))
    const configPath = path.join(directory, 'github.com_acme_1.json')
    const saved: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    stepSync('結果を確認する', () => {
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
  })

  it('dry-run の場合は、設定ファイルを書かず、予定の行を表示する', async () => {
    await explains('`dry-run` を指定した場合のテストです。設定ファイルを書き込まず、作成とアクティブ化の予定を表示することを確認します。')
    const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
    const { io, out } = stepSync('出力の捕捉を用意する', () => captured(true))
    const result = stepSync('プロジェクトの設定を同期する', () => syncProjectConfig(out, board([workflowField()]), { owner: 'acme', host: HOST, isDryRun: true }))
    const configPath = path.join(directory, 'github.com_acme_1.json')
    stepSync('結果を確認する', () => {
      expect({ result, written: existsSync(configPath) }).toEqual({ result: { configPath, change: 'create', activeProject: 'github.com_acme_1', movedFrom: undefined }, written: false })
      expect(io.err.join('')).toBe(`dry-run: would create config file ${configPath}\ndry-run: would set active project to github.com_acme_1\n`)
    })
  })

  describe('内容が同じとき', () => {
    it.for([
      { name: 'アクティブなプロジェクトを変更しない', extra: {}, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: undefined, movedFrom: undefined }, err: '', isActivated: false } },
      { name: 'activateIfUnchanged を指定するとアクティブにする', extra: { activateIfUnchanged: true }, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: 'github.com_acme_1', movedFrom: undefined }, err: 'set: active project to github.com_acme_1\n', isActivated: true } },
      { name: 'dry-run の場合はアクティブにする予定を表示する', extra: { activateIfUnchanged: true, isDryRun: true }, expected: { second: { configPath: 'github.com_acme_1.json', change: 'unchanged', activeProject: 'github.com_acme_1', movedFrom: undefined }, err: 'dry-run: would leave config file <dir>/github.com_acme_1.json unchanged\ndry-run: would set active project to github.com_acme_1\n', isActivated: false } },
    ])('設定の内容が変わらない場合は、設定ファイルを書き込まず、$name', async ({ name, extra, expected }) => {
      await explains(`ボードの内容が前回と同じ場合の同期のテストです。設定ファイルを書き込まず、${name}ことを確認します。`)
      stepSync('結果を確認する', () => {
        expect(syncTwice(extra)).toEqual(expected)
      })
    })
  })

  describe('止まるとき', () => {
    it.for([
      {
        name: 'ワークフローのフィールドが存在しない',
        fields: [statusField],
        message: 'error: project "board" has no pecot-status field\n  required field: pecot-status (Backlog/Pending/Ready/Active/In Review/Archived)\n  call project_check with method: "fields", owner: "acme", project: 1 and apply the changes it asks for with the project-fields operation of github-ops, then project_activate with project: "1", owner: "acme" to read the board into the project config\n',
      },
      {
        name: 'ワークフローのフィールドで必須の選択肢が不足している',
        fields: [workflowField(['Backlog', 'Ready'])],
        message: 'error: pecot-status field is missing options: Pending, Active, In Review, Archived\n  required options: Backlog / Pending / Ready / Active / In Review / Archived\n',
      },
    ])('$name 場合は、エラーの行を表示して止め、設定ファイルを書かない', async ({ name, fields, message }) => {
      await explains(`設定ファイルを同期できない場合のテストです。${name}場合は、エラーの行を表示して、例外（\`CommandExit\`）で止まり、設定ファイルを書かないことを確認します。`)
      const directory = stepSync('プロジェクトの設定を用意する', () => useProjectRoot())
      const { io, out } = stepSync('出力の捕捉を用意する', () => captured())
      stepSync('結果を確認する', () => {
        expect(() => syncProjectConfig(out, board(fields), { owner: 'acme', host: HOST })).toThrow(CommandExit)
        expect({ err: io.err.join(''), written: existsSync(path.join(directory, 'github.com_acme_1.json')) }).toEqual({ err: message, written: false })
      })
    })
  })
})
