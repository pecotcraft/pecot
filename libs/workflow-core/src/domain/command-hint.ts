// 出力の文に添える、次に呼ぶツールの案内。案内はツールの path と入力のデータで持ち、ツール名と入力の呼び方（`call x with a: "b"`）に描く。
// ツールの形（入力名）は commands/registry.ts と hint-catalog.ts が registerHintCommands で登録する。

/**
利用者が埋める値。`<NAME>` と出す
*/
export interface HintPlaceholder {
  readonly placeholder: string
}

export type HintValue = string | number | boolean | HintPlaceholder | readonly string[]

/**
ツール 1 つの案内。input の並びが、描いた入力の並びになる
*/
export interface CommandHint {
  readonly kind: 'command'
  readonly path: readonly string[]
  readonly input: Readonly<Record<string, HintValue>>
}

/**
入力 1 つだけの案内（`force: true` の形）
*/
export interface InputHint {
  readonly kind: 'input'
  readonly path: readonly string[]
  readonly name: string
  /**
  undefined なら名前だけ
  */
  readonly value: HintValue | undefined
}

/**
全ツールに共通の入力 repo の案内。どのツールでも同じ形なので path を持たない
*/
export interface GlobalRepositoryHint {
  readonly kind: 'global-repo'
  readonly value: HintValue | undefined
}

export type Hint = CommandHint | InputHint | GlobalRepositoryHint

/**
文字列と案内を並べた文。描くときに案内をツールの呼び方にする
*/
export type HintedText = readonly (string | Hint)[]

/**
ツールの形。案内の入力名の検証に使う。案内の path を `_` でつないだものが name
*/
export interface HintCommandShape {
  readonly name: string
  readonly inputs: readonly string[]
}

const catalog = new Map<string, HintCommandShape>()

export function registerHintCommands(shapes: readonly HintCommandShape[]): void {
  for (const shape of shapes) catalog.set(shape.name, shape)
}

export function commandHint(path: readonly string[], input: Readonly<Record<string, HintValue>> = {}): CommandHint {
  return { kind: 'command', path, input }
}

export function inputHint(path: readonly string[], name: string, value: HintValue = true): InputHint {
  return { kind: 'input', path, name, value }
}

/**
入力の名前だけの案内。`host is required` の `host`
*/
export function inputNameHint(path: readonly string[], name: string): InputHint {
  return { kind: 'input', path, name, value: undefined }
}

/**
入力 repo の案内。value が無ければ名前だけ
*/
export function globalRepositoryHint(value?: HintValue): GlobalRepositoryHint {
  return { kind: 'global-repo', value }
}

export function placeholder(name: string): HintPlaceholder {
  return { placeholder: name }
}

/**
案内の動詞。文の中で `call <案内>` と書く所に置く
*/
export const RUN = 'call'

/**
案内の前置き。`call <ツール>`
*/
export const RUN_COLON = 'call '

/**
もう一度呼ぶ案内。`call <ツール> again`
*/
export function runAgain(hint: CommandHint): HintedText {
  return ['call ', hint, ' again']
}

function isHint(value: unknown): value is Hint {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
タグ付きテンプレートで HintedText を作る。`hinted\`call ${commandHint(['project', 'init'])}\``
*/
export function hinted(strings: TemplateStringsArray, ...values: readonly (string | number | Hint | HintedText)[]): HintedText {
  return strings.flatMap((text, index): (string | Hint)[] => {
    const value = values.at(index)
    if (index >= values.length) return [text]
    if (isHintedText(value)) return [text, ...value]
    return [text, isHint(value) ? value : String(value)]
  })
}

/**
HintedText を連結する。区切りは separator
*/
export function joinHinted(parts: readonly (string | HintedText)[], separator = '\n'): HintedText {
  return parts.flatMap((part, index) => [...index === 0 ? [] : [separator], ...typeof part === 'string' ? [part] : part])
}

function shapeOf(path: readonly string[]): HintCommandShape {
  const shape = catalog.get(path.join('_'))
  if (shape === undefined) throw new TypeError(`案内のツール '${path.join('_')}' が定義に無い`)
  return shape
}

function assertInput(shape: HintCommandShape, name: string): void {
  if (!shape.inputs.includes(name)) throw new TypeError(`案内の入力 '${name}' が '${shape.name}' の定義に無い`)
}

function isList(value: HintValue): value is readonly string[] {
  return Array.isArray(value)
}

function isPlaceholder(value: HintValue): value is HintPlaceholder {
  return typeof value === 'object' && !isList(value)
}

function valueText(value: HintValue): string {
  if (isPlaceholder(value)) return `<${value.placeholder}>`
  return typeof value === 'string' || isList(value) ? JSON.stringify(value) : String(value)
}

function formatCommand(hint: CommandHint): string {
  const shape = shapeOf(hint.path)
  const entries = Object.entries(hint.input)
  for (const [name] of entries) assertInput(shape, name)
  const tool = hint.path.join('_')
  return entries.length === 0 ? tool : `${tool} with ${entries.map(([name, value]) => `${name}: ${valueText(value)}`).join(', ')}`
}

/**
案内 1 つをツールの呼び方にする。定義に無い path・入力名は TypeError
*/
export function formatHint(hint: Hint): string {
  if (hint.kind === 'command') return formatCommand(hint)
  if (hint.kind === 'input') assertInput(shapeOf(hint.path), hint.name)
  const name = hint.kind === 'input' ? hint.name : 'repo'
  return hint.value === undefined ? name : `${name}: ${valueText(hint.value)}`
}

export function formatHinted(text: string | HintedText): string {
  return typeof text === 'string' ? text : text.map(part => typeof part === 'string' ? part : formatHint(part)).join('')
}

function isHintedText(value: unknown): value is HintedText {
  return Array.isArray(value) && value.every((part: unknown) => typeof part === 'string' || isHint(part))
}

/**
例外が持つ案内（hintedText）。無ければ undefined
*/
export function hintedTextOf(error: unknown): HintedText | undefined {
  if (typeof error !== 'object' || error === null || !('hintedText' in error)) return undefined
  const { hintedText } = error
  return isHintedText(hintedText) ? hintedText : undefined
}
