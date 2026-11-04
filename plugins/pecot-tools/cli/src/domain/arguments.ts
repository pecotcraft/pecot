// 入力の検証と awscli 引数配列の組み立て。
//
// shell を介さず spawn するため、利用者の値は必ず 1 要素 1 値で配列へ入れる。
// 値が '-' で始まると awscli の引数解析でオプションと解釈され得るので、原則として先頭 '-' を
// 拒否する（research R3）。例外はフラグで渡す 1 値の string だけで、こちらは
// `--flag=value` の 1 トークン形にして渡す（doesAllowLeadingDash / flagTokens）。
//
// shorthand-list（`--dimensions` / `--filters` / `--image-ids`）は JSON.stringify で 1 トークンに
// する。awscli はこれらのフラグを shorthand と JSON の双方で受ける。
// JSON を選べば区切り文字の解釈がエスケープに閉じ、利用者の値が構文へ漏れる余地が無くなる（`,` を含むタグ値も渡せる）。

import { PROFILE_INPUT, REGION_INPUT, type AllowlistEntry, type InputSpec } from './allowlist.js'
import { validateLocalPath, validateS3ListUri, validateS3Uri } from './s3-input.js'

/**
shorthand の構成要素の値に混入すると構文として解釈される文字。

awscli の shorthand は `Key=value,Key=value` の書式。
構成要素の値に `,` や `=` を含めると、契約に無いキー（`ExpectedBucketOwner` 等）を後ろに足せる。
実 awscli が受理することを動作確認済みなので、組み立て前に弾く。対象は文字列を連結する `shorthand`（Athena / ECR の
`--filter`）だけで、JSON で組み立てる `shorthand-list` には要らない。
*/
const SHORTHAND_SYNTAX = /[,={}]/

/**
制御文字（U+0000〜U+001F と U+007F）を含むか。

argv に NUL を載せると spawn が同期 throw し、ExecutionResult を伴わない応答になる。
他の制御文字も awscli の解釈が値ごとに変わるため、検証の段階で invalid-input にする。
*/
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7F || code <= 0x1F) return true
  }
  return false
}

/**
共通入力として末尾で付与するフラグ。

エントリ側が同じフラグを inputs に宣言していても、付与箇所は末尾の 1 本に絞る
（フラグ列挙でも出すと `--profile x --profile x` が並ぶ）。
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
値の先頭 '-' を許す入力か。

対象はフラグで渡す `kind: 'string'` の 1 値だけ。CloudWatch Logs の除外パターン（`-INFO`）の
ように、先頭 '-' に意味を持つ値が実在する。
実 awscli 2.36.40 では `--filter-pattern=-INFO` が受理される（`--filter-pattern -INFO` は 252）。組み立ては buildArguments が
`--flag=value` の 1 トークン形で行うため、オプション注入にはならない。

string-list は nargs が貪欲で、1 トークン形へ畳めない。
位置引数には `--flag=value` の逃がし先が無い。
そのため、いずれも従来どおり拒否する（enum は許容値が許可リストの静的宣言なので、
そもそも利用者の値が本判定に届かない）。
*/
function doesAllowLeadingDash(spec: Readonly<InputSpec>): boolean {
  return spec.kind === 'string' && spec.awsFlag !== undefined && spec.positional === undefined
}

/**
string 系 1 値の検証。制御文字・先頭 '-' 拒否と kind 固有の書式を見る。
*/
function validateStringValue(spec: Readonly<InputSpec>, value: string): InvalidInput | undefined {
  if (hasControlCharacter(value)) {
    return invalid(`${spec.name} は制御文字を含まない値で指定してください`)
  }
  if (value.startsWith('-') && !doesAllowLeadingDash(spec)) {
    return invalid(`${spec.name} の値は '-' で始められません: ${value}`)
  }
  const predicate = kindPredicate(spec.kind, value)
  if (predicate !== undefined) {
    return invalid(`${spec.name} ${predicate}: ${value}`)
  }
  if (spec.pattern !== undefined && !spec.pattern.test(value)) {
    return invalid(`${spec.name} の形式が不正です: ${value}`)
  }
  return undefined
}

/**
shorthand の構成要素として載る値を検証する。

shorthand 自身は入力レコードから読まない（利用者は指定できない）。見るのは構成要素の
取得元入力の値だけで、取得元自体の型・書式は通常の入力として別途検証されている。
*/
function validateShorthandParts(
  spec: Readonly<InputSpec>,
  input: Readonly<Record<string, unknown>>,
): InvalidInput | undefined {
  const declaredParts = spec.parts ?? []
  for (const part of declaredParts) {
    const value = readInput(input, part.from)
    if (typeof value === 'string' && SHORTHAND_SYNTAX.test(value)) {
      return invalid(`${part.from} に , = { } は含められません: ${value}`)
    }
  }
  return undefined
}

/**
shorthand-list の構成要素の値 1 つずつを検証する。

区切り文字（`, = { }`）は見ない。組み立てが JSON.stringify で、値はエスケープされて JSON の
文字列リテラルに収まるため、要素の中へ契約外のキーを足す手段が無い。
空文字は awscli が空値として解釈するので弾く。制御文字は spawn へ届く前にここで拒否する。
*/
function validateElementTexts(
  spec: Readonly<InputSpec>,
  field: string,
  texts: readonly string[],
): InvalidInput | undefined {
  for (const text of texts) {
    if (text === '') return invalid(`${spec.name} の ${field} に空文字は指定できません`)
    if (hasControlCharacter(text)) {
      return invalid(`${spec.name} の ${field} は制御文字を含まない値で指定してください`)
    }
  }
  return undefined
}

/**
shorthand-list の要素 1 件を検証する。

値を持つ構成要素が 1 つも無い要素は拒否する。`--filters` に空の要素を渡すと awscli が
空トークンを受け取り、意図しない絞り込みになるため。
*/
function validateShorthandListElement(
  spec: Readonly<InputSpec>,
  element: Readonly<Record<string, unknown>>,
): InvalidInput | undefined {
  const parts = spec.elements ?? []

  /* c8 ignore start -- inputSchema の z.strictObject が入力検証エラーで先に落とすため到達しない（二重防御） */
  for (const key of Object.keys(element)) {
    if (parts.every(part => part.field !== key)) {
      return invalid(`${spec.name} の要素に指定できないキーです: ${key}`)
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
        return invalid(`${spec.name} の ${part.field} は文字列の配列で指定してください`)
      }
      if (value.length === 0) {
        return invalid(`${spec.name} の ${part.field} は 1 つ以上の値で指定してください`)
      }
      texts = value
    }
    else {
      if (typeof value !== 'string') {
        return invalid(`${spec.name} の ${part.field} は文字列で指定してください`)
      }
      texts = [value]
    }
    const rejected = validateElementTexts(spec, part.field, texts)
    if (rejected !== undefined) return rejected
    filled += 1
  }

  return filled === 0 ? invalid(`${spec.name} の要素は ${parts.map(part => part.field).join(' / ')} のいずれかで指定してください`) : undefined
}

/**
shorthand-list の値（オブジェクトの配列）を検証する。
*/
function validateShorthandList(
  spec: Readonly<InputSpec>,
  value: unknown,
): InvalidInput | undefined {
  if (!Array.isArray(value)) return invalid(`${spec.name} はオブジェクトの配列で指定してください`)
  for (const element of value) {
    if (!isElementRecord(element)) {
      return invalid(`${spec.name} の要素はオブジェクトで指定してください`)
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
      return typeof value === 'string' ? validateStringValue(spec, value) : invalid(`${spec.name} は文字列で指定してください`)
    }
    case 'string-list': {
      if (!isStringArray(value)) return invalid(`${spec.name} は文字列の配列で指定してください`)
      for (const element of value) {
        const rejected = validateStringValue(spec, element)
        if (rejected !== undefined) return rejected
        // 列挙を持つ string-list（--statistics 等）は要素ごとに比較する。awscli は列挙を
        // クライアント側で検証しないため、ここを抜くと綴り違いがそのまま API へ届く。
        if (spec.values !== undefined && !spec.values.includes(element)) {
          return invalid(`${spec.name} に指定できない値です: ${element}`)
        }
      }
      return undefined
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return invalid(`${spec.name} は整数で指定してください`)
      }
      if (spec.min !== undefined && value < spec.min) {
        return invalid(`${spec.name} は ${String(spec.min)} 以上で指定してください: ${String(value)}`)
      }
      if (spec.max !== undefined && value > spec.max) {
        return invalid(`${spec.name} は ${String(spec.max)} 以下で指定してください: ${String(value)}`)
      }
      return undefined
    }
    case 'boolean': {
      return typeof value === 'boolean' ? undefined : invalid(`${spec.name} は true / false で指定してください`)
    }
    case 'enum': {
      if (typeof value !== 'string') return invalid(`${spec.name} は文字列で指定してください`)
      if (spec.values?.includes(value) !== true) {
        return invalid(`${spec.name} に指定できない値です: ${value}`)
      }
      return undefined
    }
    case 'shorthand-list': {
      return validateShorthandList(spec, value)
    }
    /* c8 ignore start -- shorthand は validateInput が先に分岐するため到達しない。switch の網羅性のために置く */
    case 'shorthand': {
      return invalid(`${spec.name} は直接指定できません`)
    }
    /* c8 ignore stop */
  }
}

/**
入力を検証する。問題があれば invalid-input を、無ければ undefined を返す。

profile / region も同じ処理で検証する（別扱いにすると書式検証が抜ける）。
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
      if (spec.required) return invalid(`${spec.name} は必須です`)
      continue
    }
    const rejected = validateValue(spec, value)
    if (rejected !== undefined) return rejected
  }

  const exclusiveGroups = entry.exclusive ?? []
  for (const group of exclusiveGroups) {
    const specified = group.filter(name => readInput(input, name) !== undefined)
    if (specified.length > 1) {
      return invalid(`${specified.join(' と ')} は同時に指定できません`)
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
shorthand フラグに載せる `Key=value,…` を組み立てる。

値を持つ構成要素だけを並べ、1 つも無ければ undefined（= フラグごと省く）。
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
shorthand-list フラグに載せる JSON 1 トークンを組み立てる。

配列全体が `[{"Name":"…","Value":"…"}]` の 1 トークンになり、`list` の構成要素は JSON の配列のまま載せる。
値を持つ構成要素が無い要素は落とす。要素が 1 つも残らなければ undefined
（= フラグごと省く）。
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
フラグ 1 つ分のトークン列。値が '-' で始まる string のときだけ `--flag=value` の 1 トークンにする。

別トークンで渡すと awscli の argparse が値をオプションとして読む。`=` 連結は shell を
介さない配列渡しなので、別トークンへ割れることも別コマンドへ委譲されることも無い。
*/
function flagTokens(flag: string, value: InputValue): string[] {
  return typeof value === 'string' && value.startsWith('-') ? [`${flag}=${value}`] : [flag, ...valueTexts(value)]
}

/**
awscli へ渡す引数配列を組み立てる。

並びは `<service> <subcommand> <位置引数…> <フラグ…> --output json --no-cli-pager
--profile <p> --region <r>`。位置引数を先・フラグを後に置くと、string-list（nargs が貪欲）と
位置引数が同居しても awscli v2 の argparse が取り違えない（動作確認済み）。

`--no-cli-pager` は jsonOutput の有無に依らず常に付ける（非 tty では無害で、分岐を持たない方が単純）。

`--profile` / `--region` は末尾で 1 度だけ付ける。エントリ側が inputs に同名を宣言していても
フラグ列挙では飛ばす。

値が '-' で始まる string は `--flag=value` の 1 トークンにする（flagTokens）。
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
