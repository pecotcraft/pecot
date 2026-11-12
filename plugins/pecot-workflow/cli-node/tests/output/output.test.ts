// 共通の出力関数が、期待の行の一覧（cases.json）どおりに出すことを確かめる。
import { closeSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AbortedError, createLineReader, createOutput, createProcessIo, isConfirmed, reportAborted, VerbSchema } from '../../src/commands/output.js'
import type { CommandIo } from '../../src/commands/registry.js'
import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
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

function openInput(content: string): number {
  const directory = makeTemporaryDirectory()
  writeTree(directory, { 'input.txt': content })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 一時ディレクトリの中のファイル
  return openSync(`${directory}/input.txt`, 'r')
}

describe('readLine', () => {
  it('ファイルの fd から 1 行ずつ読み、読み残しを作らない', () => {
    const fd = openInput('yes\nno\n')
    try {
      const io = createProcessIo(fd)
      expect(io.readLine?.()).toBe('yes')
      expect(io.readLine?.()).toBe('no')
      expect(io.readLine?.()).toBeUndefined()
    }
    finally {
      closeSync(fd)
    }
  })

  it('末尾の改行が無い最後の行は返し、その次は終端', () => {
    const fd = openInput('a\n\nlast')
    try {
      const readLine = createLineReader(fd)
      expect([readLine(), readLine(), readLine(), readLine()]).toEqual(['a', '', 'last', undefined])
    }
    finally {
      closeSync(fd)
    }
  })

  it('空の入力は終端', () => {
    const fd = openInput('')
    try {
      expect(createLineReader(fd)()).toBeUndefined()
    }
    finally {
      closeSync(fd)
    }
  })

  it('UTF-8 の複数バイトの文字を壊さない', () => {
    const fd = openInput('はい\n')
    try {
      expect(createLineReader(fd)()).toBe('はい')
    }
    finally {
      closeSync(fd)
    }
  })

  it('EAGAIN は待って読み直す', () => {
    const script: (string | number)[] = ['EAGAIN', 121, 'EAGAIN', 10]
    let waited = 0
    const readLine = createLineReader(
      0,
      (_fd, buffer) => {
        const next = script.shift()
        if (next === 'EAGAIN') throw Object.assign(new Error('try again'), { code: 'EAGAIN' })
        if (typeof next !== 'number') return 0
        buffer[0] = next
        return 1
      },
      () => {
        waited += 1
      },
    )
    expect(readLine()).toBe('y')
    expect(waited).toBe(2)
  })

  it('EAGAIN 以外の読みの失敗は伝える', () => {
    const readLine = createLineReader(0, () => {
      throw Object.assign(new Error('bad fd'), { code: 'EBADF' })
    })
    expect(() => readLine()).toThrow('bad fd')
  })
})

interface Session {
  readonly io: CommandIo
  readonly out: string[]
  readonly errors: string[]
}

function sessionWith(lines: readonly string[] | undefined): Session {
  const out: string[] = []
  const errors: string[] = []
  const queue = [...lines ?? []]
  const base: CommandIo = {
    stdout: (text) => { out.push(text) },
    stderr: (text) => { errors.push(text) },
  }
  const io: CommandIo = lines === undefined ? base : { ...base, readLine: () => queue.shift() }
  return { io, out, errors }
}

describe('isConfirmed', () => {
  it.each([
    ['y', true], ['yes', true], ['Y', true], [' YES ', true],
    ['n', false], ['no', false], ['N', false], ['', false],
  ])('答え %j は %s', (answer, expected) => {
    const { io, out, errors } = sessionWith([answer])
    expect(isConfirmed(io, 'overwrite it?')).toBe(expected)
    expect(errors).toEqual(['overwrite it? [y/N]:'])
    expect(out).toEqual([' '])
  })

  it('それ以外の答えは Error: invalid input を出して問い直す', () => {
    const { io, out, errors } = sessionWith(['maybe', 'y'])
    expect(isConfirmed(io, 'go?')).toBe(true)
    expect(errors).toEqual(['go? [y/N]:', 'Error: invalid input\n', 'go? [y/N]:'])
    expect(out).toEqual([' ', ' '])
  })

  it('終端なら AbortedError を投げる。code は持たない', () => {
    const { io, errors } = sessionWith([])
    let caught: unknown
    try {
      isConfirmed(io, 'go?')
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AbortedError)
    expect(caught).not.toHaveProperty('code')
    expect(errors).toEqual(['go? [y/N]:'])
  })

  it('readLine が無い io（MCP）は終端と同じ', () => {
    expect(() => isConfirmed(sessionWith(undefined).io, 'go?')).toThrow(AbortedError)
  })
})

describe('reportAborted', () => {
  it('Aborted. を stderr に出して終了コード 1 を返す', () => {
    const { io, errors } = sessionWith(undefined)
    expect(reportAborted(io)).toBe(1)
    expect(errors).toEqual(['Aborted.\n'])
  })
})
