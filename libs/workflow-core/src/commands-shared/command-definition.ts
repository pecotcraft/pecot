// MCP のツールの定義の型と defineTool()。ツールのファイルが import する。
// registry.ts が TOOLS を持つために各ツールのファイルを import するので、循環を避けて定義をここに分ける。全ツールの入力に repo を合成する。
import { z } from 'zod'

import { BaseError } from '../domain/errors.js'
import type { FailureKind } from './failure-kind.js'
import { COMMAND_VERBS } from './names.js'

/**
ツールが出力を書く先。MCP のサーバは結果の文字列に集め（collectIo）、actions/ は process の stdout・stderr に書く
*/
export interface CommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /**
  MCP の要求の取り消し。MCP だけが渡す
  */
  readonly signal?: Readonly<AbortSignal>
  /**
  失敗の原因の名前を受け取る。MCP だけが渡す
  */
  readonly failureKind?: (kind: FailureKind) => void
  /**
  結果の行（created: など。改行を含まない）を受け取る。片付けの行は渡さない。MCP だけが渡す
  */
  readonly resultLine?: (line: string) => void
  /**
  成功の data の項目を受け取る。何度も渡されたら浅く重ねる（後の値が勝つ）。MCP だけが渡す
  */
  readonly data?: (fields: Readonly<Record<string, unknown>>) => void
  /**
  warning の文（`warning: ` の前置きを除き、続きの行の字下げは残したもの）を受け取る。MCP だけが渡す
  */
  readonly warning?: (text: string) => void
  /**
  失敗の文（`error: ` の前置きを除き、続きの行の字下げは残したもの）を受け取る。MCP だけが渡す
  */
  readonly error?: (text: string) => void
  /**
  子プロセスの生の出力を受け取る。MCP だけが渡す
  */
  readonly log?: (text: string) => void
}

/**
ツールの途中で、決めた終了コードで止めるための例外。defineTool が包む run の 1 か所で捕まえて、戻り値の終了コードにする。
`error:` の行は出さない（出す行は投げる前に書く）ので、PecotError・InvalidValueError・OsError・UsageError は継がない
*/
export class CommandExit extends BaseError {
  readonly exitCode: number
  readonly kind: FailureKind

  constructor(exitCode: number, kind: FailureKind) {
    super(`exit ${String(exitCode)}`)
    this.exitCode = exitCode
    this.kind = kind
  }
}

/**
MCP の結果の structuredContent の最上位に、output と並べて置く共通の項目の名前
*/
// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const COMMON_OUTPUT_KEYS = ['kind', 'detail', 'log', 'warnings'] as const
export type CommonOutputKey = typeof COMMON_OUTPUT_KEYS[number]

/**
全ツールの入力に足す repo
*/
const GLOBAL_SHAPE = { repo: z.string().optional().describe('Target repository, given explicitly as \'owner/repo\'') }
const GLOBAL_SCHEMA = z.object(GLOBAL_SHAPE)

export type GlobalInput = z.output<typeof GLOBAL_SCHEMA>

export interface ToolSpec<Input extends z.ZodObject, Output extends z.ZodObject> {
  /**
  `board_add`、`issue_comment_check`。決まりは `<対象>_<動詞>` で、最後の語が動詞（names.ts の toolNameViolations）
  */
  readonly name: string
  /**
  MCP の Tool の最上位の title（表示名）。英語・4 語以内
  */
  readonly title: string
  readonly description: string
  /**
  入力。`repo` は全ツールに足す入力の予約名。hasOwnRepo が真のツールだけ、自分の `repo` として持てる
  */
  readonly input: Input
  /**
  MCP の成功の data の型（z.strictObject）。run は createOutput<z.input<typeof output>>() の result で項目を渡す。
  `.default()`・transform・z.date() は使わない（定義書への書き出しで形が変わるか、例外になる）
  */
  readonly output: Output
  /**
  自分の `repo` を持つ印。真なら input に `repo` を書ける（説明は `.describe()`、形の検証は input の refine）
  */
  readonly hasOwnRepo?: boolean
  /**
  真なら、共通の repo を使わない。`repo` は自分の入力の値だけになる（hasOwnRepo のツール用）
  */
  readonly ignoresGlobalRepo?: boolean
  /**
  偽なら、外の世界（GitHub など）に触れない印。MCP の openWorldHint: false になる。省けば印を出さない
  */
  readonly openWorld?: false
  /**
  実行して 0 を返す。出力は io に書く。失敗は CommandExit で止め、原因の名前を運ぶ
  */
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
  readonly run: (input: z.output<Input> & GlobalInput, io: CommandIo) => Promise<0>
}

/**
検証を終えた入力で、本体を呼べる状態のツール
*/
export interface PreparedCommand {
  readonly run: (io: CommandIo) => Promise<number>
}

/**
入力の型を消した定義。一覧の要素の型
*/
export interface ToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  /**
  共通の repo を足した入力
  */
  readonly input: z.ZodObject
  /**
  MCP の成功の data の型
  */
  readonly output: z.ZodObject
  /**
  自分の `repo` を持つか。真のとき、input の repo はツール自身の入力
  */
  readonly hasOwnRepo: boolean
  /**
  共通の repo を入力に渡さないか
  */
  readonly ignoresGlobalRepo: boolean
  /**
  動詞が読むだけの印（names.ts の readOnly）を持つか
  */
  readonly readOnly: boolean
  /**
  外の世界に触れないツールだけ false。ほかは undefined
  */
  readonly openWorld?: false
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
ツール名から定義書（interface/）の項目の ID を作る。`session_start` は PW-SESSION-START、`issue_comment_check` は PW-ISSUE-COMMENT-CHECK
*/
export function interfaceIdOf(name: string): string {
  return `PW-${name.toUpperCase().replaceAll('_', '-')}`
}

async function runToExitCode<Input>(run: (input: Input, io: CommandIo) => Promise<number>, input: Input, io: CommandIo): Promise<number> {
  try {
    return await run(input, io)
  }
  catch (error: unknown) {
    if (!(error instanceof CommandExit)) throw error
    io.failureKind?.(error.kind)
    return error.exitCode
  }
}

/**
型付きの仕様から、型を消した定義を作る。parse が input で検証してから本体を呼ぶので、型を消しても安全に呼べる
*/
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(spec: Readonly<ToolSpec<Input, Output>>): ToolDefinition {
  if (spec.name === '') throw new TypeError('ツールの name が空です')
  const hasOwnRepository = spec.hasOwnRepo === true
  const hasRepositoryField = Object.hasOwn(spec.input.shape, 'repo')
  if (hasRepositoryField && !hasOwnRepository) throw new TypeError('input の repo は全ツールに足す入力の予約名です')
  if (hasOwnRepository && !hasRepositoryField) throw new TypeError('hasOwnRepo のツールは input に repo が要ります')
  // 定義書の data の成功の側を閉じた型（additionalProperties: false）にするため
  if (!(spec.output.def.catchall instanceof z.ZodNever)) throw new TypeError('output は z.strictObject で書きます')
  // 同じ名前だと outputSchema では共通の項目が、失敗の値では output が勝ち、結果が outputSchema に合わなくなる
  const reserved = COMMON_OUTPUT_KEYS.filter(key => Object.hasOwn(spec.output.shape, key))
  if (reserved.length > 0) throw new TypeError(`output の ${reserved.join('・')} は MCP の結果の共通の項目の予約名です`)
  const input = hasOwnRepository ? spec.input : spec.input.safeExtend(GLOBAL_SHAPE)
  const parse = (raw: Readonly<Record<string, unknown>>): PreparedCommand => {
    // 検証は spec.input で行う（全体の refine を保つ）。共通の repo は strictObject が拒むので外し、別に検証する
    const parsed: z.output<Input> & GlobalInput = hasOwnRepository
      ? spec.input.parse(raw)
      : { ...spec.input.parse(Object.fromEntries(Object.entries(raw).filter(([name]) => name !== 'repo'))), ...GLOBAL_SCHEMA.parse(raw) }
    return { run: async io => await runToExitCode(spec.run, parsed, io) }
  }
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input,
    output: spec.output,
    hasOwnRepo: hasOwnRepository,
    ignoresGlobalRepo: spec.ignoresGlobalRepo === true,
    readOnly: COMMAND_VERBS.some(verb => verb.name === spec.name.slice(spec.name.lastIndexOf('_') + 1) && verb.readOnly === true),
    ...spec.openWorld === false && { openWorld: false },
    parse,
    run: async (raw, io) => await parse(raw).run(io),
  }
}
