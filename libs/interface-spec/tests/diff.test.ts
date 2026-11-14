import { describe, expect, it } from 'vitest'
import { diffGenerated, formatStale } from '../src/domain/diff.js'
import { generatedFileSchema } from '../src/domain/schema.js'
import type { GeneratedFile } from '../src/domain/schema.js'

const NAMES = { separator: ' ', positions: [[{ word: 'issue', meaning: 'Issue' }], [{ word: 'show', meaning: 'show one', read_only: true }]], rest: false }

function file(entries: readonly object[], header: object = {}): GeneratedFile {
  return generatedFileSchema.parse({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: NAMES, entries, ...header })
}

function entry(id: string, input: object, extra: object = {}): object {
  return {
    id, name: id.toLowerCase(), description: 'x', surfaces: { cli: { path: ['x'] } }, hidden: false, deprecated: false,
    input: { type: 'object', properties: input, required: [] }, ...extra,
  }
}

describe('diffGenerated', () => {
  it('同じ内容のファイルのとき、何も返さない', () => {
    const same = file([entry('PW-A', { a: { type: 'string' } })])
    expect(diffGenerated(same, same)).toEqual([])
  })

  it('プロパティの追加・default の変更・削除があると、それぞれ名前を出す', () => {
    const before = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: false }, gone: { type: 'string' } })])
    const after = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: true }, label: { type: 'string' } })])
    expect(diffGenerated(before, after)).toEqual([
      'PW-ISSUE-CREATE: input.properties.draft.default: false -> true',
      'PW-ISSUE-CREATE: input.properties.gone: removed',
      'PW-ISSUE-CREATE: input.properties.label: added',
    ])
  })

  it('項目の追加と削除があると、id の順に名前を出す', () => {
    const before = file([entry('PW-B', {}), entry('PW-C', {})])
    const after = file([entry('PW-A', {}), entry('PW-B', {})])
    expect(diffGenerated(before, after)).toEqual(['PW-A: entry: added', 'PW-C: entry: removed'])
  })

  it('配列の要素を比べるとき、添字で対応づける', () => {
    const before = file([entry('PW-A', {}, { surfaces: { cli: { path: ['a', 'b'] } } })])
    const after = file([entry('PW-A', {}, { surfaces: { cli: { path: ['a', 'c', 'd'] } } })])
    expect(diffGenerated(before, after)).toEqual(['PW-A: surfaces.cli.path[1]: "b" -> "c"', 'PW-A: surfaces.cli.path[2]: added'])
    expect(diffGenerated(after, before)).toEqual(['PW-A: surfaces.cli.path[1]: "c" -> "b"', 'PW-A: surfaces.cli.path[2]: removed'])
  })

  it('値の型が変わると、報告する', () => {
    const before = file([entry('PW-A', { a: { type: 'string', default: 1 } })])
    const after = file([entry('PW-A', { a: { type: 'string', default: [1] } })])
    expect(diffGenerated(before, after)).toEqual(['PW-A: input.properties.a.default: 1 -> [1]'])
  })

  it('ファイルの先頭部が変わると、報告する', () => {
    expect(diffGenerated(file([]), file([], { prefix: 'PV' }))).toEqual(['file: prefix: "PW" -> "PV"'])
  })

  it('語彙の語の追加と読むだけの印の削除があると、names の欄のパスで報告する', () => {
    const after = { ...NAMES, positions: [[{ word: 'issue', meaning: 'Issue' }, { word: 'pr', meaning: 'PR' }], [{ word: 'show', meaning: 'show one' }]] }
    expect(diffGenerated(file([]), file([], { names: after }))).toEqual([
      'file: names.positions[0][1]: added',
      'file: names.positions[1][0].read_only: removed',
    ])
  })
})

describe('formatStale', () => {
  it('差の行を字下げして error の行と run の行で挟む', () => {
    expect(formatStale('plugins/x/interface/generated.json', ['PW-A: entry: added', 'PW-B: entry: removed'], 'do --write')).toEqual([
      'error: plugins/x/interface/generated.json is stale',
      '  PW-A: entry: added',
      '  PW-B: entry: removed',
      '  run: do --write',
    ])
  })

  it('差の行が無くても error の行と run の行を返す', () => {
    expect(formatStale('f.json', [], 'cmd')).toEqual(['error: f.json is stale', '  run: cmd'])
  })
})
