/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時のリポの中とこのリポの project.json だけ */
// lint-dist の command を project.json から読み、一時のリポで動かす。build の代わりに作業ツリーを書き換える。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

import { cleanDistribution } from '../scripts/clean-distribution.js'
import { createGitRepository, gitEnvironment } from '../../libs/workflow-core/tests/_helpers/git-repository.js'
import { stepSync } from '../../libs/workflow-core/tests/_helpers/step.js'

const PROJECT: unknown = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'project.json'), 'utf8'))

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function lintDistributionCommand(): string {
  let command: unknown = PROJECT
  for (const key of ['targets', 'lint-dist', 'options', 'command']) command = field(command, key)
  if (typeof command !== 'string') throw new TypeError('lint-dist の command が project.json に無い')
  return command
}

const FILES = {
  'actions/auto-start/dist/index.js': 'export const a = 1\n',
  'actions/src/auto-start.ts': 'export const a = 1\n',
}

function writeFile(repository: string, relative: string, content: string): void {
  const target = path.join(repository, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function runLintDistribution(repository: string): { status: number | null, output: string } {
  return stepSync('lint-dist の command を動かす', () => {
    const result = spawnSync('sh', ['-c', lintDistributionCommand()], { cwd: repository, env: gitEnvironment(), encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  })
}

describe('pecot-actions:lint-dist', () => {
  it('追跡している dist のファイルが書き換わっていると、そのファイルを出して失敗する', async () => {
    await explains('`lint-dist` の command のテストです。commit した `actions/<処理>/dist/index.js` が作業ツリーで書き換わっている場合に、0 以外で終わり、そのファイルを出力することを確認します。')
    const repository = createGitRepository(FILES)
    writeFile(repository, 'actions/auto-start/dist/index.js', 'export const a = 2\n')
    const result = runLintDistribution(repository)
    stepSync('終了コードと出力を確かめる', () => {
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('actions/auto-start/dist/index.js')
    })
  })

  it('build が作り、commit していない dist のファイルがあると、そのファイルを出して失敗する', async () => {
    await explains('`lint-dist` の command のテストです。`actions/<処理>/dist` に追跡していないファイルがある場合に、0 以外で終わり、そのファイルを出力することを確認します。')
    const repository = createGitRepository(FILES)
    writeFile(repository, 'actions/new-action/dist/index.js', 'export const b = 1\n')
    const result = runLintDistribution(repository)
    stepSync('終了コードと出力を確かめる', () => {
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('actions/new-action/dist/index.js')
    })
  })

  it('commit した古い dist が build の前の削除で消えていると、そのファイルを出して失敗する', async () => {
    await explains('source の無い action の dist を commit したまま、`cleanDistribution` を動かした後の `lint-dist` のテストです。0 以外で終わり、消えたファイルを出力することを確認します。')
    const repository = createGitRepository({ ...FILES, 'actions/old-action/dist/index.js': 'export const c = 1\n' })
    stepSync('build の前と同じく dist を消し、今の action の dist を作り直す', () => {
      cleanDistribution(path.join(repository, 'actions'))
      writeFile(repository, 'actions/auto-start/dist/index.js', FILES['actions/auto-start/dist/index.js'])
    })
    const result = runLintDistribution(repository)
    stepSync('終了コードと出力を確かめる', () => {
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('actions/old-action/dist/index.js')
      expect(result.output).not.toContain('actions/auto-start/dist/index.js')
    })
  })

  it('dist の外のファイルだけが変わっていると、成功する', async () => {
    await explains('`lint-dist` の command のテストです。`actions/src` のように dist の外のファイルだけが変わっている場合に、0 で終わることを確認します。')
    const repository = createGitRepository(FILES)
    writeFile(repository, 'actions/src/auto-start.ts', 'export const a = 2\n')
    writeFile(repository, 'actions/src/extra.ts', 'export const d = 1\n')
    const result = runLintDistribution(repository)
    stepSync('終了コードを確かめる', () => {
      expect(result.status).toBe(0)
    })
  })

  it('作業ツリーに変更が無いと、成功する', async () => {
    await explains('`lint-dist` の command のテストです。commit した状態から何も変わっていない場合に、0 で終わることを確認します。')
    const repository = createGitRepository(FILES)
    const result = runLintDistribution(repository)
    stepSync('終了コードを確かめる', () => {
      expect(result.status).toBe(0)
    })
  })
})

describe('cleanDistribution', () => {
  it('直下のディレクトリの dist を消し、node_modules の dist を残す', async () => {
    await explains('build の前に dist を消す `cleanDistribution` のテストです。`actions/<処理>/dist` を消して、そのパスを返し、`node_modules/dist` と dist の外のファイルを残すことを確認します。')
    const repository = createGitRepository({
      ...FILES,
      'actions/old-action/dist/index.js': 'export const c = 1\n',
      'actions/node_modules/dist/index.js': 'export const e = 1\n',
    })
    const actions = path.join(repository, 'actions')
    const removed = stepSync('cleanDistribution を動かす', () => cleanDistribution(actions))
    stepSync('消えたものと残ったものを確かめる', () => {
      expect(removed).toEqual([path.join('auto-start', 'dist'), path.join('old-action', 'dist')])
      expect(existsSync(path.join(actions, 'auto-start', 'dist'))).toBe(false)
      expect(existsSync(path.join(actions, 'old-action', 'dist'))).toBe(false)
      expect(existsSync(path.join(actions, 'node_modules', 'dist', 'index.js'))).toBe(true)
      expect(existsSync(path.join(actions, 'src', 'auto-start.ts'))).toBe(true)
    })
  })
})
