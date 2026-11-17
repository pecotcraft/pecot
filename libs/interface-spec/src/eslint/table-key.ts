// 表を回すテストの題の `$キー` が、vitest にキーとして読める形かを確かめる eslint の規則。
// eslint.config.js が Node の型の除去で直に読むので、相対の値の import を持たない。
import { readFileSync } from 'node:fs'
import type { Rule } from 'eslint'

type Expression = Extract<Rule.Node, { type: 'MemberExpression' }>['object']

const CONVENTION = '.claude/rules/test-conventions.md'
const ROOT_NAMES: ReadonlySet<string> = new Set(['it', 'test', 'describe', 'suite'])
const TABLE_METHODS: ReadonlySet<string> = new Set(['each', 'for'])

// vitest 5 の formatTitle が `$` の後ろをキーとして読む範囲。ひらがな・漢字・`・`・`ー`・`$`・`.` も入る。
const KEY_PATTERN = /\$([$\p{ID_Continue}.]+)/gu
// 行のキーとして許す形。ASCII の識別子か数字を `.` でつないだもの。`$` は入れない。
const VALID_SEGMENT = /^(?:[a-z_]\w*|\d+)$/i

function isValidKey(key: string): boolean {
  return key.split('.').every(segment => VALID_SEGMENT.test(segment))
}

function readVersion(): string {
  const url = new URL('../../package.json', import.meta.url)
  const data: unknown = JSON.parse(readFileSync(url, 'utf8'))
  const version = typeof data === 'object' && data !== null && 'version' in data ? data.version : undefined
  if (typeof version !== 'string') throw new TypeError(`package.json に文字列の version が無い: ${url.pathname}`)
  return version
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

// `X.each(rows)` か `X.for(rows)` の呼び出しなら true。
function isTableCall(node: Expression): boolean {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false
  const property = node.callee.property
  return property.type === 'Identifier' && !node.callee.computed && TABLE_METHODS.has(property.name)
}

function readTitle(argument: Expression | { type: 'SpreadElement' } | undefined): string | undefined {
  if (argument?.type === 'Literal' && typeof argument.value === 'string') return argument.value
  if (argument?.type === 'TemplateLiteral' && argument.expressions.length === 0) {
    return argument.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return undefined
}

// 題の中で、キーとして読めない `$キー` を返す。
export function invalidKeys(title: string): string[] {
  const found: string[] = []
  for (const match of title.matchAll(KEY_PATTERN)) {
    const key = match[1] ?? ''
    if (!isValidKey(key)) found.push(key)
  }
  return found
}

export const tableKeyRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      invalidKey: `題の $'{{key}}' がキーとして読めない。$ の直後は空白・、・括弧にする（${CONVENTION}）`,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // 題を受ける呼び出しは `X.each(rows)(題)` の外側。callee が表の呼び出しのものだけを見る。
        if (!isTableCall(node.callee)) return
        const root = rootName(node.callee)
        if (root === undefined || !ROOT_NAMES.has(root)) return
        const title = readTitle(node.arguments[0])
        if (title === undefined) return
        for (const key of invalidKeys(title)) {
          context.report({ node, messageId: 'invalidKey', data: { key } })
        }
      },
    }
  },
}

export const tableKeyPlugin = {
  meta: { name: 'test-title', version: readVersion(), namespace: 'test-title' },
  rules: { 'table-key': tableKeyRule },
}

export interface TableKeyConfig {
  files: string[]
  plugins: { 'test-title': typeof tableKeyPlugin }
  rules: { 'test-title/table-key': 'error' }
}

// テストのファイルに当てる flat config のブロックを返す。files は、各 project の vitest の規則と同じ範囲を渡す。
export function tableKeyConfig(files: readonly string[]): TableKeyConfig {
  return {
    files: [...files],
    plugins: { 'test-title': tableKeyPlugin },
    rules: { 'test-title/table-key': 'error' },
  }
}
