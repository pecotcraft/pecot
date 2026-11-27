import { describe, expect, it } from 'vitest'
import { buildRules, EXCLUDED_RULE_IDS, lintText } from '../index.js'
import type { TextMode } from '../index.js'
import { pickWord } from './helpers/dictionary.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

const word = pickWord()
const sentence = `${word}を使う。`
const modes: readonly TextMode[] = ['fragment', 'markdown']

describe('lintText', () => {
  it.each(modes)('AI の文章で多用される語を含む文を %s モードで渡すと、no-ai-words の指摘を返す', async (mode) => {
    await explains(`文章の規則違反を返す \`lintText\` のテストです。AI の文章で多用される語を含む文を \`${mode}\` モードで渡した場合に、規則 \`no-ai-words\` の指摘が含まれることを確認します。`)
    const findings = await step('規則にかける', () => lintText(sentence, mode))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.map(finding => finding.ruleId)).toContain('no-ai-words')
    })
  })

  it('100 文字を超える文は、sentence-length の指摘として返す', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。101 文字の文を渡した場合に、規則 `sentence-length` の指摘が含まれることを確認します。')
    const findings = await step('規則にかける', () => lintText(`${'あ'.repeat(101)}。`, 'markdown'))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.some(finding => finding.ruleId.includes('sentence-length'))).toBe(true)
    })
  })

  it.each(['短い文です。', 'This is English only.', '', '   \n'])('指摘の対象にならない入力 %j は、どのモードでも空の配列を返す', async (text) => {
    await explains(`文章の規則違反を返す \`lintText\` のテストです。入力 \`${JSON.stringify(text)}\` を、\`fragment\` と \`markdown\` のどちらのモードで渡した場合も、空の配列を返すことを確認します。`)
    await step('各モードで規則にかけ、空配列かを比べる', async () => {
      for (const mode of modes) {
        expect(await lintText(text, mode)).toEqual([])
      }
    })
  })

  it.each(modes)('まとめの指摘を %s モードで除外し、個別の指摘だけを返す', async (mode) => {
    await explains(`文章の規則違反を返す \`lintText\` のテストです。複数の指摘をまとめる、【テクニカルライティング品質分析】で始まる指摘を \`${mode}\` モードで除外し、【構造化】などの個別の指摘だけが残ることを確認します。`)
    const findings = await step('規則にかける', () => lintText('また、短い文です。'.repeat(2), mode))
    stepSync('結果の指摘を比べる', () => {
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some(finding => finding.message.startsWith('【テクニカルライティング品質分析】'))).toBe(false)
      expect(findings.some(finding => finding.message.includes('【構造化】'))).toBe(true)
    })
  })

  it.each(['1. ', '- ', '# '])('fragment モードでは、行頭の %j を Markdown のブロック記法として扱わない', async (marker) => {
    await explains(`文章の規則違反を返す \`lintText\` のテストです。\`fragment\` モードで、行頭に \`${marker}\` を付けた文を渡した場合に、指摘が 1 件も返らないことを確認します。`)
    await step('fragment で規則にかけ、空配列かを比べる', async () => {
      expect(await lintText(`${marker}概要を説明します`, 'fragment')).toEqual([])
    })
  })

  it('markdown モードでは、箇条書きを Markdown として解釈する', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。`markdown` モードで `- 概要を説明します` を渡した場合に、箇条書きとして解釈され、規則 `no-mix-dearu-desumasu` の指摘が返ることを確認します。')
    const findings = await step('規則にかける', () => lintText('- 概要を説明します', 'markdown'))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.some(finding => finding.ruleId.includes('no-mix-dearu-desumasu'))).toBe(true)
    })
  })

  it('markdown の太字ラベル付き箇条書きを no-ai-list-formatting として 3 件返す', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。`markdown` モードで、太字のラベルを付けた箇条書きを 3 項目渡した場合に、規則 `no-ai-list-formatting` の指摘が 3 件返ることを確認します。')
    const text = ['a', 'b', 'c'].map(label => `- **${label}**: 説明`).join('\n')
    const findings = await step('規則にかける', () => lintText(text, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      expect(findings.filter(finding => finding.ruleId.includes('no-ai-list-formatting'))).toHaveLength(3)
    })
  })

  it('textlint-disable のコメントがあっても指摘を返し、行番号を 1 から数える', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。`textlint-disable` のコメントの次の行に違反がある場合に、指摘が無効にならず、行番号が 2 になることを確認します。')
    const findings = await step('規則にかける', () => lintText(`<!-- textlint-disable -->\n${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found?.line).toBe(2)
    })
  })

  it('先頭に空行があると、空行も行番号に含める', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。先頭に空行が 2 つある文を渡した場合に、指摘の行番号が 3、桁が 1 になることを確認します。')
    const findings = await step('規則にかける', () => lintText(`\n\n${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found).toMatchObject({ line: 3, column: 1 })
    })
  })

  it('違反の前に文字がある場合は、その文字数に 1 を加えた桁を返す', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。違反の前に 6 文字の文がある場合に、指摘の桁が文字数に 1 を加えた 7 になることを確認します。')
    const prefix = '短い文です。'
    const findings = await step('規則にかける', () => lintText(`${prefix}${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found?.column).toBe(prefix.length + 1)
    })
  })

  it('指摘の message に含まれる改行を取り除き、1 行にする', async () => {
    await explains('文章の規則違反を返す `lintText` のテストです。複数の指摘を返す文を渡した場合に、すべての指摘の message に改行が含まれないことを確認します。')
    const findings = await step('規則にかける', () => lintText('また、短い文です。'.repeat(2), 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      expect(findings.length).toBeGreaterThan(0)
      for (const finding of findings) {
        expect(finding.message).not.toMatch(/\n/)
      }
    })
  })
})

describe('buildRules', () => {
  it('除外する規則の ID を、規則の一覧に含めない', async () => {
    await explains('規則の一覧を作成する `buildRules` のテストです。除外する規則 `ja-no-mixed-period` が、返された一覧に含まれないことを確認します。')
    stepSync('除外する規則 ID と規則の一覧を比べる', () => {
      expect([...EXCLUDED_RULE_IDS]).toEqual(['ja-no-mixed-period'])
      expect(buildRules().some(rule => EXCLUDED_RULE_IDS.has(rule.ruleId))).toBe(false)
    })
  })

  it('2 回呼び出すと、同じ配列を返す', async () => {
    await explains('規則の一覧を作成する `buildRules` のテストです。2 回呼び出した場合に、どちらも同じ配列のインスタンスを返すことを確認します。')
    stepSync('規則の一覧を 2 回作り、同じ配列かを比べる', () => {
      expect(buildRules()).toBe(buildRules())
    })
  })
})
