// 出力の文に添える、次に打つコマンドの案内。案内はコマンドの path と入力のデータで持ち、CLI の行か MCP のツールの呼び方にする。
// コマンドの形（位置引数・入力名）は commands/registry.ts が registerHintCommands で登録する。

/**
案内の出し先。cli は `pecot ...` の行、mcp はツール名と入力
*/
export type HintSurface = 'cli' | 'mcp'

/**
利用者が埋める値。CLI でも MCP でも `<NAME>` と出す
*/
export interface HintPlaceholder {
  readonly placeholder: string
}

export type HintValue = string | number | boolean | HintPlaceholder | readonly string[]

/**
コマンド 1 つの案内。input の並びは、位置引数の後ろのオプションの並びになる
*/
export interface CommandHint {
  readonly kind: 'command'
  readonly path: readonly string[]
  readonly input: Readonly<Record<string, HintValue>>
}

/**
入力 1 つだけの案内（`--allow-cross-repo` の形）
*/
export interface InputHint {
  readonly kind: 'input'
  readonly path: readonly string[]
  readonly name: string
  /**
  undefined なら名前だけ（CLI は `--host`、MCP は `host`）
  */
  readonly value: HintValue | undefined
}

/**
グローバルの repo の案内。どのコマンドでも同じ形なので path を持たない
*/
export interface GlobalRepositoryHint {
  readonly kind: 'global-repo'
  readonly value: HintValue | undefined
}

export type Hint = CommandHint | InputHint | GlobalRepositoryHint

/**
文字列と案内を並べた文。描くときに案内を出し先の形にする
*/
export type HintedText = readonly (string | Hint)[]

/**
コマンドの形。案内の検証と、CLI の位置引数の並びに使う
*/
export interface HintCommandShape {
  readonly path: readonly string[]
  readonly positional: readonly string[]
  readonly inputs: readonly string[]
  /**
  偽なら、入力 repo はグローバルの `--repo` で、CLI ではコマンド名の前に出す
  */
  readonly hasOwnRepo: boolean
}

const catalog = new Map<string, HintCommandShape>()

export function registerHintCommands(shapes: readonly HintCommandShape[]): void {
  for (const shape of shapes) catalog.set(shape.path.join(' '), shape)
}

export function commandHint(path: readonly string[], input: Readonly<Record<string, HintValue>> = {}): CommandHint {
  return { kind: 'command', path, input }
}

export function inputHint(path: readonly string[], name: string, value: HintValue = true): InputHint {
  return { kind: 'input', path, name, value }
}

/**
入力の名前だけの案内。`--host is required` の `--host`
*/
export function inputNameHint(path: readonly string[], name: string): InputHint {
  return { kind: 'input', path, name, value: undefined }
}

/**
グローバルの repo の案内。value が無ければ名前だけ（CLI は `--repo`、MCP は `repo`）
*/
export function globalRepositoryHint(value?: HintValue): GlobalRepositoryHint {
  return { kind: 'global-repo', value }
}

export function placeholder(name: string): HintPlaceholder {
  return { placeholder: name }
}

function isHint(value: unknown): value is Hint {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
タグ付きテンプレートで HintedText を作る。`hinted\`run: ${commandHint(['project', 'init'])}\``
*/
export function hinted(strings: TemplateStringsArray, ...values: readonly (string | number | Hint)[]): HintedText {
  return strings.flatMap((text, index): (string | Hint)[] => {
    const value = values.at(index)
    if (index >= values.length) return [text]
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
  const shape = catalog.get(path.join(' '))
  if (shape === undefined) throw new TypeError(`案内のコマンド '${path.join(' ')}' が定義に無い`)
  return shape
}

function assertInput(shape: HintCommandShape, name: string): void {
  // 自分の --repo を持たないコマンドの repo は、グローバルの --repo
  if (name === 'repo' && !shape.hasOwnRepo) return
  if (!shape.inputs.includes(name)) throw new TypeError(`案内の入力 '${name}' が '${shape.path.join(' ')}' の定義に無い`)
}

function isList(value: HintValue): value is readonly string[] {
  return Array.isArray(value)
}

function isPlaceholder(value: HintValue): value is HintPlaceholder {
  return typeof value === 'object' && !isList(value)
}

// シェルにそのまま渡せない値は、単一引用符で包む
function cliValue(value: string | number | HintPlaceholder): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') return `<${value.placeholder}>`
  return /^[\w./:@=+,-]+$/u.test(value) ? value : `'${value.replaceAll('\'', String.raw`'\''`)}'`
}

function mcpValue(value: HintValue): string {
  if (isPlaceholder(value)) return `<${value.placeholder}>`
  return typeof value === 'string' || isList(value) ? JSON.stringify(value) : String(value)
}

function flagOf(name: string): string {
  return `--${name.replaceAll('_', '-')}`
}

function cliOption(name: string, value: HintValue): readonly string[] {
  const flag = flagOf(name)
  if (typeof value === 'boolean') {
    if (!value) throw new TypeError(`案内の入力 '${name}' に false は出せない`)
    return [flag]
  }
  return isList(value) ? value.flatMap((item: string) => [flag, cliValue(item)]) : [flag, cliValue(value)]
}

function cliPositional(value: HintValue): readonly string[] {
  if (typeof value === 'boolean') throw new TypeError('位置引数に真偽値は出せない')
  return isList(value) ? value.map((item: string) => cliValue(item)) : [cliValue(value)]
}

function formatCommand(hint: CommandHint, surface: HintSurface): string {
  const shape = shapeOf(hint.path)
  const values = new Map(Object.entries(hint.input))
  const names = Object.keys(hint.input)
  for (const name of names) assertInput(shape, name)
  const ordered = [...shape.positional.filter(name => names.includes(name)), ...names.filter(name => !shape.positional.includes(name))]
  const valueOf = (name: string): HintValue => values.get(name) ?? ''
  if (surface === 'mcp') {
    const tool = hint.path.join('_')
    return ordered.length === 0 ? tool : `${tool} with ${ordered.map(name => `${name}: ${mcpValue(valueOf(name))}`).join(', ')}`
  }
  const globalRepository = !shape.hasOwnRepo && names.includes('repo') ? cliOption('repo', valueOf('repo')) : []
  const words = ordered.filter(name => globalRepository.length === 0 || name !== 'repo').flatMap(name =>
    shape.positional.includes(name) ? cliPositional(valueOf(name)) : cliOption(name, valueOf(name)))
  return ['pecot', ...globalRepository, ...hint.path, ...words].join(' ')
}

/**
案内 1 つを出し先の形にする。定義に無い path・入力名は TypeError
*/
export function formatHint(hint: Hint, surface: HintSurface): string {
  if (hint.kind === 'command') return formatCommand(hint, surface)
  if (hint.kind === 'input') assertInput(shapeOf(hint.path), hint.name)
  const name = hint.kind === 'input' ? hint.name : 'repo'
  const { value } = hint
  switch (surface) {
    case 'mcp': {
      return value === undefined ? name : `${name}: ${mcpValue(value)}`
    }
    case 'cli': {
      return value === undefined ? flagOf(name) : cliOption(name, value).join(' ')
    }
  }
}

export function formatHinted(text: string | HintedText, surface: HintSurface): string {
  return typeof text === 'string' ? text : text.map(part => typeof part === 'string' ? part : formatHint(part, surface)).join('')
}

function isHintedText(value: unknown): value is HintedText {
  return Array.isArray(value) && value.every((part: unknown) => typeof part === 'string' || isHint(part))
}

/**
例外が持つ案内（hintedText）。最上位はこれを出し先の形で描き直す。無ければ undefined
*/
export function hintedTextOf(error: unknown): HintedText | undefined {
  if (typeof error !== 'object' || error === null || !('hintedText' in error)) return undefined
  const { hintedText } = error
  return isHintedText(hintedText) ? hintedText : undefined
}
