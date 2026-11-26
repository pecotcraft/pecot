import { describe, expect, it } from 'vitest'
import { buildRules, EXCLUDED_RULE_IDS, lintText } from '../index.js'
import type { TextMode } from '../index.js'
import { pickWord } from './helpers/dictionary.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'

const word = pickWord()
const sentence = `${word}を使う。`
const modes: readonly TextMode[] = ['fragment', 'markdown']

describe('lintText', () => {
  it.each(modes)('辞書語を %s で no-ai-words として返す', async (mode) => {
    const findings = await step('規則にかける', () => lintText(sentence, mode))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.map(finding => finding.ruleId)).toContain('no-ai-words')
    })
  })

  it('100 文字を超える文を sentence-length として返す', async () => {
    const findings = await step('規則にかける', () => lintText(`${'あ'.repeat(101)}。`, 'markdown'))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.some(finding => finding.ruleId.includes('sentence-length'))).toBe(true)
    })
  })

  it.each(['短い文です。', 'This is English only.', '', '   \n'])('指摘の無い入力 %j は空配列を返す', async (text) => {
    await step('各モードで規則にかけ、空配列かを比べる', async () => {
      for (const mode of modes) {
        expect(await lintText(text, mode)).toEqual([])
      }
    })
  })

  it.each(modes)('要約の message を %s で除き、個別の指摘は残す', async (mode) => {
    const findings = await step('規則にかける', () => lintText('また、短い文です。'.repeat(2), mode))
    stepSync('結果の指摘を比べる', () => {
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some(finding => finding.message.startsWith('【テクニカルライティング品質分析】'))).toBe(false)
      expect(findings.some(finding => finding.message.includes('【構造化】'))).toBe(true)
    })
  })

  it.each(['1. ', '- ', '# '])('fragment では行頭の %j をブロック記法として扱わない', async (marker) => {
    await step('fragment で規則にかけ、空配列かを比べる', async () => {
      expect(await lintText(`${marker}概要を説明します`, 'fragment')).toEqual([])
    })
  })

  it('markdown では箇条書きを解釈する', async () => {
    const findings = await step('規則にかける', () => lintText('- 概要を説明します', 'markdown'))
    stepSync('結果の規則 ID を比べる', () => {
      expect(findings.some(finding => finding.ruleId.includes('no-mix-dearu-desumasu'))).toBe(true)
    })
  })

  it('markdown の太字ラベル付き箇条書きを no-ai-list-formatting として 3 件返す', async () => {
    const text = ['a', 'b', 'c'].map(label => `- **${label}**: 説明`).join('\n')
    const findings = await step('規則にかける', () => lintText(text, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      expect(findings.filter(finding => finding.ruleId.includes('no-ai-list-formatting'))).toHaveLength(3)
    })
  })

  it('textlint-disable コメントがあっても指摘を返し、行番号は 1 始まりで数える', async () => {
    const findings = await step('規則にかける', () => lintText(`<!-- textlint-disable -->\n${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found?.line).toBe(2)
    })
  })

  it('先頭の空行を行番号に数える', async () => {
    const findings = await step('規則にかける', () => lintText(`\n\n${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found).toMatchObject({ line: 3, column: 1 })
    })
  })

  it('前置きの文字数に 1 を足した桁を返す', async () => {
    const prefix = '短い文です。'
    const findings = await step('規則にかける', () => lintText(`${prefix}${sentence}`, 'markdown'))
    stepSync('結果の指摘を比べる', () => {
      const found = findings.find(finding => finding.ruleId === 'no-ai-words')
      expect(found?.column).toBe(prefix.length + 1)
    })
  })

  it('message の改行を 1 行にする', async () => {
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
  it('除外する規則 ID を含まない', () => {
    stepSync('除外する規則 ID と規則の一覧を比べる', () => {
      expect([...EXCLUDED_RULE_IDS]).toEqual(['ja-no-mixed-period'])
      expect(buildRules().some(rule => EXCLUDED_RULE_IDS.has(rule.ruleId))).toBe(false)
    })
  })

  it('2 回呼ぶと同じ配列を返す', () => {
    stepSync('規則の一覧を 2 回作り、同じ配列かを比べる', () => {
      expect(buildRules()).toBe(buildRules())
    })
  })
})
