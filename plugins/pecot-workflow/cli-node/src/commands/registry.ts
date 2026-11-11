// コマンド定義の一覧。CLI と MCP の両方がこの一覧から作られる。
// 各コマンドは defineCommand() で定義して command-list.ts の COMMANDS に足す。グローバルの --repo は、全コマンドの入力 repo として合成する。
import { z } from 'zod'

/**
コマンドが出力を書く先。CLI は process の stdout・stderr、MCP は結果の文字列に集める
*/
export interface CommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/**
グローバルの --repo を入力にしたもの。全コマンドの入力に足される
*/
const GLOBAL_SHAPE = { repo: z.string().optional() }
const GLOBAL_SCHEMA = z.object(GLOBAL_SHAPE)

export type GlobalInput = z.output<typeof GLOBAL_SCHEMA>

/**
グローバルの --repo の値。ownsRepo のコマンドは、入力ではなくここから読む
*/
export interface CommandContext {
  readonly globalRepository: string | undefined
}

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
  引数とオプション。名前は CLI のオプション名の `-` を `_` にしたもの。`repo` は、ownsRepo でなければグローバルの --repo 用の予約名
  */
  readonly input: Input
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
  readonly run: (input: z.output<Input> & GlobalInput, io: CommandIo, context: CommandContext) => Promise<number>
  /**
  input の `repo` を、このコマンド自身の入力として持つか。持つと、グローバルの --repo は input に混ぜず context で渡す
  */
  readonly ownsRepo?: boolean
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
  ownsRepo でなければ、グローバルの repo を足した入力
  */
  readonly input: z.ZodObject
  readonly positional: readonly string[]
  /**
  input の名前から短いオプションへ
  */
  readonly shortFlags: ReadonlyMap<string, string>
  /**
  input の名前から否定形のオプションへ
  */
  readonly negations: ReadonlyMap<string, string>
  readonly interactive: boolean
  readonly ownsRepo: boolean
  /**
  検証の段。入力が不正なら ZodError を投げる。本体は呼ばない。context は ownsRepo のコマンドの本体へ渡る
  */
  readonly parse: (input: Readonly<Record<string, unknown>>, context?: Readonly<CommandContext>) => PreparedCommand
  /**
  parse してから本体を呼ぶ。本体が投げた ZodError は、検証の誤りと区別できる
  */
  readonly run: (input: Readonly<Record<string, unknown>>, io: CommandIo, context?: Readonly<CommandContext>) => Promise<number>
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

/**
型付きの仕様から、型を消した定義を作る。parse が input で検証してから本体を呼ぶので、型を消しても安全に呼べる
*/

export function defineCommand<Input extends z.ZodObject>(spec: Readonly<CommandSpec<Input>>): CommandDefinition {
  if (spec.path.length === 0) throw new TypeError('コマンドの path が空です')
  const isOwner = spec.ownsRepo ?? false
  const hasRepository = Object.hasOwn(spec.input.shape, 'repo')
  if (!isOwner && hasRepository) throw new TypeError('input の repo はグローバルの --repo 用の予約名です')
  if (isOwner && !hasRepository) throw new TypeError('ownsRepo のコマンドは input に repo が要ります')
  const input = isOwner ? spec.input : spec.input.safeExtend(GLOBAL_SHAPE)
  const parse = (raw: Readonly<Record<string, unknown>>, context?: Readonly<CommandContext>): PreparedCommand => {
    if (isOwner) {
      const parsedOwn: z.output<Input> = spec.input.parse(raw)
      const own: CommandContext = { globalRepository: context?.globalRepository }
      return { run: async io => await spec.run(parsedOwn, io, own) }
    }
    // 検証は spec.input で行う（全体の refine を保つ）。repo は strictObject が拒むので外し、別に検証する
    const own: z.output<Input> = spec.input.parse(Object.fromEntries(Object.entries(raw).filter(([name]) => name !== 'repo')))
    const parsed = { ...own, ...GLOBAL_SCHEMA.parse(raw) }
    return { run: async io => await spec.run(parsed, io, { globalRepository: parsed.repo }) }
  }
  return {
    path: spec.path,
    toolName: toolNameOf(spec.path),
    description: spec.description,
    input,
    positional: spec.positional,
    shortFlags: flagMap(spec.shortFlags),
    negations: flagMap(spec.negations),
    interactive: spec.interactive,
    ownsRepo: isOwner,
    parse,
    run: async (raw, io, context) => await parse(raw, context).run(io),
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
export function findCommand(path: readonly string[], commands: readonly CommandDefinition[]): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
