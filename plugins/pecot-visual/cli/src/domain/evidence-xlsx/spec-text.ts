// エビデンス spec の文言を、文章規則に渡す形で取り出す純粋関数。
// fs / process には触れない（憲法 II）。
//
// parseEvidenceSpec は省略された caption をファイル名で補う。補った値は利用者が書いた文言ではないので、
// parse の成功結果が持つ、補う前の spec から取り出す。

import type { TextItem } from '../_shared/text-item.js'
import type { EvidenceSpec } from './spec-schema.js'

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
title・items[i].caption・items[i].annotations[j].text（callout のみ）を列挙する。
j は元の annotations 配列の添字で、highlight・arrow も数える。空白だけの文言は含めない。
*/
export function specTexts(spec: Readonly<EvidenceSpec>): readonly TextItem[] {
  const texts: TextItem[] = []
  if (!isBlank(spec.title)) texts.push({ item: 'title', text: spec.title })
  for (const [index, entry] of spec.items.entries()) {
    if (entry.caption !== undefined && !isBlank(entry.caption)) {
      texts.push({ item: `items[${index.toString()}].caption`, text: entry.caption })
    }
    const annotations = entry.annotations ?? []
    for (const [position, annotation] of annotations.entries()) {
      if (annotation.type === 'callout' && !isBlank(annotation.text)) {
        texts.push({ item: `items[${index.toString()}].annotations[${position.toString()}].text`, text: annotation.text })
      }
    }
  }
  return texts
}
