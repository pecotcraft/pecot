import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoadError, loadJson, loadSources, loadYaml } from '../src/infra/load.js'
import { materialize } from './helpers/repository.js'

describe('loadJson and loadYaml', () => {
  it('ファイルが無いと、missing として報告する', async () => {
    const root = await materialize('empty')
    expect(await loadJson(path.join(root, 'none.json'))).toEqual({ kind: 'missing' })
    expect(await loadYaml(path.join(root, 'none.yaml'))).toEqual({ kind: 'missing' })
  })

  it('ファイルが無い以外の読み取りエラーは、投げる', async () => {
    const root = await materialize('empty')
    await expect(loadJson(root)).rejects.toThrow(/EISDIR/u)
  })

  it('json と yaml のファイルを読み込むと、ok の状態とパースしたデータを返す', async () => {
    const root = await materialize('empty')
    await writeFile(path.join(root, 'a.json'), '{"a":1}')
    await writeFile(path.join(root, 'a.yaml'), 'a: 1\n')
    expect(await loadJson(path.join(root, 'a.json'))).toEqual({ kind: 'ok', data: { a: 1 } })
    expect(await loadYaml(path.join(root, 'a.yaml'))).toEqual({ kind: 'ok', data: { a: 1 } })
  })

  it('yaml のエラーには、すべて行を付ける', async () => {
    const root = await materialize('empty')
    await writeFile(path.join(root, 'a.yaml'), 'a: 1\na: 2\nb: [\n')
    const state = await loadYaml(path.join(root, 'a.yaml'))
    expect(state.kind).toBe('syntax')
    if (state.kind !== 'syntax') return
    expect(state.problems.map(problem => problem.line)).toEqual([2, 4])
    expect(state.problems[0]?.message).toBe('map keys must be unique')
  })
})

describe('loadSources', () => {
  it('glob が無いとき、何も読まない', async () => {
    expect(await loadSources(await materialize('valid'), 'pecot-workflow', [])).toEqual([])
  })

  it('追跡されて一致するファイルだけを、パス順に読む', async () => {
    const root = await materialize('valid')
    await mkdir(path.join(root, 'plugins/pecot-workflow/cli/node_modules'), { recursive: true })
    await writeFile(path.join(root, 'plugins/pecot-workflow/cli/node_modules/ignored.py'), 'x = 1\n')
    const sources = await loadSources(root, 'pecot-workflow', ['cli/**/*.py'])
    expect(sources.map(source => source.path)).toEqual(['plugins/pecot-workflow/cli/core/session.py'])
    expect(sources[0]?.text).toContain('PECOT_GITHUB_API_URL')
  })
})

describe('loadSources with a missing or broken repository', () => {
  it('git に載っていてもワーキングツリーに無いファイルは、飛ばす', async () => {
    const root = await materialize('valid')
    await rm(path.join(root, 'plugins/pecot-workflow/cli/core/session.py'))
    expect(await loadSources(root, 'pecot-workflow', ['cli/**/*.py'])).toEqual([])
  })

  it('root が git リポジトリでないと、LoadError を投げる', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    try {
      await expect(loadSources(root, 'pecot-workflow', ['**/*.py'])).rejects.toBeInstanceOf(LoadError)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('syntax errors with a position', () => {
  it('不正な JSON には、行を付ける', async () => {
    const root = await materialize('empty')
    await writeFile(path.join(root, 'a.json'), '{\n"a": 1\n"b": 2}')
    expect(await loadJson(path.join(root, 'a.json'))).toEqual({ kind: 'syntax', problems: [{ line: 3, message: 'is not valid JSON' }] })
  })

  it('alias の展開が投げると、構文エラーとして報告する', async () => {
    const root = await materialize('empty')
    const item = Array.from({ length: 20 }, (_, index) => String(index)).join(', ')
    const references = Array.from({ length: 200 }, () => '*a').join(', ')
    await writeFile(path.join(root, 'a.yaml'), `a: &a [${item}]\nb: [${references}]\n`)
    const state = await loadYaml(path.join(root, 'a.yaml'))
    expect(state.kind).toBe('syntax')
  })
})
