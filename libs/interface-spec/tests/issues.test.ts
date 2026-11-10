import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { issuesToFindings } from '../src/domain/issues.js'
import { formatFinding, sortFindings } from '../src/domain/finding.js'

type Issue = z.core.$ZodIssue

function lines(issues: readonly Issue[], root: unknown, kind: 'generated' | 'authored' | 'targets' = 'authored'): string[] {
  return issuesToFindings(issues, 'f.yaml', root, kind).map(finding => formatFinding(finding))
}

describe('issuesToFindings', () => {
  it('never drops an issue it does not know', () => {
    const issue: Issue = { code: 'not_multiple_of', divisor: 5, path: ['entries', 'PW-A', 'x'], message: 'Invalid number: must be a multiple of 5', input: 3 }
    expect(lines([issue], { entries: { 'PW-A': { x: 3 } } })).toEqual([
      'error: f.yaml: PW-A: x: unknown validation issue (not_multiple_of): Invalid number: must be a multiple of 5',
    ])
  })

  it('treats a too_small issue that is not about an array as unknown', () => {
    const issue: Issue = { code: 'too_small', origin: 'string', minimum: 1, inclusive: true, path: ['plugin'], message: 'Too small', input: '' }
    expect(lines([issue], { plugin: '' })).toEqual(['error: f.yaml: plugin: unknown validation issue (too_small): Too small'])
  })

  it.each([
    [{ code: 'too_small', origin: 'number', minimum: 0, inclusive: true, path: ['code'], message: 'Too small', input: -1 }, -1],
    [{ code: 'too_big', origin: 'number', maximum: 255, inclusive: true, path: ['code'], message: 'Too big', input: 256 }, 256],
  ] satisfies readonly (readonly [Issue, number])[])('reads a number out of range as a fixed sentence (%#)', (issue, input) => {
    expect(lines([issue], { code: input })).toEqual(['error: f.yaml: code: must be between 0 and 255'])
  })

  it('treats an invalid_union without a discriminator as unknown', () => {
    const issue: Issue = { code: 'invalid_union', errors: [], path: ['x'], message: 'Invalid input', input: 1 }
    expect(lines([issue], { x: 1 })).toEqual(['error: f.yaml: x: unknown validation issue (invalid_union): Invalid input'])
  })

  it('passes a custom message through', () => {
    const issue: Issue = { code: 'custom', path: ['x'], message: 'because', input: 1 }
    expect(lines([issue], { x: 1 })).toEqual(['error: f.yaml: x: because'])
  })

  it('writes the key for an unrecognized key at the top level', () => {
    const issue: Issue = { code: 'unrecognized_keys', keys: ['a', 'b'], path: [], message: 'Unrecognized keys', input: {} }
    expect(lines([issue], { a: 1, b: 2 })).toEqual(['error: f.yaml: a: unknown field', 'error: f.yaml: b: unknown field'])
  })

  it('names a generated entry by its id', () => {
    const issue: Issue = { code: 'invalid_type', expected: 'boolean', path: ['entries', 1, 'hidden'], message: 'x', input: undefined }
    expect(lines([issue], { entries: [{ id: 'PW-A', hidden: true }, { id: 'PW-B' }] }, 'generated')).toEqual(['error: f.yaml: PW-B: hidden: field is missing'])
  })

  it('names a generated entry by its index when it has no id', () => {
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['entries', 0, 'id'], message: 'x', input: undefined }
    expect(lines([issue], { entries: [{}] }, 'generated')).toEqual(['error: f.yaml: 0: id: field is missing'])
  })

  it('names a missing array element as missing', () => {
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['list', 2], message: 'x', input: undefined }
    expect(lines([issue], { list: ['a'] })).toEqual(['error: f.yaml: list[2]: field is missing'])
  })

  it('names what a value is when its type is wrong', () => {
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['a', 'b'], message: 'x', input: 1 }
    expect(lines([issue], { a: { b: [] } })).toEqual(['error: f.yaml: a.b: expected string but got array'])
    expect(lines([issue], { a: { b: 1 } })).toEqual(['error: f.yaml: a.b: expected string but got number'])
  })

  it('does not give an unused value to a field that is not directly under an entry', () => {
    const issue: Issue = { code: 'invalid_type', expected: 'string', path: ['entries', 'PW-A', 'examples', 0, 'note'], message: 'x', input: undefined }
    expect(lines([issue], { entries: { 'PW-A': { examples: [{}] } } })).toEqual(['error: f.yaml: PW-A: examples[0].note: field is missing'])
  })
})

describe('sortFindings', () => {
  it('orders by file, line, id, field and reason with plain string comparison', () => {
    const sorted = sortFindings([
      { file: 'b', scope: 'X', field: 'f', reason: 'r' },
      { file: 'a', line: 10, reason: 'r' },
      { file: 'a', line: 9, reason: 'r' },
      { file: 'a', scope: 'PW-A-01', reason: 'r' },
      { file: 'a', scope: 'PW-A', field: 'z', reason: 'r' },
      { file: 'a', scope: 'PW-A', field: 'z', reason: 'q' },
      { file: 'a', scope: 'PW-A', field: 'b', reason: 'r' },
    ]).map(finding => formatFinding(finding))
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
