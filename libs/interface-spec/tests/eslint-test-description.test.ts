import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { testDescriptionConfig, testDescriptionPlugin, testDescriptionRule } from '../src/eslint/test-description.js'
import { explains } from '../src/vitest/explains.js'
import { useExplainedRuleTester } from '../src/vitest/rule-tester.js'

useExplainedRuleTester(RuleTester)

const RULE_FILE = path.join(import.meta.dirname, '..', 'src', 'eslint', 'test-description.ts')
const PACKAGE_JSON = path.join(import.meta.dirname, '..', 'package.json')

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

ruleTester.run('test-description', testDescriptionRule, {
  valid: [
    { name: '本体の先頭で説明を渡すテストは止めない', code: 'it(\'t\', async () => { await explains(\'説明です。\'); run() })' },
    { name: 'verifies の後ろで説明を渡すテストは止めない', code: 'it(\'t\', async (ctx) => { await verifies(ctx, \'X-01\'); await explains(\'説明です。\'); run() })' },
    { name: '説明の後ろに verifies があっても止めない', code: 'it(\'t\', async (ctx) => { await explains(\'説明です。\'); await verifies(ctx, \'X-01\') })' },
    { name: 'テンプレートリテラルで行の値を埋めた説明は止めない', code: 'it.for(rows)(\'$name\', async (row) => { await explains(`${row.name} を確認します。`) })' },
    { name: 'test と function 式の本体も読む', code: 'test(\'t\', async function () { await explains(\'説明です。\') })' },
    { name: 'options が先にある呼び方でも、最後の関数式を本体とする', code: 'it(\'t\', { timeout: 1 }, async () => { await explains(\'説明です。\') })' },
    { name: 'timeout が後ろにある呼び方でも、関数式を本体とする', code: 'it(\'t\', async () => { await explains(\'説明です。\') }, 1000)' },
    { name: 'skipIf で修飾したテストも、説明があれば止めない', code: 'it.skipIf(cond)(\'t\', async () => { await explains(\'説明です。\') })' },
    { name: '本体の無い todo は見ない', code: 'it.todo(\'t\')' },
    { name: 'test.extend は、テストを作らないので見ない', code: 'const test2 = test.extend({ x: async ({}, use) => { await use(1) } })' },
    { name: '本体が関数式でないテストは見ない', code: 'it(\'t\', run)' },
    { name: 'it と test 以外の呼び出しは見ない', code: 'describe(\'d\', () => { run() })' },
  ],
  invalid: [
    { name: '説明の無いテストを止める', code: 'it(\'t\', () => { run() })', errors: [{ messageId: 'missing' }] },
    { name: '本体が式のアロー関数は、説明を持てないので止める', code: 'it(\'t\', () => run())', errors: [{ messageId: 'missing' }] },
    { name: 'options が先にある呼び方で、説明が無ければ止める', code: 'it(\'t\', { timeout: 1 }, async () => { run() })', errors: [{ messageId: 'missing' }] },
    { name: 'timeout が後ろにある呼び方で、説明が無ければ止める', code: 'it(\'t\', async () => { run() }, 1000)', errors: [{ messageId: 'missing' }] },
    { name: 'each で回すテストも、説明が無ければ止める', code: 'it.each(rows)(\'%s\', () => { run() })', errors: [{ messageId: 'missing' }] },
    { name: 'concurrent で修飾したテストも、説明が無ければ止める', code: 'test.concurrent(\'t\', async () => { run() })', errors: [{ messageId: 'missing' }] },
    { name: 'await の無い説明は先頭の並びと見なさず、止める', code: 'it(\'t\', async () => { explains(\'説明です。\') })', errors: [{ messageId: 'missing' }, { messageId: 'notLeading' }] },
    { name: '先頭の並びの外で渡した説明を止める', code: 'it(\'t\', async () => { run(); await explains(\'説明です。\') })', errors: [{ messageId: 'missing' }, { messageId: 'notLeading' }] },
    { name: '説明を 2 回渡すテストを止める', code: 'it(\'t\', async () => { await explains(\'1 つ目です。\'); await explains(\'2 つ目です。\') })', errors: [{ messageId: 'duplicated' }] },
    { name: '変数で渡した説明を止める', code: 'it(\'t\', async () => { await explains(text) })', errors: [{ messageId: 'notText' }] },
    { name: '空の文字列の説明を止める', code: 'it(\'t\', async () => { await explains(\'  \') })', errors: [{ messageId: 'notText' }] },
    { name: '入れ子の describe の中のテストも止める', code: 'describe(\'d\', () => { describe(\'e\', () => { it(\'t\', () => {}) }) })', errors: [{ messageId: 'missing' }] },
  ],
})

const typedTester = new RuleTester({ languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' } })

typedTester.run('test-description の typescript-eslint の parser', testDescriptionRule, {
  valid: [{ name: '型引数の付いた for でも、説明があれば止めない', code: 'it.for<{ name: string }>(rows)(\'$name\', async () => { await explains(\'説明です。\') })' }],
  invalid: [{ name: '型引数の付いた for でも、説明が無ければ止める', code: 'it.for<{ name: string }>(rows)(\'$name\', () => {})', errors: [{ messageId: 'missing' }] }],
})

describe('testDescriptionConfig', () => {
  it('渡した files に、test-description/required を当てるブロックを返す', async () => {
    await explains('`testDescriptionConfig` が返す flat config のブロックのテストです。2 つの glob を渡した場合に、`files` が渡した順に並び、規則が error で有効になることを確認します。')
    const block = testDescriptionConfig(['src/**/tests/**/*.ts', '**/*.test.ts'])
    expect(block.files).toEqual(['src/**/tests/**/*.ts', '**/*.test.ts'])
    expect(block.rules).toEqual({ 'test-description/required': 'error' })
    expect(block.plugins['test-description'].rules.required).toBe(testDescriptionRule)
  })

  it('plugin が、名前と package.json の版を meta に持つ', async () => {
    await explains('plugin の `meta` のテストです。名前と namespace が `test-description` で、版が interface-spec の `package.json` の version と一致することを確認します。')
    const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    expect(packageJson).toMatchObject({ version: testDescriptionPlugin.meta.version })
    expect(testDescriptionPlugin.meta).toMatchObject({ name: 'test-description', namespace: 'test-description' })
  })
})

describe('規則のファイル', () => {
  it('子プロセスの node が、型を除去して import できる', async () => {
    await explains('`eslint.config.js` と同じく、子プロセスの node で規則の `.ts` を直接 import するテストです。型の除去だけで読み込め、`testDescriptionConfig` を関数として取得できることを確認します。')
    const url = pathToFileURL(RULE_FILE).href
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.testDescriptionConfig)`],
      { encoding: 'utf8' },
    )
    expect(output.trim()).toBe('function')
  })
})
