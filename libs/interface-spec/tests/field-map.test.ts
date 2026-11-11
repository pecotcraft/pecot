import { describe, expect, it } from 'vitest'
import { BORROWED_MAP, POSIX_MAP, definedFields, mappedFields } from '../src/domain/field-map.js'

describe('field map', () => {
  it('エントリの schema の全フィールドを、一覧にする', () => {
    expect(definedFields()).toEqual([
      'behaviors', 'cli.flags', 'cli.positional', 'constraints', 'default_notes', 'deprecated', 'description', 'details',
      'diagnostics', 'effects', 'environment', 'examples', 'exit_status', 'hidden', 'id', 'idempotent', 'input',
      'mcp.annotations', 'mcp.output', 'name', 'on_error', 'output', 'prerequisites', 'stdin', 'surfaces.cli.path', 'surfaces.mcp.tool',
    ])
  })

  it('定義済みのフィールドは、すべて map に載る', () => {
    const mapped = new Set(mappedFields())
    expect(definedFields().filter(field => !mapped.has(field))).toEqual([])
  })

  it('schema が定義しないフィールドは、map に載らない', () => {
    const defined = new Set(definedFields())
    expect(mappedFields().filter(field => !defined.has(field))).toEqual([])
  })

  it('契約の POSIX 節の順を、保つ', () => {
    expect(POSIX_MAP.map(row => row.section)).toEqual([
      'NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS・OPERANDS', 'STDIN', 'INPUT FILES・OUTPUT FILES', 'ENVIRONMENT VARIABLES',
      'ASYNCHRONOUS EVENTS', 'STDOUT', 'STDERR', 'EXIT STATUS', 'CONSEQUENCES OF ERRORS', 'EXAMPLES', 'FUTURE DIRECTIONS', 'CHANGE HISTORY',
    ])
  })

  it('POSIX 節の無いフィールドは、すべて出典を挙げる', () => {
    expect(BORROWED_MAP.every(row => row.source !== '' && row.fields.length > 0)).toBe(true)
  })
})
