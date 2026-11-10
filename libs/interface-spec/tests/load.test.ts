import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadJson, loadSources, loadYaml } from '../src/infra/load.js'
import { materialize } from './helpers/repository.js'

describe('loadJson and loadYaml', () => {
  it('report a missing file as missing', async () => {
    const root = await materialize('empty')
    expect(await loadJson(path.join(root, 'none.json'))).toEqual({ kind: 'missing' })
    expect(await loadYaml(path.join(root, 'none.yaml'))).toEqual({ kind: 'missing' })
  })

  it('throw on a read error that is not a missing file', async () => {
    const root = await materialize('empty')
    await expect(loadJson(root)).rejects.toThrow(/EISDIR/u)
  })

  it('parse the content', async () => {
    const root = await materialize('empty')
    await writeFile(path.join(root, 'a.json'), '{"a":1}')
    await writeFile(path.join(root, 'a.yaml'), 'a: 1\n')
    expect(await loadJson(path.join(root, 'a.json'))).toEqual({ kind: 'ok', data: { a: 1 } })
    expect(await loadYaml(path.join(root, 'a.yaml'))).toEqual({ kind: 'ok', data: { a: 1 } })
  })

  it('give every yaml error its line', async () => {
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
  it('reads nothing when there is no glob', async () => {
    expect(await loadSources(await materialize('valid'), 'pecot-workflow', [])).toEqual([])
  })

  it('reads only tracked files that match, in path order', async () => {
    const root = await materialize('valid')
    await mkdir(path.join(root, 'plugins/pecot-workflow/cli/node_modules'), { recursive: true })
    await writeFile(path.join(root, 'plugins/pecot-workflow/cli/node_modules/ignored.py'), 'x = 1\n')
    const sources = await loadSources(root, 'pecot-workflow', ['cli/**/*.py'])
    expect(sources.map(source => source.path)).toEqual(['plugins/pecot-workflow/cli/core/session.py'])
    expect(sources[0]?.text).toContain('PECOT_GITHUB_API_URL')
  })
})
