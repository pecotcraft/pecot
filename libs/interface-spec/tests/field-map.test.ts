import { describe, expect, it } from 'vitest'
import { BORROWED_MAP, POSIX_MAP, definedFields, mappedFields } from '../src/domain/field-map.js'

describe('field map', () => {
  it('lists every field of the entry schemas', () => {
    expect(definedFields()).toEqual([
      'behaviors', 'cli.flags', 'cli.positional', 'constraints', 'default_notes', 'deprecated', 'description', 'details',
      'diagnostics', 'effects', 'environment', 'examples', 'exit_status', 'hidden', 'id', 'idempotent', 'input',
      'mcp.annotations', 'mcp.output', 'name', 'on_error', 'output', 'prerequisites', 'stdin', 'surfaces.cli.path', 'surfaces.mcp.tool',
    ])
  })

  it('has every defined field in the map', () => {
    const mapped = new Set(mappedFields())
    expect(definedFields().filter(field => !mapped.has(field))).toEqual([])
  })

  it('has no field in the map that the schemas do not define', () => {
    const defined = new Set(definedFields())
    expect(mappedFields().filter(field => !defined.has(field))).toEqual([])
  })

  it('keeps the POSIX sections of the contract in order', () => {
    expect(POSIX_MAP.map(row => row.section)).toEqual([
      'NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS・OPERANDS', 'STDIN', 'INPUT FILES・OUTPUT FILES', 'ENVIRONMENT VARIABLES',
      'ASYNCHRONOUS EVENTS', 'STDOUT', 'STDERR', 'EXIT STATUS', 'CONSEQUENCES OF ERRORS', 'EXAMPLES', 'FUTURE DIRECTIONS', 'CHANGE HISTORY',
    ])
  })

  it('names the source of every field that has no POSIX section', () => {
    expect(BORROWED_MAP.every(row => row.source !== '' && row.fields.length > 0)).toBe(true)
  })
})
