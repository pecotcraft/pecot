// tests/interface/ のテストで、いちばん外の describe の題が定義書の name にあるかを確かめる eslint の規則。
// 各 project の eslint.config.js が、この .ts を拡張子つきの相対パスで直に import する（Node の型の除去で読む）。
// 型の除去は .js を .ts に読み替えないので、相対の値の import は持たない（lint の no-restricted-imports と、子プロセスのテストで止める）。
import { readFileSync } from 'node:fs'
import type { Rule } from 'eslint'

type Expression = Extract<Rule.Node, { type: 'MemberExpression' }>['object']

const CONVENTION = '.claude/rules/test-conventions.md'
const ROOT_NAMES: ReadonlySet<string> = new Set(['describe', 'suite'])

// 定義書はパスごとに一度だけ読む。
const namesByPath = new Map<string, ReadonlySet<string>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNames(file: string): ReadonlySet<string> {
  const cached = namesByPath.get(file)
  if (cached) return cached
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`定義書を読めない: ${file}（${error instanceof Error ? error.message : String(error)}）`, { cause: error })
  }
  const entries = isRecord(data) ? data['entries'] : undefined
  if (!Array.isArray(entries)) throw new TypeError(`定義書の形が違う: ${file}（entries が配列でない）`)
  const names = new Set<string>()
  for (const entry of entries) {
    const name = isRecord(entry) ? entry['name'] : undefined
    if (typeof name !== 'string') throw new TypeError(`定義書の形が違う: ${file}（entries の要素に文字列の name が無い）`)
    names.add(name)
  }
  namesByPath.set(file, names)
  return names
}

// callee をたどる 1 歩。たどれない node は undefined。
function inner(node: Expression): Expression | undefined {
  if (node.type === 'MemberExpression') return node.object
  if (node.type === 'CallExpression') return node.callee
  if (node.type === 'TaggedTemplateExpression') return node.tag
  return undefined
}

function rootName(start: Expression): string | undefined {
  let current = start
  for (;;) {
    if (current.type === 'Identifier') return current.name
    const next = inner(current)
    if (next === undefined) return undefined
    current = next
  }
}

type Title = { kind: 'text', text: string } | { kind: 'dynamic' }

function readTitle(argument: Expression | { type: 'SpreadElement' } | undefined): Title {
  if (argument?.type === 'Literal' && typeof argument.value === 'string') return { kind: 'text', text: argument.value }
  if (argument?.type === 'TemplateLiteral' && argument.expressions.length === 0) {
    return { kind: 'text', text: argument.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('') }
  }
  return { kind: 'dynamic' }
}

export const describeTitleRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { definitions: { type: 'array', items: { type: 'string' } } },
        required: ['definitions'],
        additionalProperties: false,
      },
    ],
    messages: {
      unlisted: `describe の題 '{{title}}' が定義書の name に無い（${CONVENTION}）`,
      notLiteral: `describe の題が文字列のリテラルでない（${CONVENTION}）`,
    },
  },
  create(context) {
    // schema が形を検証済み。型のために狭める。
    const option: unknown = context.options[0]
    const definitions = isRecord(option) && Array.isArray(option['definitions']) ? option['definitions'] : []
    const names = new Set<string>()
    for (const file of definitions) {
      if (typeof file !== 'string') continue
      for (const name of readNames(file)) names.add(name)
    }
    return {
      CallExpression(node) {
        // プログラムの直下の式の文にある呼び出しだけを見る（入れ子と関数の中は見ない）。
        if (node.parent.type !== 'ExpressionStatement' || node.parent.parent.type !== 'Program') return
        const root = rootName(node.callee)
        if (root === undefined || !ROOT_NAMES.has(root)) return
        // describe.each(…)(…) のような呼び出しは、いちばん外の呼び出しの第 1 引数を題とする。
        const title = readTitle(node.arguments[0])
        if (title.kind === 'dynamic') {
          context.report({ node, messageId: 'notLiteral' })
        }
        else if (!names.has(title.text)) {
          context.report({ node, messageId: 'unlisted', data: { title: title.text } })
        }
      },
    }
  },
}

export const describeTitlePlugin = { rules: { 'describe-title': describeTitleRule } }

export interface DescribeTitleConfig {
  files: string[]
  plugins: { 'interface-spec': typeof describeTitlePlugin }
  rules: { 'interface-spec/describe-title': ['error', { definitions: string[] }] }
}

// tests/interface/ にだけ当てる flat config のブロックを返す。呼んだ時点で定義書を読み、読めなければパスを添えて throw する。
export function describeTitleConfig(definitions: readonly string[]): DescribeTitleConfig {
  for (const file of definitions) readNames(file)
  return {
    files: ['tests/interface/**/*.ts'],
    plugins: { 'interface-spec': describeTitlePlugin },
    rules: { 'interface-spec/describe-title': ['error', { definitions: [...definitions] }] },
  }
}
