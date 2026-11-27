import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { attachOutput } from '../src/vitest/attach.js'
import { describeTitleConfig, describeTitleRule } from '../src/eslint/describe-title.js'
import { stepSync } from '../src/vitest/step.js'
import { useExplainedRuleTester } from '../src/vitest/rule-tester.js'
import { explains } from '../src/vitest/explains.js'

useExplainedRuleTester(RuleTester)

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
    { name: '定義書の name にある題の describe は止めない', code: 'describe(\'alpha_tool\', () => {})', options },
    { name: '空白を含む name の題も、そのまま比べて止めない', code: 'describe(\'beta tool\', () => { it(\'x\', () => {}) })', options },
    { name: 'describe の無いファイルの it は見ない', code: 'it(\'値を比べると、等しい\', () => {})', options },
    { name: 'テストを持たないファイルは見ない', code: 'const value = 1', options },
    { name: '入れ子の describe の題は見ない', code: 'describe(\'alpha_tool\', () => { describe(\'unknown\', () => {}) })', options },
    { name: '関数の中の describe の題は見ない', code: 'function run() { describe(\'unknown\', () => {}) }', options },
    { name: '2 つ目の定義書にある name の題も止めない', code: 'describe(\'gamma_tool\', () => {})', options: [{ definitions: [GENERATED, SECOND] }] },
    { name: 'skipIf で修飾した describe も、題が name にあれば止めない', code: 'describe.skipIf(process.env.CI)(\'alpha_tool\', () => {})', options },
    { name: '値を埋めないテンプレートリテラルの題は、文字列として読む', code: 'describe(`alpha_tool`, () => {})', options },
    { name: '別名で呼んだ describe は追わない', code: 'd(\'unknown\', () => {})', options },
    { name: 'ほかのオブジェクトの describe メソッドは見ない', code: 'other.describe(\'unknown\', () => {})', options },
    { name: '根が describe でない呼び出しの連なりは見ない', code: 'foo(\'unknown\')(\'x\')', options },
    { name: '根がタグ付きテンプレートの呼び出しは見ない', code: 'foo`unknown`(\'x\')', options },
    { name: '関数式をその場で呼ぶ形は見ない', code: '(() => {})(\'unknown\')', options },
  ],
  invalid: [
    {
      name: '定義書の name に無い題の describe を止める',
      code: 'describe(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: 'skip で修飾した describe も、題が name に無ければ止める',
      code: 'describe.skip(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: '修飾を 2 つ重ねた describe も、題が name に無ければ止める',
      code: 'describe.only.skip(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: 'suite も describe と同じく、題が name に無ければ止める',
      code: 'suite(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: '変数で渡した題を、リテラルでないとして止める',
      code: 'const title = "alpha_tool"\ndescribe(title, () => {})',
      options,
      errors: [{ messageId: NOT_LITERAL, line: 2 }],
    },
    {
      name: '値を埋めるテンプレートリテラルの題を、リテラルでないとして止める',
      code: 'describe(`${prefix}alpha_tool`, () => {})',
      options,
      errors: [{ messageId: NOT_LITERAL }],
    },
    {
      name: '題の無い describe を、リテラルでないとして止める',
      code: 'describe(() => {})',
      options,
      errors: [{ messageId: NOT_LITERAL }],
    },
    {
      name: 'each で回す describe も、題が name に無ければ止める',
      code: 'describe.each([1, 2])(\'%s\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: '%s' } }],
    },
    {
      name: 'for で回す describe は、値を埋める前の題で比べて止める',
      code: 'describe.for([1, 2])(\'alpha_tool %s\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'alpha_tool %s' } }],
    },
    {
      name: 'skipIf で修飾した describe も、題が name に無ければ止める',
      code: 'describe.skipIf(flag)(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: 'タグ付きテンプレートで呼んだ describe は、外側の呼び出しの題で比べて止める',
      code: 'describe`alpha_tool`(\'unknown\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
    {
      name: '定義書を 1 つも渡さないと、どの題も止める',
      code: 'describe(\'alpha_tool\', () => {})',
      options: [{ definitions: [] }],
      errors: [{ messageId: UNLISTED, data: { title: 'alpha_tool' } }],
    },
    {
      name: '渡していない定義書にだけある name の題を止める',
      code: 'describe(\'gamma_tool\', () => {})',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'gamma_tool' } }],
    },
    {
      name: 'name に無い題の describe が 2 つあれば、行ごとに 2 回止める',
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
  valid: [{ name: '型注釈のあるファイルでも、題が name にあれば止めない', code: 'const n: number = 1\ndescribe(\'alpha_tool\', () => {})', options }],
  invalid: [
    {
      name: '型注釈のあるファイルでも、題が name に無ければ止める',
      code: 'const n: number = 1\ndescribe(\'unknown\', (): void => { const m = n as number })',
      options,
      errors: [{ messageId: UNLISTED, data: { title: 'unknown' } }],
    },
  ],
})

describe('describeTitleConfig', () => {
  it('定義書のパスを rules の options に渡した flat config のブロックを返す', async () => {
    await explains('`describeTitleConfig` が返す flat config のブロックのテストです。定義書のパスを 1 つ渡した場合に、対象が `tests/interface/` の下に限られ、規則の options にパスが入ることを確認します。')
    const block = stepSync('ブロックを作る', () => describeTitleConfig([GENERATED]))
    stepSync('ブロックの内容を比べる', () => {
      expect(block.files).toEqual(['tests/interface/**/*.ts'])
      expect(block.rules).toEqual({ 'interface-spec/describe-title': ['error', { definitions: [GENERATED] }] })
      expect(block.plugins['interface-spec'].rules['describe-title']).toBe(describeTitleRule)
    })
  })

  it('定義書が無いパスを渡すと、パスを添えて throw する', async () => {
    await explains('存在しない定義書のパスを渡した場合に、ブロックを作成する時点で例外が発生し、例外のメッセージにパスが含まれることを確認します。')
    const missing = path.join(FIXTURES, 'missing.json')
    stepSync('throw を比べる', () => {
      expect(() => describeTitleConfig([missing])).toThrow(missing)
    })
  })

  it('定義書が JSON でないと、パスを添えて throw する', async () => {
    await explains('JSON として解析できない定義書を渡した場合に、例外が発生し、例外のメッセージにパスが含まれることを確認します。')
    const file = path.join(FIXTURES, 'invalid.json')
    stepSync('throw を比べる', () => {
      expect(() => describeTitleConfig([file])).toThrow(file)
    })
  })

  it('entries の形が違う定義書を渡すと、パスを添えて throw する', async () => {
    await explains('`entries` の要素が文字列の `name` を持たない定義書を渡した場合に、例外が発生し、例外のメッセージにパスが含まれることを確認します。')
    const file = path.join(FIXTURES, 'bad-entries.json')
    stepSync('throw を比べる', () => {
      expect(() => describeTitleConfig([file])).toThrow(file)
    })
  })

  it('定義書を渡さなくても throw しない', async () => {
    await explains('定義書を持たない project のように空の配列を渡した場合に、例外が発生せず、規則の options の `definitions` が空の配列になることを確認します。')
    stepSync('定義書なしのブロックを比べる', () => {
      expect(describeTitleConfig([]).rules['interface-spec/describe-title']).toEqual(['error', { definitions: [] }])
    })
  })
})

describe('規則のファイル', () => {
  it('子プロセスの node が、型を除去して import できる', async () => {
    await explains('`eslint.config.js` と同じく、子プロセスの node で規則の `.ts` を直接 import するテストです。型の除去だけで読み込め、`describeTitleConfig` を関数として取得できることを確認します。')
    const url = pathToFileURL(RULE_FILE).href
    const output = stepSync('子プロセスで import する', () => execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.describeTitleConfig)`],
      { encoding: 'utf8' },
    ))
    attachOutput(`node --eval import ${path.basename(RULE_FILE)}`, 0, output, '')
    stepSync('結果を比べる', () => {
      expect(output.trim()).toBe('function')
    })
  })
})
