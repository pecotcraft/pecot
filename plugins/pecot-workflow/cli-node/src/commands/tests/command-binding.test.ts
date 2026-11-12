import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runDefinition, synopsisOf, usageOf } from '../command-binding.js'
import { defineCommand } from '../registry.js'
import { formatUsageError, UsageError } from '../usage-error.js'
import { capture, exitWith, failWith, throwFailure } from './support.js'

const seen: unknown[] = []

const readInput = z.object({
  issue_ref: z.string(),
  comment_limit: z.coerce.number().default(5),
  json: z.boolean(),
  labels: z.array(z.string()).optional(),
})

const read = defineCommand({
  path: ['issue', 'read'],
  description: 'Issue を読む',
  input: readInput,
  positional: ['issue_ref'],
  shortFlags: { comment_limit: '-c' },
  interactive: false,
  run: async (input) => {
    seen.push(input)
    return await exitWith(7)
  },
})

const preflight = defineCommand({
  path: ['release', 'preflight'],
  description: 'リリース前の確認',
  input: z.object({ version: z.string().optional(), directory: z.string(), mode: z.enum(['a', 'b']).optional() }),
  positional: ['version'],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async () => await exitWith(0),
})

const namesInput = z.object({ names: z.array(z.string()) })

const remove = defineCommand({
  path: ['worktree', 'remove'],
  description: '消す',
  input: namesInput,
  positional: ['names'],
  interactive: false,
  run: async (input) => {
    seen.push(input)
    return await exitWith(0)
  },
})

const optionalStrings = z.array(z.string()).optional()

const optionalFiles = defineCommand({
  path: ['quick'],
  description: '任意の複数',
  input: z.object({ files: optionalStrings }),
  positional: ['files'],
  interactive: false,
  run: async () => await exitWith(0),
})

const ownRepository = defineCommand({
  path: ['issue', 'quick'],
  description: '自分の repo を持つ',
  input: z.object({ repo: z.string().optional(), title: z.string() }),
  positional: ['title'],
  shortFlags: { repo: '-r' },
  interactive: false,
  run: async (input) => {
    seen.push(input)
    return await exitWith(0)
  },
})

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await usageErrorOf(promise)
  return error.message
}

async function usageErrorOf(promise: Promise<unknown>): Promise<UsageError> {
  try {
    await promise
  }
  catch (error: unknown) {
    if (error instanceof UsageError) return error
    throw error
  }
  throw new Error('UsageError が投げられませんでした')
}

describe('synopsisOf・usageOf', () => {
  it('必須の位置引数は波括弧、任意なら角括弧、複数なら ... を付ける', () => {
    expect(synopsisOf(read)).toBe('[OPTIONS] {issue_ref}')
    expect(synopsisOf(preflight)).toBe('[OPTIONS] [version]')
    expect(synopsisOf(remove)).toBe('[OPTIONS] {names}...')
    expect(synopsisOf(optionalFiles)).toBe('[OPTIONS] [files]...')
    expect(usageOf(read)).toEqual({ commandPath: ['issue', 'read'], synopsis: '[OPTIONS] {issue_ref}' })
  })
})

describe('runDefinition', () => {
  it('位置引数とオプションを input にして run を呼び、終了コードを返す', async () => {
    seen.length = 0
    expect(await runDefinition(read, ['a/b/1', '-c', '3', '--json', '--labels', 'x', '--labels', 'y'], capture())).toBe(7)
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 3, json: true, labels: ['x', 'y'] }])
  })

  it('グローバルの --repo は入力 repo にする', async () => {
    seen.length = 0
    await runDefinition(read, ['a/b/1'], capture(), 'x/y')
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 5, json: false, repo: 'x/y' }])
  })

  it('自分の repo を持つコマンドは、自分の -r を使い、グローバルの --repo は捨てる', async () => {
    seen.length = 0
    await runDefinition(ownRepository, ['t', '-r', 'y/z'], capture(), 'x/y')
    await runDefinition(ownRepository, ['t'], capture(), 'x/y')
    expect(seen).toEqual([{ title: 't', repo: 'y/z' }, { title: 't' }])
  })

  it('指定の無い真偽値は false。既定値は zod が足す', async () => {
    seen.length = 0
    await runDefinition(read, ['a/b/1'], capture())
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 5, json: false }])
  })

  it('複数の位置引数は配列にする', async () => {
    seen.length = 0
    await runDefinition(remove, ['one', 'two'], capture())
    expect(seen).toEqual([{ names: ['one', 'two'] }])
  })

  it('必須の位置引数が無ければ Missing argument', async () => {
    const error = await usageErrorOf(runDefinition(read, [], capture()))
    expect(formatUsageError(error)).toBe([
      'Usage: pecot issue read [OPTIONS] {issue_ref}',
      'Try \'pecot issue read --help\' for help.',
      '╭─ Error ──────────────────────────────────────────────────────────────────────╮',
      '│ Missing argument \'issue_ref\'.                                                │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '',
    ].join('\n'))
  })

  it('必須のオプションが無ければ Missing option（長い形・短い形の順）', async () => {
    const error = await usageErrorOf(runDefinition(preflight, [], capture()))
    expect(error.message).toBe('Missing option \'--directory\' / \'-D\'.')
    expect(error.context).toEqual({ commandPath: ['release', 'preflight'], synopsis: '[OPTIONS] [version]' })
  })

  it('任意の位置引数は省ける。短いオプションで渡せる', async () => {
    expect(await runDefinition(preflight, ['-D', '.'], capture())).toBe(0)
    expect(await runDefinition(preflight, ['1.0.0', '--directory', '.'], capture())).toBe(0)
  })

  it('未知のオプションは No such option', async () => {
    const error = await usageErrorOf(runDefinition(preflight, ['--bogus'], capture()))
    expect(error.message).toBe('No such option: --bogus')
  })

  it('値の無いオプションは requires an argument', async () => {
    const error = await usageErrorOf(runDefinition(preflight, ['--directory'], capture()))
    expect(error.message).toBe('Option \'--directory\' requires an argument.')
  })

  it('余分な位置引数は Got unexpected extra argument', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(preflight, ['1', '2', '-D', '.'], io))).toBe('Got unexpected extra argument (2)')
    expect(await messageOf(runDefinition(preflight, ['1', '2', '3', '-D', '.'], io))).toBe('Got unexpected extra arguments (2 3)')
  })

  it('--help は説明を出して 0', async () => {
    const io = capture()
    expect(await runDefinition(preflight, ['--help'], io)).toBe(0)
    expect(io.out.join('')).toContain('リリース前の確認')
  })

  it('run の入力検証に失敗すれば Invalid value', async () => {
    const error = await usageErrorOf(runDefinition(preflight, ['-D', '.', '--mode', 'z'], capture()))
    expect(error.message).toMatch(/^Invalid value for '--mode': /u)
  })

  it('入力全体の誤りは input として扱う', async () => {
    const strict = defineCommand({
      path: ['x'],
      description: '',
      input: z.object({ a: z.string().optional() }).refine(() => false, 'だめです'),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const io = capture()
    expect(await messageOf(runDefinition(strict, [], io))).toBe('Invalid value for \'input\': だめです')
  })

  it('run が投げた他の例外は握りつぶさない', async () => {
    const broken = defineCommand({
      path: ['x'],
      description: '',
      input: z.object({}),
      positional: [],
      interactive: false,
      run: async () => await failWith('boom'),
    })
    await expect(runDefinition(broken, [], capture())).rejects.toThrow('boom')
  })
})

describe('型の変換', () => {
  const typed = defineCommand({
    path: ['typed'],
    description: '型',
    input: z.object({
      count: z.number().int().min(0).max(20).default(5),
      limit: z.number().int().min(1).optional(),
      ratio: z.number().optional(),
      step: z.number().int().optional(),
      number: z.number().int(),
    }),
    positional: ['number'],
    shortFlags: { count: '-c' },
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('整数・実数に変換して渡す', async () => {
    seen.length = 0
    await runDefinition(typed, ['7', '-c', '3', '--limit', '4', '--ratio', '1.5', '--step', ' 8 '], capture())
    expect(seen).toEqual([{ number: 7, count: 3, limit: 4, ratio: 1.5, step: 8 }])
  })

  it('範囲つきの整数は、click と同じ文で誤りにする', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['1', '-c', 'x'], io))).toBe('Invalid value for \'--count\' / \'-c\': \'x\' is not a valid integer range.')
    expect(await messageOf(runDefinition(typed, ['1', '-c', '99'], io))).toBe('Invalid value for \'--count\' / \'-c\': 99 is not in the range 0<=x<=20.')
    expect(await messageOf(runDefinition(typed, ['1', '--limit', '0'], io))).toBe('Invalid value for \'--limit\': 0 is not in the range x>=1.')
  })

  it('整数の項目に 1.5、実数の項目に abc を渡すと、範囲を言わない誤りの文を返す', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['1', '--step', '1.5'], io))).toBe('Invalid value for \'--step\': \'1.5\' is not a valid integer.')
    expect(await messageOf(runDefinition(typed, ['1', '--ratio', 'abc'], io))).toBe('Invalid value for \'--ratio\': \'abc\' is not a valid float.')
  })

  it('位置引数の誤りは、入力の名前で出す', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['abc'], io))).toBe('Invalid value for \'number\': \'abc\' is not a valid integer.')
  })

  it('実数は指数と _ を受ける', async () => {
    seen.length = 0
    await runDefinition(typed, ['1', '--ratio', '1_0e1'], capture())
    expect(seen).toEqual([{ number: 1, count: 5, ratio: 100 }])
  })
})

describe('否定形と包んだスキーマ', () => {
  const transformedFlag = z.boolean().transform(value => value)
  const namesField = z.array(z.string()).readonly().optional()
  const filesField = z.array(z.string()).readonly()

  const flags = defineCommand({
    path: ['flags'],
    description: '旗',
    input: z.object({
      checkout: z.boolean().default(true),
      verbose: transformedFlag,
      names: namesField,
      files: filesField,
    }),
    positional: ['files'],
    negations: { checkout: '--no-checkout' },
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('既定値が真の真偽値は、--no-x で偽にできる', async () => {
    seen.length = 0
    await runDefinition(flags, ['a'], capture())
    await runDefinition(flags, ['a', '--no-checkout'], capture())
    await runDefinition(flags, ['a', '--checkout'], capture())
    expect(seen).toEqual([
      { files: ['a'], checkout: true, verbose: false },
      { files: ['a'], checkout: false, verbose: false },
      { files: ['a'], checkout: true, verbose: false },
    ])
  })

  it('入力名が no_ で始まる真偽値は、付けると true になり、省くと既定値の false になる', async () => {
    const quick = defineCommand({
      path: ['quick'],
      description: '起票する',
      input: z.object({ no_branch: z.boolean().default(false) }),
      positional: [],
      interactive: false,
      run: async (input) => {
        seen.push(input)
        return await exitWith(0)
      },
    })
    seen.length = 0
    await runDefinition(quick, ['--no-branch'], capture())
    await runDefinition(quick, [], capture())
    expect(seen).toEqual([{ no_branch: true }, { no_branch: false }])
  })

  it('readonly の配列は繰り返しで渡し、transform つきの真偽値は旗になる', async () => {
    seen.length = 0
    await runDefinition(flags, ['a', '--names', 'x', '--names', 'y', '--verbose'], capture())
    expect(seen).toEqual([{ files: ['a'], checkout: true, verbose: true, names: ['x', 'y'] }])
  })

  it('必須の可変長の位置引数が無ければ、入力の名前で案内する', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(flags, [], io))).toBe('Missing argument \'files\'.')
    expect(synopsisOf(flags)).toBe('[OPTIONS] {files}...')
  })

  it('否定形も未知のオプションの候補になる', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(flags, ['a', '--no-checkou'], io))).toBe('No such option: --no-checkou (Possible options: --checkout, --no-checkout)')
  })
})

describe('誤りの扱い', () => {
  it('値の無いオプションは、利用者が打った名前で案内する', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(read, ['1', '-c'], io))).toBe('Option \'-c\' requires an argument.')
    expect(await messageOf(runDefinition(read, ['1', '--comment-limit'], io))).toBe('Option \'--comment-limit\' requires an argument.')
  })

  it('未知の長いオプションには候補を案内する。短いオプションには案内しない', async () => {
    const io = capture()
    expect(await messageOf(runDefinition(read, ['1', '--jso'], io))).toBe('No such option: --jso (Possible options: --json)')
    expect(await messageOf(runDefinition(read, ['1', '-x'], io))).toBe('No such option: -x')
  })

  const checked = z.object({ mode: z.enum(['a', 'b']).optional(), text: z.string().optional() })

  it('入力の検証（parse）の誤りだけを使い方の誤りにする', async () => {
    const command = defineCommand({
      path: ['checked'],
      description: '',
      input: checked,
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const io = capture()
    const error = await usageErrorOf(runDefinition(command, ['--mode', 'z'], io))
    expect(error.message).toMatch(/^Invalid value for '--mode': /u)
  })

  it('本体（run）が投げた context 無しの UsageError には、このコマンドの使い方を付ける', async () => {
    const command = defineCommand({
      path: ['issue', 'read'],
      description: '',
      input: z.object({ issue_ref: z.string() }),
      positional: ['issue_ref'],
      interactive: false,
      run: async () => await throwFailure(new UsageError('Invalid value: bad')),
    })
    const error = await usageErrorOf(runDefinition(command, ['1'], capture()))
    expect(formatUsageError(error)).toContain('Usage: pecot issue read [OPTIONS] {issue_ref}')
  })

  it('本体（run）が投げた ZodError は、使い方の誤りにしない', async () => {
    const command = defineCommand({
      path: ['inner'],
      description: '',
      input: z.object({}),
      positional: [],
      interactive: false,
      run: async () => {
        await Promise.resolve()
        return z.string().parse(1) === '' ? 0 : 1
      },
    })
    await expect(runDefinition(command, [], capture())).rejects.toBeInstanceOf(z.ZodError)
  })
})
