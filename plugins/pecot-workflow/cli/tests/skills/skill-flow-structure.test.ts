// w-active・w-quick・w-revise の手順（Step の順序と見出し）が崩れていないことを確かめる。
import { describe, expect, it } from 'vitest'

import { readPluginFile } from './_helpers/documents.js'

const PARALLEL_SPAWN_NOTE = '1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。'
const SERIAL_REASON_MARKER = '(直列の理由: ...)'
const STEP_HEADING = /^### Step (\d+)[:：] ?(.+)$/u

interface Heading {
  readonly number: number
  readonly title: string
  readonly line: number
}

function readSkill(name: string): string {
  return readPluginFile(`skills/${name}/SKILL.md`)
}

function stepHeadings(text: string): readonly Heading[] {
  const headings: Heading[] = []
  for (const [index, line] of text.split('\n').entries()) {
    const match = STEP_HEADING.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) headings.push({ number: Number(match[1]), title: match[2].trim(), line: index })
  }
  return headings
}

function titleIndex(headings: readonly Heading[], keyword: string): number {
  const position = headings.findIndex(heading => heading.title.includes(keyword))
  expect(position, `タイトルに ${keyword} を含む Step が無い`).toBeGreaterThanOrEqual(0)
  return position
}

function numberIndex(headings: readonly Heading[], step: number): number {
  const position = headings.findIndex(heading => heading.number === step)
  expect(position, `Step ${String(step)} が無い`).toBeGreaterThanOrEqual(0)
  return position
}

/**
position 番目の Step の本文。終端は次の Step 見出しと次の H2 見出しのうち早いほう
*/
function sectionBody(text: string, position: number): string {
  const lines = text.split('\n')
  const headings = stepHeadings(text)
  const start = headings.find((_, index) => index === position)?.line ?? 0
  const nextStep = headings[position + 1]?.line ?? lines.length
  const nextH2 = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const end = nextH2 === -1 ? nextStep : Math.min(nextStep, nextH2)
  return lines.slice(start, end).join('\n')
}

describe.each(['w-active', 'w-quick'])('%s の手順', (name) => {
  const text = readSkill(name)
  const headings = stepHeadings(text)

  it('調査、計画ドラフト、プランモードの順に並ぶ', () => {
    expect(titleIndex(headings, '調査')).toBeLessThan(titleIndex(headings, '計画ドラフト'))
    expect(titleIndex(headings, '計画ドラフト')).toBeLessThan(titleIndex(headings, 'プランモード'))
  })

  it('確認を求める前に、通常モードで計画を Issue へ投稿する', () => {
    const draft = titleIndex(headings, '計画ドラフト')
    const post = titleIndex(headings, '計画の投稿')
    const body = sectionBody(text, post)
    const draftBody = sectionBody(text, draft)
    expect(draftBody).toContain('`issue_comment`')
    expect(draftBody).toContain('`prepare: true`')
    expect(draftBody).toContain('`template: "plan"`')
    expect(draft).toBeLessThan(post)
    expect(post).toBeLessThan(titleIndex(headings, 'プランモード'))
    expect(body).toContain('`issue_comment` を `file: "<書いたファイル>"` で呼ぶ')
    expect(body).toContain('EnterPlanMode を呼ばない')
  })

  it('調査は、ブランチ切り替えの後にある', () => {
    expect(titleIndex(headings, 'ブランチ切り替え')).toBeLessThan(titleIndex(headings, '調査'))
  })

  it('調査の手順に、通常モードのままにするガードが残る', () => {
    const body = sectionBody(text, titleIndex(headings, '調査'))
    expect(body).toContain('通常モードのまま')
    expect(body).toContain('EnterPlanMode を呼ばない')
  })

  it('プランモードの手順に、承認を得る窓の宣言が残る', () => {
    expect(sectionBody(text, titleIndex(headings, 'プランモード'))).toContain('投稿した計画で承認を得る')
  })
})

describe('w-active の手順', () => {
  const text = readSkill('w-active')
  const headings = stepHeadings(text)

  it('レビューは、計画ドラフトとプランモードの間にある', () => {
    const review = titleIndex(headings, 'レビュー')
    expect(titleIndex(headings, '計画ドラフト')).toBeLessThan(review)
    expect(review).toBeLessThan(titleIndex(headings, 'プランモード'))
  })

  it('レビューは一巡 1 回で、再レビューを求めない', () => {
    const body = sectionBody(text, titleIndex(headings, 'レビュー'))
    for (const word of ['w-tech-advisor', 'w-e2e-planner', '一巡 1 回', '再レビューは不要', 'EnterPlanMode を呼ばない']) expect(body).toContain(word)
  })

  it('レビューの 2 者は、並列 spawn を既定にする', () => {
    const body = sectionBody(text, titleIndex(headings, 'レビュー'))
    expect(body).toContain('2 者の並列 spawn を既定とする')
    expect(body).toContain(SERIAL_REASON_MARKER)
    expect(body).toContain(PARALLEL_SPAWN_NOTE)
    expect(body).not.toContain('spawn してよい')
  })

  it('ブロック中で止まったときは、出力の案内の行を利用者に示す', () => {
    const body = sectionBody(text, titleIndex(headings, '事前確認'))
    for (const word of ['is blocked by', 'issue unblock', '--wait stack', '前提を見直すかどうかは利用者が決める']) expect(body).toContain(word)
  })

  it('ブランチ作成では base を渡さず、積んで着手した旨を伝える', () => {
    const create = sectionBody(text, titleIndex(headings, 'ブランチ作成'))
    const switching = sectionBody(text, titleIndex(headings, 'ブランチ切り替え'))
    expect(create).toContain('`base` は渡さない')
    expect(switching).toContain('(stacked on #N)')
    expect(switching).toContain('積んで着手した旨を利用者に伝える')
  })

  it('base の選び方を、スキルの文に書かない', () => {
    expect(text).not.toContain('--base')
    expect(text).not.toContain('develop_branch')
  })
})

describe('w-quick の手順', () => {
  const text = readSkill('w-quick')
  const headings = stepHeadings(text)

  it('レビューの手順を持たない', () => {
    expect(headings.filter(heading => heading.title.includes('レビュー'))).toEqual([])
  })

  it('Step 1 の引用ブロックのガードが残る', () => {
    const body = sectionBody(text, numberIndex(headings, 1))
    const guard = body.split('\n').filter(line => line.trimStart().startsWith('>')).join('\n')
    expect(guard).not.toBe('')
    expect(guard).toContain('Issue 番号')
    expect(guard).toContain('EnterPlanMode')
  })
})

describe('w-revise の手順', () => {
  const text = readSkill('w-revise')
  const headings = stepHeadings(text)

  it('Step 5 は、複数の w-implementer の並列起動を既定にし、直列の理由を書かせる', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('複数 w-implementer の並列起動を既定とする')
    expect(body).toContain(SERIAL_REASON_MARKER)
    expect(body).toContain(PARALLEL_SPAWN_NOTE)
  })

  it('Step 2 は、3 体のレビューアを並列 spawn する', () => {
    const body = sectionBody(text, numberIndex(headings, 2))
    expect(body).toContain('3 体の並列 spawn を既定とする')
    expect(body).toContain(SERIAL_REASON_MARKER)
    expect(body).toContain(PARALLEL_SPAWN_NOTE)
    for (const reviewer of ['w-tech-advisor', 'w-e2e-planner', 'w-implementer']) expect(body).toContain(reviewer)
  })

  it('Step 6 の一括 resolve は、別名を使う', () => {
    const body = sectionBody(text, numberIndex(headings, 6))
    expect(body.match(/\bt\d+:\s*resolveReviewThread/gu)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(body).not.toContain('$threadId')
  })
})
