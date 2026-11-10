// 入力の検証と awscli 引数配列の組み立て。
// 先頭 '-' の値は原則拒否し、例外の string は `--flag=value` の 1 トークンで渡す（research R3）。

import { PROFILE_INPUT, REGION_INPUT, type AllowlistEntry, type InputSpec } from './allowlist.js'
import { validateLocalPath, validateS3ListUri, validateS3Uri } from './s3-input.js'

/**
shorthand の値に混入すると構文になる文字。`,` や `=` で契約外のキーを足せるため、組み立て前に弾く。
*/
const SHORTHAND_SYNTAX = /[,={}]/

/**
制御文字（U+0000〜U+001F と U+007F）を含むか。NUL は spawn が同期 throw するため、検証で弾く。
*/
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7F || code <= 0x1F) return true
  }
  return false
}

/**
共通入力として末尾で付与するフラグ。inputs 側の宣言と重複して並ばないよう、付与は末尾の 1 本に絞る。
*/
const COMMON_FLAGS: ReadonlySet<string> = new Set(
  [PROFILE_INPUT.awsFlag, REGION_INPUT.awsFlag].filter(flag => flag !== undefined),
)

/**
awscli の引数に載せられる値。検証を通った入力はこのいずれかになる。
*/
type InputValue = string | number | boolean | readonly string[]

/**
検証で弾いたときの戻り値。awscli は起動しない。
*/
export interface InvalidInput {
  readonly category: 'invalid-input'
  readonly message: string
}

/**
全エントリ共通の任意入力。指定時のみ awscli へ付与する。
*/
export interface CommonOptions {
  readonly profile?: string
  readonly region?: string
}

/**
検証対象の入力宣言。エントリ固有の入力に共通の profile / region を足したもの。
*/
function specsOf(entry: Readonly<AllowlistEntry>): readonly InputSpec[] {
  return [...entry.inputs, PROFILE_INPUT, REGION_INPUT]
}

function invalid(message: string): InvalidInput {
  return { category: 'invalid-input', message }
}

/**
入力レコードから 1 項目を読む。キーは許可リストの静的宣言に由来する。
*/
function readInput(input: Readonly<Record<string, unknown>>, name: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- name は AllowlistEntry の静的宣言由来で利用者入力ではない
  return input[name]
}

/**
shorthand-list の要素から構成要素 1 件を読む。キーは InputSpec.elements の静的宣言に由来する。
*/
function readElement(element: Readonly<Record<string, unknown>>, field: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- field は InputSpec.elements の静的宣言由来。利用者入力ではない
  return element[field]
}

/**
shorthand-list の要素になり得る値か。配列は要素として認めない。
*/
function isElementRecord(value: unknown): value is Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(element => typeof element === 'string')
}

function isInputValue(value: unknown): value is InputValue {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || isStringArray(value)
}

/**
kind 固有の書式検証。述部を返す関数は s3-input.ts が持つ（書式の定義を 1 箇所に置く）。
*/
function kindPredicate(kind: InputSpec['kind'], value: string): string | undefined {
  switch (kind) {
    case 'abs-path': {
      return validateLocalPath(value)
    }
    case 's3-uri': {
      return validateS3Uri(value)
    }
    case 's3-list-uri': {
      return validateS3ListUri(value)
    }
    case 'string':
    case 'string-list':
    case 'integer':
    case 'boolean':
    case 'enum': {
      return undefined
    }
    /* c8 ignore start -- shorthand 系は validateValue が先に分岐するため到達しない。switch の網羅性のために置く */
    case 'shorthand':
    case 'shorthand-list': {
      return undefined
    }
    /* c8 ignore stop */
  }
}

/**
値の先頭 '-' を許す入力か。対象はフラグで渡す string の 1 値だけで、`--flag=value` の 1 トークンで組み立てる。
*/
function doesAllowLeadingDash(spec: Readonly<InputSpec>): boolean {
  return spec.kind === 'string' && spec.awsFlag !== undefined && spec.positional === undefined
}

/**
string 系 1 値の検証。制御文字・先頭 '-' 拒否と kind 固有の書式を見る。
*/
function validateStringValue(spec: Readonly<InputSpec>, value: string): InvalidInput | undefined {
  if (hasControlCharacter(value)) {
    return invalid(`${spec.name} must not contain control characters`)
  }
  if (value.startsWith('-') && !doesAllowLeadingDash(spec)) {
    return invalid(`${spec.name} must not start with '-': ${value}`)
  }
  const predicate = kindPredicate(spec.kind, value)
  if (predicate !== undefined) {
    return invalid(`${spec.name} ${predicate}: ${value}`)
  }
  if (spec.pattern !== undefined && !spec.pattern.test(value)) {
    return invalid(`${spec.name} has an invalid format: ${value}`)
  }
  return undefined
}

/**
shorthand の構成要素の値を検証する。shorthand 自身は読まず、取得元入力の値だけを見る。
*/
function validateShorthandParts(
  spec: Readonly<InputSpec>,
  input: Readonly<Record<string, unknown>>,
): InvalidInput | undefined {
  const declaredParts = spec.parts ?? []
  for (const part of declaredParts) {
    const value = readInput(input, part.from)
    if (typeof value === 'string' && SHORTHAND_SYNTAX.test(value)) {
      return invalid(`${part.from} must not contain , = { }: ${value}`)
    }
  }
  return undefined
}

/**
shorthand-list の構成要素の値を検証する。JSON.stringify がエスケープするので、区切り文字は見ない。
*/
function validateElementTexts(
  spec: Readonly<InputSpec>,
  field: string,
  texts: readonly string[],
): InvalidInput | undefined {
  for (const text of texts) {
    if (text === '') return invalid(`${spec.name} ${field} must not be empty`)
    if (hasControlCharacter(text)) {
      return invalid(`${spec.name} ${field} must not contain control characters`)
    }
  }
  return undefined
}

/**
shorthand-list の要素 1 件を検証する。値を持つ構成要素が無い要素は、意図しない絞り込みになるので拒否する。
*/
function validateShorthandListElement(
  spec: Readonly<InputSpec>,
  element: Readonly<Record<string, unknown>>,
): InvalidInput | undefined {
  const parts = spec.elements ?? []

  /* c8 ignore start -- inputSchema の z.strictObject が入力検証エラーで先に落とすため到達しない（二重防御） */
  for (const key of Object.keys(element)) {
    if (parts.every(part => part.field !== key)) {
      return invalid(`${spec.name} element has an unsupported key: ${key}`)
    }
  }
  /* c8 ignore stop */

  let filled = 0
  for (const part of parts) {
    const value = readElement(element, part.field)
    if (value === undefined) continue

    let texts: readonly string[]
    if (part.list === true) {
      if (!isStringArray(value)) {
        return invalid(`${spec.name} ${part.field} must be an array of strings`)
      }
      if (value.length === 0) {
        return invalid(`${spec.name} ${part.field} must have at least one value`)
      }
      texts = value
    }
    else {
      if (typeof value !== 'string') {
        return invalid(`${spec.name} ${part.field} must be a string`)
      }
      texts = [value]
    }
    const rejected = validateElementTexts(spec, part.field, texts)
    if (rejected !== undefined) return rejected
    filled += 1
  }

  return filled === 0 ? invalid(`${spec.name} element must have at least one of ${parts.map(part => part.field).join(' / ')}`) : undefined
}

/**
shorthand-list の値（オブジェクトの配列）を検証する。
*/
function validateShorthandList(
  spec: Readonly<InputSpec>,
  value: unknown,
): InvalidInput | undefined {
  if (!Array.isArray(value)) return invalid(`${spec.name} must be an array of objects`)
  for (const element of value) {
    if (!isElementRecord(element)) {
      return invalid(`${spec.name} element must be an object`)
    }
    const rejected = validateShorthandListElement(spec, element)
    if (rejected !== undefined) return rejected
  }
  return undefined
}

function validateValue(spec: Readonly<InputSpec>, value: unknown): InvalidInput | undefined {
  switch (spec.kind) {
    case 'string':
    case 'abs-path':
    case 's3-uri':
    case 's3-list-uri': {
      return typeof value === 'string' ? validateStringValue(spec, value) : invalid(`${spec.name} must be a string`)
    }
    case 'string-list': {
      if (!isStringArray(value)) return invalid(`${spec.name} must be an array of strings`)
      for (const element of value) {
        const rejected = validateStringValue(spec, element)
        if (rejected !== undefined) return rejected
        // 列挙を持つ string-list（--statistics 等）は要素ごとに比較する。awscli は列挙を
        // クライアント側で検証しないため、ここを抜くと綴り違いがそのまま API へ届く。
        if (spec.values !== undefined && !spec.values.includes(element)) {
          return invalid(`${spec.name} has an unsupported value: ${element}`)
        }
      }
      return undefined
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return invalid(`${spec.name} must be an integer`)
      }
      if (spec.min !== undefined && value < spec.min) {
        return invalid(`${spec.name} must be at least ${String(spec.min)}: ${String(value)}`)
      }
      if (spec.max !== undefined && value > spec.max) {
        return invalid(`${spec.name} must be at most ${String(spec.max)}: ${String(value)}`)
      }
      return undefined
    }
    case 'boolean': {
      return typeof value === 'boolean' ? undefined : invalid(`${spec.name} must be true or false`)
    }
    case 'enum': {
      if (typeof value !== 'string') return invalid(`${spec.name} must be a string`)
      if (spec.values?.includes(value) !== true) {
        return invalid(`${spec.name} has an unsupported value: ${value}`)
      }
      return undefined
    }
    case 'shorthand-list': {
      return validateShorthandList(spec, value)
    }
    /* c8 ignore start -- shorthand は validateInput が先に分岐するため到達しない。switch の網羅性のために置く */
    case 'shorthand': {
      return invalid(`${spec.name} cannot be specified directly`)
    }
    /* c8 ignore stop */
  }
}

/**
入力を検証する。問題があれば invalid-input を、無ければ undefined を返す。profile / region も同じ処理で検証する。
*/
export function validateInput(
  entry: Readonly<AllowlistEntry>,
  input: Readonly<Record<string, unknown>>,
): InvalidInput | undefined {
  for (const spec of specsOf(entry)) {
    if (spec.kind === 'shorthand') {
      const rejected = validateShorthandParts(spec, input)
      if (rejected !== undefined) return rejected
      continue
    }

    const value = readInput(input, spec.name)
    if (value === undefined) {
      if (spec.required) return invalid(`${spec.name} is required`)
      continue
    }
    const rejected = validateValue(spec, value)
    if (rejected !== undefined) return rejected
  }

  const exclusiveGroups = entry.exclusive ?? []
  for (const group of exclusiveGroups) {
    const specified = group.filter(name => readInput(input, name) !== undefined)
    if (specified.length > 1) {
      return invalid(`${specified.join(' and ')} cannot be combined`)
    }
  }

  return undefined
}

/**
位置引数・フラグに載せる値を決める（未指定なら default）。
*/
function effectiveValue(
  spec: Readonly<InputSpec>,
  input: Readonly<Record<string, unknown>>,
): InputValue | undefined {
  const value = readInput(input, spec.name) ?? spec.default
  return isInputValue(value) ? value : undefined
}

/**
shorthand フラグに載せる `Key=value,…` を組み立てる。値を持つ構成要素が無ければ undefined（フラグごと省く）。
*/
function shorthandValue(
  spec: Readonly<InputSpec>,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const parts: string[] = []
  const shorthandParts = spec.parts ?? []
  for (const part of shorthandParts) {
    const value = readInput(input, part.from)
    if (typeof value === 'string') parts.push(`${part.key}=${value}`)
  }
  return parts.length === 0 ? undefined : parts.join(',')
}

/**
shorthand-list フラグに載せる JSON 1 トークンを組み立てる。要素が 1 つも残らなければ undefined。
*/
function shorthandListToken(
  spec: Readonly<InputSpec>,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = readInput(input, spec.name)
  if (!Array.isArray(value)) return undefined

  const elements: Record<string, string | readonly string[]>[] = []
  for (const element of value) {
    if (!isElementRecord(element)) continue
    // キーは elements の静的宣言由来。動的な代入を避けて entries から組む。
    const written: [string, string | readonly string[]][] = []
    const elementParts = spec.elements ?? []
    for (const part of elementParts) {
      const partValue = readElement(element, part.field)
      if (typeof partValue === 'string') written.push([part.key, partValue])
      else if (isStringArray(partValue) && partValue.length > 0) {
        written.push([part.key, [...partValue]])
      }
    }
    if (written.length > 0) elements.push(Object.fromEntries(written))
  }
  return elements.length === 0 ? undefined : JSON.stringify(elements)
}

/**
値を awscli の引数トークン列にする（string-list は 1 要素 1 トークン）。
*/
function valueTexts(value: InputValue): string[] {
  if (isStringArray(value)) return [...value]
  return [typeof value === 'string' ? value : String(value)]
}

/**
フラグ 1 つ分のトークン列。値が '-' で始まる string は、argparse の誤読を避けて `--flag=value` の 1 トークンにする。
*/
function flagTokens(flag: string, value: InputValue): string[] {
  return typeof value === 'string' && value.startsWith('-') ? [`${flag}=${value}`] : [flag, ...valueTexts(value)]
}

/**
awscli へ渡す引数配列を組み立てる。位置引数を先・フラグを後に置くと、nargs が貪欲な string-list と同居しても取り違えない。
*/
export function buildArguments(
  entry: Readonly<AllowlistEntry>,
  input: Readonly<Record<string, unknown>>,
  common: Readonly<CommonOptions> = {},
): string[] {
  const argv = [entry.service, entry.subcommand]

  const positionals = entry.inputs
    .filter(spec => spec.positional !== undefined)
    .toSorted((left, right) => (left.positional ?? 0) - (right.positional ?? 0))
  for (const spec of positionals) {
    const value = effectiveValue(spec, input)
    if (value !== undefined) argv.push(...valueTexts(value))
  }

  for (const spec of entry.inputs) {
    const flag = spec.awsFlag
    if ((flag === undefined) || COMMON_FLAGS.has(flag)) continue
    if (spec.kind === 'shorthand') {
      const shorthand = shorthandValue(spec, input)
      if (shorthand !== undefined) argv.push(flag, shorthand)
      continue
    }
    if (spec.kind === 'shorthand-list') {
      const listJson = shorthandListToken(spec, input)
      if (listJson !== undefined) argv.push(flag, listJson)
      continue
    }
    const value = effectiveValue(spec, input)
    if (value === undefined) continue
    if (spec.kind === 'boolean') {
      argv.push(value === true ? flag : `--no-${flag.slice(2)}`)
      continue
    }
    argv.push(...flagTokens(flag, value))
  }

  if (entry.jsonOutput) argv.push('--output', 'json')
  argv.push('--no-cli-pager')

  if (common.profile !== undefined) argv.push(...flagTokens('--profile', common.profile))
  if (common.region !== undefined) argv.push(...flagTokens('--region', common.region))

  return argv
}
