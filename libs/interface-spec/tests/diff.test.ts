import { describe, expect, it } from 'vitest'
import { diffGenerated, formatStale } from '../src/domain/diff.js'
import { generatedFileSchema } from '../src/domain/schema.js'
import type { GeneratedFile } from '../src/domain/schema.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const NAMES = { separator: ' ', positions: [[{ word: 'issue', meaning: 'Issue' }], [{ word: 'show', meaning: 'show one', read_only: true }]], rest: false }

function file(entries: readonly object[], header: object = {}): GeneratedFile {
  return generatedFileSchema.parse({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: NAMES, entries, ...header })
}

function entry(id: string, input: object, extra: object = {}): object {
  return {
    id, name: id.toLowerCase(), description: 'x', surfaces: { mcp: { tool: 'x' } }, hidden: false, deprecated: false,
    input: { type: 'object', properties: input, required: [] }, ...extra,
  }
}

function required(names: readonly string[]): object {
  return { input: { type: 'object', properties: {}, required: names } }
}

describe('diffGenerated', () => {
  it('同じ内容の generated.json を比べると、差を返さない', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。同じ内容のファイルを比較した場合に、空の配列を返すことを確認します。')
    const same = file([entry('PW-A', { a: { type: 'string' } })])
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(same, same)).toEqual([])
    })
  })

  it('入力のプロパティの追加・default の変更・削除があると、それぞれの差の行を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。入力のプロパティが追加・削除された場合と `default` が変わった場合に、項目の ID とフィールドのパスを含む差の行を返すことを確認します。')
    const before = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: false }, gone: { type: 'string' } })])
    const after = file([entry('PW-ISSUE-CREATE', { draft: { type: 'boolean', default: true }, label: { type: 'string' } })])
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(before, after)).toEqual([
        'PW-ISSUE-CREATE: input.properties.draft.default: false -> true',
        'PW-ISSUE-CREATE: input.properties.gone: removed',
        'PW-ISSUE-CREATE: input.properties.label: added',
      ])
    })
  })

  it('項目の追加と削除があると、id の順に差の行を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。項目が追加された場合と削除された場合に、項目の ID の順で `added` と `removed` の行を返すことを確認します。')
    const before = file([entry('PW-B', {}), entry('PW-C', {})])
    const after = file([entry('PW-A', {}), entry('PW-B', {})])
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(before, after)).toEqual(['PW-A: entry: added', 'PW-C: entry: removed'])
    })
  })

  it('配列の要素は、添字で対応づけて比べる', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。配列の要素が変わり、さらに増減した場合に、添字ごとの差の行が方向に合わせて返ることを確認します。')
    const before = file([entry('PW-A', {}, required(['a', 'b']))])
    const after = file([entry('PW-A', {}, required(['a', 'c', 'd']))])
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(before, after)).toEqual(['PW-A: input.required[1]: "b" -> "c"', 'PW-A: input.required[2]: added'])
      expect(diffGenerated(after, before)).toEqual(['PW-A: input.required[1]: "c" -> "b"', 'PW-A: input.required[2]: removed'])
    })
  })

  it('値の型が変わると、変更前と変更後の値を含む差の行を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。`default` が数値から配列へ変わった場合に、変更前と変更後の値を示す差の行を返すことを確認します。')
    const before = file([entry('PW-A', { a: { type: 'string', default: 1 } })])
    const after = file([entry('PW-A', { a: { type: 'string', default: [1] } })])
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(before, after)).toEqual(['PW-A: input.properties.a.default: 1 -> [1]'])
    })
  })

  it('ファイルの先頭の項目が変わると、file の行で差を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。先頭の `prefix` が変わった場合に、`file: prefix:` で始まる差の行を返すことを確認します。')
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(file([]), file([], { prefix: 'PV' }))).toEqual(['file: prefix: "PW" -> "PV"'])
    })
  })

  it('names の語の追加と read_only の削除があると、names のパスを含む差の行を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。コマンド名の語彙（`names`）に語が追加された場合と `read_only` が削除された場合に、`names.positions` 以下のパスを含む差の行を返すことを確認します。')
    const after = { ...NAMES, positions: [[{ word: 'issue', meaning: 'Issue' }, { word: 'pr', meaning: 'PR' }], [{ word: 'show', meaning: 'show one' }]] }
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(file([]), file([], { names: after }))).toEqual([
        'file: names.positions[0][1]: added',
        'file: names.positions[1][0].read_only: removed',
      ])
    })
  })
})

describe('diffGenerated の resources', () => {
  const RESOURCE = { uri: 'pecot-template://issue/task', name: 'issue-task', mimeType: 'text/markdown' }

  it('resources の追加・変更・削除があると、file の行で差を返す', async () => {
    await explains('`generated.json` の 2 つの版の差を求める `diffGenerated` のテストです。`resources` の要素が追加・変更・削除された場合に、`file: resources[…]` の形の差の行を返すことを確認します。')
    const before = file([], { resources: [RESOURCE] })
    const after = file([], { resources: [{ ...RESOURCE, mimeType: 'text/plain' }, { uri: 'pecot-template://pr/default', name: 'pr-default' }] })
    stepSync('差分を求めて比べる', () => {
      expect(diffGenerated(before, after)).toEqual([
        'file: resources[0].mimeType: "text/markdown" -> "text/plain"',
        'file: resources[1]: added',
      ])
      expect(diffGenerated(before, file([]))).toEqual(['file: resources[0]: removed'])
      expect(diffGenerated(file([]), before)).toEqual(['file: resources[0]: added'])
    })
  })
})

describe('formatStale', () => {
  it('差の行を字下げし、error の行と run の行で挟んで返す', async () => {
    await explains('古い `generated.json` を報告する `formatStale` のテストです。差の行がある場合に、2 つの空白で字下げした差の行を、`error:` の行と `run:` の行で挟んで返すことを確認します。')
    stepSync('stale の行を整えて比べる', () => {
      expect(formatStale('plugins/x/interface/generated.json', ['PW-A: entry: added', 'PW-B: entry: removed'], 'do --write')).toEqual([
        'error: plugins/x/interface/generated.json is stale',
        '  PW-A: entry: added',
        '  PW-B: entry: removed',
        '  run: do --write',
      ])
    })
  })

  it('差の行が存在しなくても、error の行と run の行を返す', async () => {
    await explains('古い `generated.json` を報告する `formatStale` のテストです。差の行が 0 件の場合でも、`error:` の行と `run:` の行の 2 行を返すことを確認します。')
    stepSync('stale の行を整えて比べる', () => {
      expect(formatStale('f.json', [], 'cmd')).toEqual(['error: f.json is stale', '  run: cmd'])
    })
  })
})
