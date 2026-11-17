import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { invalidKeys, tableKeyConfig, tableKeyPlugin, tableKeyRule } from '../src/eslint/table-key.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const RULE_FILE = path.join(import.meta.dirname, '..', 'src', 'eslint', 'table-key.ts')
const PACKAGE_JSON = path.join(import.meta.dirname, '..', 'package.json')
const INVALID = 'invalidKey'

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

ruleTester.run('table-key', tableKeyRule, {
  valid: [
    { code: 'it.for(rows)(\'$name を渡すと、$expected を返す\', () => {})' },
    { code: 'it.for(rows)(\'$name、$expected\', () => {})' },
    { code: 'it.each(rows)(\'値（$name）を返す\', () => {})' },
    { code: 'it.each(rows)(\'$0 と $1 を足す\', () => {})' },
    { code: 'test.for(rows)(\'$input.path を読む\', () => {})' },
    { code: 'describe.each(rows)(\'$tool\', () => {})' },
    { code: 'it.for(rows)(\'%s を渡すと、%j を返す\', () => {})' },
    // ${} を含むテンプレートリテラルは、値が決まらないので見ない
    { code: 'it.for(rows)(`$name${suffix}だと`, () => {})' },
    // 表でない呼び出しは、vitest が $ を埋めないので見ない
    { code: 'it(\'$nameだと\', () => {})' },
    { code: 'other.for(rows)(\'$nameだと\', () => {})' },
    { code: 'it.for(rows)(title, () => {})' },
  ],
  invalid: [
    { code: 'it.for(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID, data: { key: 'nameだと' } }] },
    { code: 'it.each(rows)(\'$nameのとき、止まる\', () => {})', errors: [{ messageId: INVALID, data: { key: 'nameのとき' } }] },
    { code: 'it.for(rows)(\'値は $name.\', () => {})', errors: [{ messageId: INVALID, data: { key: 'name.' } }] },
    { code: 'it.for(rows)(\'$a..b を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: 'a..b' } }] },
    { code: 'it.for(rows)(\'$a・$b を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: 'a・$b' } }] },
    { code: 'it.for(rows)(\'$$a を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: '$a' } }] },
    { code: 'describe.for(rows)(\'$toolで\', () => {})', errors: [{ messageId: INVALID, data: { key: 'toolで' } }] },
    { code: 'suite.each(rows)(\'$toolで\', () => {})', errors: [{ messageId: INVALID, data: { key: 'toolで' } }] },
    { code: 'it.skipIf(c).for(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID }] },
    { code: 'test.concurrent.each(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID }] },
    { code: 'it.for(rows)(`$nameだと、止まる`, () => {})', errors: [{ messageId: INVALID }] },
    // 入れ子の describe の中と、関数の中も見る
    { code: 'describe(\'x\', () => { it.for(rows)(\'$nameだと\', () => {}) })', errors: [{ messageId: INVALID }] },
    { code: 'function run() { it.for(rows)(\'$nameだと\', () => {}) }', errors: [{ messageId: INVALID }] },
    {
      code: 'it.for(rows)(\'$nameだと $kindで\', () => {})',
      errors: [{ messageId: INVALID, data: { key: 'nameだと' } }, { messageId: INVALID, data: { key: 'kindで' } }],
    },
  ],
})

const typedTester = new RuleTester({ languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' } })

typedTester.run('table-key の typescript-eslint の parser', tableKeyRule, {
  valid: [{ code: 'it.for<{ name: string }>(rows)(\'$name を渡す\', () => {})' }],
  invalid: [{ code: 'it.for<{ name: string }>(rows)(\'$nameだと\', () => {})', errors: [{ messageId: INVALID }] }],
})

describe('invalidKeys', () => {
  it('キーとして読めない $キー だけを、出た順に返す', () => {
    expect(invalidKeys('$ok、$ngだと、$0、$x.')).toEqual(['ngだと', 'x.'])
  })
})

describe('tableKeyConfig', () => {
  it('渡した files に、test-title/table-key を当てるブロックを返す', () => {
    const block = tableKeyConfig(['src/**/tests/**/*.ts', '**/*.test.ts'])
    expect(block.files).toEqual(['src/**/tests/**/*.ts', '**/*.test.ts'])
    expect(block.rules).toEqual({ 'test-title/table-key': 'error' })
    expect(block.plugins['test-title'].rules['table-key']).toBe(tableKeyRule)
  })

  it('plugin が、名前と package.json の版を meta に持つ', () => {
    const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    expect(packageJson).toMatchObject({ version: tableKeyPlugin.meta.version })
    expect(tableKeyPlugin.meta).toMatchObject({ name: 'test-title', namespace: 'test-title' })
  })
})

describe('規則のファイル', () => {
  it('子プロセスの node が、型を除去して import できる', () => {
    const url = pathToFileURL(RULE_FILE).href
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.tableKeyConfig)`],
      { encoding: 'utf8' },
    )
    expect(output.trim()).toBe('function')
  })
})
