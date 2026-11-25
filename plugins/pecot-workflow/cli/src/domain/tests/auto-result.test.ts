// 自動処理の結果のコメントの目印と、札を自動処理が書いたかの決め方を確かめる。
// 決まりは specs/023-label-triggered-autofix/data-model.md の「自動処理が書いた札か」「結果のコメント」。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AUTO_RESULTS, autoMarker, autoResultOf, countCiFixes, decideAutoEnsure, isLabelWrittenByAutomation, lastResultOn, markerBranch, renderAutoResult, resultEffects, runResultOf } from '../auto-result.js'
import type { AutoNext, AutoResult } from '../auto-result.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '../frontmatter.js'
import type { IssuePullRequest } from '../readiness.js'
import type { ExecutionReading, IssueCommentReading } from '../review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '../sections.js'

const TEMPLATE = readFileSync(path.resolve(import.meta.dirname, '../../../templates/comment/auto-result.md'), 'utf8')
const TEMPLATE_BODY = stripLeadingHtmlComment(stripFrontmatter(TEMPLATE))

function isValid(body: string): boolean {
  const sections = extractSectionsFromTemplate(TEMPLATE)
  return validateSections(body, sections).length === 0 && validateHeadingSummaries(body, sections).length === 0 && validateBodyStyle(body).length === 0
}

function spikePullRequest(state: 'open' | 'merged' | 'closed' = 'open'): IssuePullRequest {
  return { repository: { owner: 'acme', repository: 'demo' }, number: 11, state, headRefName: 'spike', baseRefName: 'main', isDraft: false, isCrossRepository: false }
}

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

describe('resultEffects', () => {
  it.for([
    { result: 'pr-created', setsWaiting: false, removesLabel: true },
    { result: 'ci-passed', setsWaiting: false, removesLabel: false },
    { result: 'ci-fix-pushed', setsWaiting: false, removesLabel: false },
    { result: 'question', setsWaiting: true, removesLabel: true },
    { result: 'out-of-scope', setsWaiting: false, removesLabel: true },
    { result: 'failed', setsWaiting: true, removesLabel: true },
    { result: 'limit', setsWaiting: true, removesLabel: true },
    { result: 'setup-missing', setsWaiting: false, removesLabel: true },
  ] satisfies { result: AutoResult, setsWaiting: boolean, removesLabel: boolean }[])('$result は、待ちの値を書くかが $setsWaiting で、起動ラベルを外すかが $removesLabel になる', ({ result, setsWaiting, removesLabel }) => {
    expect(resultEffects(result)).toEqual({ setsWaiting, removesLabel })
  })
})

describe('autoMarker', () => {
  it('結果・run・試行・ブランチを、決めた形の目印の行にする', () => {
    expect(autoMarker('question', { runId: '500', attempt: '2' }, 'feat/x/7')).toBe('<!-- pecot-auto: result=question run=500 attempt=2 branch=feat/x/7 -->')
  })

  it.for(AUTO_RESULTS)('%s の目印を本文の先頭に置くと、autoResultOf がその結果を読み戻す', (result) => {
    expect(autoResultOf(`${autoMarker(result, { runId: '1', attempt: '1' }, '-')}\n## Auto result — 見本`)).toBe(result)
  })
})

function record(body: string, userType = 'Bot'): IssueCommentReading {
  return { body, userType }
}

function on(result: string, branch: string, run = '1', attempt = '1', userType = 'Bot'): IssueCommentReading {
  return record(`<!-- pecot-auto: result=${result} run=${run} attempt=${attempt} branch=${branch} -->\n本文`, userType)
}

describe('runResultOf', () => {
  it('同じ run・同じ試行の目印を持つ bot のコメントがあれば、その結果を返す', () => {
    expect(runResultOf([on('pr-created', 'b/7', '9'), on('question', 'b/7', '9', '2')], { runId: '9', attempt: '2' })).toBe('question')
  })

  it.for([
    { name: '試行が違う', comments: [on('question', 'b/7', '9', '1')] },
    { name: 'run が違う', comments: [on('question', 'b/7', '8', '2')] },
    { name: '人が書いた', comments: [on('question', 'b/7', '9', '2', 'User')] },
  ])('$name 目印だけなら、undefined を返す', ({ comments }) => {
    expect(runResultOf(comments, { runId: '9', attempt: '2' })).toBeUndefined()
  })
})

describe('countCiFixes', () => {
  it('同じブランチの、bot の ci-fix-pushed の目印を数える', () => {
    expect(countCiFixes([on('pr-created', 'b/7'), on('ci-fix-pushed', 'b/7'), on('ci-fix-pushed', 'b/7'), on('ci-fix-pushed', 'c/7'), on('ci-fix-pushed', 'b/7', '1', '1', 'User')], 'b/7')).toBe(2)
  })

  it('同じブランチの最後の limit より後の目印だけを数える', () => {
    expect(countCiFixes([on('ci-fix-pushed', 'b/7'), on('limit', 'b/7'), on('ci-fix-pushed', 'b/7'), on('limit', 'c/7')], 'b/7')).toBe(1)
  })

  it('目印が無ければ 0 を返す', () => {
    expect(countCiFixes([record('答え', 'User')], 'b/7')).toBe(0)
  })
})

describe('lastResultOn', () => {
  it('同じブランチの、bot の最後の結果と、そのコメントを返す', () => {
    const last = on('ci-passed', 'b/7')

    expect(lastResultOn([on('pr-created', 'b/7'), last, on('question', 'c/7'), on('limit', 'b/7', '1', '1', 'User')], 'b/7')).toEqual({ result: 'ci-passed', comment: last })
  })

  it('同じブランチの目印が無ければ、undefined を返す', () => {
    expect(lastResultOn([on('pr-created', 'c/7')], 'b/7')).toBeUndefined()
  })
})

describe('markerBranch', () => {
  it('開いた PR を持つブランチを、末尾が Issue の番号のブランチより先に取る', () => {
    expect(markerBranch(['feat/a/7', 'spike'], [spikePullRequest()], 7)).toBe('spike')
  })

  it('PR を開いたブランチが Development のブランチに無くても、開いた PR の head を取る', () => {
    expect(markerBranch([], [spikePullRequest()], 7)).toBe('spike')
  })

  it('開いた PR が複数あれば、head の末尾が Issue の番号のものを取る', () => {
    expect(markerBranch([], [spikePullRequest(), { ...spikePullRequest(), number: 12, headRefName: 'feat/a/7' }], 7)).toBe('feat/a/7')
  })

  it('fork の開いた PR の head は取らない', () => {
    expect(markerBranch(['feat/a/7'], [{ ...spikePullRequest(), isCrossRepository: true }], 7)).toBe('feat/a/7')
  })

  it('開いた PR が無ければ、末尾が /Issue番号 のブランチを取る', () => {
    expect(markerBranch(['spike', 'feat/a/7', 'feat/b/17'], [spikePullRequest('closed')], 7)).toBe('feat/a/7')
  })

  it('どちらも無ければ - を返す', () => {
    expect(markerBranch(['spike', 'feat/b/17'], [], 7)).toBe('-')
  })
})

describe('decideAutoEnsure', () => {
  const ABSENT: ExecutionReading = { kind: 'absent' }

  it('job が成功なら、書かない', () => {
    expect(decideAutoEnsure({ jobStatus: 'success', execution: ABSENT })).toEqual({ action: 'skip' })
  })

  it('job が cancelled なら、limit にする', () => {
    expect(decideAutoEnsure({ jobStatus: 'cancelled', execution: ABSENT })).toEqual({ action: 'write', result: 'limit' })
  })

  it('execution_file の最後の result が error_max_turns なら、limit にする', () => {
    const execution: ExecutionReading = { kind: 'read', last: { subtype: 'error_max_turns', isError: true, terminalReason: 'max_turns', text: '', errors: [] } }

    expect(decideAutoEnsure({ jobStatus: 'failure', execution })).toEqual({ action: 'write', result: 'limit' })
  })

  it.for([
    { name: '無い', execution: { kind: 'absent' } },
    { name: '読めない', execution: { kind: 'unreadable' } },
    { name: 'ほかの result', execution: { kind: 'read', last: { subtype: 'error_during_execution', isError: true, terminalReason: undefined, text: '', errors: [] } } },
  ] satisfies { name: string, execution: ExecutionReading }[])('job が failure で execution_file が$name なら、failed にする', ({ execution }) => {
    expect(decideAutoEnsure({ jobStatus: 'failure', execution })).toEqual({ action: 'write', result: 'failed' })
  })
})

describe('renderAutoResult', () => {
  const RUN_URL = 'https://github.com/acme/demo/actions/runs/500'

  it('見出し・本文・結果・実行の記録・次にすることを埋める', () => {
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'question', label: 'pecot-auto', body: '形式を残すか、移すかを決めてください。', runUrl: RUN_URL })

    expect(body).toBe([
      '## Auto result — 質問があり、自動処理が止まった',
      '',
      '形式を残すか、移すかを決めてください。',
      '',
      '- 結果 — `question`（質問を書いて止まった）',
      `- 実行の記録 — ${RUN_URL}`,
      '- 次にすること — 答えを Issue にコメントで書き、起動ラベル `pecot-auto` を付け直す',
      '',
    ].join('\n'))
  })

  it('本文が無ければ、本文の行ごと消す', () => {
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'pr-created', label: 'pecot-auto', runUrl: RUN_URL })

    expect(body).toBe([
      '## Auto result — 自動処理が PR を作った',
      '',
      '- 結果 — `pr-created`（PR を作った）',
      `- 実行の記録 — ${RUN_URL}`,
      '- 次にすること — PR の CI の結果を待ち、CI が通ったら PR をレビューする',
      '',
    ].join('\n'))
  })

  it('目印を渡すと、本文の先頭に置く', () => {
    const marker = autoMarker('failed', { runId: '500', attempt: '1' }, 'feat/x/7')
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'pecot-auto', runUrl: RUN_URL, marker })

    expect(body.startsWith(`${marker}\n\n## Auto result — `)).toBe(true)
    expect(autoResultOf(body)).toBe('failed')
  })

  it('足りない設定を渡すと、本文の後に、札を書けなかったことと設定の名前を足す', () => {
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'limit', label: 'pecot-auto', body: '上限に達した。', missing: ['Status option Needs Attention'], runUrl: RUN_URL })

    expect(body).toContain('上限に達した。\n\n札を `Needs Attention` にできなかった。足りない設定は `Status option Needs Attention` だ。\n\n- 結果')
  })

  it('run の URL が無ければ、実行の記録を分からないと書く', () => {
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'pecot-auto' })).toContain('- 実行の記録 — 分からない（`GITHUB_RUN_ID` が無い）')
  })

  it('次にすることを渡すと、結果の既定の文の代わりに書く', () => {
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'out-of-scope', label: 'my-label', next: 'ready' })).toContain('- 次にすること — `/pecot-w:w-ready` の手順で Issue を Ready に置いてから、起動ラベル `my-label` を付け直す')
  })

  it.for(AUTO_RESULTS)('%s の本文は、目印と足りない設定があっても、テンプレートの検証を通る', (result) => {
    const marker = autoMarker(result, { runId: '500', attempt: '1' }, 'feat/x/7')

    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result, label: 'pecot-auto', body: '理由を書く。', missing: ['Status option Needs Attention'], runUrl: RUN_URL, marker }))).toBe(true)
  })

  it.for(['ready', 'prerequisites', 'hand-over', 'subtask', 'tracker', 'issue-only', 'reopen'] satisfies AutoNext[])('次にすることが %s の本文は、テンプレートの検証を通る', (next) => {
    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result: 'out-of-scope', label: 'pecot-auto', next }))).toBe(true)
  })

  it('利用者のラベルの名前に改行とバッククォートがあっても、空白と引用符に替えてコードの中に書く', () => {
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'a`b\nc' })).toContain('起動ラベル `a\'b c` を付け直す')
  })
})
