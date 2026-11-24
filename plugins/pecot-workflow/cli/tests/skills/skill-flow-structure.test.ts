/* eslint-disable security/detect-non-literal-fs-filename -- 確かめるのはプラグイン内のリンク先のみ */
// w-active・w-quick・w-review・w-pr・w-issueize・w-breakdown の手順（Step の順序と見出し）が崩れていないことを確かめる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pluginRoot, readPluginFile } from './_helpers/documents.js'

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
    expect(draftBody).toContain('`pecot-template://comment/plan`')
    expect(draft).toBeLessThan(post)
    expect(post).toBeLessThan(titleIndex(headings, 'プランモード'))
    expect(body).toContain('`issue_comment` を使って、書いたファイルを Issue に投稿する')
  })

  it('調査は、ブランチ切り替えの後にある', () => {
    expect(titleIndex(headings, 'ブランチ切り替え')).toBeLessThan(titleIndex(headings, '調査'))
  })

  it('計画ドラフトの Step は、計画の投稿より前に、参照の clarify に従って曖昧な点を AskUserQuestion で聞く', () => {
    const draft = titleIndex(headings, '計画ドラフト')
    const draftBody = sectionBody(text, draft)
    const link = '../w-help/references/plan-clarify.md'
    expect(draft).toBeLessThan(titleIndex(headings, '計画の投稿'))
    expect(draftBody).toContain(`](${link}) に従って clarify を行う`)
    expect(draftBody).toContain('Issue と依頼の曖昧な点を AskUserQuestion で聞き、答えを受けるたびに、できたファイルへ書く')
    expect(draftBody.indexOf('clarify を行う')).toBeLessThan(draftBody.indexOf('テンプレの見出しと規則のとおりに計画を書く'))
    expect(existsSync(path.join(pluginRoot, 'skills', name, link))).toBe(true)
  })

  it('EnterPlanMode を呼ばない、という注意を手順に書かない', () => {
    expect(text).not.toContain('EnterPlanMode を呼ばない')
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
    for (const word of ['w-plan-reviewer', '一巡 1 回', '再レビューは不要']) expect(body).toContain(word)
  })

  it('レビューは、w-plan-reviewer を 1 回起こし、ほかのエージェントを起こさない', () => {
    const body = sectionBody(text, titleIndex(headings, 'レビュー'))
    expect(body).toContain('`Agent` ツールで w-plan-reviewer を 1 回起こし')
    expect(body).toContain('agent teams が有効なら `name: w-plan-reviewer` を付ける')
    expect(body).not.toContain('agent ID を控える')
    for (const agent of ['w-e2e-planner', 'w-implementer']) expect(body).not.toContain(agent)
    for (const word of ['並列 spawn', '単発 spawn', '待機']) expect(body).not.toContain(word)
  })

  it('ブランチ作成で止まったときは、エラーの案内を利用者に示し、エージェントの判断で先へ進めない', () => {
    const body = sectionBody(text, titleIndex(headings, 'ブランチ作成'))
    for (const word of ['エラーの案内を利用者に示して止まる', 'エージェントの判断で先へ進めない', '前提を見直すかどうかは利用者が決める', '`base` を渡さない']) expect(body).toContain(word)
  })

  it('Step 1 は、着手できる Issue だけを表で示す', () => {
    expect(text).toContain('着手できる Issue だけを、次の表で利用者に示す')
    expect(text).toContain('AskUserQuestion は使わない')
  })

  it('ブランチ作成では base を渡さず、スタックして着手した旨を伝える', () => {
    const create = sectionBody(text, titleIndex(headings, 'ブランチ作成'))
    const switching = sectionBody(text, titleIndex(headings, 'ブランチ切り替え'))
    expect(create).toContain('`base` は渡さない')
    expect(switching).toContain('作ったブランチに切り替える')
    expect(switching).toContain('別の Issue の上にスタックして着手したときは、その旨を利用者に伝える')
  })

  it('実装の Step は、計画の CUJ を main が cuj-run.md に従って流すと書き、リンク先が実在する', () => {
    const body = sectionBody(text, titleIndex(headings, '実装'))
    expect(body).toContain('計画の CUJ を main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流す。')
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-help', 'references', 'cuj-run.md'))).toBe(true)
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

  it('Step 1 は、session_show でセッションのリポを確かめ、issue_create（freeform）で起票する', () => {
    const body = sectionBody(text, numberIndex(headings, 1))
    expect(body).toContain('`issue_create` を使って、Issue を作る')
    expect(body).toContain('`session_show`')
    expect(body).toContain('`freeform: true`')
  })

  it('Step 2 は、session_start でブランチを作り、切り替える', () => {
    const body = sectionBody(text, numberIndex(headings, 2))
    expect(body).toContain('`session_start` を使って、作った Issue に紐づくブランチを作る')
    expect(body).toContain('git checkout')
  })
})

describe('w-review の手順', () => {
  const text = readSkill('w-review')
  const headings = stepHeadings(text)

  it('Step は 1〜4 だけで、採否を聞く・直す・resolve する Step を持たない', () => {
    expect(headings.map(heading => heading.number)).toEqual([1, 2, 3, 4])
    for (const word of ['AskUserQuestion', 'resolveReviewThread', 'review-resolution', 'w-implementer']) expect(text).not.toContain(word)
  })

  it('Step 1 の前に、引数の project を pecot-workflow の MCP ツールへ渡す文がある', () => {
    const lines = text.split('\n')
    const start = lines.indexOf('## 手順')
    const preamble = lines.slice(start, headings[0]?.line).join('\n')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(preamble).toContain('引数に `project=<名前>` があれば、このスキルで使う pecot-workflow の MCP ツールに、その名前を `project` で渡す。')
    expect(preamble).toContain('渡す先は `pr_show`・`issue_show`・`issue_comment` の 3 つ。')
  })

  it('Step 1 では、スタックし直さない', () => {
    expect(sectionBody(text, numberIndex(headings, 1))).not.toContain('pr_restack')
  })

  it('2 巡目以降は、前の指摘が直ったかを先に見て、F-NN を振り直さない', () => {
    expect(sectionBody(text, numberIndex(headings, 2))).toContain('F-NN ごとに、直ったか・直っていないかを決める')
    expect(sectionBody(text, numberIndex(headings, 4))).toContain('番号は PR の中の通し番号にし、振り直さない。')
    expect(text).not.toMatch(/R\d+\/F-/u)
  })

  it('Step 1 は、PR が閉じる Issue をコメント 20 件まで読み、計画が無ければ照らす手順を飛ばす', () => {
    const body = sectionBody(text, numberIndex(headings, 1))
    for (const phrase of ['`closing_issues`', '`comment_limit: 20`', '`## Plan` と `## PECOT-Workflow`', '計画と照らす手順を飛ばしてレビューを続ける']) expect(body).toContain(phrase)
  })

  it('視点の参照は、[tech] の節の下に計画と照らす節を持つ', () => {
    const viewpoints = readPluginFile('skills/w-review/references/review-viewpoints.md')
    const tech = viewpoints.indexOf('## [tech] ')
    expect(tech).toBeGreaterThanOrEqual(0)
    expect(viewpoints.indexOf('### 計画と照らす', tech)).toBeGreaterThan(tech)
    expect(sectionBody(text, numberIndex(headings, 3))).toContain('「計画と照らす」')
  })

  it('Step 3 は、main が視点の参照に従ってレビューし、サブエージェントを起こさない', () => {
    const body = sectionBody(text, numberIndex(headings, 3))
    expect(body).toContain('main が diff をレビューする')
    const link = 'references/review-viewpoints.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-review', link))).toBe(true)
    for (const word of ['`Agent`', '`SendMessage`', 'w-plan-reviewer', 'cuj-run.md']) expect(body).not.toContain(word)
  })

  it('Step 4 のインラインコメントは、レビューの指摘に視点の印を付け、外部のレビュアーの指摘には付けない', () => {
    const body = sectionBody(text, numberIndex(headings, 4))
    expect(body).toContain('`**F-NN** [視点の印]` で始める')
    for (const mark of ['`[tech]`', '`[cuj]`']) expect(body).toContain(mark)
    expect(body).toContain('外部のレビュアーの指摘には印を付けない')
  })

  it('Step 4 は、インラインコメントを action の MCP ツールで投稿し、gh を使わない', () => {
    const body = sectionBody(text, numberIndex(headings, 4))
    expect(body).toContain('`create_inline_comment`')
    expect(text).not.toMatch(/\bgh (api|auth)\b/u)
  })

  it('Step 4 は、投稿で終わる', () => {
    expect(sectionBody(text, numberIndex(headings, 4))).toContain('投稿したら終わる。採否は聞かず、コードは直さない。スレッドの resolve もしない。')
  })
})

describe('w-pr の手順', () => {
  const text = readSkill('w-pr')
  const headings = stepHeadings(text)

  it('Step 5 は、CI を待つ Step 4 の後で、レビューの指摘に対応する', () => {
    expect(titleIndex(headings, 'CI を待って直す')).toBeLessThan(titleIndex(headings, 'レビューの指摘に対応'))
  })

  it('Step 5 は、採否を利用者に聞かず、main が決めて対応してから報告する', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).not.toContain('AskUserQuestion')
    expect(body).toContain('#### 採否を決める')
    expect(body).toContain('採否を利用者に聞かない。main が F-NN ごとに「対応」か「対応不要」かを決め、対応を終えてから報告する。')
    expect(body).toContain('既定は「対応」にする')
    expect(body).toContain('採否は main が決め、途中で利用者に確かめない。')
  })

  it('Step 5 は、対応不要にできる場合を絞り、理由に根拠を添えてスレッドに返信させる', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    for (const word of ['指摘が事実と違う', '承認された計画や Issue の決めた仕様・挙動と食い違う', 'その理由に同意する', '確かめた根拠', '保留や別 Issue への先送りにしない', '対応不要の F-NN のスレッドに、理由を返信する']) expect(body).toContain(word)
  })

  it('Step 5 は、main が直すことを基本にし、委譲する条件を subagent-usage.md から読ませる', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('main が直すことを基本にする')
    expect(body).toContain('当たらなければ main が直し、w-implementer を起こさない')
    const link = '../w-help/references/subagent-usage.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-pr', link))).toBe(true)
    expect(body.indexOf(link)).toBeLessThan(body.indexOf('複数 w-implementer の並列起動を既定とする'))
  })

  it('Step 5 は、委譲するときに複数の w-implementer の並列起動を既定にし、直列の理由を書かせる', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('条件に当たって委譲するときは')
    expect(body).toContain('複数 w-implementer の並列起動を既定とする')
    expect(body).toContain(SERIAL_REASON_MARKER)
    expect(body).toContain(PARALLEL_SPAWN_NOTE)
  })

  it('Step 5 は、割り当て表の書式とモデルの基準へのリンクを持ち、リンク先が実在する', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('実装者名 / モデル / 担当 F-NN / 担当ファイル群')
    const link = '../w-help/references/agent-models.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-pr', link))).toBe(true)
  })

  it('Step 5 の CUJ の再実行は、main が CUJ の流し方の参照に従って流し、サブエージェントに渡さない', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流し直す。サブエージェントには渡さない。')
  })

  it('Step 5 は、F-NN とスレッドの対応表のクエリを自分で持ち、w-review を案内しない', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('#### F-NN とスレッド ID の対応表')
    expect(body).toContain('reviewThreads(first: 100)')
    expect(body).not.toContain('/pecot-w:w-review')
  })

  it('Step 5 は、session_show で子 PR を確かめ、あれば pr_restack が要る旨を報告に入れる', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('`session_show`')
    expect(body).toContain('`pr_restack`')
    expect(body.indexOf('`session_show`')).toBeGreaterThan(body.indexOf('`review-resolution` を投稿'))
    expect(body).not.toContain('git rebase')
  })

  it('Step 5 の一括 resolve は、別名を使う', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body.match(/\bt\d+:\s*resolveReviewThread/gu)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(body).not.toContain('$threadId')
  })
})

describe('w-ready の手順', () => {
  const text = readSkill('w-ready')
  const headings = stepHeadings(text)

  it('description は、前提に応じて Ready か Blocked に置くと書く', () => {
    const frontmatter = text.split('---\n', 2)[1] ?? ''
    expect(frontmatter).toContain('Blocked')
  })

  it('計画の Step は、前提を決めて blocked_by に書く', () => {
    const body = sectionBody(text, titleIndex(headings, '計画'))
    expect(body).toContain('`blocked_by`')
    expect(body).toContain('`wait: merge`')
    expect(body).toContain('`reason`')
    expect(body).toContain('前提（`blocked_by`）と種類')
  })

  it('order の続番を数えさせない', () => {
    expect(text).not.toContain('続番')
    expect(text).not.toContain('枝つき')
    expect(text).toContain('`order`・`status` は書かない')
  })

  it('投稿の前に issue_check で確かめる', () => {
    const body = sectionBody(text, titleIndex(headings, '作成'))
    const planned = body.indexOf('`issue_check`')
    const posted = body.indexOf('`issue_create` を使って投稿する')
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(posted).toBeGreaterThan(planned)
  })

  it('issue_check では置く列を確かめさせない（issue_check の結果に列は無い）', () => {
    const body = sectionBody(text, titleIndex(headings, '作成'))
    expect(body.slice(0, body.indexOf('`issue_create` を使って投稿する'))).not.toContain('置く列')
  })

  it('完了報告に、置いた列と、Blocked のときに待つものを入れる', () => {
    const body = sectionBody(text, titleIndex(headings, '完了報告'))
    for (const word of ['`Ready`', '`Blocked`', '待つ']) expect(body).toContain(word)
  })

  it('完了報告は、置いた列を投稿の結果から伝え、列が書かれていなければその旨を伝える', () => {
    const body = sectionBody(text, titleIndex(headings, '完了報告'))
    expect(body).toContain('投稿の結果')
    expect(body).toContain('列が書かれていない')
  })

  it('既存の Issue に前提として付ける操作は issue_block で案内する', () => {
    expect(text).toContain('`issue_block`')
  })
})

describe('w-issueize の手順', () => {
  const text = readSkill('w-issueize')
  const headings = stepHeadings(text)

  it('前提の読み取り、ファイルの編集、完了報告の順に並ぶ', () => {
    expect(titleIndex(headings, '前提')).toBeLessThan(titleIndex(headings, 'Issueとして作成'))
    expect(titleIndex(headings, 'Issueとして作成')).toBeLessThan(titleIndex(headings, '完了報告'))
  })

  it('Step 2 は、4 列の表が無い tasks.md の扱いを持つ', () => {
    const body = sectionBody(text, titleIndex(headings, '前提'))
    expect(body).toContain('4 列の表が無い tasks.md')
    expect(body).toContain('種類はすべて「スタックできる」とする')
    expect(body).toContain('表が無かった旨を伝える')
  })

  it('Step 3 は、issue_check で確かめた番号・前提・進め方を、前提の表と並べて示す', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('結果の番号・前提・進め方を表にし')
    expect(body).toContain('スタックできる並びも示す')
    expect(body).toContain('前提の表と並べて')
  })

  it('Step 3 は、前の版の tasks.md の「積める」を「スタックできる」と同じに扱う', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('「積める」は「スタックできる」と同じに扱う')
  })

  it('Step 3 は、失敗しても作った Issue があれば呼び直さないと書く', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('結果に作った Issue があれば、その Issue は作られている')
    expect(body).toContain('同じ `files` で呼び直さない')
    expect(body).toContain('呼び直さず、エラーの文を利用者に示して止まる')
  })

  it('Step 3 は、付け直すコマンドの行を打たずに示す', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('前提を付け直すコマンドの行があれば、打たずにそのままユーザーへ示す')
  })

  it('issue_check の呼び出しは、投稿の呼び出しより前にある', () => {
    const body = sectionBody(text, numberIndex(headings, 3))
    const planned = body.indexOf('`issue_check`')
    const posted = body.indexOf('`issue_create` を 1 回だけ使う')
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(posted).toBeGreaterThan(planned)
    expect(body).toContain('合意を得てから投稿する')
  })

  it('blocked_by を書き、order・parallel・status は書かせない', () => {
    const body = sectionBody(text, numberIndex(headings, 3))
    expect(body).toContain('`blocked_by`')
    expect(body).toContain('`order`・`parallel`・`status` は書かない')
  })

  it('段と枝の文字の計算を書かない', () => {
    expect(text).not.toMatch(/`a`・`b`・`c`/u)
    expect(text).not.toContain('番号が示すのは着手の条件')
    expect(text).not.toContain('続番')
    expect(text).not.toMatch(/段を決める/u)
  })

  it('完了報告に、進め方・スタックできる並び・最初に着手できる Issue を入れる', () => {
    const body = sectionBody(text, numberIndex(headings, 4))
    for (const word of ['進め方', 'スタックできる並び', '最初に着手できる Issue']) expect(body).toContain(word)
  })
})

/**
本文の最初のコードブロックの中身。フェンスの行は含めない
*/
function firstCodeBlock(body: string): string {
  const lines = body.split('\n')
  const open = lines.findIndex(line => line.trimStart().startsWith('```'))
  const close = lines.findIndex((line, index) => index > open && line.trimStart().startsWith('```'))
  expect(open, 'コードブロックが無い').toBeGreaterThanOrEqual(0)
  expect(close, 'コードブロックが閉じていない').toBeGreaterThan(open)
  return lines.slice(open + 1, close).join('\n')
}

const TABLE_HEADER = '| Phase | 前提 | 種類 | 理由 |'
const MERGE_EXAMPLES_HEADING = '「マージを待つ」になる例:'

/**
見出しの行の直後から空行までの行
*/
function linesAfter(block: string, heading: string): readonly string[] {
  const lines = block.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  expect(start, `${heading} の行が無い`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim() === '')
  return end === -1 ? rest : rest.slice(0, end)
}

/**
text の中の pattern の 1 番目のグループを、すべて数にする
*/
function referencedSteps(text: string, pattern: Readonly<RegExp>): readonly number[] {
  return Array.from(text.matchAll(pattern), match => Number(match[1]))
}

/**
本文の最初の YAML の例にある reason の値
*/
function exampleReason(source: string): string | undefined {
  return /reason: "(.+)"/u.exec(source)?.[1]
}

describe('w-breakdown の手順', () => {
  const text = readSkill('w-breakdown')
  const headings = stepHeadings(text)
  const tasksStep = (): number => titleIndex(headings, 'tasks 実行')
  const checkStep = (): number => titleIndex(headings, '前提の表を確かめる')
  const clarifyStep = (): number => titleIndex(headings, 'clarify')
  const fileStep = (): number => titleIndex(headings, '分解のタスクを起票')
  const tasksBlock = (): string => firstCodeBlock(sectionBody(text, tasksStep()))
  const stepNumber = (position: number): number | undefined => headings.find((_, index) => index === position)?.number

  it('specify、clarify、tasks、前提の表の確かめの順に並ぶ', () => {
    expect(titleIndex(headings, 'specify')).toBeLessThan(clarifyStep())
    expect(clarifyStep()).toBeLessThan(tasksStep())
    expect(tasksStep()).toBeLessThan(checkStep())
  })

  it('clarify の Step の工程の順序に、/speckit.tasks が無い', () => {
    const body = sectionBody(text, clarifyStep())
    const order = body.split('\n').find(line => line.startsWith('工程の順序'))
    expect(order).toContain('`/speckit.clarify`')
    expect(order).toContain('`/speckit.plan`')
    expect(order).not.toContain('/speckit.tasks')
  })

  it('clarify の Step は、次に進む・修正を指示する・やり直すの承認 3 択を持つ', () => {
    const body = sectionBody(text, clarifyStep())
    for (const choice of ['次に進む', '修正を指示する', 'やり直す']) expect(body).toContain(`| ${choice} |`)
  })

  it('本文の Step の番号の参照は、参照先の Step の番号と合う', () => {
    const tasks = stepNumber(tasksStep())
    const goTo = referencedSteps(sectionBody(text, clarifyStep()), /Step (\d+) へ進む/gu)
    const tasksReferences = referencedSteps(text, /tasks の工程（Step (\d+)）/gu)
    const blockReferences = referencedSteps(text, /Step (\d+) のコードブロック/gu)
    const approvalReferences = referencedSteps(text, /Step (\d+) と同じ承認 3 択/gu)
    expect(goTo).toEqual([tasks])
    expect(tasksReferences.length).toBeGreaterThan(0)
    expect(blockReferences.length).toBeGreaterThan(0)
    for (const step of [...tasksReferences, ...blockReferences]) expect(step).toBe(tasks)
    expect(approvalReferences).toEqual([stepNumber(clarifyStep())])
  })

  it('再開の Step の番号の参照は、準備の Step と、続ける工程の Step の番号と合う', () => {
    const prepare = stepNumber(titleIndex(headings, '準備'))
    const resumeReferences = referencedSteps(text, /Step (\d+) (?:で|の)再開/gu)
    expect(resumeReferences.length).toBeGreaterThan(0)
    for (const step of resumeReferences) expect(step).toBe(prepare)
    const prepareBody = sectionBody(text, titleIndex(headings, '準備'))
    const rows: Record<string, number> = {}
    for (const match of prepareBody.matchAll(/^ *\| (\S+) \| Step (\d+)/gmu)) {
      if (match[1] !== undefined) rows[match[1]] = Number(match[2])
    }
    expect(rows).toEqual({
      tasks: stepNumber(headings.length - 1),
      plan: stepNumber(tasksStep()),
      clarify: stepNumber(clarifyStep()),
      specify: stepNumber(clarifyStep()),
      無い: stepNumber(titleIndex(headings, 'specify')),
    })
  })

  it('準備の Step は、承認の commit のメッセージに工程の名前を入れさせ、再開でそれを読む', () => {
    const body = sectionBody(text, titleIndex(headings, '準備'))
    expect(body).toContain('メッセージに工程の名前（specify・clarify・plan・tasks）を入れる')
    expect(body).toContain('git log --format=%s origin/<開発ブランチ>..HEAD -- specs/<NNN-名前>/')
  })

  it('準備の Step は、develop_branch が null なら止める', () => {
    expect(sectionBody(text, titleIndex(headings, '準備'))).toContain('`develop_branch` が null なら止め')
  })

  it('tasks の Step は、/speckit.tasks の引数に、コードブロック 1 つをそのまま貼らせる', () => {
    const body = sectionBody(text, tasksStep())
    expect(body).toContain('`/speckit.tasks`')
    expect(body).toContain('中身をそのまま貼る。言い換えない。要約もしない。')
    expect(body.split('\n').filter(line => line.trimStart().startsWith('```'))).toHaveLength(2)
  })

  it('渡す指示は、表の形と置き場を持つ', () => {
    const block = tasksBlock()
    for (const word of [TABLE_HEADER, '`## Dependencies & Execution Order`', '`### Phase Dependencies`']) expect(block).toContain(word)
  })

  it('渡す指示は、種類を決める 2 つの問いを、開発ブランチを基準に持つ', () => {
    const block = tasksBlock()
    expect(block).toContain('前提の変更を、手元のブランチか試験環境で動かして、このフェーズの実装と確認ができる。このときは「スタックできる」')
    expect(block).toContain('前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、このフェーズの実装か確認ができない。このときは「マージを待つ」')
    expect(block).toContain('試験環境は、開発ブランチに入れる前の変更を動かして確かめる場所だ。プロジェクトの文書に、その場所で動かす手順があるときだけ使う。無いときは、手元のブランチだけで判断する。')
    expect(block).not.toContain('main に入っていない')
  })

  it('マージを待つになる例は 3 つで、配られるもの・リリースの後・開発ブランチのワークフローを挙げる', () => {
    const examples = linesAfter(tasksBlock(), MERGE_EXAMPLES_HEADING)
    expect(examples).toHaveLength(3)
    expect(examples[0]).toContain('既定のブランチから配られるものを使う')
    expect(examples[0]).not.toContain('プラグイン')
    expect(examples[1]).toContain('リリースの後の実物で確かめる')
    expect(examples[2]).toContain('開発ブランチの CI やリリースのワークフロー')
  })

  it('渡す指示は、読み違いにつながる決まりを持つ', () => {
    const block = tasksBlock()
    for (const word of ['前提の無いフェーズは、表に書かない', '直接の前提だけ', 'すべての行', '見出しの行と区切りの行だけの表']) expect(block).toContain(word)
  })

  it('渡す指示に、行頭が ## の行を置かない', () => {
    expect(tasksBlock().split('\n').filter(line => line.trimStart().startsWith('##'))).toEqual([])
  })

  it('確かめの Step は、表の形・フェーズの番号・種類・理由の 4 つを確かめる', () => {
    const body = sectionBody(text, checkStep())
    expect(body).toContain(`1. \`${TABLE_HEADER}\` の 4 列の表がある`)
    expect(body).toContain('2. `Phase` と `前提` が数字だけで、どれも tasks.md のフェーズの見出し（`## Phase <番号>:`）にある')
    expect(body).toContain('3. `種類` の値が、どの行も「スタックできる」か「マージを待つ」')
    expect(body).toContain('4. すべての行に `理由` がある')
  })

  it('確かめが通らずやり直すときは、tasks の Step のコードブロックを貼り直し、外れた箇所を 1 行足す', () => {
    const body = sectionBody(text, checkStep())
    expect(body).toContain('のコードブロックをもう一度そのまま貼り、その後ろに、通らなかった確かめと箇所を 1 行足して `/speckit.tasks` を実行する')
    expect(body).toContain('やり直しは 1 回まで')
  })

  it('承認の修正を指示する・やり直すで tasks の工程を実行するときも、コードブロックを貼り直す', () => {
    const body = sectionBody(text, checkStep())
    expect(body).toContain('「修正を指示する」「やり直す」で tasks の工程をもう一度実行するときも、')
    expect(body.match(/のコードブロックをもう一度そのまま貼/gu)).toHaveLength(2)
  })

  it('マージを待つ行の理由が空のときは、ユーザーに確かめ、答えを main が理由のセルに書く', () => {
    const body = sectionBody(text, checkStep())
    for (const word of ['開発ブランチに入っていないと進められない訳をユーザーに確かめる', 'エージェントが理由を作らない', 'ユーザーが答えた文を、main がその行の `理由` のセルにそのまま書く', 'tasks の工程はやり直さない', 'やり直しの回数に数えない']) expect(body).toContain(word)
    expect(body).not.toContain('main に入っていない')
  })

  it('スタックできる行の理由が空のときは、tasks の工程をやり直す', () => {
    expect(sectionBody(text, checkStep())).toContain('「スタックできる」の行の理由が空のとき')
  })

  it('analyze の案内は、確かめの Step の承認の文より後ろにある', () => {
    const body = sectionBody(text, checkStep())
    const approval = body.indexOf('AskUserQuestion')
    expect(approval).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('/speckit.analyze')).toBeGreaterThan(approval)
  })

  it('起票の Step は、Epic の特定の後、specify の前にある', () => {
    expect(titleIndex(headings, '対象Epic')).toBeLessThan(fileStep())
    expect(fileStep()).toBeLessThan(titleIndex(headings, 'specify'))
  })

  it('起票の Step は、issue_create を freeform と owner/repo/N の parent_epic で呼び、session_start に base を渡さない', () => {
    const body = sectionBody(text, fileStep())
    for (const word of ['`issue_create`', '`freeform: true`', '`parent_epic`: Step 3 で読んだ Epic の `owner/repo/N`', '`session_start`', '`base` は渡さない']) expect(body).toContain(word)
  })

  it('起票の Step は、既存の分解のタスクを 3 通りに分けて扱い、2 重に起票しない', () => {
    const body = sectionBody(text, fileStep())
    for (const row of ['| タスクと、紐づいたブランチ | 起票しない。', '| タスクだけ（ブランチが無い） | 起票しない。', '| どちらも無い | 起票し、']) expect(body).toContain(row)
    expect(body).toContain('`feat/breakdown-`')
    expect(body.indexOf('題に「speckit で分解する:」を含む OPEN の sub-issue を探す')).toBeLessThan(body.indexOf('紐づいたブランチを確かめる'))
    expect(body).toContain('`speckit で分解する: <Epic の題>`')
  })

  it('specify の Step は、/speckit.specify に足す 1 行で、今のブランチ名と --allow-existing-branch を hook に渡す', () => {
    const block = firstCodeBlock(sectionBody(text, titleIndex(headings, 'specify')))
    for (const word of ['GIT_BRANCH_NAME', '--allow-existing-branch', 'create-new-feature-branch.sh --json']) expect(block).toContain(word)
    expect(block.startsWith('次の指示は hook の動かし方で、機能の説明ではない。spec には書かない。')).toBe(true)
  })

  it('specify の Step は、git 拡張の hook が無いか切れているリポでは何も足さない', () => {
    const body = sectionBody(text, titleIndex(headings, 'specify'))
    expect(body).toContain('`enabled` は `false` でない')
    expect(body).toContain('条件に当たらないリポでは、何も足さない')
  })

  it('準備の Step は、再開のときに spec のディレクトリを求め、.specify/feature.json を書き直す', () => {
    const body = sectionBody(text, titleIndex(headings, '準備'))
    expect(body).toContain('git diff --name-only origin/<開発ブランチ>...HEAD -- specs/')
    expect(body).toContain('"feature_directory": "specs/<NNN-名前>"')
  })

  it('specify・clarify・確かめの Step は、承認の後に spec のディレクトリを commit して push させる', () => {
    for (const position of [titleIndex(headings, 'specify'), clarifyStep(), checkStep()]) {
      expect(sectionBody(text, position)).toContain('を commit し、タスクのブランチへ push する')
    }
  })

  it('最後の Step は、w-pr を案内し、w-issueize はマージの後に案内する', () => {
    const body = sectionBody(text, headings.length - 1)
    expect(body).toContain('`/pecot-w:w-pr`')
    expect(body.indexOf('PR のマージの後')).toBeLessThan(body.indexOf('`/pecot-w:w-issueize`'))
    expect(body).toContain('w-pr は、このスキルから起動しない')
  })

  it('表の列の名前は、w-issueize の Step 2 が読む列と同じ', () => {
    const block = tasksBlock()
    const header = block.split('\n').find(line => line.trim() === TABLE_HEADER) ?? ''
    const written = header.split('|').map(cell => cell.trim()).filter(cell => cell !== '')
    const issueize = readSkill('w-issueize')
    const body = sectionBody(issueize, titleIndex(stepHeadings(issueize), '前提'))
    const read = /4 列の表（([^）]+)）/u.exec(body)?.[1]?.split('・') ?? []
    expect(written).toEqual(['Phase', '前提', '種類', '理由'])
    expect(read).toEqual(written)
  })
})

describe('w-issueize の前提の表の読み方', () => {
  const text = readSkill('w-issueize')
  const body = sectionBody(text, titleIndex(stepHeadings(text), '前提'))

  const step = sectionBody(text, titleIndex(stepHeadings(text), 'Issueとして作成'))

  it('見出しの行と区切りの行だけの表は、前提が無いと読み、文から前提を読まない', () => {
    expect(body).toContain('見出しの行と区切りの行だけの表')
    expect(body).not.toContain('見出しの行だけの表')
    expect(body).toContain('「前提が無い」と読む')
    expect(body).toContain('文から前提を読まない')
  })

  it('reason は、表の理由の文をそのまま写し、言い換えさせない', () => {
    expect(step).toContain('そのまま写した `reason`')
    expect(step).toContain('言い換えない')
    expect(step).not.toContain('1 行で写した')
    // 例の表の理由と、例の reason が同じ文
    const reason = exampleReason(step)
    expect(reason).toBeDefined()
    expect(step).toContain(`| マージを待つ | ${reason ?? ''} |`)
  })

  it('reason を YAML に書くときは、表の \\| を戻してから、バックスラッシュと二重引用符を逃がし、改行しない', () => {
    expect(step).toContain('表の `\\|` を `|` に戻してから、`\\` を `\\\\`、`"` を `\\"` にする')
    expect(step).toContain('`reason` は 1 行で書き、改行を入れない')
  })

  it('テンプレートの例の reason は、w-issueize の例の reason と同じ文', () => {
    const template = readPluginFile('cli/templates/issue/task-implement.md')
    expect(exampleReason(template)).toBe(exampleReason(step))
  })

  it('テンプレートは、表の理由をそのまま写した 1 行の reason を求める', () => {
    const template = readPluginFile('cli/templates/issue/task-implement.md')
    expect(template).toContain('表の `理由` の文をそのまま写した `reason`（改行しない）')
    expect(template).not.toContain('1 行の `reason` を足す')
  })
})

describe('前提の種類を決める文', () => {
  const STACK_PHRASE = '前提の変更を、手元のブランチか試験環境で動かして'
  const MERGE_PHRASE = '手元のブランチと試験環境のどちらでも'

  it.for([
    'skills/w-breakdown/SKILL.md',
    'skills/w-ready/SKILL.md',
    'skills/w-help/references/issue-flow-rules.md',
    'skills/w-help/references/spec-driven-workflow.md',
  ])('%s は、スタックできる・マージを待つの文に、試験環境の句を持つ', (file) => {
    const text = readPluginFile(file)
    expect(text).toContain(STACK_PHRASE)
    expect(text).toContain(MERGE_PHRASE)
  })

  it('issue-flow-rules の merge の説明は、プラグインをマージを待つ例に挙げない', () => {
    const line = readPluginFile('skills/w-help/references/issue-flow-rules.md').split('\n').find(text => text.startsWith('- `merge`（マージを待つ）'))
    expect(line).toBeDefined()
    expect(line).not.toContain('プラグイン')
  })
})
