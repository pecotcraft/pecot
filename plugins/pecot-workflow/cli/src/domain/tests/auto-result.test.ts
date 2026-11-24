// 自動処理の結果のコメントの目印と、札を自動処理が書いたかの決め方を確かめる。
// 決まりは specs/023-label-triggered-autofix/data-model.md の「自動処理が書いた札か」「結果のコメント」。
import { describe, expect, it } from 'vitest'

import { autoResultOf, isLabelWrittenByAutomation } from '../auto-result.js'
import type { IssueCommentReading } from '../review-finish.js'

function marker(result: string): string {
  return `<!-- pecot-auto: result=${result} run=123 attempt=1 branch=feat/x/7 -->`
}

function bot(result: string): IssueCommentReading {
  return { body: `${marker(result)}\n## 質問がある`, userType: 'Bot' }
}

describe('autoResultOf', () => {
  it.for([
    { name: 'question', body: marker('question'), expected: 'question' },
    { name: 'pr-created', body: marker('pr-created'), expected: 'pr-created' },
    { name: '先頭に空白がある', body: `\n  ${marker('limit')}\n本文`, expected: 'limit' },
  ])('目印が $name なら、その結果を返す', ({ body, expected }) => {
    expect(autoResultOf(body)).toBe(expected)
  })

  it.for([
    { name: '目印が先頭に無い', body: `本文\n${marker('question')}` },
    { name: '知らない結果', body: marker('unknown') },
    { name: '目印の欄が欠けている', body: '<!-- pecot-auto: result=question -->' },
    { name: '目印が無い', body: '## 質問がある' },
  ])('$name と、undefined を返す', ({ body }) => {
    expect(autoResultOf(body)).toBeUndefined()
  })
})

describe('isLabelWrittenByAutomation', () => {
  it.for(['question', 'failed', 'limit'])('札が Needs Attention で、最後の Bot の結果が %s なら、真を返す', (result) => {
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('pr-created'), bot(result)])).toBe(true)
  })

  it('最後の Bot の結果の後に、目印の無いコメントがあっても、真を返す', () => {
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), { body: '答えを書いた', userType: 'User' }, { body: 'ok', userType: 'Bot' }])).toBe(true)
  })

  it.for(['pr-created', 'ci-passed', 'ci-fix-pushed', 'out-of-scope', 'setup-missing'])('最後の Bot の結果が %s なら、前に待ちの結果があっても偽を返す', (result) => {
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), bot(result)])).toBe(false)
  })

  it('人が書いた目印は見ず、偽を返す', () => {
    expect(isLabelWrittenByAutomation('Needs Attention', [{ body: marker('question'), userType: 'User' }])).toBe(false)
  })

  it('人が後から書いた目印は、Bot の最後の結果を置き換えない', () => {
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), { body: marker('pr-created'), userType: 'User' }])).toBe(true)
  })

  it.for([
    { name: 'Todo', label: 'Todo' },
    { name: '札なし', label: undefined },
  ])('札が $name なら、Bot の待ちの結果があっても偽を返す', ({ label }) => {
    expect(isLabelWrittenByAutomation(label, [bot('question')])).toBe(false)
  })

  it('Bot のコメントの目印が先頭に無いと、偽を返す', () => {
    expect(isLabelWrittenByAutomation('Needs Attention', [{ body: `前置き\n${marker('question')}`, userType: 'Bot' }])).toBe(false)
  })

  it('コメントが無いと、偽を返す', () => {
    expect(isLabelWrittenByAutomation('Needs Attention', [])).toBe(false)
  })
})
