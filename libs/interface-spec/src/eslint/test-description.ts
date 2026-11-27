// it・test の本体が、先頭で explains を呼んで説明を持つかを確かめる eslint の規則。
// eslint.config.js が Node の型の除去で直に読むので、相対の値の import を持たない。
import { readFileSync } from 'node:fs'
import type { Rule } from 'eslint'

type Expression = Extract<Rule.Node, { type: 'MemberExpression' }>['object']
type Argument = Extract<Rule.Node, { type: 'CallExpression' }>['arguments'][number]
type Statement = Extract<Rule.Node, { type: 'BlockStatement' }>['body'][number]

const CONVENTION = '.claude/rules/test-conventions.md'
const ROOT_NAMES: ReadonlySet<string> = new Set(['it', 'test'])
// テストを作らない呼び出し。todo は本体を持たず、ほかはフックと test の拡張。
const SKIPPED_METHODS: ReadonlySet<string> = new Set(['todo', 'extend', 'scoped', 'override', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'])
const LEADING_CALLS: ReadonlySet<string> = new Set(['verifies', 'explains'])

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

// callee の根の名前と、途中に出てくるプロパティの名前。
function chainOf(start: Expression): { root: string | undefined, methods: string[] } {
  const methods: string[] = []
  let current = start
  for (;;) {
    if (current.type === 'Identifier') return { root: current.name, methods }
    if (current.type === 'MemberExpression' && current.property.type === 'Identifier' && !current.computed) methods.push(current.property.name)
    const next = inner(current)
    if (next === undefined) return { root: undefined, methods }
    current = next
  }
}

function isFunction(argument: Argument): argument is Extract<Argument, { type: 'ArrowFunctionExpression' | 'FunctionExpression' }> {
  return argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression'
}

// `await name(…)` か `name(…)` の文なら、その呼び出しを返す。
function calledIn(statement: Statement): { name: string, isAwaited: boolean, call: Extract<Expression, { type: 'CallExpression' }> } | undefined {
  if (statement.type !== 'ExpressionStatement') return undefined
  const isAwaited = statement.expression.type === 'AwaitExpression'
  const expression = statement.expression.type === 'AwaitExpression' ? statement.expression.argument : statement.expression
  return expression.type === 'CallExpression' && expression.callee.type === 'Identifier' ? { name: expression.callee.name, isAwaited, call: expression } : undefined
}

function isTextArgument(argument: Argument | undefined): boolean {
  return argument?.type === 'Literal' ? typeof argument.value === 'string' && argument.value.trim() !== '' : argument?.type === 'TemplateLiteral' && argument.quasis.some(quasi => quasi.value.raw.trim() !== '')
}

export const testDescriptionRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing: `テストの本体の先頭で await explains('…') を呼んでいない（${CONVENTION}）`,
      duplicated: `explains を 2 回以上呼んでいる（${CONVENTION}）`,
      notText: `explains に、空でない文字列かテンプレートリテラルを渡していない（${CONVENTION}）`,
      notLeading: `explains を、本体の先頭の verifies・explains の並びの外で呼んでいる（${CONVENTION}）`,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // `it.each(rows)(題, 本体)` の内側の `it.each(rows)` は、テストを作る呼び出しでない。
        if (node.parent.type === 'CallExpression' && node.parent.callee === node) return
        const { root, methods } = chainOf(node.callee)
        if (root === undefined || !ROOT_NAMES.has(root) || methods.some(method => SKIPPED_METHODS.has(method))) return
        // 本体は引数の中の最後の関数式。`test(題, options, 本体)` と `test(題, 本体, timeout)` の形がある。
        const body = node.arguments.findLast(argument => isFunction(argument))
        if (body === undefined) return
        if (body.body.type !== 'BlockStatement') {
          context.report({ node, messageId: 'missing' })
          return
        }
        const statements = body.body.body
        let leading = 0
        while (leading < statements.length) {
          const statement = statements[leading]
          const called = statement === undefined ? undefined : calledIn(statement)
          if (called === undefined || !called.isAwaited || !LEADING_CALLS.has(called.name)) break
          leading += 1
        }
        const explained = statements.slice(0, leading).map(statement => calledIn(statement)).filter(called => called?.name === 'explains')
        for (const statement of statements.slice(leading)) {
          if (calledIn(statement)?.name === 'explains') context.report({ node: statement, messageId: 'notLeading' })
        }
        const [first, ...rest] = explained
        if (first === undefined) {
          context.report({ node, messageId: 'missing' })
          return
        }
        if (rest.length > 0) context.report({ node, messageId: 'duplicated' })
        if (!isTextArgument(first.call.arguments[0])) context.report({ node: first.call, messageId: 'notText' })
      },
    }
  },
}

export const testDescriptionPlugin = {
  meta: { name: 'test-description', version: readVersion(), namespace: 'test-description' },
  rules: { required: testDescriptionRule },
}

export interface TestDescriptionConfig {
  files: string[]
  plugins: { 'test-description': typeof testDescriptionPlugin }
  rules: { 'test-description/required': 'error' }
}

// テストのファイルに当てる flat config のブロックを返す。files は、各 project の vitest の規則と同じ範囲を渡す。
export function testDescriptionConfig(files: readonly string[]): TestDescriptionConfig {
  return {
    files: [...files],
    plugins: { 'test-description': testDescriptionPlugin },
    rules: { 'test-description/required': 'error' },
  }
}
