import { describe, expect, it } from 'vitest'
import { BORROWED_MAP, POSIX_MAP, definedFields, mappedFields } from '../src/domain/field-map.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

describe('field map', () => {
  it('項目の schema が定義する全フィールドを、一覧で返す', async () => {
    await explains('定義書の項目の schema から欄の一覧を作成する `definedFields` のテストです。`mcp.title` や `surfaces.mcp.tool` のような入れ子のフィールドを含め、全フィールドが名前順に返ることを確認します。')
    stepSync('定義済みの欄を一覧して比べる', () => {
      expect(definedFields()).toEqual([
        'action.outputs', 'arguments', 'behaviors', 'constraints', 'default_notes', 'deprecated', 'description', 'details',
        'diagnostics', 'effects', 'environment', 'examples', 'exit_status', 'hidden', 'id', 'idempotent',
        'input',
        'mcp.annotations', 'mcp.output', 'mcp.title', 'mcp_output.fields', 'name', 'on_error', 'output', 'prerequisites', 'stdin', 'summary', 'surfaces.action.path', 'surfaces.mcp.tool',
      ])
    })
  })

  it('schema が定義するフィールドは、すべて欄の対応表に含まれる', async () => {
    await explains('schema の欄と、POSIX の節への対応表の整合を検証するテストです。`definedFields` の返すフィールドが、すべて対応表に含まれていることを確認します。')
    const mapped = new Set(mappedFields())
    stepSync('map に無い欄を調べて比べる', () => {
      expect(definedFields().filter(field => !mapped.has(field))).toEqual([])
    })
  })

  it('schema が定義しないフィールドは、欄の対応表に含まれない', async () => {
    await explains('schema の欄と、POSIX の節への対応表の整合を検証するテストです。対応表のフィールドが、すべて `definedFields` の返すフィールドに含まれていることを確認します。')
    const defined = new Set(definedFields())
    stepSync('定義に無い欄を調べて比べる', () => {
      expect(mappedFields().filter(field => !defined.has(field))).toEqual([])
    })
  })

  it('POSIX の節の順を、契約どおりに保つ', async () => {
    await explains('POSIX の節への対応表（`POSIX_MAP`）のテストです。節が `NAME` から `CHANGE HISTORY` まで、契約で決めた順に並んでいることを確認します。')
    stepSync('POSIX 節の順を比べる', () => {
      expect(POSIX_MAP.map(row => row.section)).toEqual([
        'NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS・OPERANDS', 'STDIN', 'INPUT FILES・OUTPUT FILES', 'ENVIRONMENT VARIABLES',
        'ASYNCHRONOUS EVENTS', 'STDOUT', 'STDERR', 'EXIT STATUS', 'CONSEQUENCES OF ERRORS', 'EXAMPLES', 'FUTURE DIRECTIONS', 'CHANGE HISTORY',
      ])
    })
  })

  it('POSIX の節に対応しないフィールドは、すべて出典を含む', async () => {
    await explains('POSIX の節に対応しないフィールドの対応表（`BORROWED_MAP`）のテストです。すべての行が、空でない出典と 1 つ以上のフィールドを持つことを確認します。')
    stepSync('出典の有無を比べる', () => {
      expect(BORROWED_MAP.every(row => row.source !== '' && row.fields.length > 0)).toBe(true)
    })
  })
})
