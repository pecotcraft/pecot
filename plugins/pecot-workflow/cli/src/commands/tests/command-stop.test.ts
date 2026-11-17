/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// コマンドが error の行を出して止める処理（stopWith・requireActiveConfig・requireConfigFor）のテスト。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { setEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { requireActiveConfig, requireConfigFor, stopWith } from '../command-stop.js'
import { createOutput } from '../output.js'
import { capture } from './support.js'
// 案内の文を描くには、コマンドの形の登録が要る
import '../registry.js'

function started(): { readonly io: ReturnType<typeof capture>, readonly output: ReturnType<typeof createOutput> } {
  const io = capture()
  return { io, output: createOutput(false, io) }
}

describe('stopWith', () => {
  it('error の行を出して、原因の名前と既定の終了コード 1 で止める', () => {
    const { io, output } = started()
    expect(() => stopWith(output, 'boom', 'other')).toThrow(expect.objectContaining({ exitCode: 1, kind: 'other' }))
    expect(io.err).toEqual(['error: boom\n'])
  })

  it('終了コードを渡せる', () => {
    const { io, output } = started()
    expect(() => stopWith(output, 'bad usage', 'invalid-input', 2)).toThrow(expect.objectContaining({ exitCode: 2, kind: 'invalid-input' }))
    expect(io.err).toEqual(['error: bad usage\n'])
  })
})

describe('requireActiveConfig', () => {
  it('アクティブなプロジェクトが無ければ、activate の案内を添えて終了コード 1', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory() })
    const { io, output } = started()
    expect(() => requireActiveConfig(output)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
    expect(io.err).toEqual(['error: no active project\n  run: pecot project activate <PROJECT>\n'])
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
      workflow_suffix: 'x',
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
  it('対象のリポを含む設定が 1 つなら、.active が無くてもそれを返す', () => {
    useProjects({ board: ['acme/app'], other: ['acme/lib'] })
    const { output } = started()
    expect(requireConfigFor(output, TARGET, undefined, PATH).name).toBe('board')
  })

  it('含む設定が無ければ、どのプロジェクトにも入っていないと出して repo-not-in-project', () => {
    useProjects({ other: ['acme/lib'] })
    const { io, output } = started()
    expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'repo-not-in-project' }))
    expect(io.err).toEqual(['error: acme/app is not in any project config\n  available: other\n'])
  })

  it('含む設定が 2 つで .active がその 1 つを指せば、それを返す', () => {
    const projects = useProjects({ a: ['acme/app'], b: ['acme/app'] })
    writeFileSync(path.join(projects, '.active'), 'b.json\n')
    const { output } = started()
    expect(requireConfigFor(output, TARGET, undefined, PATH).name).toBe('b')
  })

  it('含む設定が 2 つで選べなければ、候補と project の案内を出して no-active-project', () => {
    const projects = useProjects({ a: ['acme/app'], b: ['acme/app'], c: ['acme/lib'] })
    writeFileSync(path.join(projects, '.active'), 'c.json\n')
    const { io, output } = started()
    expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
    expect(io.err).toEqual(['error: acme/app is in 2 project configs\n  choose one with --project <NAME>\n  available: a, b\n'])
  })

  it('project を渡せば、候補が 2 つでもその設定を返す', () => {
    useProjects({ a: ['acme/app'], b: ['acme/app'] })
    const { output } = started()
    expect(requireConfigFor(output, TARGET, 'b.json', PATH).name).toBe('b')
  })

  it('project の名前の設定が無ければ project-not-found', () => {
    useProjects({ a: ['acme/app'] })
    const { io, output } = started()
    expect(() => requireConfigFor(output, TARGET, 'missing', PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'project-not-found' }))
    expect(io.err).toEqual(['error: project config not found: missing\n  available: a\n'])
  })

  it('project の設定が対象のリポを含まなければ repo-not-in-project', () => {
    useProjects({ a: ['acme/app'], c: ['acme/lib'] })
    const { io, output } = started()
    expect(() => requireConfigFor(output, TARGET, 'c', PATH)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'repo-not-in-project' }))
    expect(io.err).toEqual(['error: acme/app is not in project config c\n'])
  })

  it('形の誤った設定があれば、関係が無くても、そのパスを出して止める', () => {
    const projects = useProjects({ a: ['acme/app'] })
    writeFileSync(path.join(projects, 'broken.json'), '{}')
    const { output } = started()
    expect(() => requireConfigFor(output, TARGET, undefined, PATH)).toThrow(path.join(projects, 'broken.json'))
  })
})
