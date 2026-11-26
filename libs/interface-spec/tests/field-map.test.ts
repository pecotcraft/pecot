import { describe, expect, it } from 'vitest'
import { BORROWED_MAP, POSIX_MAP, definedFields, mappedFields } from '../src/domain/field-map.js'
import { stepSync } from '../src/vitest/step.js'

describe('field map', () => {
  it('エントリの schema の全フィールドを、一覧にする', () => {
    stepSync('定義済みの欄を一覧して比べる', () => {
      expect(definedFields()).toEqual([
        'arguments', 'behaviors', 'cli.flags', 'cli.only', 'cli.positional', 'cli_reference.examples', 'cli_reference.options', 'constraints', 'default_notes', 'deprecated', 'description', 'details',
        'diagnostics', 'effects', 'environment', 'examples', 'exit_status', 'help.default_notes', 'help.details', 'help.examples', 'hidden', 'id', 'idempotent',
        'input',
        'mcp.annotations', 'mcp.output', 'mcp.title', 'mcp_output.fields', 'name', 'on_error', 'output', 'prerequisites', 'stdin', 'summary', 'surfaces.cli.path', 'surfaces.mcp.tool',
      ])
    })
  })

  it('定義済みのフィールドは、すべて map に載る', () => {
    const mapped = new Set(mappedFields())
    stepSync('map に無い欄を調べて比べる', () => {
      expect(definedFields().filter(field => !mapped.has(field))).toEqual([])
    })
  })

  it('schema が定義しないフィールドは、map に載らない', () => {
    const defined = new Set(definedFields())
    stepSync('定義に無い欄を調べて比べる', () => {
      expect(mappedFields().filter(field => !defined.has(field))).toEqual([])
    })
  })

  it('契約の POSIX 節の順を、保つ', () => {
    stepSync('POSIX 節の順を比べる', () => {
      expect(POSIX_MAP.map(row => row.section)).toEqual([
        'NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS・OPERANDS', 'STDIN', 'INPUT FILES・OUTPUT FILES', 'ENVIRONMENT VARIABLES',
        'ASYNCHRONOUS EVENTS', 'STDOUT', 'STDERR', 'EXIT STATUS', 'CONSEQUENCES OF ERRORS', 'EXAMPLES', 'FUTURE DIRECTIONS', 'CHANGE HISTORY',
      ])
    })
  })

  it('POSIX 節の無いフィールドは、すべて出典を挙げる', () => {
    stepSync('出典の有無を比べる', () => {
      expect(BORROWED_MAP.every(row => row.source !== '' && row.fields.length > 0)).toBe(true)
    })
  })
})
