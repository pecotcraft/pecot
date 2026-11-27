import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { issuesToFindings } from '../src/domain/issues.js'
import { formatFinding, sortFindings } from '../src/domain/finding.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

type Issue = z.core.$ZodIssue

function lines(issues: readonly Issue[], root: unknown, kind: 'generated' | 'authored' | 'targets' = 'authored'): string[] {
  return issuesToFindings(issues, 'f.yaml', root, kind).map(finding => formatFinding(finding))
}

describe('issuesToFindings', () => {
  it('未対応の種類の zod の issue があると、unknown validation issue として報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。変換の規則を持たない種類の issue を渡した場合に、無視せず `unknown validation issue` の行として出力することを確認します。')
    const issue: Issue = { code: 'not_multiple_of', divisor: 5, path: ['entries', 'PW-A', 'x'], message: 'Invalid number: must be a multiple of 5', input: 3 }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: { 'PW-A': { x: 3 } } })).toEqual([
        'error: f.yaml: PW-A: x: unknown validation issue (not_multiple_of): Invalid number: must be a multiple of 5',
      ])
    })
  })

  it('空の文字列は is empty とし、既定値を書ける欄には括弧の案内を付けて報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`on_error` が空の文字列の場合に、`is empty` に `(write "default" if nothing remains)` の案内を付けた行を出力することを確認します。')
    const issue: Issue = { code: 'too_small', origin: 'string', minimum: 1, inclusive: true, path: ['entries', 'PW-A', 'on_error'], message: 'Too small', input: '' }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: { 'PW-A': { on_error: '' } } })).toEqual(['error: f.yaml: PW-A: on_error: is empty (write "default" if nothing remains)'])
    })
  })

  it('既定値を書けない欄の空の文字列は、案内を付けず is empty だけで報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`examples[0].run` が空白だけの場合に、案内を付けず `is empty` だけの行を出力することを確認します。')
    const issue: Issue = { code: 'too_small', origin: 'string', minimum: 1, inclusive: true, path: ['entries', 'PW-A', 'examples', 0, 'run'], message: 'Too small', input: ' ' }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: { 'PW-A': { examples: [{ run: ' ' }] } } })).toEqual(['error: f.yaml: PW-A: examples[0].run: is empty'])
    })
  })

  it.each([
    [{ code: 'too_small', origin: 'number', minimum: 0, inclusive: true, path: ['code'], message: 'Too small', input: -1 }, -1],
    [{ code: 'too_big', origin: 'number', maximum: 255, inclusive: true, path: ['code'], message: 'Too big', input: 256 }, 256],
  ] satisfies readonly (readonly [Issue, number])[])('範囲外の数の issue は、固定の文で報告する (%#)', async (issue, input) => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。終了コードが下限を下回る場合と上限を上回る場合に、どちらも `must be between 0 and 255` の行を出力することを確認します。')
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { code: input })).toEqual(['error: f.yaml: code: must be between 0 and 255'])
    })
  })

  it('resources の欄の issue は、項目の ID の位置に uri を出力して報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`resources` の欄の issue を渡した場合に、項目の ID の位置へ `uri` を出力することを、generated と authored の両方で確認します。')
    const uri = 'pecot-template://issue/task'
    const generated: Issue = { code: 'invalid_type', expected: 'string', path: ['resources', 0, 'name'], message: 'Invalid input', input: undefined }
    stepSync('generated の issue を整形して比べる', () => {
      expect(lines([generated], { resources: [{ uri }] }, 'generated')).toEqual([`error: f.yaml: ${uri}: name: field is missing`])
    })
    const authored: Issue = { code: 'too_small', origin: 'string', minimum: 1, inclusive: true, path: ['resources', uri, 'summary'], message: 'Too small', input: ' ' }
    stepSync('authored の issue を整形して比べる', () => {
      expect(lines([authored], { resources: { [uri]: { summary: ' ' } } })).toEqual([`error: f.yaml: ${uri}: summary: is empty`])
    })
  })

  it('判別子を持たない invalid_union は、unknown validation issue として報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。判別子を持たない `invalid_union` の issue を渡した場合に、`unknown validation issue` の行を出力することを確認します。')
    const issue: Issue = { code: 'invalid_union', errors: [], path: ['x'], message: 'Invalid input', input: 1 }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { x: 1 })).toEqual(['error: f.yaml: x: unknown validation issue (invalid_union): Invalid input'])
    })
  })

  it('custom の issue の message は、そのまま報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`custom` の issue の message を、加工せずに行の理由として出力することを確認します。')
    const issue: Issue = { code: 'custom', path: ['x'], message: 'because', input: 1 }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { x: 1 })).toEqual(['error: f.yaml: x: because'])
    })
  })

  it('最上位の未知のキーは、キーごとに unknown field として報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。最上位に未知のキーが 2 つある場合に、キーごとに `unknown field` の行を出力することを確認します。')
    const issue: Issue = { code: 'unrecognized_keys', keys: ['a', 'b'], path: [], message: 'Unrecognized keys', input: {} }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { a: 1, b: 2 })).toEqual(['error: f.yaml: a: unknown field', 'error: f.yaml: b: unknown field'])
    })
  })

  it('generated の項目の issue は、項目の id を出力して報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`generated.json` の 2 件目の項目の issue を渡した場合に、添字でなく項目の `id` を出力することを確認します。')
    const issue: Issue = { code: 'invalid_type', expected: 'boolean', path: ['entries', 1, 'hidden'], message: 'x', input: undefined }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: [{ id: 'PW-A', hidden: true }, { id: 'PW-B' }] }, 'generated')).toEqual(['error: f.yaml: PW-B: hidden: field is missing'])
    })
  })

  it('id を持たない generated の項目の issue は、添字を出力して報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`id` を持たない項目の issue を渡した場合に、項目の位置を示す添字を出力することを確認します。')
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['entries', 0, 'id'], message: 'x', input: undefined }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: [{}] }, 'generated')).toEqual(['error: f.yaml: 0: id: field is missing'])
    })
  })

  it('配列の要素が存在しないと、添字を含む field is missing として報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。配列の 3 番目の要素が存在しない場合に、`list[2]: field is missing` の行を出力することを確認します。')
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['list', 2], message: 'x', input: undefined }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { list: ['a'] })).toEqual(['error: f.yaml: list[2]: field is missing'])
    })
  })

  it('値の型が違うと、実際の値の型を含めて報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。文字列を期待した欄に配列や数値が入っている場合に、`expected string but got array` のように実際の型を出力することを確認します。')
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['a', 'b'], message: 'x', input: 1 }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { a: { b: [] } })).toEqual(['error: f.yaml: a.b: expected string but got array'])
      expect(lines([issue], { a: { b: 1 } })).toEqual(['error: f.yaml: a.b: expected string but got number'])
    })
  })

  it('項目の直下にないフィールドの issue は、括弧の案内を付けず報告する', async () => {
    await explains('zod の検証結果を検証エラーに変換する `issuesToFindings` のテストです。`examples[0].note` のような入れ子のフィールドが存在しない場合に、`field is missing` だけの行を出力することを確認します。')
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['entries', 'PW-A', 'examples', 0, 'note'], message: 'x', input: undefined }
    stepSync('issue を整形して比べる', () => {
      expect(lines([issue], { entries: { 'PW-A': { examples: [{}] } } })).toEqual(['error: f.yaml: PW-A: examples[0].note: field is missing'])
    })
  })
})

describe('sortFindings', () => {
  it('検証エラーを、ファイル・行・id・フィールド・理由の順に、文字列の比較で並べる', async () => {
    await explains('検証エラーを並べ替える `sortFindings` のテストです。ファイル・行・項目の ID・フィールド・理由の順に、文字列として比較した結果の順に並ぶことを確認します。')
    const sorted = stepSync('指摘を並べ替える', () => sortFindings([
      { file: 'b', scope: 'X', field: 'f', reason: 'r' },
      { file: 'a', line: 10, reason: 'r' },
      { file: 'a', line: 9, reason: 'r' },
      { file: 'a', scope: 'PW-A-01', reason: 'r' },
      { file: 'a', scope: 'PW-A', field: 'z', reason: 'r' },
      { file: 'a', scope: 'PW-A', field: 'z', reason: 'q' },
      { file: 'a', scope: 'PW-A', field: 'b', reason: 'r' },
    ]).map(finding => formatFinding(finding)))
    stepSync('並び順を比べる', () => {
      expect(sorted).toEqual([
        'error: a: PW-A: b: r',
        'error: a: PW-A: z: q',
        'error: a: PW-A: z: r',
        'error: a: PW-A-01: r',
        'error: a:9: r',
        'error: a:10: r',
        'error: b: X: f: r',
      ])
    })
  })
})
