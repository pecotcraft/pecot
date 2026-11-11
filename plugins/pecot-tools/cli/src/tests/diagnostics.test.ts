// 診断行の共通の関数が、期待の行の一覧（tests/diagnostics-cases.json）どおりに出すことを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDiagnostics, DiagnosticVerbSchema, passthrough, writeData } from '../diagnostics.js'

const StreamSchema = z.enum(['stdout', 'stderr'])
const MessageSchema = z.object({ message: z.string() })
const OperationSchema = z.object({ verb: DiagnosticVerbSchema, target: z.string() })
const DataSchema = z.object({ text: z.string() })

function caseOf<K extends string, I extends z.ZodType>(kind: K, input: I) {
  return z.object({ kind: z.literal(kind), input, stream: StreamSchema, line: z.string() })
}

const CaseSchema = z.discriminatedUnion('kind', [
  caseOf('error', MessageSchema),
  caseOf('warning', MessageSchema),
  caseOf('note', MessageSchema),
  caseOf('result', OperationSchema),
  caseOf('data', DataSchema),
])
type Case = z.infer<typeof CaseSchema>

function loadCases(): Case[] {
  const text = readFileSync(path.resolve(import.meta.dirname, '../../tests/diagnostics-cases.json'), 'utf8')
  const parsed: unknown = JSON.parse(text)
  return z.array(CaseSchema).parse(parsed)
}

const cases = loadCases()

interface Written {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly 不可
function run(item: Case): Written[] {
  const written: Written[] = []
  const stdout = {
    write: (text: string) => {
      written.push({ stream: 'stdout', text })
    },
  }
  const stderr = {
    write: (text: string) => {
      written.push({ stream: 'stderr', text })
    },
  }
  const diagnostics = createDiagnostics(stderr)
  switch (item.kind) {
    case 'error': {
      diagnostics.error(item.input.message)
      break
    }
    case 'warning': {
      diagnostics.warning(item.input.message)
      break
    }
    case 'note': {
      diagnostics.note(item.input.message)
      break
    }
    case 'result': {
      diagnostics.done(item.input)
      break
    }
    case 'data': {
      writeData(stdout, item.input.text)
      break
    }
  }
  return written
}

const named = cases.map((item, index) => ({ item, name: `${String(index)} ${item.kind} ${JSON.stringify(item.input)}` }))

describe('診断行の共通の関数（error・warning・note）', () => {
  it('期待の行の一覧は 13 件ある', () => {
    expect(cases.length).toBe(13)
  })

  it.each(named)('$name のとき、期待の行を書く', ({ item }) => {
    expect(run(item)).toEqual([{ stream: item.stream, text: item.line }])
  })

  it('passthrough は受け取った文字列に手を加えずに書く', () => {
    const chunks: string[] = []
    const stream = {
      write: (text: string) => {
        chunks.push(text)
      },
    }
    passthrough(stream, 'error: unknown option \'--x\'\n')
    expect(chunks).toEqual(['error: unknown option \'--x\'\n'])
  })
})
