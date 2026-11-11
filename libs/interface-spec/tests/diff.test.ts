import { describe, expect, it } from 'vitest'
import { diffGenerated, formatStale } from '../src/domain/diff.js'
import { generatedFileSchema } from '../src/domain/schema.js'
import type { GeneratedFile } from '../src/domain/schema.js'

function file(entries: readonly object[], header: object = {}): GeneratedFile {
  return generatedFileSchema.parse({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', entries, ...header })
}

function entry(id: string, input: object, extra: object = {}): object {
  return {
    id, name: id.toLowerCase(), description: 'x', surfaces: { cli: { path: ['x'] } }, hidden: false, deprecated: false,
    input: { type: 'object', properties: input, required: [] }, ...extra,
  }
}

describe('diffGenerated', () => {
  it('returns nothing for identical files', () => {
    const same = file([entry('PW-A', { a: { type: 'string' } })])
    expect(diffGenerated(same, same)).toEqual([])
  })

  it('names an added property, a changed default and a removed one', () => {
    const before = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: false }, gone: { type: 'string' } })])
    const after = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: true }, label: { type: 'string' } })])
    expect(diffGenerated(before, after)).toEqual([
      'PW-ISSUE-CREATE: input.properties.draft.default: false -> true',
      'PW-ISSUE-CREATE: input.properties.gone: removed',
      'PW-ISSUE-CREATE: input.properties.label: added',
    ])
  })

  it('names added and removed entries in id order', () => {
    const before = file([entry('PW-B', {}), entry('PW-C', {})])
    const after = file([entry('PW-A', {}), entry('PW-B', {})])
    expect(diffGenerated(before, after)).toEqual(['PW-A: entry: added', 'PW-C: entry: removed'])
  })

  it('compares array items by index', () => {
    const before = file([entry('PW-A', {}, { surfaces: { cli: { path: ['a', 'b'] } } })])
    const after = file([entry('PW-A', {}, { surfaces: { cli: { path: ['a', 'c', 'd'] } } })])
    expect(diffGenerated(before, after)).toEqual(['PW-A: surfaces.cli.path[1]: "b" -> "c"', 'PW-A: surfaces.cli.path[2]: added'])
    expect(diffGenerated(after, before)).toEqual(['PW-A: surfaces.cli.path[1]: "c" -> "b"', 'PW-A: surfaces.cli.path[2]: removed'])
  })

  it('reports a value whose type changed', () => {
    const before = file([entry('PW-A', { a: { type: 'string', default: 1 } })])
    const after = file([entry('PW-A', { a: { type: 'string', default: [1] } })])
    expect(diffGenerated(before, after)).toEqual(['PW-A: input.properties.a.default: 1 -> [1]'])
  })

  it('reports a change in the file header', () => {
    expect(diffGenerated(file([]), file([], { prefix: 'PV' }))).toEqual(['file: prefix: "PW" -> "PV"'])
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
