// 共通の出力関数が、期待の行の一覧（cases.json）どおりに出すことを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { abortUnconfirmed, AbortedError, createOutput, reportAborted, VerbSchema } from '../../src/commands-shared/output.js'
import type { CommandIo } from '../../src/commands-shared/command-definition.js'
import { parseJson } from '../_helpers/json.js'
import { explains } from '../_helpers/explains.js'

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
  it('cases.json に期待の行が 63 件ある', async () => {
    await explains('共通の出力関数の期待値（`cases.json`）のテストです。期待の行が 63 件あり、件数が減っていないことを確認します。')
    expect(cases.length).toBe(63)
  })

  it.each(named)('$name のとき、$item.line を書く', async ({ item }) => {
    await explains('共通の出力関数のテストです。`cases.json` の各行について、種類（`plan` や `error` など）と `dryRun` の指定に応じた行を、期待する出力先へ書く（出力しない場合もある）ことを確認します。')
    const expected = item.stream === null ? [] : [{ stream: item.stream, text: item.line }]
    expect(run(item)).toEqual(expected)
  })
})

interface Session {
  readonly io: CommandIo
  readonly out: string[]
  readonly errors: string[]
  readonly failures: string[]
}

function session(): Session {
  const out: string[] = []
  const errors: string[] = []
  const failures: string[] = []
  const io: CommandIo = {
    stdout: (text) => { out.push(text) },
    stderr: (text) => { errors.push(text) },
    error: (text) => { failures.push(text) },
  }
  return { io, out, errors, failures }
}

describe('abortUnconfirmed', () => {
  it('問いの文を失敗の文に渡し、code を持たない AbortedError を発生させる', async () => {
    await explains('`abortUnconfirmed` のテストです。問いの文を `io.error` に渡し、`code` を持たない `AbortedError` が発生し、標準出力と標準エラーへは何も出力しないことを確認します。')
    const { io, out, errors, failures } = session()
    let caught: unknown
    try {
      abortUnconfirmed(io, 'go?')
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AbortedError)
    expect(caught).not.toHaveProperty('code')
    expect(failures).toEqual(['go?'])
    expect([out, errors]).toEqual([[], []])
  })
})

describe('reportAborted', () => {
  it('Aborted. を標準エラーに出力し、終了コード 1 を返す', async () => {
    await explains('`reportAborted` のテストです。実行すると `Aborted.` を標準エラーへ出力し、終了コード 1 を返すことを確認します。')
    const { io, errors } = session()
    expect(reportAborted(io)).toBe(1)
    expect(errors).toEqual(['Aborted.\n'])
  })
})
