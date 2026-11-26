import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { attachOutput } from '../src/vitest/attach.js'
import { invalidKeys, tableKeyConfig, tableKeyPlugin, tableKeyRule } from '../src/eslint/table-key.js'
import { stepSync } from '../src/vitest/step.js'
import { useExplainedRuleTester } from '../src/vitest/rule-tester.js'
import { explains } from '../src/vitest/explains.js'

useExplainedRuleTester(RuleTester)

const RULE_FILE = path.join(import.meta.dirname, '..', 'src', 'eslint', 'table-key.ts')
const PACKAGE_JSON = path.join(import.meta.dirname, '..', 'package.json')
const INVALID = 'invalidKey'

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

ruleTester.run('table-key', tableKeyRule, {
  valid: [
    { name: 'キーの直後が空白と読点の題は止めない', code: 'it.for(rows)(\'$name を渡すと、$expected を返す\', () => {})' },
    { name: 'キーの直後が読点だけの題も止めない', code: 'it.for(rows)(\'$name、$expected\', () => {})' },
    { name: 'キーを全角の括弧で囲んだ題は止めない', code: 'it.each(rows)(\'値（$name）を返す\', () => {})' },
    { name: '位置を数字で指すキーは止めない', code: 'it.each(rows)(\'$0 と $1 を足す\', () => {})' },
    { name: 'ドットで深い所を指すキーは止めない', code: 'test.for(rows)(\'$input.path を読む\', () => {})' },
    { name: 'describe の表の題も、キーとして読めれば止めない', code: 'describe.each(rows)(\'$tool\', () => {})' },
    { name: 'キーを使わず % で値を埋める題は止めない', code: 'it.for(rows)(\'%s を渡すと、%j を返す\', () => {})' },
    // ${} を含むテンプレートリテラルは、値が決まらないので見ない
    { name: '値を埋めるテンプレートリテラルの題は見ない', code: 'it.for(rows)(`$name${suffix}だと`, () => {})' },
    // 表でない呼び出しは、vitest が $ を埋めないので見ない
    { name: '表でない it の題は、vitest が値を埋めないので見ない', code: 'it(\'$nameだと\', () => {})' },
    { name: '根が it・test・describe・suite でない表は見ない', code: 'other.for(rows)(\'$nameだと\', () => {})' },
    { name: '変数で渡した題は見ない', code: 'it.for(rows)(title, () => {})' },
  ],
  invalid: [
    { name: 'キーの直後にひらがなの続く題を止める', code: 'it.for(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID, data: { key: 'nameだと' } }] },
    { name: 'each の題でも、キーの直後にひらがなの続くものを止める', code: 'it.each(rows)(\'$nameのとき、止まる\', () => {})', errors: [{ messageId: INVALID, data: { key: 'nameのとき' } }] },
    { name: 'キーの直後にドットを置いた題を止める', code: 'it.for(rows)(\'値は $name.\', () => {})', errors: [{ messageId: INVALID, data: { key: 'name.' } }] },
    { name: 'ドットが 2 つ続くキーを止める', code: 'it.for(rows)(\'$a..b を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: 'a..b' } }] },
    { name: 'キーの直後に中黒が続く題を止める', code: 'it.for(rows)(\'$a・$b を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: 'a・$b' } }] },
    { name: '$ が 2 つ続くキーを止める', code: 'it.for(rows)(\'$$a を読む\', () => {})', errors: [{ messageId: INVALID, data: { key: '$a' } }] },
    { name: 'describe の表の題も、キーの直後に文字が続けば止める', code: 'describe.for(rows)(\'$toolで\', () => {})', errors: [{ messageId: INVALID, data: { key: 'toolで' } }] },
    { name: 'suite の表の題も、キーの直後に文字が続けば止める', code: 'suite.each(rows)(\'$toolで\', () => {})', errors: [{ messageId: INVALID, data: { key: 'toolで' } }] },
    { name: 'skipIf で修飾した表の題も止める', code: 'it.skipIf(c).for(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID }] },
    { name: 'concurrent で修飾した表の題も止める', code: 'test.concurrent.each(rows)(\'$nameだと、止まる\', () => {})', errors: [{ messageId: INVALID }] },
    { name: '値を埋めないテンプレートリテラルの題も止める', code: 'it.for(rows)(`$nameだと、止まる`, () => {})', errors: [{ messageId: INVALID }] },
    // 入れ子の describe の中と、関数の中も見る
    { name: 'describe の中の表の題も止める', code: 'describe(\'x\', () => { it.for(rows)(\'$nameだと\', () => {}) })', errors: [{ messageId: INVALID }] },
    { name: '関数の中の表の題も止める', code: 'function run() { it.for(rows)(\'$nameだと\', () => {}) }', errors: [{ messageId: INVALID }] },
    {
      name: '読めないキーが 2 つある題は、キーごとに 2 回止める',
      code: 'it.for(rows)(\'$nameだと $kindで\', () => {})',
      errors: [{ messageId: INVALID, data: { key: 'nameだと' } }, { messageId: INVALID, data: { key: 'kindで' } }],
    },
  ],
})

const typedTester = new RuleTester({ languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' } })

typedTester.run('table-key の typescript-eslint の parser', tableKeyRule, {
  valid: [{ name: '型引数の付いた for でも、読めるキーの題は止めない', code: 'it.for<{ name: string }>(rows)(\'$name を渡す\', () => {})' }],
  invalid: [{ name: '型引数の付いた for でも、読めないキーの題を止める', code: 'it.for<{ name: string }>(rows)(\'$nameだと\', () => {})', errors: [{ messageId: INVALID }] }],
})

describe('invalidKeys', () => {
  it('キーとして読めない $キー だけを、出た順に返す', async () => {
    await explains('`invalidKeys` のテストです。キーとして解釈できる `$ok`・`$0` と、解釈できない `$ngだと`・`$x.` を含む題から、解釈できない 2 つだけを出現順に返すことを確認します。')
    stepSync('読めないキーを集めて比べる', () => {
      expect(invalidKeys('$ok、$ngだと、$0、$x.')).toEqual(['ngだと', 'x.'])
    })
  })
})

describe('tableKeyConfig', () => {
  it('渡した files に、test-title/table-key を当てるブロックを返す', async () => {
    await explains('`tableKeyConfig` が返す flat config のブロックのテストです。2 つの glob を渡した場合に、`files` が渡した順に並び、規則が error で有効になることを確認します。')
    const block = stepSync('ブロックを作る', () => tableKeyConfig(['src/**/tests/**/*.ts', '**/*.test.ts']))
    stepSync('ブロックの内容を比べる', () => {
      expect(block.files).toEqual(['src/**/tests/**/*.ts', '**/*.test.ts'])
      expect(block.rules).toEqual({ 'test-title/table-key': 'error' })
      expect(block.plugins['test-title'].rules['table-key']).toBe(tableKeyRule)
    })
  })

  it('plugin が、名前と package.json の版を meta に持つ', async () => {
    await explains('plugin の `meta` のテストです。名前と namespace が `test-title` で、版が interface-spec の `package.json` の version と一致することを確認します。')
    const packageJson: unknown = stepSync<unknown>('package.json を読み込む', () => JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')))
    stepSync('plugin の meta を比べる', () => {
      expect(packageJson).toMatchObject({ version: tableKeyPlugin.meta.version })
      expect(tableKeyPlugin.meta).toMatchObject({ name: 'test-title', namespace: 'test-title' })
    })
  })
})

describe('規則のファイル', () => {
  it('子プロセスの node が、型を除去して import できる', async () => {
    await explains('`eslint.config.js` と同じく、子プロセスの node で規則の `.ts` を直接 import するテストです。型の除去だけで読み込め、`tableKeyConfig` を関数として取得できることを確認します。')
    const url = pathToFileURL(RULE_FILE).href
    const output = stepSync('子プロセスで import する', () => execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.tableKeyConfig)`],
      { encoding: 'utf8' },
    ))
    attachOutput(`node --eval import ${path.basename(RULE_FILE)}`, 0, output, '')
    stepSync('結果を比べる', () => {
      expect(output.trim()).toBe('function')
    })
  })
})
