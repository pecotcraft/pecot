// w-help の参照 subagent-usage.md が、委譲する条件と、起こす箇所ごとの表を持つことを確かめる。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { readPluginFile } from './_helpers/documents.js'

const text = readPluginFile('skills/w-help/references/subagent-usage.md')

// 見出し `## <title>` から、次の `## ` の手前までを返す。
function section(title: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${title}`)
  expect(start, `「## ${title}」の節が無い`).toBeGreaterThanOrEqual(0)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, next === -1 ? lines.length : next).join('\n')
}

describe('subagent-usage.md', () => {
  it('実装と修正を委譲する条件の節は、条件を 2 項目だけ持つ', async () => {
    await explains('`subagent-usage.md` の「実装と修正を委譲する条件」の節のテストです。条件が「独立した作業が 3 つ以上ある」と「調べるのに 10 以上のファイルを読む」の 2 項目だけであることを確認します。')
    const items = section('実装と修正を委譲する条件').split('\n').filter(line => line.startsWith('- '))
    expect(items).toEqual(['- 独立した作業が 3 つ以上ある', '- 調べるのに 10 以上のファイルを読む'])
  })

  it('起こす箇所の表は、スキルが起こすエージェントの行をすべて持つ', async () => {
    await explains('「スキルがサブエージェントを起こす箇所」の表のテストです。`w-plan-reviewer`・`w-implementer`・`v-diagram-creator` の行が表に含まれることを確認します。')
    const agents = section('スキルがサブエージェントを起こす箇所')
      .split('\n')
      .filter(line => line.startsWith('|'))
      .map(line => line.split('|', 3)[2]?.trim() ?? '')
    for (const agent of ['w-plan-reviewer', 'w-implementer', 'v-diagram-creator']) expect(agents).toContain(agent)
  })
})
