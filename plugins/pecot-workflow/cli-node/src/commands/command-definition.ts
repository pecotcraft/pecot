// コマンドの定義の型と defineCommand()。コマンドのファイルが import する。
// registry.ts が COMMANDS を持つために各コマンドのファイルを import するので、循環を避けて定義をここに分ける。
// グローバルの --repo は、全コマンドの入力 repo として合成する。
import { z } from 'zod'

import { BaseError } from '../domain/errors.js'
import { flagKindOf } from './value-types.js'

/**
コマンドが出力を書く先。CLI は process の stdout・stderr、MCP は結果の文字列に集める
*/
export interface CommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/**
コマンドの途中で、決めた終了コードで止めるための例外。defineCommand が包む run の 1 か所で捕まえて、戻り値の終了コードにする。
Python の `typer.Exit(n)` に当たる。`error:` の行や使い方の枠は出さない（出す行は投げる前に書く）ので、PecotError・InvalidValueError・OsError・UsageError は継がない
*/
export class CommandExit extends BaseError {
  readonly exitCode: number

  constructor(exitCode: number) {
    super(`exit ${String(exitCode)}`)
    this.exitCode = exitCode
  }
}

/**
グローバルの --repo を入力にしたもの。全コマンドの入力に足される
*/
const GLOBAL_SHAPE = { repo: z.string().optional() }
const GLOBAL_SCHEMA = z.object(GLOBAL_SHAPE)

export type GlobalInput = z.output<typeof GLOBAL_SCHEMA>

export interface CommandSpec<Input extends z.ZodObject> {
  /**
  `['issue', 'create']`、`['add-to-project']`
  */
  readonly path: readonly string[]
  /**
  typer の help の 1 行目と同じ文
  */
  readonly description: string
  /**
  引数とオプション。名前は CLI のオプション名の `-` を `_` にしたもの。
  `repo` はグローバルの --repo 用の予約名。hasOwnRepo が真のコマンドだけ、自分の `--repo` として持てる
  */
  readonly input: Input
  /**
  自分の `--repo` を持つ印。真なら input に `repo` を書ける（説明は `.describe()`、形の検証は input の refine）。
  実行時の `repo` は、サブコマンドの値を先に使い、無ければグローバルの値になる
  */
  readonly hasOwnRepo?: boolean
  /**
  input のうち CLI で位置引数になるもの（順序つき）
  */
  readonly positional: readonly (keyof Input['shape'] & string)[]
  /**
  CLI の短いオプション。キーは input の名前、値は `-D` の形
  */
  readonly shortFlags?: Readonly<Partial<Record<keyof Input['shape'] & string, string>>>
  /**
  CLI の否定形のオプション。キーは input の名前、値は `--no-checkout` の形。
  `--checkout/--no-checkout` の形で、既定値が真の真偽値を偽にできる
  */
  readonly negations?: Readonly<Partial<Record<keyof Input['shape'] & string, string>>>
  /**
  実行して終了コードを返す。出力は io に書く
  */
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
  readonly run: (input: z.output<Input> & GlobalInput, io: CommandIo) => Promise<number>
  /**
  CLI でだけ利用者に問うか
  */
  readonly interactive: boolean
}

/**
検証を終えた入力で、本体を呼べる状態のコマンド
*/
export interface PreparedCommand {
  readonly run: (io: CommandIo) => Promise<number>
}

/**
入力の型を消した定義。一覧の要素の型
*/
export interface CommandDefinition {
  readonly path: readonly string[]
  readonly toolName: string
  readonly description: string
  /**
  グローバルの repo を足した入力
  */
  readonly input: z.ZodObject
  readonly positional: readonly string[]
  /**
  自分の `--repo` を持つか。真のとき、input の repo はコマンド自身の引数
  */
  readonly hasOwnRepo: boolean
  /**
  input の名前から短いオプションへ
  */
  readonly shortFlags: ReadonlyMap<string, string>
  /**
  input の名前から否定形のオプションへ
  */
  readonly negations: ReadonlyMap<string, string>
  readonly interactive: boolean
  /**
  検証の段。入力が不正なら ZodError を投げる。本体は呼ばない
  */
  readonly parse: (input: Readonly<Record<string, unknown>>) => PreparedCommand
  /**
  parse してから本体を呼ぶ。本体が投げた ZodError は、検証の誤りと区別できる
  */
  readonly run: (input: Readonly<Record<string, unknown>>, io: CommandIo) => Promise<number>
}

/**
path から MCP のツール名を作る。`['issue', 'create']` は issue_create、`['add-to-project']` は add_to_project
*/
export function toolNameOf(path: readonly string[]): string {
  return path.join('_').replaceAll('-', '_')
}

function flagMap(flags: Readonly<Partial<Record<string, string>>> | undefined): ReadonlyMap<string, string> {
  return new Map(Object.entries(flags ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function runToExitCode<Input>(run: (input: Input, io: CommandIo) => Promise<number>, input: Input, io: CommandIo): Promise<number> {
  try {
    return await run(input, io)
  }
  catch (error: unknown) {
    if (error instanceof CommandExit) return error.exitCode
    throw error
  }
}

// commander は `--no-x` を `--x` の否定として扱う。この解釈に合わない `no_` の名前は作れない。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function rejectNegationLikeFields(shape: Readonly<Record<string, z.core.$ZodType>>, positional: readonly string[]): void {
  const options = Object.entries(shape).filter(([name]) => !positional.includes(name))
  const names = new Set(options.map(([name]) => name))
  for (const [name, schema] of options) {
    if (!name.startsWith('no_')) continue
    if (flagKindOf(schema) !== 'boolean') throw new TypeError(`no_ で始まる input の ${name} は真偽値にしてください`)
    if (names.has(name.slice(3))) throw new TypeError(`input の ${name.slice(3)} と ${name} は commander が否定の対とみなすため、同時に定義できません`)
  }
}

/**
型付きの仕様から、型を消した定義を作る。parse が input で検証してから本体を呼ぶので、型を消しても安全に呼べる
*/

export function defineCommand<Input extends z.ZodObject>(spec: Readonly<CommandSpec<Input>>): CommandDefinition {
  if (spec.path.length === 0) throw new TypeError('コマンドの path が空です')
  const hasOwnRepository = spec.hasOwnRepo === true
  const hasRepositoryField = Object.hasOwn(spec.input.shape, 'repo')
  if (hasRepositoryField && !hasOwnRepository) throw new TypeError('input の repo はグローバルの --repo 用の予約名です')
  if (hasOwnRepository && !hasRepositoryField) throw new TypeError('hasOwnRepo のコマンドは input に repo が要ります')
  rejectNegationLikeFields(spec.input.shape, spec.positional)
  const input = hasOwnRepository ? spec.input : spec.input.safeExtend(GLOBAL_SHAPE)
  const parse = (raw: Readonly<Record<string, unknown>>): PreparedCommand => {
    // 検証は spec.input で行う（全体の refine を保つ）。グローバルの repo は strictObject が拒むので外し、別に検証する。
    // 自分の repo を持つコマンドは、repo も spec.input が検証する
    const parsed: z.output<Input> & GlobalInput = hasOwnRepository
      ? spec.input.parse(raw)
      : { ...spec.input.parse(Object.fromEntries(Object.entries(raw).filter(([name]) => name !== 'repo'))), ...GLOBAL_SCHEMA.parse(raw) }
    return { run: async io => await runToExitCode(spec.run, parsed, io) }
  }
  return {
    path: spec.path,
    toolName: toolNameOf(spec.path),
    description: spec.description,
    input,
    positional: spec.positional,
    hasOwnRepo: hasOwnRepository,
    shortFlags: flagMap(spec.shortFlags),
    negations: flagMap(spec.negations),
    interactive: spec.interactive,
    parse,
    run: async (raw, io) => await parse(raw).run(io),
  }
}
