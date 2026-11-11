import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { describeTitleConfig, describeTitleRule } from '../src/eslint/describe-title.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'describe-title')
const GENERATED = path.join(FIXTURES, 'generated.json')
const SECOND = path.join(FIXTURES, 'second.json')
const RULE_FILE = path.join(import.meta.dirname, '..', 'src', 'eslint', 'describe-title.ts')

const UNLISTED = 'unlisted'
const NOT_LITERAL = 'notLiteral'
const options = [{ definitions: [GENERATED] }]

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

ruleTester.run('describe-title', describeTitleRule, {
  valid: [
    { code: 'describe(\'alpha_tool\', () => {})', options },
    { code: 'describe(\'beta tool\', () => { it(\'x\', () => {}) })', options },
    { code: 'it(\'値を比べると、等しい\', () => {})', options },
    { code: 'const value = 1', options },
    // 入れ子の describe は見ない
    { code: 'describe(\'alpha_tool\', () => { describe(\'unknown\', () => {}) })', options },
    // 関数の中の describe は見ない
    { code: 'function run() { describe(\'unknown\', () => {}) }', options },
    { code: 'describe(\'gamma_tool\', () => {})', options: [{ definitions: [GENERATED, SECOND] }] },
    { code: 'describe.skipIf(process.env.CI)(\'alpha_tool\', () => {})', options },
    { code: 'describe(`alpha_tool`, () => {})', options },
    // 別名は追わない
    { code: 'd(\'unknown\', () => {})', options },
    // 呼び出しの根が describe でも suite でもない
    { code: 'other.describe(\'unknown\', () => {})', options },
    { code: 'foo(\'unknown\')(\'x\')', options },
    { code: 'foo`unknown`(\'x\')', options },
    { code: '(() => {})(\'unknown\')', options },
  ],
  invalid: [
    {
      code: 'describe(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'describe.skip(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'describe.only.skip(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'suite(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'const title = "alpha_tool"\ndescribe(title, () => {})',
      options,
      errors: [{ messageId: NOT_LITERAL, line: 2 }],
    },
    {
      code: 'describe(`${prefix}alpha_tool`, () => {})',
      options,
      errors: [{ messageId: NOT_LITERAL }],
    },
    {
      code: 'describe(() => {})',
      options,
      errors: [{ messageId: NOT_LITERAL }],
    },
    {
      code: 'describe.each([1, 2])(\'%s\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: '%s' } }],
    },
    {
      code: 'describe.for([1, 2])(\'alpha_tool %s\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'alpha_tool %s' } }],
    },
    {
      code: 'describe.skipIf(flag)(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'describe`alpha_tool`(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      code: 'describe(\'alpha_tool\', () => {})',
      options: [{ definitions: [] }],
      errors: [{ messageId: UNLISTED, data: { title: 'alpha_tool' } }],
    },
    {
      code: 'describe(\'gamma_tool\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'gamma_tool' } }],
    },
    {
      code: 'describe(\'x\', () => {})\ndescribe(\'y\', () => {})',
      options,
      errors: [
        { messageId: UNLISTED, data: { title: 'x' }, line: 1 },
        { messageId: UNLISTED, data: { title: 'y' }, line: 2 },
      ],
    },
  ],
})

const typedTester = new RuleTester({
  languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
})

typedTester.run('describe-title の typescript-eslint の parser', describeTitleRule, {
  valid: [{ code: 'const n: number = 1\ndescribe(\'alpha_tool\', () => {})', options }],
  invalid: [
    {
      code: 'const n: number = 1\ndescribe(\'unknown\', (): void => { const m = n as number })',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
  ],
})

describe('describeTitleConfig', () => {
  it('定義書のパスを rules の options に渡した flat config のブロックを返す', () => {
    const block = describeTitleConfig([GENERATED])
    expect(block.files).toEqual(['tests/interface/**/*.ts'])
    expect(block.rules).toEqual({ 'interface-spec/describe-title': ['error', { definitions: [GENERATED] }] })
    expect(block.plugins['interface-spec'].rules['describe-title']).toBe(describeTitleRule)
  })

  it('定義書が無いパスを渡すと、パスを添えて throw する', () => {
    const missing = path.join(FIXTURES, 'missing.json')
    expect(() => describeTitleConfig([missing])).toThrow(missing)
  })

  it('定義書が JSON でないと、パスを添えて throw する', () => {
    const file = path.join(FIXTURES, 'invalid.json')
    expect(() => describeTitleConfig([file])).toThrow(file)
  })

  it('entries の形が違う定義書を渡すと、パスを添えて throw する', () => {
    const file = path.join(FIXTURES, 'bad-entries.json')
    expect(() => describeTitleConfig([file])).toThrow(file)
  })

  it('定義書を渡さなくても throw しない', () => {
    expect(describeTitleConfig([]).rules['interface-spec/describe-title']).toEqual(['error', { definitions: [] }])
  })
})

describe('規則のファイル', () => {
  it('子プロセスの node が、型を除去して import できる', () => {
    const url = pathToFileURL(RULE_FILE).href
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.describeTitleConfig)`],
      { encoding: 'utf8' },
    )
    expect(output.trim()).toBe('function')
  })
})
