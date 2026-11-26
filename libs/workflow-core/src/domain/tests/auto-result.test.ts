// 自動処理の結果のコメントの目印と、札を自動処理が書いたかの決め方を確かめる。
// 決まりは specs/023-label-triggered-autofix/data-model.md の「自動処理が書いた札か」「結果のコメント」。

import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { AUTO_RESULTS, autoMarker, autoResultOf, countCiFixes, decideAutoEnsure, isLabelWrittenByAutomation, lastResultOn, markerBranch, renderAutoResult, resultEffects, runResultOf } from '../auto-result.js'
import type { AutoNext, AutoResult } from '../auto-result.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '../frontmatter.js'
import type { IssuePullRequest } from '../readiness.js'
import type { ExecutionReading, IssueCommentReading } from '../review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '../sections.js'

// 配布テンプレートの comment/auto-result.md を写す。実物がプレースホルダを持ち検証を通すことは、cli の auto-result.test.ts が確かめる
const TEMPLATE = '---\ntemplate: auto-result\n---\n\n## Auto result — <結果を1行で>\n\n<結果ごとの本文>\n\n- 結果 — <結果>\n- 実行の記録 — <実行の記録>\n- 次にすること — <次にすること>\n'
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
    { name: 'question の場合は', body: marker('question'), expected: 'question' },
    { name: 'pr-created の場合は', body: marker('pr-created'), expected: 'pr-created' },
    { name: '先頭に空白があり limit の場合は', body: `\n  ${marker('limit')}\n本文`, expected: 'limit' },
  ])('目印が $name、その結果を返す', async ({ name, body, expected }) => {
    await explains(`コメントの本文から自動処理の結果を読み取る関数（\`autoResultOf\`）のテストです。目印が${name}、結果として \`${expected}\` を返すことを確認します。`)
    expect(autoResultOf(body)).toBe(expected)
  })

  it.for([
    { name: '目印が本文の先頭に存在しない場合は', body: `本文\n${marker('question')}` },
    { name: '未知の結果の場合は', body: marker('unknown') },
    { name: '目印の欄が不足している場合は', body: '<!-- pecot-auto: result=question -->' },
    { name: '目印が存在しない場合は', body: '## 質問がある' },
  ])('$name、undefined を返す', async ({ name, body }) => {
    await explains(`コメントの本文から自動処理の結果を読み取る関数（\`autoResultOf\`）のテストです。${name}、結果を読み取れないため \`undefined\` を返すことを確認します。`)
    expect(autoResultOf(body)).toBeUndefined()
  })
})

describe('isLabelWrittenByAutomation', () => {
  it.for(['question', 'failed', 'limit'])('札が Needs Attention で、最後の Bot の結果が %s の場合は、true を返す', async (result) => {
    await explains('札を自動処理が書いたか判定する関数（`isLabelWrittenByAutomation`）のテストです。札が `Needs Attention` で、最後の bot の結果が `question`・`failed`・`limit` のいずれかの場合に、`true` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('pr-created'), bot(result)])).toBe(true)
  })

  it('最後の Bot の結果より後に、目印のないコメントがあっても、true を返す', async () => {
    await explains('最後の bot の結果の後に、人のコメントと目印のない bot のコメントがある場合のテストです。目印のないコメントは結果として扱わず、`true` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), { body: '答えを書いた', userType: 'User' }, { body: 'ok', userType: 'Bot' }])).toBe(true)
  })

  it.for(['pr-created', 'ci-passed', 'ci-fix-pushed', 'out-of-scope', 'setup-missing'])('最後の Bot の結果が %s の場合は、前に待ちの結果があっても false を返す', async (result) => {
    await explains('最後の bot の結果が、待ちの結果ではない場合のテストです。前に `question` の結果があっても、最後の結果で判定し、`false` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), bot(result)])).toBe(false)
  })

  it('人が書いた目印は無視して、false を返す', async () => {
    await explains('人のコメントだけに結果の目印がある場合のテストです。bot のコメントではないため目印を無視し、`false` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [{ body: marker('question'), userType: 'User' }])).toBe(false)
  })

  it('人があとから書いた目印は、Bot の最後の結果として扱わない', async () => {
    await explains('bot の `question` の結果の後に、人が結果の目印を書いた場合のテストです。人の目印は無視し、bot の最後の結果で判定して `true` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [bot('question'), { body: marker('pr-created'), userType: 'User' }])).toBe(true)
  })

  it.for([
    { name: 'Todo', label: 'Todo' },
    { name: '存在しない', label: undefined },
  ])('札が $name の場合は、Bot の待ちの結果があっても false を返す', async ({ name, label }) => {
    await explains(`札を自動処理が書いたか判定する関数（\`isLabelWrittenByAutomation\`）のテストです。札が ${name}の場合は、bot の \`question\` の結果があっても、\`false\` を返すことを確認します。`)
    expect(isLabelWrittenByAutomation(label, [bot('question')])).toBe(false)
  })

  it('Bot のコメントの目印が先頭に存在しない場合は、false を返す', async () => {
    await explains('bot のコメントの先頭に前置きがあり、結果の目印が先頭に存在しない場合のテストです。目印として扱わず、`false` を返すことを確認します。')
    expect(isLabelWrittenByAutomation('Needs Attention', [{ body: `前置き\n${marker('question')}`, userType: 'Bot' }])).toBe(false)
  })

  it('コメントが存在しない場合は、false を返す', async () => {
    await explains('コメントが 1 件も存在しない場合のテストです。`false` を返すことを確認します。')
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
  ] satisfies { result: AutoResult, setsWaiting: boolean, removesLabel: boolean }[])('$result は、待ちの値を書くかが $setsWaiting で、起動ラベルを外すかが $removesLabel になる', async ({ result, setsWaiting, removesLabel }) => {
    await explains(`結果ごとに、待ちの値を書くかと起動ラベルを外すかを返す関数（\`resultEffects\`）のテストです。結果が \`${result}\` の場合に、決めた組み合わせの値を返すことを確認します。`)
    expect(resultEffects(result)).toEqual({ setsWaiting, removesLabel })
  })
})

describe('autoMarker', () => {
  it('結果・run・試行・ブランチを、決めた形の目印の行にする', async () => {
    await explains('結果の目印を作成する関数（`autoMarker`）のテストです。結果・run の ID・試行の回数・ブランチを、`pecot-auto:` で始まる決まった形の 1 行にすることを確認します。')
    expect(autoMarker('question', { runId: '500', attempt: '2' }, 'feat/x/7')).toBe('<!-- pecot-auto: result=question run=500 attempt=2 branch=feat/x/7 -->')
  })

  it.for(AUTO_RESULTS)('%s の目印を本文の先頭に置いた場合は、autoResultOf が同じ結果を読み取る', async (result) => {
    await explains('作成した目印を、本文の先頭に置いた場合のテストです。すべての結果で、`autoResultOf` が元の結果を読み取ることを確認します。')
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
  it('同じ run と同じ試行の目印を持つ bot のコメントがある場合は、その結果を返す', async () => {
    await explains('run と試行を指定して、その結果を求める関数（`runResultOf`）のテストです。同じ run と試行の目印を持つ bot のコメントがある場合に、その結果（`question`）を返すことを確認します。')
    expect(runResultOf([on('pr-created', 'b/7', '9'), on('question', 'b/7', '9', '2')], { runId: '9', attempt: '2' })).toBe('question')
  })

  it.for([
    { name: '試行が違う目印', comments: [on('question', 'b/7', '9', '1')] },
    { name: 'run が違う目印', comments: [on('question', 'b/7', '8', '2')] },
    { name: '人が書いた目印', comments: [on('question', 'b/7', '9', '2', 'User')] },
  ])('$name だけの場合は、undefined を返す', async ({ name, comments }) => {
    await explains(`run と試行を指定して、その結果を求める関数（\`runResultOf\`）のテストです。${name}、該当する結果として扱わず \`undefined\` を返すことを確認します。`)
    expect(runResultOf(comments, { runId: '9', attempt: '2' })).toBeUndefined()
  })
})

describe('countCiFixes', () => {
  it('同じブランチで、bot が書いた ci-fix-pushed の目印を数える', async () => {
    await explains('CI を直した回数を数える関数（`countCiFixes`）のテストです。別のブランチの目印と人が書いた目印は含めず、同じブランチの bot の `ci-fix-pushed` だけを数えることを確認します。')
    expect(countCiFixes([on('pr-created', 'b/7'), on('ci-fix-pushed', 'b/7'), on('ci-fix-pushed', 'b/7'), on('ci-fix-pushed', 'c/7'), on('ci-fix-pushed', 'b/7', '1', '1', 'User')], 'b/7')).toBe(2)
  })

  it('同じブランチで最後の limit より後の目印だけを数える', async () => {
    await explains('同じブランチに `limit` の結果がある場合のテストです。最後の `limit` より後の `ci-fix-pushed` だけを数え、別のブランチの `limit` は無視することを確認します。')
    expect(countCiFixes([on('ci-fix-pushed', 'b/7'), on('limit', 'b/7'), on('ci-fix-pushed', 'b/7'), on('limit', 'c/7')], 'b/7')).toBe(1)
  })

  it('目印が存在しない場合は、0 を返す', async () => {
    await explains('人のコメントだけが存在する場合のテストです。数える目印がないため、`0` を返すことを確認します。')
    expect(countCiFixes([record('答え', 'User')], 'b/7')).toBe(0)
  })
})

describe('lastResultOn', () => {
  it('同じブランチで、bot が最後に書いた結果とそのコメントを返す', async () => {
    await explains('ブランチごとの最後の結果を求める関数（`lastResultOn`）のテストです。別のブランチと人が書いた目印は除き、同じブランチの bot の最後の結果とコメントを返すことを確認します。')
    const last = on('ci-passed', 'b/7')

    expect(lastResultOn([on('pr-created', 'b/7'), last, on('question', 'c/7'), on('limit', 'b/7', '1', '1', 'User')], 'b/7')).toEqual({ result: 'ci-passed', comment: last })
  })

  it('同じブランチの目印が存在しない場合は、undefined を返す', async () => {
    await explains('別のブランチの目印だけが存在する場合のテストです。同じブランチの結果がないため、`undefined` を返すことを確認します。')
    expect(lastResultOn([on('pr-created', 'c/7')], 'b/7')).toBeUndefined()
  })
})

describe('markerBranch', () => {
  it('開いた PR を持つブランチを、末尾が Issue の番号のブランチより優先して選ぶ', async () => {
    await explains('結果の目印に使うブランチを選ぶ関数（`markerBranch`）のテストです。開いた PR を持つブランチと、末尾が Issue の番号のブランチがある場合に、開いた PR を持つブランチ（`spike`）を選ぶことを確認します。')
    expect(markerBranch(['feat/a/7', 'spike'], [spikePullRequest()], 7)).toBe('spike')
  })

  it('PR を開いたブランチが Development に登録されていなくても、開いた PR の head を選ぶ', async () => {
    await explains('Development にブランチが存在せず、開いた PR だけがある場合のテストです。開いた PR の head のブランチ（`spike`）を選ぶことを確認します。')
    expect(markerBranch([], [spikePullRequest()], 7)).toBe('spike')
  })

  it('開いた PR が複数ある場合は、head の末尾が Issue の番号のものを選ぶ', async () => {
    await explains('開いた PR が 2 件ある場合のテストです。head のブランチの末尾が Issue の番号である PR の head（`feat/a/7`）を選ぶことを確認します。')
    expect(markerBranch([], [spikePullRequest(), { ...spikePullRequest(), number: 12, headRefName: 'feat/a/7' }], 7)).toBe('feat/a/7')
  })

  it('fork の開いた PR の head は選ばない', async () => {
    await explains('fork から開いた PR がある場合のテストです。その head は選ばず、Development に登録されたブランチ（`feat/a/7`）を選ぶことを確認します。')
    expect(markerBranch(['feat/a/7'], [{ ...spikePullRequest(), isCrossRepository: true }], 7)).toBe('feat/a/7')
  })

  it('開いた PR が存在しない場合は、末尾が /Issue 番号のブランチを選ぶ', async () => {
    await explains('開いた PR が存在せず、複数のブランチがある場合のテストです。末尾が `/7` のブランチ（`feat/a/7`）を選び、`feat/b/17` は選ばないことを確認します。')
    expect(markerBranch(['spike', 'feat/a/7', 'feat/b/17'], [spikePullRequest('closed')], 7)).toBe('feat/a/7')
  })

  it('開いた PR も末尾が Issue の番号のブランチも存在しない場合は、- を返す', async () => {
    await explains('開いた PR も、末尾が Issue の番号のブランチも存在しない場合のテストです。ブランチを選べないため、`-` を返すことを確認します。')
    expect(markerBranch(['spike', 'feat/b/17'], [], 7)).toBe('-')
  })
})

describe('decideAutoEnsure', () => {
  const ABSENT: ExecutionReading = { kind: 'absent' }

  it('job が成功した場合は、結果を書き込まない', async () => {
    await explains('ワークフローの job の終わり方から、書き込む結果を決める関数（`decideAutoEnsure`）のテストです。job が `success` の場合に、何も書き込まない（`skip`）ことを確認します。')
    expect(decideAutoEnsure({ jobStatus: 'success', execution: ABSENT })).toEqual({ action: 'skip' })
  })

  it('job が cancelled の場合は、limit の結果を書き込む', async () => {
    await explains('job が取り消された場合のテストです。実行の記録の有無にかかわらず、`limit` の結果を書き込むことを確認します。')
    expect(decideAutoEnsure({ jobStatus: 'cancelled', execution: ABSENT })).toEqual({ action: 'write', result: 'limit' })
  })

  it('execution_file の最後の result が error_max_turns の場合は、limit の結果を書き込む', async () => {
    await explains('job が `failure` で、実行の記録の最後の結果が `error_max_turns` の場合のテストです。ターン数の上限に達したため、`limit` の結果を書き込むことを確認します。')
    const execution: ExecutionReading = { kind: 'read', last: { subtype: 'error_max_turns', isError: true, terminalReason: 'max_turns', text: '', errors: [] } }

    expect(decideAutoEnsure({ jobStatus: 'failure', execution })).toEqual({ action: 'write', result: 'limit' })
  })

  it.for([
    { name: '存在しない場合は', execution: { kind: 'absent' } },
    { name: '取得できない場合は', execution: { kind: 'unreadable' } },
    { name: 'ほかの result の場合は', execution: { kind: 'read', last: { subtype: 'error_during_execution', isError: true, terminalReason: undefined, text: '', errors: [] } } },
  ] satisfies { name: string, execution: ExecutionReading }[])('job が failure で execution_file が $name、failed にする', async ({ name, execution }) => {
    await explains(`自動処理が失敗したときの結果を決める関数（\`decideAutoEnsure\`）のテストです。job が \`failure\` で、実行の記録の最後の結果が \`error_max_turns\` 以外になる場合（${name}）に、\`failed\` の結果を書き込むことを確認します。`)
    expect(decideAutoEnsure({ jobStatus: 'failure', execution })).toEqual({ action: 'write', result: 'failed' })
  })
})

describe('renderAutoResult', () => {
  const RUN_URL = 'https://github.com/acme/demo/actions/runs/500'

  it('見出し・本文・結果・実行の記録・次にすることを、テンプレートに埋め込む', async () => {
    await explains('結果のコメントを作成する関数（`renderAutoResult`）のテストです。`question` の結果の場合に、見出し・本文・結果・実行の記録・次にすることを、テンプレートの該当する箇所に埋め込むことを確認します。')
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

  it('本文が存在しない場合は、本文の行ごと取り除く', async () => {
    await explains('本文を渡さずに結果のコメントを作成した場合のテストです。本文の行を空行も含めて取り除き、`pr-created` の既定の文を使うことを確認します。')
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

  it('目印を渡した場合は、本文の先頭に置く', async () => {
    await explains('目印を渡して結果のコメントを作成した場合のテストです。目印が本文の先頭に置かれ、`autoResultOf` で結果（`failed`）を読み取れることを確認します。')
    const marker = autoMarker('failed', { runId: '500', attempt: '1' }, 'feat/x/7')
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'pecot-auto', runUrl: RUN_URL, marker })

    expect(body.startsWith(`${marker}\n\n## Auto result — `)).toBe(true)
    expect(autoResultOf(body)).toBe('failed')
  })

  it('不足している設定を渡した場合は、本文の後ろに、札を書けなかったことと設定の名前を追加する', async () => {
    await explains('不足している設定の名前を渡して、結果のコメントを作成した場合のテストです。本文の後ろに、札を書けなかったことと、不足している設定の名前を追加することを確認します。')
    const body = renderAutoResult(TEMPLATE_BODY, { result: 'limit', label: 'pecot-auto', body: '上限に達した。', missing: ['Status option Needs Attention'], runUrl: RUN_URL })

    expect(body).toContain('上限に達した。\n\n札を `Needs Attention` にできなかった。足りない設定は `Status option Needs Attention` だ。\n\n- 結果')
  })

  it('run の URL が存在しない場合は、実行の記録を「分からない」と書く', async () => {
    await explains('run の URL を渡さずに結果のコメントを作成した場合のテストです。実行の記録の欄に、「分からない」と理由（`GITHUB_RUN_ID` が存在しない）を書くことを確認します。')
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'pecot-auto' })).toContain('- 実行の記録 — 分からない（`GITHUB_RUN_ID` が無い）')
  })

  it('次にすることを渡した場合は、結果ごとの既定の文の代わりに書く', async () => {
    await explains('次にすること（`ready`）を渡して、結果のコメントを作成した場合のテストです。結果ごとの既定の文ではなく、渡した内容に対応する手順の文を書くことを確認します。')
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'out-of-scope', label: 'my-label', next: 'ready' })).toContain('- 次にすること — `/pecot-w:w-ready` の手順で Issue を Ready に置いてから、起動ラベル `my-label` を付け直す')
  })

  it.for(AUTO_RESULTS)('%s の本文は、目印と不足している設定を含めても、テンプレートの検証を通る', async (result) => {
    await explains('結果のコメントの本文が、テンプレートの規則に合うか確認するテストです。目印と不足している設定を含めても、すべての結果で検証を通ることを確認します。')
    const marker = autoMarker(result, { runId: '500', attempt: '1' }, 'feat/x/7')

    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result, label: 'pecot-auto', body: '理由を書く。', missing: ['Status option Needs Attention'], runUrl: RUN_URL, marker }))).toBe(true)
  })

  it.for(['ready', 'prerequisites', 'hand-over', 'subtask', 'tracker', 'issue-only', 'reopen'] satisfies AutoNext[])('次にすることが %s の場合の本文は、テンプレートの検証を通る', async (next) => {
    await explains('結果のコメントの本文が、テンプレートの規則に合うか確認するテストです。次にすることがどの値の場合でも、検証を通ることを確認します。')
    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result: 'out-of-scope', label: 'pecot-auto', next }))).toBe(true)
  })

  it('ラベルの名前に改行とバッククォートが含まれる場合は、空白と引用符に置き換えて、コードの中に書く', async () => {
    await explains('ラベルの名前に改行とバッククォートが含まれる場合のテストです。コードの表記が崩れないよう、改行を空白に、バッククォートを引用符に置き換えて書くことを確認します。')
    expect(renderAutoResult(TEMPLATE_BODY, { result: 'failed', label: 'a`b\nc' })).toContain('起動ラベル `a\'b c` を付け直す')
  })
})
