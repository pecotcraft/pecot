// コマンドの入力（zod）から JSON Schema を作り、定義書（generated.json）と同じ形にそろえる。
// 定義書の書き出し（scripts/export-interface.ts）と、コマンドごとの --help が同じ関数を通す。
import { byName } from './names.js'

export type JsonObject = Readonly<Record<string, unknown>>

export interface InputSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, JsonObject>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

/**
引数の中のキーの順。ここに無いキーは後ろに、名前の順で付ける
*/
const SCHEMA_KEY_ORDER = ['type', 'items', 'enum', 'minimum', 'maximum', 'default', 'description']

/**
z.int() が付ける安全な整数の端
*/
const SAFE_INTEGER_EDGES = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])

/**
contracts の表に載せる type
*/
const TYPES = new Set(['string', 'integer', 'boolean', 'array'])

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keyRank(key: string): number {
  const index = SCHEMA_KEY_ORDER.indexOf(key)
  return index === -1 ? SCHEMA_KEY_ORDER.length : index
}

/**
引数 1 つの JSON Schema を、キーの順をそろえ、z.int() の端を外した形にする。
表に無いキーと type は、where を付けて例外で止める
*/
function normalizeProperty(schema: JsonObject, where: string): JsonObject {
  const entries = Object.entries(schema)
    .filter(([key, value]) => !(typeof value === 'number' && (key === 'minimum' || key === 'maximum') && SAFE_INTEGER_EDGES.has(value)))
    .map(([key, value]): [string, unknown] => {
      if (!SCHEMA_KEY_ORDER.includes(key)) throw new TypeError(`${where}: unsupported JSON Schema key ${key}`)
      if (key === 'type' && !(typeof value === 'string' && TYPES.has(value))) throw new TypeError(`${where}: unsupported type ${JSON.stringify(value)}`)
      return [key, key === 'items' && isRecord(value) ? normalizeProperty(value, where) : value]
    })
    .toSorted(([left], [right]) => keyRank(left) - keyRank(right))
  return Object.fromEntries(entries)
}

/**
グローバルの repo を除いて、input を正規化する。repo は defineCommand が足したもので、コマンド自身の引数ではない。
自分の `--repo` を持つコマンド（hasOwnRepo）の repo は、コマンド自身の引数なので残す
*/
export function normalizeInput(schema: JsonObject, command: string, isRepositoryKept: boolean): InputSchema {
  const { properties, required } = schema
  const isKept = (name: string): boolean => isRepositoryKept || name !== 'repo'
  const own = (isRecord(properties) ? Object.entries(properties) : []).filter(([name]) => isKept(name))
  const names = (Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []).filter(name => isKept(name))
  return {
    type: 'object',
    properties: Object.fromEntries(own.toSorted(([left], [right]) => byName(left, right)).map(([name, property]) => [name, normalizeProperty(isRecord(property) ? property : {}, `${command}: ${name}`)])),
    required: names.toSorted(byName),
    additionalProperties: false,
  }
}
