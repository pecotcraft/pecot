/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// コマンドが error の行を出して止める処理（stopWith・requireActiveConfig・requireConfigFor）のテスト。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { setEnvironment } from '../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { requireActiveConfig, requireConfigFor, stopWith } from '../command-stop.js'
import { createOutput } from '../output.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
// 案内の文を描くには、コマンドの形の登録が要る
import '../../../tests/_helpers/hint-commands.js'

function started(): { readonly io: ReturnType<typeof capture>, readonly output: ReturnType<typeof createOutput> } {
  const io = capture()
  return { io, output: createOutput(false, io) }
}

describe('stopWith', () => {
  it('エラーの行を標準エラー出力へ表示し、原因の種類と既定の終了コード 1 で処理を止める', async () => {
    await explains('コマンドをエラーで止める関数（`stopWith`）のテストです。終了コードを省略した場合に、`error: boom` の行を表示し、終了コード 1 と指定した原因の種類を持つ例外が発生することを確認します。')
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => stopWith(output, 'boom', 'other')).toThrow(expect.objectContaining({ exitCode: 1, kind: 'other' }))
      expect(io.err).toEqual(['error: boom\n'])
    })
  })

  it('終了コードを指定した場合は、その終了コードで処理を止める', async () => {
    await explains('`stopWith` に終了コード 2 を指定した場合のテストです。指定した終了コードと原因の種類を持つ例外が発生し、エラーの行を表示することを確認します。')
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => stopWith(output, 'bad usage', 'invalid-input', 2)).toThrow(expect.objectContaining({ exitCode: 2, kind: 'invalid-input' }))
      expect(io.err).toEqual(['error: bad usage\n'])
    })
  })
})

describe('requireActiveConfig', () => {
  it('アクティブなプロジェクトが存在しない場合は、activate の案内を表示して終了コード 1 で止める', async () => {
    await explains('アクティブなプロジェクトの設定を取得する関数（`requireActiveConfig`）のテストです。アクティブなプロジェクトが存在しない場合に、`project_activate` の案内付きのエラーを表示し、終了コード 1 の例外が発生することを確認します。')
    stepSync('環境変数を用意する', () => {
      setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory() })
    })
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireActiveConfig(output)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
      expect(io.err).toEqual(['error: no active project\n  call project_activate with project: <PROJECT>\n'])
    })
  })
})

/**
一時のプロジェクトルートに、対象のリポを repositories に持つ設定を名前で置く
*/
function useProjects(configs: Readonly<Record<string, readonly string[]>>): string {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  const projects = path.join(root, '.pecot', 'config', 'projects')
  mkdirSync(projects, { recursive: true })
  for (const [name, repositories] of Object.entries(configs)) {
    writeFileSync(path.join(projects, `${name}.json`), JSON.stringify({
      host: 'github.com',
      owner: 'acme',
      project: { number: 1, id: 'PVT_x', fields: { workflow: { id: 'F', options: {} } } },
      repositories: repositories.map(full => ({ owner: full.split('/', 2)[0] ?? '', name: full.split('/', 2)[1] ?? '' })),
    }))
  }
  return projects
}

const TARGET = { owner: 'acme', repository: 'app' }
// 案内の入力はコマンドの定義に要るので、project を既に持つ board sync を使う
const PATH = ['board', 'sync']

describe('requireConfigFor', () => {
  it('対象のリポジトリを含む設定が 1 つだけの場合は、.active が存在しなくてもその設定を返す', async () => {
    await explains('リポジトリからプロジェクトの設定を選ぶ関数（`requireConfigFor`）のテストです。対象のリポジトリを含む設定が 1 つだけの場合は、`.active` ファイルが存在しなくても、その設定が返ることを確認します。')
    stepSync('プロジェクトの設定を用意する', () => {
      useProjects({ board: ['acme/app'], other: ['acme/lib'] })
    })
    const { output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(requireConfigFor(output, TARGET, undefined, PATH).name).toBe('board')
    })
  })

  it('対象のリポジトリを含む設定が存在しない場合は、どのプロジェクトにも含まれないと表示して repo-not-in-project で止める', async () => {
    await explains('対象のリポジトリを含む設定が存在しない場合のテストです。`acme/app is not in any project config` と候補の一覧を表示し、種類が `repo-not-in-project` の例外が発生することを確認します。')
    stepSync('プロジェクトの設定を用意する', () => {
      useProjects({ other: ['acme/lib'] })
    })
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'repo-not-in-project' }))
      expect(io.err).toEqual(['error: acme/app is not in any project config\n  available: other\n'])
    })
  })

  it('対象のリポジトリを含む設定が 2 つあり、.active がそのうちの 1 つを指す場合は、その設定を返す', async () => {
    await explains('同じリポジトリを含む設定が 2 つ存在する場合のテストです。`.active` の指す設定を返すことを確認します。')
    const projects = stepSync('プロジェクトの設定を用意する', () => useProjects({ a: ['acme/app'], b: ['acme/app'] }))
    stepSync('設定のファイルを用意する', () => {
      writeFileSync(path.join(projects, '.active'), 'b.json\n')
    })
    const { output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(requireConfigFor(output, TARGET, undefined, PATH).name).toBe('b')
    })
  })

  it('設定が 2 つあり .active でも選べない場合は、候補と project の案内を表示して no-active-project で止める', async () => {
    await explains('対象のリポジトリを含む設定が 2 つあり、`.active` が別の設定を指している場合のテストです。候補の一覧と `project` の指定方法を表示し、種類が `no-active-project` の例外が発生することを確認します。')
    const projects = stepSync('プロジェクトの設定を用意する', () => useProjects({ a: ['acme/app'], b: ['acme/app'], c: ['acme/lib'] }))
    stepSync('設定のファイルを用意する', () => {
      writeFileSync(path.join(projects, '.active'), 'c.json\n')
    })
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
      expect(io.err).toEqual(['error: acme/app is in 2 project configs\n  choose one with project: <NAME>\n  available: a, b\n'])
    })
  })

  it('project を指定した場合は、候補が 2 つあっても指定した設定を返す', async () => {
    await explains('対象のリポジトリを含む設定が 2 つある場合に、`project` を指定したときのテストです。指定した設定（`b`）が返ることを確認します。')
    stepSync('プロジェクトの設定を用意する', () => {
      useProjects({ a: ['acme/app'], b: ['acme/app'] })
    })
    const { output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(requireConfigFor(output, TARGET, 'b.json', PATH).name).toBe('b')
    })
  })

  it('指定した project の設定が存在しない場合は、project-not-found で止める', async () => {
    await explains('存在しない `project` の名前を指定した場合のテストです。`project config not found: missing` と候補の一覧を表示し、種類が `project-not-found` の例外が発生することを確認します。')
    stepSync('プロジェクトの設定を用意する', () => {
      useProjects({ a: ['acme/app'] })
    })
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireConfigFor(output, TARGET, 'missing', PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'project-not-found' }))
      expect(io.err).toEqual(['error: project config not found: missing\n  available: a\n'])
    })
  })

  it('指定した project の設定に対象のリポジトリが含まれない場合は、repo-not-in-project で止める', async () => {
    await explains('指定した `project` の設定が、対象のリポジトリを含まない場合のテストです。`acme/app is not in project config c` を表示し、種類が `repo-not-in-project` の例外が発生することを確認します。')
    stepSync('プロジェクトの設定を用意する', () => {
      useProjects({ a: ['acme/app'], c: ['acme/lib'] })
    })
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireConfigFor(output, TARGET, 'c', PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'repo-not-in-project' }))
      expect(io.err).toEqual(['error: acme/app is not in project config c\n'])
    })
  })

  it('設定ファイルの形式が不正な場合は、対象と無関係でもそのパスを示して止める', async () => {
    await explains('形式が不正な設定ファイル（`broken.json`）が存在する場合のテストです。対象のリポジトリと無関係な設定でも、そのファイルのパスを含む例外が発生することを確認します。')
    const projects = stepSync('プロジェクトの設定を用意する', () => useProjects({ a: ['acme/app'] }))
    stepSync('設定のファイルを用意する', () => {
      writeFileSync(path.join(projects, 'broken.json'), '{}')
    })
    const { output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(path.join(projects, 'broken.json'))
    })
  })
})
