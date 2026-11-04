// domain/evidence-xlsx/spec-text.ts の単体テスト。エビデンス spec の文言を、文章規則に渡す形で取り出す。
import { describe, expect, it } from 'vitest'

import type { EvidenceSpec } from '../spec-schema.js'
import { specTexts } from '../spec-text.js'

const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
const POINT = { x: 0.5, y: 0.5 }

function specOf(overrides: Partial<EvidenceSpec>): EvidenceSpec {
  return { title: 'タイトル', createdDate: '2026-10-28', items: [{ imagePath: 'a.png' }], ...overrides }
}

describe('specTexts', () => {
  it('title・caption・callout の text を item 付きで返す', () => {
    const spec = specOf({
      items: [
        { imagePath: 'a.png', caption: '一枚目', annotations: [{ type: 'callout', text: '注記', box: BOX, anchor: POINT }] },
        { imagePath: 'b.png', caption: '二枚目' },
      ],
    })
    expect(specTexts(spec)).toStrictEqual([
      { item: 'title', text: 'タイトル' },
      { item: 'items[0].caption', text: '一枚目' },
      { item: 'items[0].annotations[0].text', text: '注記' },
      { item: 'items[1].caption', text: '二枚目' },
    ])
  })

  it('annotations の添字は highlight・arrow を含む元の配列のまま使う', () => {
    const spec = specOf({
      items: [{
        imagePath: 'a.png',
        annotations: [
          { type: 'highlight', box: BOX },
          { type: 'arrow', from: POINT, to: POINT },
          { type: 'callout', text: '3 番目', box: BOX, anchor: POINT },
        ],
      }],
    })
    expect(specTexts(spec)).toStrictEqual([
      { item: 'title', text: 'タイトル' },
      { item: 'items[0].annotations[2].text', text: '3 番目' },
    ])
  })

  it('省略された caption と extraHeaders は含めない', () => {
    const spec = specOf({
      extraHeaders: [{ label: '環境', value: '本番' }],
      items: [{ imagePath: 'screenshot.png' }],
    })
    expect(specTexts(spec)).toStrictEqual([{ item: 'title', text: 'タイトル' }])
  })

  it('空の caption は含めない', () => {
    const spec = specOf({ items: [{ imagePath: 'a.png', caption: '' }] })
    expect(specTexts(spec).map(entry => entry.item)).toStrictEqual(['title'])
  })

  it('空白だけの title・caption・callout の text は含めない', () => {
    const spec = specOf({
      title: '  ',
      items: [{
        imagePath: 'a.png',
        caption: '\n',
        annotations: [
          { type: 'callout', text: '', box: BOX, anchor: POINT },
          { type: 'callout', text: ' ', box: BOX, anchor: POINT },
          { type: 'callout', text: '残る', box: BOX, anchor: POINT },
        ],
      }],
    })
    expect(specTexts(spec)).toStrictEqual([{ item: 'items[0].annotations[2].text', text: '残る' }])
  })
})
