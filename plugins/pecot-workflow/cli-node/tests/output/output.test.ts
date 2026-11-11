// 共通の出力関数が、期待の行の一覧（cases.json）どおりに出すことを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createOutput, createProcessIo, VerbSchema } from '../../src/commands/output.js'
import { parseJson } from '../../src/tests/_helpers/json.js'

const StreamSchema = z.enum(['stdout', 'stderr']).nullable()
const OperationSchema = z.object({ verb: VerbSchema, target: z.string() })
const MessageSchema = z.object({ message: z.string() })
const CountSchema = z.object({ label: z.string(), value: z.number().int().nullable() })
const DataSchema = z.object({ text: z.string() })

function caseOf<K extends string, I extends z.ZodType>(kind: K, input: I) {
  return z.object({ kind: z.literal(kind), dryRun: z.boolean(), input, stream: StreamSchema, line: z.string() })
}

const CaseSchema = z.discriminatedUnion('kind', [
  caseOf('plan', OperationSchema),
  caseOf('result', OperationSchema),
  caseOf('error', MessageSchema),
  caseOf('warning', MessageSchema),
  caseOf('count', CountSchema),
  caseOf('data', DataSchema),
])
type Case = z.infer<typeof CaseSchema>

const CasesSchema = z.array(CaseSchema)

function loadCases(): Case[] {
  const text = readFileSync(path.resolve(import.meta.dirname, 'cases.json'), 'utf8')
  return CasesSchema.parse(parseJson(text))
}

const cases = loadCases()

interface Written {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly 不可
function run(item: Case): Written[] {
  const written: Written[] = []
  const output = createOutput(item.dryRun, {
    stdout: (text) => {
      written.push({ stream: 'stdout', text })
    },
    stderr: (text) => {
      written.push({ stream: 'stderr', text })
    },
  })
  switch (item.kind) {
    case 'plan': {
      output.planned(item.input)
      break
    }
    case 'result': {
      output.done(item.input)
      break
    }
    case 'error': {
      output.error(item.input.message)
      break
    }
    case 'warning': {
      output.warning(item.input.message)
      break
    }
    case 'count': {
      output.count(item.input.label, item.input.value ?? undefined)
      break
    }
    case 'data': {
      output.data(item.input.text)
      break
    }
  }
  return written
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly 不可
function titleOf(item: Case, index: number): string {
  const input = JSON.stringify(item.input)
  return `${String(index)} ${item.kind} dryRun=${String(item.dryRun)} ${input}`
}

const named = cases.map((item, index) => ({ item, name: titleOf(item, index) }))

describe('共通の出力関数', () => {
  it('期待の行の一覧は 63 件ある', () => {
    expect(cases.length).toBe(63)
  })

  it.each(named)('$name のとき、$item.line を書く', ({ item }) => {
    const expected = item.stream === null ? [] : [{ stream: item.stream, text: item.line }]
    expect(run(item)).toEqual(expected)
  })
})

function captureWrites(stream: 'stdout' | 'stderr'): string[] {
  const written: string[] = []
  vi.spyOn(stream === 'stdout' ? process.stdout : process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  return written
}

describe('createProcessIo', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stdout は process.stdout.write に、stderr は process.stderr.write に、そのまま書く', () => {
    const out = captureWrites('stdout')
    const errors = captureWrites('stderr')
    const io = createProcessIo()
    io.stdout('out\n')
    io.stderr('err\n')
    expect(out).toEqual(['out\n'])
    expect(errors).toEqual(['err\n'])
  })

  it('createOutput に渡すと、警告が process.stderr に前置きと字下げ付きで出る', () => {
    const errors = captureWrites('stderr')
    createOutput(false, createProcessIo()).warning('first\nsecond')
    expect(errors).toEqual(['warning: first\n  second\n'])
  })
})
