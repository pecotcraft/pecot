import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { isHelpRequested, runDefinition, synopsisOf, usageOf } from '../command-binding.js'
import { exitCodeOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { defineCommand } from '../registry.js'
import { formatUsageError, UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { ATTRIBUTES_INPUT, capture, exitWith, failWith, throwFailure } from './support.js'

const seen: unknown[] = []

const readInput = z.object({
  issue_ref: z.string(),
  comment_limit: z.coerce.number().default(5),
  json: z.boolean(),
  labels: z.array(z.string()).optional(),
})

const read = defineCommand({
  path: ['issue', 'read'],
  title: 'Test command',
  description: 'Issue を読む',
  input: readInput,
  output: z.strictObject({}),
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
  title: 'Test command',
  description: 'リリース前の確認',
  input: z.object({ version: z.string().optional(), directory: z.string(), mode: z.enum(['a', 'b']).optional() }),
  output: z.strictObject({}),
  positional: ['version'],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async () => await exitWith(0),
})

const namesInput = z.object({ names: z.array(z.string()) })

const remove = defineCommand({
  path: ['worktree', 'remove'],
  title: 'Test command',
  description: '消す',
  input: namesInput,
  output: z.strictObject({}),
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
  title: 'Test command',
  description: '任意の複数',
  input: z.object({ files: optionalStrings }),
  output: z.strictObject({}),
  positional: ['files'],
  interactive: false,
  run: async () => await exitWith(0),
})

const ownRepository = defineCommand({
  path: ['issue', 'quick'],
  title: 'Test command',
  description: '自分の repo を持つ',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  input: z.object({ repo: z.string().optional(), title: z.string() }),
  output: z.strictObject({}),
  positional: ['title'],
  shortFlags: { repo: '-r' },
  interactive: false,
  run: async (input) => {
    seen.push(input)
    return await exitWith(0)
  },
})

const add = defineCommand({
  path: ['worktree', 'add'],
  title: 'Test command',
  description: '作る',
  input: z.object({ allow_existing_branch: z.boolean().default(false), directory: z.string().optional() }),
  output: z.strictObject({}),
  positional: [],
  shortFlags: { directory: '-D' },
  aliases: { allow_existing_branch: '--force' },
  interactive: false,
  run: async (input) => {
    seen.push(input)
    return await exitWith(0)
  },
})

const skipping = defineCommand({
  path: ['skipping'],
  title: 'Test command',
  description: '名前が no_ で始まる入力',
  input: z.object({ no_copy: z.boolean().default(false) }),
  output: z.strictObject({}),
  positional: [],
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
  it('必須の位置引数は波括弧、任意の位置引数は角括弧、複数の位置引数は末尾に ... を付けて、使い方の文を作成する', async () => {
    await explains('コマンドの使い方の文を作成する `synopsisOf` と `usageOf` のテストです。必須の位置引数は `{issue_ref}`、任意の位置引数は `[version]`、複数の位置引数は `{names}...` の形で表示することを確認します。')
    expect(synopsisOf(read)).toBe('[OPTIONS] {issue_ref}')
    expect(synopsisOf(preflight)).toBe('[OPTIONS] [version]')
    expect(synopsisOf(remove)).toBe('[OPTIONS] {names}...')
    expect(synopsisOf(optionalFiles)).toBe('[OPTIONS] [files]...')
    expect(usageOf(read)).toEqual({ commandPath: ['issue', 'read'], synopsis: '[OPTIONS] {issue_ref}' })
  })
})

describe('runDefinition', () => {
  it('位置引数とオプションを input にして run を呼び、終了コードを返す', async () => {
    await explains('コマンドの引数を解釈して `run` を呼ぶ `runDefinition` のテストです。位置引数と `-c` や `--labels` などのオプションを渡した場合に、それらを入力としてまとめて `run` に渡し、`run` が返した終了コード `7` を返すことを確認します。')
    seen.length = 0
    expect(await runDefinition(read, ['a/b/1', '-c', '3', '--json', '--labels', 'x', '--labels', 'y'], capture())).toBe(7)
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 3, json: true, labels: ['x', 'y'] }])
  })

  it('グローバルの --repo の値を、入力の repo として run に渡す', async () => {
    await explains('グローバルの `--repo` を扱う `runDefinition` のテストです。グローバルの値 `x/y` を渡した場合に、`run` の入力の `repo` にその値が入ることを確認します。')
    seen.length = 0
    await runDefinition(read, ['a/b/1'], capture(), 'x/y')
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 5, json: false, repo: 'x/y' }])
  })

  it('ignoresGlobalRepo を指定したコマンドは、自分の -r の値を使い、グローバルの --repo を無視する', async () => {
    await explains('`ignoresGlobalRepo` を指定したコマンドのテストです。コマンド自身の `-r y/z` を指定した場合はその値を使い、指定しない場合はグローバルの `--repo` の値 `x/y` を渡さないことを確認します。')
    seen.length = 0
    await runDefinition(ownRepository, ['t', '-r', 'y/z'], capture(), 'x/y')
    await runDefinition(ownRepository, ['t'], capture(), 'x/y')
    expect(seen).toEqual([{ title: 't', repo: 'y/z' }, { title: 't' }])
  })

  it('指定しない真偽値は false になり、既定値を持つ入力には既定値が入る', async () => {
    await explains('オプションを何も指定しない場合の `runDefinition` のテストです。真偽値の `json` が `false` になり、`comment_limit` に既定値の `5` が入ることを確認します。')
    seen.length = 0
    await runDefinition(read, ['a/b/1'], capture())
    expect(seen).toEqual([{ issue_ref: 'a/b/1', comment_limit: 5, json: false }])
  })

  it('複数の位置引数は、配列にまとめて run に渡す', async () => {
    await explains('複数指定できる位置引数 `names` を持つコマンドのテストです。`one` と `two` を渡した場合に、`names` が `[\'one\', \'two\']` の配列になって `run` に渡されることを確認します。')
    seen.length = 0
    await runDefinition(remove, ['one', 'two'], capture())
    expect(seen).toEqual([{ names: ['one', 'two'] }])
  })

  it('必須の位置引数が指定されていない場合は、Missing argument の使い方の誤りにする', async () => {
    await explains('必須の位置引数 `issue_ref` を指定しなかった場合のテストです。`Usage:` の行と `Missing argument \'issue_ref\'.` を、枠で囲んだエラーの文として表示することを確認します。')
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

  it('必須のオプションが指定されていない場合は、長い形と短い形を並べた Missing option の使い方の誤りにする', async () => {
    await explains('必須の `--directory` を指定しなかった場合のテストです。`Missing option \'--directory\' / \'-D\'.` のメッセージで、コマンドの使い方の情報を持つ `UsageError` が発生することを確認します。')
    const error = await usageErrorOf(runDefinition(preflight, [], capture()))
    expect(error.message).toBe('Missing option \'--directory\' / \'-D\'.')
    expect(error.context).toEqual({ commandPath: ['release', 'preflight'], synopsis: '[OPTIONS] [version]' })
  })

  it('任意の位置引数は省略でき、オプションは短い形でも長い形でも渡せる', async () => {
    await explains('任意の位置引数 `version` と、必須の `--directory`（短い形は `-D`）を持つコマンドのテストです。位置引数を省略して `-D .` だけを渡した場合も、位置引数と `--directory .` を渡した場合も、終了コード `0` を返すことを確認します。')
    expect(await runDefinition(preflight, ['-D', '.'], capture())).toBe(0)
    expect(await runDefinition(preflight, ['1.0.0', '--directory', '.'], capture())).toBe(0)
  })

  it('定義されていないオプションを渡すと、No such option の使い方の誤りにする', async () => {
    await explains('コマンドに定義されていないオプションのテストです。`--bogus` を渡した場合に、`No such option: --bogus` の使い方の誤りになることを確認します。')
    const error = await usageErrorOf(runDefinition(preflight, ['--bogus'], capture()))
    expect(error.message).toBe('No such option: --bogus')
  })

  it('値を指定しないオプションは、requires an argument の使い方の誤りにする', async () => {
    await explains('値を取るオプションの値を省略した場合のテストです。`--directory` だけを渡した場合に、`Option \'--directory\' requires an argument.` の使い方の誤りになることを確認します。')
    const error = await usageErrorOf(runDefinition(preflight, ['--directory'], capture()))
    expect(error.message).toBe('Option \'--directory\' requires an argument.')
  })

  it('余分な位置引数を渡すと、個数によらず Got unexpected extra argument(s) の使い方の誤りにする', async () => {
    await explains('位置引数が 1 つのコマンドへ、余分な位置引数を渡した場合のテストです。余分な引数が 1 つの場合と 2 つの場合で、使い方の誤りとして `Got unexpected extra argument(s)` と余分な引数を表示することを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(preflight, ['1', '2', '-D', '.'], io))).toBe('Got unexpected extra argument(s) (2)')
    expect(await messageOf(runDefinition(preflight, ['1', '2', '3', '-D', '.'], io))).toBe('Got unexpected extra argument(s) (2 3)')
  })

  it('--help は未知のオプションとして拒否し、標準出力には何も出力しない', async () => {
    await explains('`runDefinition` が `--help` を受け取った場合のテストです。ヘルプを表示せず、`No such option: --help (Possible options: --help)` の使い方の誤りにして、標準出力には何も出力しないことを確認します。')
    const io = capture()
    const error = await usageErrorOf(runDefinition(preflight, ['--help'], io))
    expect(error.message).toBe('No such option: --help (Possible options: --help)')
    expect(io.out).toEqual([])
  })

  it('--help に値を付けると、値を取らない旨の使い方の誤りにし、Possible options は付けない', async () => {
    await explains('`--help=x` のように値を付けた場合のテストです。`Option \'--help\' does not take a value.` の使い方の誤りになり、コマンドの使い方の情報は付かないことを確認します。')
    const error = await usageErrorOf(runDefinition(preflight, ['--help=x'], capture()))
    expect(error.message).toBe('Option \'--help\' does not take a value.')
    expect(error.context).toBeUndefined()
  })

  it('入力の検証に失敗した場合は、Invalid value の使い方の誤りにする', async () => {
    await explains('`--mode` に、選択肢の `a` と `b` 以外の値 `z` を渡した場合のテストです。`Invalid value for \'--mode\':` で始まる使い方の誤りになることを確認します。')
    const error = await usageErrorOf(runDefinition(preflight, ['-D', '.', '--mode', 'z'], capture()))
    expect(error.message).toMatch(/^Invalid value for '--mode': /u)
  })

  it('入力全体の検証に失敗した場合は、Invalid value for \'input\' の使い方の誤りにする', async () => {
    await explains('入力全体を検証する `refine` が失敗する場合のテストです。個別の項目でなく `input` を対象にした `Invalid value for \'input\': だめです` の使い方の誤りになることを確認します。')
    const strict = defineCommand({
      path: ['x'],
      title: 'Test command',
      description: '',
      input: z.object({ a: z.string().optional() }).refine(() => false, 'だめです'),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const io = capture()
    expect(await messageOf(runDefinition(strict, [], io))).toBe('Invalid value for \'input\': だめです')
  })

  it('run が使い方の誤り以外の例外を投げると、runDefinition はそのまま送出する', async () => {
    await explains('コマンドの `run` が例外 `boom` を投げた場合のテストです。`runDefinition` が使い方の誤りに変換せず、元の例外をそのまま送出することを確認します。')
    const broken = defineCommand({
      path: ['x'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
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
    title: 'Test command',
    description: '型',
    input: z.object({
      count: z.number().int().min(0).max(20).default(5),
      limit: z.number().int().min(1).optional(),
      ratio: z.number().optional(),
      step: z.number().int().optional(),
      number: z.number().int(),
    }),
    output: z.strictObject({}),
    positional: ['number'],
    shortFlags: { count: '-c' },
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('文字列で渡した引数を、整数や実数に変換して run に渡す', async () => {
    await explains('数値の入力を持つコマンドのテストです。`7` や `1.5`、前後に空白がある ` 8 ` などを渡した場合に、整数や実数に変換して `run` に渡すことを確認します。')
    seen.length = 0
    await runDefinition(typed, ['7', '-c', '3', '--limit', '4', '--ratio', '1.5', '--step', ' 8 '], capture())
    expect(seen).toEqual([{ number: 7, count: 3, limit: 4, ratio: 1.5, step: 8 }])
  })

  it('範囲を持つ整数に、整数でない値や範囲外の値を渡すと、範囲を示す使い方の誤りにする', async () => {
    await explains('範囲を持つ整数の入力（`--count` は 0 以上 20 以下、`--limit` は 1 以上）のテストです。整数でない値や範囲外の値を渡した場合に、`is not a valid int range.` や `is not in the range` を含む使い方の誤りになることを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['1', '-c', 'x'], io))).toBe('Invalid value for \'--count\' / \'-c\': \'x\' is not a valid int range.')
    expect(await messageOf(runDefinition(typed, ['1', '-c', '99'], io))).toBe('Invalid value for \'--count\' / \'-c\': 99 is not in the range 0<=x<=20.')
    expect(await messageOf(runDefinition(typed, ['1', '--limit', '0'], io))).toBe('Invalid value for \'--limit\': 0 is not in the range x>=1.')
  })

  it('整数の項目に 1.5、実数の項目に abc を渡すと、範囲に触れない使い方の誤りにする', async () => {
    await explains('範囲を持たない数値の入力のテストです。整数の `--step` と実数の `--ratio` に不正な値を渡した場合に、`is not a valid int.` と `is not a valid float.` の誤りになることを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['1', '--step', '1.5'], io))).toBe('Invalid value for \'--step\': \'1.5\' is not a valid int.')
    expect(await messageOf(runDefinition(typed, ['1', '--ratio', 'abc'], io))).toBe('Invalid value for \'--ratio\': \'abc\' is not a valid float.')
  })

  it('位置引数に不正な値を渡すと、入力の名前を示した使い方の誤りにする', async () => {
    await explains('整数の位置引数 `number` のテストです。`abc` を渡した場合に、`Invalid value for \'number\': \'abc\' is not a valid int.` の使い方の誤りになることを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(typed, ['abc'], io))).toBe('Invalid value for \'number\': \'abc\' is not a valid int.')
  })

  const tagType = z.enum(['a', 'b'])

  it('選択肢を持つ項目に選択肢以外の値を渡すと、選択肢をすべて並べた使い方の誤りにする', async () => {
    await explains('選択肢を持つ項目（`--kind` と `--tags`）のテストです。選択肢以外の値を渡した場合に、`is not one of \'task\', \'bug\'.` のように選択肢をすべて並べた使い方の誤りになり、選択肢の値は受け付けることを確認します。')
    const command = defineCommand({
      path: ['pick'],
      title: 'Test command',
      description: '',
      input: z.object({ kind: z.enum(['task', 'bug']).optional(), tags: z.array(tagType).default([]) }),
      output: z.strictObject({}),
      positional: [],
      shortFlags: { kind: '-k' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    const io = capture()
    expect(await messageOf(runDefinition(command, ['--kind', 'bogus'], io))).toBe('Invalid value for \'--kind\' / \'-k\': \'bogus\' is not one of \'task\', \'bug\'.')
    expect(await messageOf(runDefinition(command, ['--tags', 'a', '--tags', 'z'], io))).toBe('Invalid value for \'--tags\': \'z\' is not one of \'a\', \'b\'.')
    expect(await runDefinition(command, ['-k', 'bug'], io)).toBe(0)
  })

  it('実数は、指数表記や区切りの _ を含む値も受け付ける', async () => {
    await explains('実数の入力 `--ratio` のテストです。`1_0e1` を渡した場合に、`_` を区切りとして無視し、指数表記として解釈した `100` が `run` に渡されることを確認します。')
    seen.length = 0
    await runDefinition(typed, ['1', '--ratio', '1_0e1'], capture())
    expect(seen).toEqual([{ number: 1, count: 5, ratio: 100 }])
  })
})

describe('JSON のオブジェクトの値', () => {
  const edit = defineCommand({
    path: ['issue', 'edit'],
    title: 'Test command',
    description: '属性を書く',
    input: z.object({ attributes: ATTRIBUTES_INPUT }),
    output: z.strictObject({}),
    positional: [],
    aliases: { attributes: '--attribute' },
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('別名の --attribute で JSON を 2 回渡すと、2 要素の配列にして run に渡す', async () => {
    await explains('JSON のオブジェクトを受け取る入力 `attributes` のテストです。別名の `--attribute` で JSON を 2 回渡した場合に、2 要素の配列にして `run` に渡すことを確認します。')
    seen.length = 0
    const argv = ['--attribute', '{"name":"Estimate","value":3}', '--attribute', '{"name":"Labels","value":["a","b"],"source":"issue"}']
    expect(await runDefinition(edit, argv, capture())).toBe(0)
    expect(seen).toEqual([{ attributes: [{ name: 'Estimate', value: 3 }, { name: 'Labels', value: ['a', 'b'], source: 'issue' }] }])
  })

  it('JSON のオブジェクトの入力は、長い形の --attributes でも受け付ける', async () => {
    await explains('JSON のオブジェクトを受け取る入力 `attributes` のテストです。別名でなく長い形の `--attributes` で JSON を渡した場合に、1 要素の配列にして `run` に渡すことを確認します。')
    seen.length = 0
    await runDefinition(edit, ['--attributes', '{"name":"Due","value":"2026-12-01"}'], capture())
    expect(seen).toEqual([{ attributes: [{ name: 'Due', value: '2026-12-01' }] }])
  })

  it.for([
    { name: '読めない JSON', text: '{name:Estimate}' },
    { name: '配列', text: '[{"name":"Estimate","value":3}]' },
    { name: '数', text: '3' },
    { name: 'null', text: 'null' },
  ])('$name を渡すと、JSON のオブジェクトでない旨の使い方の誤りにし、終了コード 2 を返す', async ({ text }) => {
    await explains('JSON のオブジェクトを受け取る `--attribute` に、オブジェクトでない値を渡した場合のテストです。読めない JSON・配列・数・`null` のどれでも、`is not a valid JSON object.` の使い方の誤りになり、終了コードが `2` になることを確認します。')
    const error = await usageErrorOf(runDefinition(edit, ['--attribute', text], capture()))
    expect(error.message).toBe(`Invalid value for '--attributes' / '--attribute': '${text}' is not a valid JSON object.`)
    expect(error.context).toEqual({ commandPath: ['issue', 'edit'], synopsis: '[OPTIONS]' })
    expect(exitCodeOfFailure(error, capture(), 80)).toBe(2)
  })

  it('JSON の中身が入力の形に合わない場合は、Invalid value の使い方の誤りにする', async () => {
    await explains('`--attribute` に、必須の `value` を含まない JSON（`{"name":"Estimate"}`）を渡した場合のテストです。`Invalid value for \'--attributes\' / \'--attribute\':` で始まる使い方の誤りになることを確認します。')
    const message = await messageOf(runDefinition(edit, ['--attribute', '{"name":"Estimate"}'], capture()))
    expect(message).toMatch(/^Invalid value for '--attributes' \/ '--attribute': /u)
  })
})

describe('否定形と包んだスキーマ', () => {
  const transformedFlag = z.boolean().transform(value => value)
  const namesField = z.array(z.string()).readonly().optional()
  const filesField = z.array(z.string()).readonly()

  const flags = defineCommand({
    path: ['flags'],
    title: 'Test command',
    description: '旗',
    input: z.object({
      checkout: z.boolean().default(true),
      verbose: transformedFlag,
      names: namesField,
      files: filesField,
    }),
    output: z.strictObject({}),
    positional: ['files'],
    negations: { checkout: '--no-checkout' },
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('既定値が true の真偽値は、--no-checkout を指定すると false になる', async () => {
    await explains('既定値が `true` の真偽値 `checkout` のテストです。指定しない場合と `--checkout` を指定した場合は `true`、`--no-checkout` を指定した場合は `false` になることを確認します。')
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

  it('入力名が no_ で始まる真偽値は、--no-branch を指定すると true、省略すると既定値の false になる', async () => {
    await explains('入力名が `no_` で始まる真偽値 `no_branch` のテストです。`--no-branch` を指定した場合は `true`、指定しない場合は既定値の `false` になることを確認します。')
    const quick = defineCommand({
      path: ['quick'],
      title: 'Test command',
      description: '起票する',
      input: z.object({ no_branch: z.boolean().default(false) }),
      output: z.strictObject({}),
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

  it('readonly の配列は同じオプションの繰り返しで渡し、transform を使った真偽値はフラグとして受け付ける', async () => {
    await explains('`readonly` の配列と、`transform` を使った真偽値のテストです。`--names` を繰り返して値を渡し、`--verbose` をフラグとして指定した場合に、`names` が配列に、`verbose` が `true` になることを確認します。')
    seen.length = 0
    await runDefinition(flags, ['a', '--names', 'x', '--names', 'y', '--verbose'], capture())
    expect(seen).toEqual([{ files: ['a'], checkout: true, verbose: true, names: ['x', 'y'] }])
  })

  it('複数指定できる必須の位置引数を渡さないと、入力の名前を示した使い方の誤りにする', async () => {
    await explains('複数指定できる必須の位置引数 `files` のテストです。何も渡さなかった場合に、`Missing argument \'files\'.` の使い方の誤りになり、書式が `[OPTIONS] {files}...` になることを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(flags, [], io))).toBe('Missing argument \'files\'.')
    expect(synopsisOf(flags)).toBe('[OPTIONS] {files}...')
  })

  it('名前が no_ で始まる真偽値 no_copy は、指定しなければ false、--no-copy を指定すれば true になる', async () => {
    await explains('入力名が `no_` で始まる真偽値 `no_copy` のテストです。何も指定しない場合は `false`、`--no-copy` を指定した場合は `true` になることを確認します。')
    seen.length = 0
    await runDefinition(skipping, [], capture())
    await runDefinition(skipping, ['--no-copy'], capture())
    expect(seen).toEqual([{ no_copy: false }, { no_copy: true }])
  })

  it('--no-copy の反対の --copy を渡すと、No such option の使い方の誤りにする', async () => {
    await explains('入力名が `no_` で始まる真偽値 `no_copy` のテストです。`--copy` を渡した場合に、`No such option: --copy (Possible options: --no-copy)` の使い方の誤りになり、`run` を呼ばないことを確認します。')
    seen.length = 0
    const error = await usageErrorOf(runDefinition(skipping, ['--copy'], capture()))
    expect(error.message).toBe('No such option: --copy (Possible options: --no-copy)')
    expect(seen).toEqual([])
  })

  it('別名の --force は、元の名前 allow_existing_branch の入力として run に渡す', async () => {
    await explains('別名 `--force` を持つ真偽値 `allow_existing_branch` のテストです。`--allow-existing-branch` と `--force` のどちらを指定しても `true`、指定しない場合は `false` になることを確認します。')
    seen.length = 0
    await runDefinition(add, ['--allow-existing-branch'], capture())
    await runDefinition(add, ['--force'], capture())
    await runDefinition(add, [], capture())
    expect(seen).toEqual([
      { allow_existing_branch: true },
      { allow_existing_branch: true },
      { allow_existing_branch: false },
    ])
  })

  it('定義されていないオプションの誤りでは、別名も候補として表示する', async () => {
    await explains('別名の綴りを誤った場合のテストです。`--forc` を渡した場合に、`No such option: --forc (Possible options: --force)` のように、別名を候補として表示することを確認します。')
    const message = await messageOf(runDefinition(add, ['--forc'], capture()))
    expect(message).toBe('No such option: --forc (Possible options: --force)')
  })

  it('定義されていないオプションの誤りでは、否定形も候補として表示する', async () => {
    await explains('否定形の綴りを誤った場合のテストです。`--no-checkou` を渡した場合に、`Possible options: --checkout, --no-checkout` のように、否定形を候補に含めて表示することを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(flags, ['a', '--no-checkou'], io))).toBe('No such option: --no-checkou (Possible options: --checkout, --no-checkout)')
  })
})

describe('名前が no_ で始まる旗', () => {
  const skip = defineCommand({
    path: ['skip'],
    title: 'Test command',
    description: '省く',
    input: z.object({ no_issue_ref: z.boolean().default(false) }),
    output: z.strictObject({}),
    positional: [],
    interactive: false,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('--no-issue-ref を指定しなければ false、指定すれば true になる', async () => {
    await explains('入力名が `no_issue_ref` の真偽値のテストです。何も指定しない場合は `false`、`--no-issue-ref` を指定した場合は `true` になることを確認します。')
    seen.length = 0
    await runDefinition(skip, [], capture())
    await runDefinition(skip, ['--no-issue-ref'], capture())
    expect(seen).toEqual([{ no_issue_ref: false }, { no_issue_ref: true }])
  })
})

describe('誤りの扱い', () => {
  it('値を指定しないオプションは、利用者が指定した名前を使って案内する', async () => {
    await explains('値を取るオプションの値を省略した場合のテストです。`-c` と `--comment-limit` のどちらでも、指定した名前を使った `requires an argument.` の使い方の誤りになることを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(read, ['1', '-c'], io))).toBe('Option \'-c\' requires an argument.')
    expect(await messageOf(runDefinition(read, ['1', '--comment-limit'], io))).toBe('Option \'--comment-limit\' requires an argument.')
  })

  it('値を取らないフラグに =値 を付けると、Usage 行を付けずに拒否する', async () => {
    await explains('真偽値のフラグ `--json` に `--json=1` のように値を付けた場合のテストです。`Option \'--json\' does not take a value.` の使い方の誤りになり、コマンドの使い方の情報は付かないことを確認します。')
    const io = capture()
    const error = await usageErrorOf(runDefinition(read, ['--json=1', '1'], io))
    expect(error.message).toBe('Option \'--json\' does not take a value.')
    expect(error.context).toBeUndefined()
  })

  it('値を指定しないオプションの誤りには、Usage 行を付けない', async () => {
    await explains('値を取る `-c` の値を省略した場合のテストです。コマンドの使い方の情報が付かず、整形した文が枠付きの `Error` の表示で始まることを確認します。')
    const error = await usageErrorOf(runDefinition(read, ['1', '-c'], capture()))
    expect(error.context).toBeUndefined()
    expect(formatUsageError(error)).toMatch(/^╭─ Error/u)
  })

  it('定義されていない長いオプションには候補を表示し、短いオプションには表示しない', async () => {
    await explains('定義されていないオプションを渡した場合のテストです。長い形の `--jso` には `Possible options: --json` の候補を表示し、短い形の `-x` には候補を表示しないことを確認します。')
    const io = capture()
    expect(await messageOf(runDefinition(read, ['1', '--jso'], io))).toBe('No such option: --jso (Possible options: --json)')
    expect(await messageOf(runDefinition(read, ['1', '-x'], io))).toBe('No such option: -x')
  })

  const checked = z.object({ mode: z.enum(['a', 'b']).optional(), text: z.string().optional() })

  it('入力の検証（parse）に失敗すると、使い方の誤りにする', async () => {
    await explains('`--mode` に選択肢以外の値 `z` を渡した場合のテストです。入力の検証（`parse`）の失敗が、`Invalid value for \'--mode\':` で始まる使い方の誤りになることを確認します。')
    const command = defineCommand({
      path: ['checked'],
      title: 'Test command',
      description: '',
      input: checked,
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const io = capture()
    const error = await usageErrorOf(runDefinition(command, ['--mode', 'z'], io))
    expect(error.message).toMatch(/^Invalid value for '--mode': /u)
  })

  it('run が使い方の情報を持たない UsageError を投げると、このコマンドの使い方を付ける', async () => {
    await explains('`run` が使い方の情報を持たない `UsageError` を投げた場合のテストです。整形した文に、このコマンドの `Usage: pecot issue read [OPTIONS] {issue_ref}` が含まれることを確認します。')
    const command = defineCommand({
      path: ['issue', 'read'],
      title: 'Test command',
      description: '',
      input: z.object({ issue_ref: z.string() }),
      output: z.strictObject({}),
      positional: ['issue_ref'],
      interactive: false,
      run: async () => await throwFailure(new UsageError('Invalid value: bad')),
    })
    const error = await usageErrorOf(runDefinition(command, ['1'], capture()))
    expect(formatUsageError(error)).toContain('Usage: pecot issue read [OPTIONS] {issue_ref}')
  })

  it('run が ZodError を投げた場合は、使い方の誤りにせず、そのまま送出する', async () => {
    await explains('`run` の中で `ZodError` が発生した場合のテストです。使い方の誤りに変換せず、`ZodError` のまま送出することを確認します。')
    const command = defineCommand({
      path: ['inner'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => {
        await Promise.resolve()
        return z.string().parse(1) === '' ? 0 : await exitWith(1)
      },
    })
    await expect(runDefinition(command, [], capture())).rejects.toBeInstanceOf(z.ZodError)
  })
})

describe('click と同じ文にそろえた使い方の誤り', () => {
  const flags = defineCommand({
    path: ['project', 'set'],
    title: 'Test command',
    description: '設定する',
    input: z.object({ value: z.string(), yes: z.boolean(), checkout: z.boolean().default(true), branch: z.string().optional() }),
    output: z.strictObject({}),
    positional: ['value'],
    shortFlags: { branch: '-b' },
    negations: { checkout: '--no-checkout' },
    interactive: false,
    run: async () => await exitWith(0),
  })

  it('値を取るオプションに値が無い場合は、Usage 行と Try 行を付けない', async () => {
    await explains('値を取る `-b` の値を省略した場合のテストです。コマンドの使い方の情報は付かず、`Option \'-b\' requires an argument.` だけを枠で囲んだ文になることを確認します。')
    const error = await usageErrorOf(runDefinition(flags, ['a', '-b'], capture()))
    expect(error.context).toBeUndefined()
    expect(formatUsageError(error)).toBe(`╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Option '-b' requires an argument.                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
`)
  })

  it('真偽値のオプションに値を付けると、does not take a value の使い方の誤りにし、Usage 行は付けない', async () => {
    await explains('`--yes=1`・`--yes=`・`--no-checkout=1` のように、真偽値のオプションに値を付けた場合のテストです。`does not take a value.` の使い方の誤りになり、コマンドの使い方の情報は付かないことを確認します。')
    const cases: readonly (readonly [string, string])[] = [['--yes=1', '--yes'], ['--yes=', '--yes'], ['--no-checkout=1', '--no-checkout']]
    for (const [argument, name] of cases) {
      const error = await usageErrorOf(runDefinition(flags, ['a', argument], capture()))
      expect(error.message).toBe(`Option '${name}' does not take a value.`)
      expect(error.context).toBeUndefined()
    }
  })

  it('定義されていないオプションに =値 を付けても、値を含めず名前だけで案内する', async () => {
    await explains('`--bogus=1` や `--yse=1` のように、定義されていないオプションへ値を付けた場合のテストです。値を含めない `No such option: --bogus` の形になり、近い名前があれば `Possible options: --yes` も表示することを確認します。')
    const plain = await messageOf(runDefinition(flags, ['a', '--bogus=1'], capture()))
    expect(plain).toBe('No such option: --bogus')
    const close = await messageOf(runDefinition(flags, ['a', '--yse=1'], capture()))
    expect(close).toBe('No such option: --yse (Possible options: --yes)')
  })

  it('負数に見える語は位置引数として受け付けず、先頭の 2 文字だけを示した No such option の使い方の誤りにする', async () => {
    await explains('`-1` や `-12` のように、負数に見える語を渡した場合のテストです。位置引数として受け付けず、`No such option: -1` のように先頭の 2 文字だけを示した使い方の誤りになることを確認します。')
    const cases: readonly (readonly [readonly string[], string])[] = [[['-1'], '-1'], [['a', '-1'], '-1'], [['a', '-12'], '-1'], [['a', '-1x'], '-1'], [['a', '--yes', '-5'], '-5']]
    for (const [argv, name] of cases) {
      const error = await usageErrorOf(runDefinition(flags, argv, capture()))
      expect(error.message).toBe(`No such option: ${name}`)
      expect(error.context).toEqual({ commandPath: ['project', 'set'], synopsis: '[OPTIONS] {value}' })
    }
  })

  it('値を取るオプションの値として渡した負数と、-- の後ろの負数は、誤りにしない', async () => {
    await explains('負数に見える語を、オプションの値や `--` の後ろに置いた場合のテストです。`-b -1`・`--branch -1`・`-- -1` のどれも、使い方の誤りにならず、終了コード `0` を返すことを確認します。')
    expect(await runDefinition(flags, ['a', '-b', '-1'], capture())).toBe(0)
    expect(await runDefinition(flags, ['a', '--branch', '-1'], capture())).toBe(0)
    expect(await runDefinition(flags, ['--', '-1'], capture())).toBe(0)
  })

  it('負数に見える語より前に誤りがある場合は、その誤りを先に表示する', async () => {
    await explains('`--yes=1 -1` や `--bogus -1` のように、負数に見える語より前に誤りがある場合のテストです。負数の誤りでなく、前にある誤り（`does not take a value.` と `No such option: --bogus`）を表示することを確認します。')
    const first = await messageOf(runDefinition(flags, ['a', '--yes=1', '-1'], capture()))
    expect(first).toBe('Option \'--yes\' does not take a value.')
    const second = await messageOf(runDefinition(flags, ['a', '--bogus', '-1'], capture()))
    expect(second).toBe('No such option: --bogus')
  })
})

describe('isHelpRequested', () => {
  const cases: readonly (readonly [readonly string[], boolean])[] = [
    [['--help'], true],
    [['--help', '-1'], true],
    [['--bogus', '--help'], true],
    [['--base', '--help'], true],
    [['a', 'b', '--help'], true],
    [['--help', '--', 'x'], true],
    [[], false],
    [['a', 'b'], false],
    [['-h'], false],
    [['--base=--help', 'x', 'y'], false],
    [['--', '--help'], false],
    [['a', '--', '--help'], false],
  ]

  it.for(cases)('引数が $0 のとき、help の要求かどうかを $1 と判定する', async ([argv, expected]) => {
    await explains('引数に `--help` が含まれるかを判定する `isHelpRequested` のテストです。`--help` が `--` より前にある場合は `true`、`--` の後ろや `--base=--help` のように値の一部の場合は `false` を返すことを確認します。')
    expect(isHelpRequested(argv)).toBe(expected)
  })
})
