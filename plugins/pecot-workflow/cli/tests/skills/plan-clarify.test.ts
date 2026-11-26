// w-help の参照 plan-clarify.md が、Spec Kit の clarify と同じ進め方（洗い出す・選ぶ・聞く・書く）を持つことを確かめる。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { readPluginFile } from './_helpers/documents.js'

const text = readPluginFile('skills/w-help/references/plan-clarify.md')

function section(title: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${title}`)
  expect(start, `「## ${title}」の節が無い`).toBeGreaterThanOrEqual(0)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, next === -1 ? lines.length : next).join('\n')
}

describe('plan-clarify.md', () => {
  it('洗い出す、質問を選ぶ、聞く、計画に書くの順に節が並ぶ', async () => {
    await explains('w-help の参照 `plan-clarify.md` の構成のテストです。見出しが「洗い出す」「質問を選ぶ」「聞く」「計画に書く」の 4 つで、この順に並んでいることを確認します。')
    const titles = text.split('\n').filter(line => line.startsWith('## '))
    expect(titles).toEqual(['## 1. 洗い出す', '## 2. 質問を選ぶ', '## 3. 聞く', '## 4. 計画に書く'])
  })

  it('質問は、実装か検証のやり方が変わる点だけにし、5 問までにする', async () => {
    await explains('「質問を選ぶ」の節の記述のテストです。答えで実装か検証のやり方が変わる点だけを質問にすることと、質問を 5 問までにすることが書かれていることを確認します。')
    const body = section('2. 質問を選ぶ')
    expect(body).toContain('答えで実装か検証のやり方が変わる点だけを、質問にする')
    expect(body).toContain('質問は 5 問までにする')
  })

  it('質問の候補が存在しない場合は、聞かずに計画へ進む', async () => {
    await explains('「質問を選ぶ」の節の記述のテストです。質問の候補が存在しない場合は、聞かずに計画へ進むと書かれていることを確認します。')
    expect(section('2. 質問を選ぶ')).toContain('候補が無ければ、聞かずに計画へ進む')
  })

  it('AskUserQuestion で 1 問ずつ聞き、推奨の案を先頭に置く', async () => {
    await explains('「聞く」の節の記述のテストです。`AskUserQuestion` で 1 問ずつ聞くことと、推奨の案を先頭に置いて理由を書くことが書かれていることを確認します。')
    const body = section('3. 聞く')
    expect(body).toContain('AskUserQuestion で、1 問ずつ聞く')
    expect(body).toContain('推奨の案を先頭に置き、推す理由を書く')
  })

  it('答えを受けるたびに、質問と答えを計画の Notes に書く', async () => {
    await explains('「計画に書く」の節の記述のテストです。答えを 1 つ受けるたびに計画のファイルへ書くことと、`- Q: <質問> → A: <答え>` の形式が書かれていることを確認します。')
    const body = section('4. 計画に書く')
    expect(body).toContain('答えを 1 つ受けるたびに、計画のファイルに書く')
    expect(body).toContain('`- Q: <質問> → A: <答え>`')
  })
})
