// 共通の出力関数が、期待の行の一覧（cases.json）どおりに出すことを確かめる。
import { closeSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AbortedError, createLineReader, createOutput, createProcessIo, isConfirmed, reportAborted, VerbSchema } from '../../src/commands-shared/output.js'
import type { CommandIo } from '../../src/commands-shared/command-definition.js'
import { makeTemporaryDirectory, writeTree } from '../_helpers/temporary.js'
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

  it('stdout は process.stdout.write に、stderr は process.stderr.write に、そのまま書く', async () => {
    await explains('`createProcessIo` のテストです。標準出力用の関数は `process.stdout.write` へ、標準エラー用の関数は `process.stderr.write` へ、文字列をそのまま書き込むことを確認します。')
    const out = captureWrites('stdout')
    const errors = captureWrites('stderr')
    const io = createProcessIo()
    io.stdout('out\n')
    io.stderr('err\n')
    expect(out).toEqual(['out\n'])
    expect(errors).toEqual(['err\n'])
  })

  it('createOutput に渡すと、警告は先頭に warning: が付き、2 行目以降は字下げして process.stderr に出る', async () => {
    await explains('`createOutput` に `createProcessIo` を渡すテストです。複数行の警告を出した場合に、先頭に `warning:` が付き、2 行目以降が字下げされて標準エラーへ出力されることを確認します。')
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
  it('ファイルの fd から 1 行ずつ読み込み、最後は終端を返す', async () => {
    await explains('`createProcessIo` の `readLine` のテストです。2 行のファイルを読み込んだ場合に、1 行ずつ返し、3 回目は `undefined`（終端）を返すことを確認します。')
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

  it('末尾に改行がない最後の行も返し、その次は終端を返す', async () => {
    await explains('`createLineReader` のテストです。空行と、末尾に改行がない最後の行を含む入力の場合に、`a`・空文字・`last` の順に返し、その次は `undefined` を返すことを確認します。')
    const fd = openInput('a\n\nlast')
    try {
      const readLine = createLineReader(fd)
      expect([readLine(), readLine(), readLine(), readLine()]).toEqual(['a', '', 'last', undefined])
    }
    finally {
      closeSync(fd)
    }
  })

  it('空の入力は、終端を返す', async () => {
    await explains('`createLineReader` のテストです。空のファイルを読み込んだ場合に、`undefined`（終端）を返すことを確認します。')
    const fd = openInput('')
    try {
      expect(createLineReader(fd)()).toBeUndefined()
    }
    finally {
      closeSync(fd)
    }
  })

  it('UTF-8 の複数バイトの文字を、壊さずに読み込む', async () => {
    await explains('`createLineReader` のテストです。日本語の「はい」のように複数バイトの文字を含む行を、そのまま読み込めることを確認します。')
    const fd = openInput('はい\n')
    try {
      expect(createLineReader(fd)()).toBe('はい')
    }
    finally {
      closeSync(fd)
    }
  })

  it('読み込みが EAGAIN で失敗した場合は、待機してから読み直す', async () => {
    await explains('`createLineReader` のテストです。読み込みが 2 回 `EAGAIN` で失敗した場合に、そのたびに待機して読み直し、`y` を返すことを確認します。')
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

  it('読み込みが EAGAIN 以外で失敗した場合は、そのまま例外を発生させる', async () => {
    await explains('`createLineReader` のテストです。読み込みが `EBADF` で失敗した場合に、元のエラーのメッセージで例外が発生することを確認します。')
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
  ])('答え %j に対する確認の結果は %s になる', async (answer, expected) => {
    await explains('`isConfirmed` のテストです。確認の質問に対する答えが `y` や `yes` の場合は `true`、`n` や空文字の場合は `false` を返し、質問を標準エラーへ出力することを確認します。')
    const { io, out, errors } = sessionWith([answer])
    expect(isConfirmed(io, 'overwrite it?')).toBe(expected)
    expect(errors).toEqual(['overwrite it? [y/N]:'])
    expect(out).toEqual([' '])
  })

  it('無効な答えには Error: invalid input を出力し、質問し直す', async () => {
    await explains('`isConfirmed` のテストです。`maybe` のような無効な答えの場合に、`Error: invalid input` を出力して質問し直し、次の `y` で `true` を返すことを確認します。')
    const { io, out, errors } = sessionWith(['maybe', 'y'])
    expect(isConfirmed(io, 'go?')).toBe(true)
    expect(errors).toEqual(['go? [y/N]:', 'Error: invalid input\n', 'go? [y/N]:'])
    expect(out).toEqual([' ', ' '])
  })

  it('入力が終端の場合は、code を持たない AbortedError を発生させる', async () => {
    await explains('`isConfirmed` のテストです。入力が終端で答えを得られない場合に、`code` を持たない `AbortedError` が発生することを確認します。')
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

  it('readLine を持たない io（MCP）は、入力が終端の場合と同じ扱いになる', async () => {
    await explains('`isConfirmed` のテストです。`readLine` を持たない `io`（MCP の場合）では、`AbortedError` が発生することを確認します。')
    expect(() => isConfirmed(sessionWith(undefined).io, 'go?')).toThrow(AbortedError)
  })
})

describe('reportAborted', () => {
  it('Aborted. を標準エラーに出力し、終了コード 1 を返す', async () => {
    await explains('`reportAborted` のテストです。実行すると `Aborted.` を標準エラーへ出力し、終了コード 1 を返すことを確認します。')
    const { io, errors } = sessionWith(undefined)
    expect(reportAborted(io)).toBe(1)
    expect(errors).toEqual(['Aborted.\n'])
  })
})
