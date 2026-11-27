/* eslint-disable security/detect-non-literal-fs-filename -- 確かめるのはプラグイン内のリンク先のみ */
// w-active・w-quick・w-review・w-pr・w-issueize・w-breakdown の手順（Step の順序と見出し）が崩れていないことを確かめる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { pluginRoot, readPluginFile } from './_helpers/documents.js'

const PARALLEL_SPAWN_NOTE = '1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。'
const SERIAL_REASON_MARKER = '(直列の理由: ...)'
const STEP_HEADING = /^### Step (\d+)[:：] ?(.+)$/u
// マージされた後の片付けの手順を、同じ中身の references/after-merge.md で持つスキル
const AFTER_MERGE_SKILLS = ['w-pr', 'w-active', 'w-quick', 'w-breakdown']

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

  it('調査、計画ドラフト、プランモードの順に並ぶ', async () => {
    await explains('`w-active` と `w-quick` の `SKILL.md` に書かれた手順のテストです。Step の見出しが、調査・計画ドラフト・プランモードの順に並んでいることを確認します。')
    expect(titleIndex(headings, '調査')).toBeLessThan(titleIndex(headings, '計画ドラフト'))
    expect(titleIndex(headings, '計画ドラフト')).toBeLessThan(titleIndex(headings, 'プランモード'))
  })

  it('確認を求める前に、通常モードで計画を Issue へ投稿する', async () => {
    await explains('`w-active` と `w-quick` の計画の投稿に関するテストです。計画ドラフトの後、プランモードの前に、`issue_comment_check` に通して `add_issue_comment` で計画を Issue に投稿する Step が存在することを確認します。')
    const draft = titleIndex(headings, '計画ドラフト')
    const post = titleIndex(headings, '計画の投稿')
    const body = sectionBody(text, post)
    const draftBody = sectionBody(text, draft)
    expect(draftBody).toContain('`pecot-template://comment/plan`')
    expect(draft).toBeLessThan(post)
    expect(post).toBeLessThan(titleIndex(headings, 'プランモード'))
    expect(body).toContain('`issue_comment_check` に通す。通ったら、公式の MCP の `add_issue_comment` で Issue に投稿する')
    expect(body).toContain('`comment_id`')
  })

  it('調査は、ブランチ切り替えの後にある', async () => {
    await explains('`w-active` と `w-quick` の Step の順序のテストです。ブランチ切り替えの Step が、調査の Step より前に存在することを確認します。')
    expect(titleIndex(headings, 'ブランチ切り替え')).toBeLessThan(titleIndex(headings, '調査'))
  })

  it('計画ドラフトの Step は、計画の投稿より前に、参照の clarify に従って曖昧な点を AskUserQuestion で聞く', async () => {
    await explains('計画ドラフトの Step のテストです。計画の投稿より前に、参照先の `plan-clarify.md` に従って曖昧な点を `AskUserQuestion` で質問する手順が書かれ、リンク先のファイルが存在することを確認します。')
    const draft = titleIndex(headings, '計画ドラフト')
    const draftBody = sectionBody(text, draft)
    const link = '../w-help/references/plan-clarify.md'
    expect(draft).toBeLessThan(titleIndex(headings, '計画の投稿'))
    expect(draftBody).toContain(`](${link}) に従って clarify を行う`)
    expect(draftBody).toContain('Issue と依頼の曖昧な点を AskUserQuestion で聞き、答えを受けるたびに、できたファイルへ書く')
    expect(draftBody.indexOf('clarify を行う')).toBeLessThan(draftBody.indexOf('テンプレの見出しと規則のとおりに計画を書く'))
    expect(existsSync(path.join(pluginRoot, 'skills', name, link))).toBe(true)
  })

  it('EnterPlanMode を呼ばない、という注意を手順に書かない', async () => {
    await explains('`w-active` と `w-quick` の `SKILL.md` のテストです。`EnterPlanMode` を呼ばないという注意書きが、手順に含まれないことを確認します。')
    expect(text).not.toContain('EnterPlanMode を呼ばない')
  })

  it('プランモードの手順に、投稿した計画で承認を得るという宣言が含まれる', async () => {
    await explains('プランモードの Step のテストです。投稿した計画で承認を得るという文が、Step の本文に含まれることを確認します。')
    expect(sectionBody(text, titleIndex(headings, 'プランモード'))).toContain('投稿した計画で承認を得る')
  })
})

describe('w-active の手順', () => {
  const text = readSkill('w-active')
  const headings = stepHeadings(text)

  it('利用者が一覧から選ぶと、allowed-tools の許可を得るため、選んだ Issue を引数にスキルを呼び直す', async () => {
    await explains('`w-active` の Step 1 のテストです。利用者が一覧から Issue を選んだ場合に、選んだ Issue を引数にしてスキルを呼び直し、引数に Issue がある場合は一覧を表示せずに Step 2 から進むと書かれていることを確認します。')
    const body = sectionBody(text, 0)
    expect(body).toContain('Skill ツールで `pecot-w:w-active` を、選んだ Issue を引数にして呼び直す')
    expect(body).toContain('スキルの引数に Issue があるときは、一覧を飛ばして Step 2 から進む')
  })

  it('レビューは、計画ドラフトとプランモードの間にある', async () => {
    await explains('`w-active` の Step の順序のテストです。レビューの Step が、計画ドラフトの後、プランモードの前に存在することを確認します。')
    const review = titleIndex(headings, 'レビュー')
    expect(titleIndex(headings, '計画ドラフト')).toBeLessThan(review)
    expect(review).toBeLessThan(titleIndex(headings, 'プランモード'))
  })

  it('レビューは一巡 1 回で、再レビューを求めない', async () => {
    await explains('`w-active` のレビューの Step のテストです。`w-plan-reviewer` を一巡で 1 回だけ起動し、再レビューは不要と書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'レビュー'))
    for (const word of ['w-plan-reviewer', '一巡 1 回', '再レビューは不要']) expect(body).toContain(word)
  })

  it('レビューは、w-plan-reviewer を 1 回起動し、ほかのエージェントを起動しない', async () => {
    await explains('`w-active` のレビューの Step のテストです。`Agent` ツールで `w-plan-reviewer` だけを起動し、`w-e2e-planner` や `w-implementer` など、ほかのエージェントの記述が含まれないことを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'レビュー'))
    expect(body).toContain('`Agent` ツールで w-plan-reviewer を 1 回起こし')
    expect(body).toContain('agent teams が有効なら `name: w-plan-reviewer` を付ける')
    expect(body).not.toContain('agent ID を控える')
    for (const agent of ['w-e2e-planner', 'w-implementer']) expect(body).not.toContain(agent)
    for (const word of ['並列 spawn', '単発 spawn', '待機']) expect(body).not.toContain(word)
  })

  it('ブランチ作成で止まったときは、エラーの案内を利用者に示し、エージェントの判断で先へ進めない', async () => {
    await explains('`w-active` のブランチ作成の Step のテストです。止まった場合は、エラーの案内を利用者に表示して止まり、先へ進む判断をエージェントが行わないと書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'ブランチ作成'))
    for (const word of ['エラーの案内を利用者に示して止まる', 'エージェントの判断で先へ進めない', '前提を見直すかどうかは利用者が決める', '`base` を渡さない']) expect(body).toContain(word)
  })

  it('Step 1 は、着手できる Issue だけを表で表示する', async () => {
    await explains('`w-active` の Step 1 のテストです。着手できる Issue だけを表で利用者に表示し、`AskUserQuestion` は使わないと書かれていることを確認します。')
    expect(text).toContain('着手できる Issue だけを、次の表で利用者に示す')
    expect(text).toContain('AskUserQuestion は使わない')
  })

  it('ブランチ作成では base を渡さず、スタックして着手した旨を伝える', async () => {
    await explains('`w-active` のブランチ作成とブランチ切り替えの Step のテストです。`base` を渡さずにブランチを作成し、別の Issue の上にスタックして着手した場合は、その旨を利用者に伝えると書かれていることを確認します。')
    const create = sectionBody(text, titleIndex(headings, 'ブランチ作成'))
    const switching = sectionBody(text, titleIndex(headings, 'ブランチ切り替え'))
    expect(create).toContain('`base` は渡さない')
    expect(switching).toContain('作ったブランチに切り替える')
    expect(switching).toContain('別の Issue の上にスタックして着手したときは、その旨を利用者に伝える')
  })

  it('実装の Step は、計画の CUJ を main が cuj-run.md に従って流すと書き、リンク先が実在する', async () => {
    await explains('`w-active` の実装の Step のテストです。計画の CUJ を `cuj-run.md` に従って実行すると書かれ、リンク先のファイルが存在することを確認します。')
    const body = sectionBody(text, titleIndex(headings, '実装'))
    expect(body).toContain('計画の CUJ を main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流す。')
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-help', 'references', 'cuj-run.md'))).toBe(true)
  })

  it('base の選び方を、スキルの文に書かない', async () => {
    await explains('`w-active` の `SKILL.md` のテストです。`--base` や `develop_branch` など、ブランチの基準の選び方に関する記述が含まれないことを確認します。')
    expect(text).not.toContain('--base')
    expect(text).not.toContain('develop_branch')
  })
})

describe('w-quick の手順', () => {
  const text = readSkill('w-quick')
  const headings = stepHeadings(text)

  it('w-quick は、レビューの手順を持たない', async () => {
    await explains('`w-quick` の手順のテストです。題にレビューを含む Step が存在しないことを確認します。')
    expect(headings.filter(heading => heading.title.includes('レビュー'))).toEqual([])
  })

  it('Step 1 は、session_show でセッションのリポジトリを確認し、テンプレートを渡さずに issue_check で確かめて issue_write で起票する', async () => {
    await explains('`w-quick` の Step 1 のテストです。`session_show` でセッションのリポジトリを確認すると書かれていることを確認します。続けて、`template` を渡さずに `issue_check` を通し、公式の MCP の `issue_write` で Issue を作成すると書かれていることも確認します。')
    const body = sectionBody(text, numberIndex(headings, 1))
    expect(body).toContain('公式の MCP の `issue_write` で、Issue を作る')
    expect(body).toContain('`session_show`')
    expect(body).toContain('`issue_check` に、`template` を渡さずに通す')
  })

  it('Step 2 は、session_start でブランチを作り、切り替える', async () => {
    await explains('`w-quick` の Step 2 のテストです。`session_start` で、作成した Issue に紐づくブランチを作成し、`git checkout` で切り替えると書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 2))
    expect(body).toContain('`session_start` を使って、作った Issue に紐づくブランチを作る')
    expect(body).toContain('git checkout')
  })
})

describe('w-review の手順', () => {
  const text = readSkill('w-review')
  const headings = stepHeadings(text)

  it('Step は 1〜4 だけで、採否を聞く・直す・resolve する Step を持たない', async () => {
    await explains('`w-review` の手順のテストです。Step が 1 から 4 までだけで、`AskUserQuestion` や `w-implementer` など、採否の確認や修正に関する記述が含まれないことを確認します。')
    expect(headings.map(heading => heading.number)).toEqual([1, 2, 3, 4])
    for (const word of ['AskUserQuestion', 'resolveReviewThread', 'review-resolution', 'w-implementer']) expect(text).not.toContain(word)
  })

  it('w-review は、Step 1 の前に、引数の project を pecot-workflow の MCP ツールへ渡す文がある', async () => {
    await explains('`w-review` の手順の冒頭のテストです。引数に `project=<名前>` がある場合に、その名前を `project` として MCP ツールへ渡す文があることを確認します。')
    const lines = text.split('\n')
    const start = lines.indexOf('## 手順')
    const preamble = lines.slice(start, headings[0]?.line).join('\n')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(preamble).toContain('引数に `project=<名前>` があれば、このスキルで使う pecot-workflow の MCP ツールに、その名前を `project` で渡す。')
    expect(preamble).toContain('渡す先は `pr_show` の 1 つ。')
  })

  it('w-review の Step 1 は、スタックし直さない', async () => {
    await explains('`w-review` の Step 1 のテストです。`pr_restack` に関する記述が含まれないことを確認します。')
    expect(sectionBody(text, numberIndex(headings, 1))).not.toContain('pr_restack')
  })

  it('2 巡目以降は、前の指摘が直ったかを先に判定し、F-NN を振り直さない', async () => {
    await explains('`w-review` の 2 巡目以降の手順のテストです。前回の指摘ごとに、直ったかどうかを判定する手順があり、番号は PR 内の通し番号として振り直さないと書かれていることを確認します。')
    expect(sectionBody(text, numberIndex(headings, 2))).toContain('F-NN ごとに、直ったか・直っていないかを決める')
    expect(sectionBody(text, numberIndex(headings, 4))).toContain('番号は PR の中の通し番号にし、振り直さない。')
    expect(text).not.toMatch(/R\d+\/F-/u)
  })

  it('w-review の Step 1 は、PR が閉じる Issue とコメントを公式の MCP で読み、計画が存在しなければ計画と比較する手順を省略する', async () => {
    await explains('`w-review` の Step 1 のテストです。`closing_issues` の Issue を公式の MCP の `issue_read` の `get` と `get_comments` で読むと書かれていることを確認します。計画が存在しない場合は、比較を省略してレビューを続けることも確認します。')
    const body = sectionBody(text, numberIndex(headings, 1))
    for (const phrase of ['`closing_issues`', '`issue_read`', '`get_comments`', '`## Plan` と `## PECOT-Workflow`', '計画と照らす手順を飛ばしてレビューを続ける']) expect(body).toContain(phrase)
  })

  it('視点の参照は、[tech] の節の下に、計画と比較する節を持つ', async () => {
    await explains('`review-viewpoints.md` のテストです。`[tech]` の節の下に「計画と照らす」の節が存在し、`w-review` の Step 3 がその節を参照することを確認します。')
    const viewpoints = readPluginFile('skills/w-review/references/review-viewpoints.md')
    const tech = viewpoints.indexOf('## [tech] ')
    expect(tech).toBeGreaterThanOrEqual(0)
    expect(viewpoints.indexOf('### 計画と照らす', tech)).toBeGreaterThan(tech)
    expect(sectionBody(text, numberIndex(headings, 3))).toContain('「計画と照らす」')
  })

  it('Step 3 は、main が視点の参照に従ってレビューし、サブエージェントを起こさない', async () => {
    await explains('`w-review` の Step 3 のテストです。`main` が視点の参照に従って diff をレビューすると書かれ、リンク先のファイルが存在し、サブエージェントの起動に関する記述が含まれないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 3))
    expect(body).toContain('main が diff をレビューする')
    const link = 'references/review-viewpoints.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-review', link))).toBe(true)
    for (const word of ['`Agent`', '`SendMessage`', 'w-plan-reviewer', 'cuj-run.md']) expect(body).not.toContain(word)
  })

  it('Step 4 のインラインコメントは、レビューの指摘に視点の印を付け、外部のレビュアーの指摘には付けない', async () => {
    await explains('`w-review` の Step 4 のインラインコメントのテストです。指摘を `**F-NN** [視点の印]` の形で始め、`[tech]` や `[cuj]` の印を付け、外部のレビュアーの指摘には印を付けないと書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 4))
    expect(body).toContain('`**F-NN** [視点の印]` で始める')
    for (const mark of ['`[tech]`', '`[cuj]`']) expect(body).toContain(mark)
    expect(body).toContain('外部のレビュアーの指摘には印を付けない')
  })

  it('Step 4 は、インラインコメントを action の MCP ツールで投稿し、gh を使わない', async () => {
    await explains('`w-review` の Step 4 のテストです。`create_inline_comment` を使ってインラインコメントを投稿すると書かれ、`gh api` や `gh auth` を使う記述が含まれないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 4))
    expect(body).toContain('`create_inline_comment`')
    expect(text).not.toMatch(/\bgh (api|auth)\b/u)
  })

  it('Step 4 は、投稿で終わる', async () => {
    await explains('`w-review` の Step 4 のテストです。投稿した後は、採否を質問せず、コードの修正やスレッドの resolve を行わずに終了すると書かれていることを確認します。')
    expect(sectionBody(text, numberIndex(headings, 4))).toContain('投稿したら終わる。採否は聞かず、コードは直さない。スレッドの resolve もしない。')
  })
})

describe('w-pr の手順', () => {
  const text = readSkill('w-pr')
  const headings = stepHeadings(text)

  it('Step 5 は、CI を待つ Step 4 の後で、レビューの指摘に対応する', async () => {
    await explains('`w-pr` の Step の順序のテストです。レビューの指摘に対応する Step が、CI を待って修正する Step より後に存在することを確認します。')
    expect(titleIndex(headings, 'CI を待って直す')).toBeLessThan(titleIndex(headings, 'レビューの指摘に対応'))
  })

  it('Step 5 は、採否を利用者に聞かず、main が決めて対応してから報告する', async () => {
    await explains('`w-pr` の Step 5 のテストです。採否を利用者に質問せず、`main` が F-NN ごとに対応か対応不要かを決め、対応を終えてから報告すると書かれ、既定は対応とすることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).not.toContain('AskUserQuestion')
    expect(body).toContain('#### 採否を決める')
    expect(body).toContain('採否を利用者に聞かない。main が F-NN ごとに「対応」か「対応不要」かを決め、対応を終えてから報告する。')
    expect(body).toContain('既定は「対応」にする')
    expect(body).toContain('採否は main が決め、途中で利用者に確かめない。')
  })

  it('Step 5 は、対応不要にできる場合を絞り、理由に根拠を添えてスレッドに返信させる', async () => {
    await explains('`w-pr` の Step 5 のテストです。対応不要にできる場合を限定し、その理由に根拠を添えてスレッドへ返信すると書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    for (const word of ['指摘が事実と違う', '承認された計画や Issue の決めた仕様・挙動と食い違う', 'その理由に同意する', '確かめた根拠', '保留や別 Issue への先送りにしない', '対応不要の F-NN のスレッドに、理由を返信する']) expect(body).toContain(word)
  })

  it('Step 5 は、main が直すことを基本にし、委譲する条件を subagent-usage.md から読ませる', async () => {
    await explains('`w-pr` の Step 5 のテストです。`main` が修正することを基本とし、委譲する条件を `subagent-usage.md` で参照させる記述があり、リンク先のファイルが存在することを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('main が直すことを基本にする')
    expect(body).toContain('当たらなければ main が直し、w-implementer を起こさない')
    const link = '../w-help/references/subagent-usage.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-pr', link))).toBe(true)
    expect(body.indexOf(link)).toBeLessThan(body.indexOf('複数 w-implementer の並列起動を既定とする'))
  })

  it('Step 5 は、委譲するときに複数の w-implementer の並列起動を既定にし、直列の理由を書かせる', async () => {
    await explains('`w-pr` の Step 5 のテストです。修正を委譲する場合に、複数の `w-implementer` を並列に起動することを既定とし、直列にする理由を書く記述が含まれることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('条件に当たって委譲するときは')
    expect(body).toContain('複数 w-implementer の並列起動を既定とする')
    expect(body).toContain(SERIAL_REASON_MARKER)
    expect(body).toContain(PARALLEL_SPAWN_NOTE)
  })

  it('Step 5 は、割り当て表の書式とモデルの基準へのリンクを持ち、リンク先が実在する', async () => {
    await explains('`w-pr` の Step 5 のテストです。割り当て表の書式と、モデルの基準へのリンクが含まれ、リンク先のファイルが存在することを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('実装者名 / モデル / 担当 F-NN / 担当ファイル群')
    const link = '../w-help/references/agent-models.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-pr', link))).toBe(true)
  })

  it('Step 5 の CUJ の再実行は、main が CUJ の流し方の参照に従って流し、サブエージェントに渡さない', async () => {
    await explains('`w-pr` の Step 5 のテストです。CUJ の再実行は `main` が `cuj-run.md` に従って行い、サブエージェントには任せないと書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流し直す。サブエージェントには渡さない。')
  })

  it('Step 5 は、F-NN とスレッドの対応表のクエリを自分で持ち、w-review を案内しない', async () => {
    await explains('`w-pr` の Step 5 のテストです。F-NN とスレッド ID の対応表を取得するクエリが `w-pr` の中に書かれ、`w-review` への案内が含まれないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('#### F-NN とスレッド ID の対応表')
    expect(body).toContain('reviewThreads(first: 100)')
    expect(body).not.toContain('/pecot-w:w-review')
  })

  it('Step 5 は、session_show で子 PR を確認し、存在すれば pr_restack が必要な旨を報告に含める', async () => {
    await explains('`w-pr` の Step 5 のテストです。`review-resolution` の投稿より後に `session_show` で子 PR を確認し、`pr_restack` が必要な旨を報告すると書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('`session_show`')
    expect(body).toContain('`pr_restack`')
    expect(body.indexOf('`session_show`')).toBeGreaterThan(body.indexOf('`review-resolution` を投稿'))
    expect(body).not.toContain('git rebase')
  })

  it('Step 5 の一括 resolve は、別名を使う', async () => {
    await explains('`w-pr` の Step 5 の一括 resolve のテストです。複数のスレッドを GraphQL の別名（`t1:` など）で 1 回のクエリにまとめ、`$threadId` の変数は使わないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body.match(/\bt\d+:\s*resolveReviewThread/gu)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(body).not.toContain('$threadId')
  })

  it('Step 6 は、レビューの指摘に対応した後で、マージを待ち受けて片付ける', async () => {
    await explains('`w-pr` の Step の順序のテストです。マージを待ち受けて片付ける Step が、レビュー指摘の対応の Step より後ろに並ぶことを確認します。')
    expect(titleIndex(headings, 'レビューの指摘に対応')).toBeLessThan(titleIndex(headings, 'マージを待ち受けて片付ける'))
  })

  it('Step 4 は、CI の待ちの間もコンフリクトを待ち受け、出力ごとに次の手順を持つ', async () => {
    await explains('`w-pr` の Step 4 のテストです。`wait-pr.cjs` を `ci` の待ち方で起動し、CI の結果とコンフリクトの出力ごとに次の手順があり、`gh pr checks --watch` で CI だけを待たないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 4))
    expect(body).toContain('node <このスキルの base directory>/scripts/wait-pr.cjs ci <PR の URL>')
    for (const word of ['CI_PASSED', 'CI_FAILED', 'NO_CHECKS', 'CONFLICTING', 'DEQUEUED', 'TIMEOUT', '待ち受けを続けられません:']) expect(body).toContain(`| \`${word}`)
    expect(body).not.toContain('--watch')
    expect(body).toContain('コンフリクトの直しは、この回数に数えない')
  })

  it('Step 6 は、待ち受けのスクリプトの出力ごとに次の手順を持ち、コンフリクトと queue からの外れと CI の失敗で Step 4 に戻す', async () => {
    await explains('`w-pr` の Step 6 のテストです。`wait-pr.cjs` を `merge` の待ち方で起動し、出力ごとに次の手順があり、コンフリクト・queue からの除外・CI の失敗で Step 4 に戻ることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 6))
    expect(body).toContain('node <このスキルの base directory>/scripts/wait-pr.cjs merge <PR の URL>')
    for (const word of ['MERGED', 'CLOSED', 'CONFLICTING', 'CI_FAILED', 'DEQUEUED', 'TIMEOUT', '待ち受けを続けられません:']) expect(body).toContain(`| \`${word}`)
    expect(body.match(/Step 4 に戻り/gu)).toHaveLength(3)
    expect(body).toContain('マージされずに閉じられた旨を利用者に伝えて止まる。片付けない')
  })

  it('Step 4 と Step 6 は、background の待ちが終わったら、w-pr を resume で呼び直させる', async () => {
    await explains('`w-pr` の Step 4 と Step 6 のテストです。background での待機が終わった後に、`pecot-w:w-pr` を引数 `resume` で呼び直すと書かれていることを確認します。')
    for (const step of [4, 6]) {
      expect(sectionBody(text, numberIndex(headings, step)), `Step ${String(step)}`).toMatch(/Skill ツールで `pecot-w:w-pr` を引数 `resume` で呼び直/u)
    }
  })

  it('Step 1 は、引数を本文に受け、resume のときに Step 4 か Step 6 の出力から続けさせる', async () => {
    await explains('`w-pr` の Step 1 のテストです。引数が `resume` の場合に、Step 4 または Step 6 の出力から続きを行う手順が書かれ、参照先の見出しへのリンクが含まれることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 1))
    expect(body).toContain('引数: $ARGUMENTS')
    expect(body).toContain('引数が `resume` なら')
    expect(body).toContain('[Step 4](#step-4-ci-を待って直す) の出力を読むところから続ける')
    expect(body).toContain('[Step 6](#step-6-マージを待ち受けて片付ける) の出力の表から続ける')
    expect(body).toContain('- CI 待ちの `wait-pr.cjs ci` なら、')
    expect(body).toContain('- マージ待ちの `wait-pr.cjs merge` なら、')
  })

  it('Step 4 と Step 5 は、途中で終えずに Step 6 の待ち受けへつなぐ', async () => {
    await explains('`w-pr` の Step 4 と Step 5 のテストです。途中で終了せず、Step 5 から Step 6 の待ち受けへ進むと書かれていることを確認します。')
    expect(sectionBody(text, numberIndex(headings, 4))).toContain('その旨を伝えて Step 5 へ進む')
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).not.toMatch(/伝えて終える/u)
    expect(body).toContain('push する修正が無ければ、Step 6 へ進む')
  })
})

describe('w-handoff の手順', () => {
  const text = readSkill('w-handoff')
  const headings = stepHeadings(text)

  it('Step は 1〜3 で、PR と Issue を読む・merge-diff・precede-notify の順に並ぶ', async () => {
    await explains('`w-handoff` の手順のテストです。Step が 1 から 3 までで、2 番目の題に `merge-diff`、3 番目の題に `precede-notify` を含むことを確認します。')
    expect(headings.map(heading => heading.number)).toEqual([1, 2, 3])
    expect(headings[1]?.title).toContain('merge-diff')
    expect(headings[2]?.title).toContain('precede-notify')
  })

  it('frontmatter に allowed-tools を持たず、手元のセッションでは使わないと書く', async () => {
    await explains('`w-handoff` の frontmatter のテストです。`allowed-tools` を持たず、`when_to_use` に手元のセッションでは使わないと書かれていることを確認します。')
    const frontmatter = text.slice(0, text.indexOf('\n---', 4))
    expect(frontmatter).not.toContain('allowed-tools')
    expect(frontmatter).toContain('when_to_use:')
    expect(frontmatter).toContain('Not for a local session.')
  })

  it('w-handoff は、Step 1 の前に、引数の project を pecot-workflow の MCP ツールへ渡す文がある', async () => {
    await explains('`w-handoff` の手順の冒頭のテストです。引数に `project=<名前>` がある場合に、その名前を `project` として MCP ツールへ渡す文があることを確認します。')
    const lines = text.split('\n')
    const preamble = lines.slice(lines.indexOf('## 手順'), headings[0]?.line).join('\n')
    expect(preamble).toContain('引数に `project=<名前>` があれば、このスキルで使う pecot-workflow の MCP ツールに、その名前を `project` で渡す。')
    expect(preamble).toContain('渡す先は `pr_show` の 1 つ。')
  })

  it('Step 1 は、閉じた Issue を closing issues とブランチ名の番号から特定し、親 Epic が存在しなければ何も投稿せずに終了する', async () => {
    await explains('`w-handoff` の Step 1 のテストです。`pr_show` の `closing_issues` と `head_ref` から閉じた Issue を特定し、`parent` が存在しない場合は何も投稿せずに終了することを確認します。')
    const body = sectionBody(text, numberIndex(headings, 1))
    for (const phrase of ['`pr_show`', '`closing_issues`', '`head_ref`', '`/<番号>`', '`issue_read`', '`parent`', '何も投稿せずに終える']) expect(body).toContain(phrase)
    expect(body).not.toContain('session_finish')
  })

  it('Step 2 は、diff と計画のコメントを比較し、テンプレートのガイドで書いた本文を issue_comment_check に通して Epic に投稿する', async () => {
    await explains('`w-handoff` の Step 2 のテストです。diff と計画のコメントを比較し、`merge-diff` の本文を `issue_comment_check` で確かめて `add_issue_comment` で投稿すると書かれていることを確認します。計画どおりの場合も投稿することを確認します。')
    const body = sectionBody(text, numberIndex(headings, 2))
    for (const phrase of ['`gh pr diff', '`## Plan` と `## PECOT-Workflow`', '`pecot-template://comment/merge-diff`', '`issue_comment_check`', '`add_issue_comment`', '計画どおりで違いが無いときも、その旨を投稿する。']) {
      expect(body).toContain(phrase)
    }
  })

  it('Step 3 は、speckit 由来のときだけ、閉じた Issue を blocked by に持つ OPEN のサブタスクを選んで precede-notify を投稿する', async () => {
    await explains('`w-handoff` の Step 3 のテストです。speckit 由来のタスクの場合だけ、閉じた Issue に依存する OPEN のサブタスクを選び、`precede-notify` のテンプレートで投稿することを確認します。')
    const body = sectionBody(text, numberIndex(headings, 3))
    for (const phrase of ['speckit 由来のタスク', '`specs/`・`.specify/`', '`get_sub_issues`', '`issue_dependency_read`', '`pecot-template://comment/precede-notify`', '`issue_comment_check`']) {
      expect(body).toContain(phrase)
    }
    expect(body).not.toContain('readinessChanges')
  })

  it('w-handoff は、ファイルを書き換えず、Issue を閉じず、ブランチも消さない', async () => {
    await explains('`w-handoff` の `SKILL.md` のテストです。`session_finish` や `branch_delete` が含まれず、ファイルの書き換え・Issue のクローズ・ブランチの削除をしないと明記されていることを確認します。')
    for (const word of ['session_finish', 'branch_delete', 'Write', 'AskUserQuestion']) expect(text).not.toContain(word)
    expect(text).toContain('ファイルを書き換えず、Issue を閉じず、ブランチも消さない。')
  })
})

describe('w-auto の手順', () => {
  const text = readSkill('w-auto')
  const headings = stepHeadings(text)
  const lines = text.split('\n')
  const procedure = lines.slice(lines.indexOf('## 手順')).join('\n')
  // 契約（specs/023-label-triggered-autofix/contracts/skill-flow.md）の表の止まる条件と結果。文脈を作れないときは、ワークフローの Start の step が止める
  const STOPS: readonly (readonly [number, readonly string[]])[] = [
    [2, ['out-of-scope']],
    [3, ['setup-missing', 'out-of-scope', 'failed']],
    [5, ['question']],
    [6, ['failed']],
    [8, ['failed', 'setup-missing']],
    [9, ['failed']],
    [10, ['failed']],
    [11, ['pr-created']],
  ]

  it('w-auto の start と resume の Step は 1〜11 で、契約の表の順に並ぶ', async () => {
    await explains('`w-auto` の手順のテストです。Step が 1 から 11 まで連番で存在し、題が契約の表と同じ順序であることを確認します。')
    expect(headings.map(heading => heading.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(headings.map(heading => heading.title)).toEqual([
      '文脈を読む',
      '対象かを確かめる',
      'ブランチを用意する',
      '変更対象を読む',
      '直し方が決まるかを確かめる',
      '計画を投稿する',
      '実装する',
      'テストを動かす',
      'コミットする',
      'PR を作る',
      '結果を書いて終える',
    ])
  })

  it('w-auto は、frontmatter に allowed-tools を持たず、when_to_use と argument-hint を持つ', async () => {
    await explains('`w-auto` の frontmatter のテストです。`allowed-tools` を持たず、`when_to_use` と `argument-hint` を持つことを確認します。')
    const frontmatter = text.slice(0, text.indexOf('\n---', 4))
    expect(frontmatter).not.toContain('allowed-tools')
    expect(frontmatter).toContain('when_to_use:')
    expect(frontmatter).toContain('argument-hint:')
  })

  it('手順の前に共通の決まりの 7 つを置き、その 1 つで --no-verify を禁じる', async () => {
    await explains('`w-auto` の共通の決まりのテストです。手順より前の節に決まりが 7 つ存在し、そのうち 1 つで `--no-verify` を使わないと定めていることを確認します。')
    const start = lines.indexOf('## 共通の決まり')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(start).toBeLessThan(lines.indexOf('## 手順'))
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
    const rules = lines.slice(start, end).filter(line => line.startsWith('- '))
    expect(rules).toHaveLength(7)
    expect(rules.join('\n')).toContain('`--no-verify` を使わない')
  })

  it('w-auto は人を待たないため、手順の節に EnterPlanMode・AskUserQuestion・--no-verify が含まれない', async () => {
    await explains('`w-auto` の手順のテストです。`EnterPlanMode` と `AskUserQuestion` が `SKILL.md` に含まれず、`--no-verify` が手順の節に含まれないことを確認します。')
    for (const word of ['EnterPlanMode', 'AskUserQuestion']) expect(text).not.toContain(word)
    expect(procedure).not.toContain('--no-verify')
  })

  it('w-auto は、Step 1 の前に、引数の project を pecot-workflow の MCP ツールへ渡す文がある', async () => {
    await explains('`w-auto` の手順の冒頭のテストです。引数に `project=<名前>` がある場合に、その名前を `project` として pecot-workflow の MCP ツールへ渡す文が存在することを確認します。')
    const preamble = lines.slice(lines.indexOf('## 手順'), headings[0]?.line).join('\n')
    expect(preamble).toContain('引数に `project=<名前>` があれば、このスキルで使う pecot-workflow の MCP ツールに、その名前を `project` で渡す。')
  })

  it('Step 1 の前に、止まる Step が結果のファイルの frontmatter に result を書いて終える文がある', async () => {
    await explains('`w-auto` の手順の冒頭のテストです。止まる Step が、`result=` のパスに結果のファイルを書き、frontmatter の `result` に結果を書くと定めていることを確認します。')
    const preamble = lines.slice(lines.indexOf('## 手順'), headings[0]?.line).join('\n')
    expect(preamble).toContain('止まる Step では、`result=` のパスに結果のファイルを書いて終わる。')
    expect(preamble).toContain('frontmatter の `result` に、その Step の結果を書く。')
  })

  it('Step 1 は、context= のパスの文脈のファイルを読み、MCP ツールを呼ばない', async () => {
    await explains('`w-auto` の Step 1 のテストです。`context=` のパスの JSON を読み、Issue や計画などの欄を表で説明し、MCP ツールを呼ばないことを確認します。')
    const body = sectionBody(text, numberIndex(headings, 1))
    expect(body).toContain('`context=` のパスにある JSON のファイルを読む。')
    for (const field of ['issue', 'plan', 'results', 'answers', 'withheld', 'branch', 'pr']) expect(body).toContain(`| \`${field}\` |`)
    expect(body).not.toContain('MCP ツール')
  })

  it('自動処理の MCP ツールを呼ばない', async () => {
    await explains('`w-auto` の SKILL.md の全体のテストです。移した自動処理のツール（`auto_start`・`auto_finish`）と `body_file` の入力が書かれていないことを確認します。')
    for (const word of ['auto_start', 'auto_finish', 'body_file']) expect(text).not.toContain(word)
  })

  it.for(STOPS)('Step %i は、結果のファイルに結果 %j を書いて止まる', async ([step, results]) => {
    await explains(`\`w-auto\` の Step ${String(step)} のテストです。結果のファイルに \`${results.join('`・`')}\` を書いて止まると書かれていることを確認します。`)
    const body = sectionBody(text, numberIndex(headings, step))
    expect(body).toContain('結果のファイル')
    for (const result of results) expect(body).toContain(`\`result: ${result}\``)
  })

  it('Step 3 は、session_start で base を渡さずにブランチを作る', async () => {
    await explains('`w-auto` の Step 3 のテストです。`session_start` を使い、`base` を渡さずにブランチを作成すると書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 3))
    expect(body).toContain('`session_start`')
    expect(body).toContain('`base` は渡さない')
  })

  it('Step 10 は、push してから pr_check と pr_create で PR を作成し、screenshot に無人で実行した理由を書く', async () => {
    await explains('`w-auto` の Step 10 のテストです。`git push`・`pr_check`・`pr_create` がこの順に書かれ、`screenshot` の項目に無人で実行した理由を書くと書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 10))
    const order = ['`git push', '`pr_check`', '`pr_create`'].map(word => body.indexOf(word))
    expect(order.every(position => position >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((left, right) => left - right))
    expect(body).toContain('`screenshot`')
  })
})

describe('マージされた後の片付け', () => {
  const link = 'references/after-merge.md'
  const text = readPluginFile(`skills/w-pr/${link}`)

  it.for(AFTER_MERGE_SKILLS)('%s は、片付けの手順を自分の references/after-merge.md で参照させ、リンク先が存在する', async (skill) => {
    await explains(`マージされた後の片付けの参照のテストです。\`${skill}\` の \`SKILL.md\` が、同じスキルの \`references/after-merge.md\` へのリンクを持ち、そのファイルが存在することを確認します。`)
    expect(readSkill(skill)).toContain(`](${link})`)
    expect(existsSync(path.join(pluginRoot, 'skills', skill, link))).toBe(true)
  })

  it.for(AFTER_MERGE_SKILLS.filter(skill => skill !== 'w-pr'))('%s の写しは、w-pr のものと中身が同じ', async (skill) => {
    await explains(`\`${skill}\` の \`references/after-merge.md\` のテストです。\`w-pr\` の同じファイルと、内容が一致することを確認します。`)
    expect(readPluginFile(`skills/${skill}/${link}`)).toBe(text)
  })

  it('session_finish でリモートブランチも削除し、Epic と後続へのコメントは書かせず、引き継ぎのワークフローに任せる', async () => {
    await explains('マージされた後の片付けの手順のテストです。`session_finish` でリモートブランチも削除し、Epic と後続の Issue へのコメントは `pecot-handoff.yml` に任せると書かれていることを確認します。')
    expect(text).toContain('`session_finish` を使って、マージ後の片付けをする。リモートブランチも消す（`delete_branch: true`）。')
    expect(text).toContain('Epic と後続の Issue へのコメントは、セッションでは書かない。引き継ぎのワークフロー（`pecot-handoff.yml`）が書く。')
    for (const word of ['merge-diff', 'precede-notify', 'issue_comment', 'mergeDiff', '`cleanup`', 'frontmatter の `pr_ref`']) expect(text).not.toContain(word)
  })

  it('w-pr は、Epic と後続へのコメントを書かせない', async () => {
    await explains('`w-pr` の `SKILL.md` のテストです。`merge-diff`・`precede-notify`・「Epic・後続へのコメント」のいずれも含まれないことを確認します。')
    const body = readSkill('w-pr')
    for (const word of ['merge-diff', 'precede-notify', 'Epic・後続へのコメント']) expect(body, `w-pr が ${word} を書かせる`).not.toContain(word)
  })

  it.for(['w-active', 'w-quick', 'w-breakdown'])('%s は、session_start の leftovers を、ブランチの切り替えの前に PR ごとの片付けの節で処理する', async (skill) => {
    await explains(`\`${skill}\` の \`SKILL.md\` のテストです。\`session_start\` の結果に \`leftovers\` がある場合の処理が、ブランチの切り替えより前に書かれていることを確認します。`)
    const body = readSkill(skill)
    const leftovers = body.indexOf('`session_start` の結果に `leftovers` があれば')
    expect(leftovers).toBeGreaterThan(body.indexOf('`session_start` を使って'))
    expect(leftovers).toBeLessThan(body.indexOf('git checkout'))
    expect(body).toContain('PR ごとに [マージされた後の片付け](references/after-merge.md) の「片付け」の節を行う。')
    for (const word of ['`cleanup`', 'merge-diff']) expect(body).not.toContain(word)
  })

  it('w-active は、session_start の前に git pull を実行せず、ブランチ作成・取りこぼし・切り替えの順に並べる', async () => {
    await explains('`w-active` の `SKILL.md` のテストです。`git pull` が含まれず、Step の順序が、ブランチ作成・取りこぼし・ブランチ切り替えであることを確認します。')
    const body = readSkill('w-active')
    const headings = stepHeadings(body)
    expect(body).not.toContain('git pull')
    expect(titleIndex(headings, 'ブランチ作成')).toBeLessThan(titleIndex(headings, '取りこぼし'))
    expect(titleIndex(headings, '取りこぼし')).toBeLessThan(titleIndex(headings, 'ブランチ切り替え'))
  })
})

describe('w-ready の手順', () => {
  const text = readSkill('w-ready')
  const headings = stepHeadings(text)

  it('w-ready の description は、前提に応じて Ready か Blocked に置くと書く', async () => {
    await explains('`w-ready` の frontmatter のテストです。`description` に `Blocked` が含まれることを確認します。')
    const frontmatter = text.split('---\n', 2)[1] ?? ''
    expect(frontmatter).toContain('Blocked')
  })

  it('計画の Step は、前提を決めて blocked_by に書く', async () => {
    await explains('`w-ready` の計画の Step のテストです。前提を決めて `blocked_by` に書くと記載され、`wait: merge` と `reason` の指定、および前提と種類を示す文が含まれることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '計画'))
    expect(body).toContain('`blocked_by`')
    expect(body).toContain('`wait: merge`')
    expect(body).toContain('`reason`')
    expect(body).toContain('前提（`blocked_by`）と種類')
  })

  it('w-ready は、題の番号を、Epic の sub-issue の題で使っていない番号から書かせる', async () => {
    await explains('`w-ready` の `SKILL.md` のテストです。題の番号を、Epic の sub-issue の題で使っていない番号のうち最大の次から書くと記載され、枝の文字を使う記述が含まれないことを確認します。')
    expect(text).toContain('Epic の sub-issue の題で使っていない番号のうち、最大の次を 2 桁で書く')
    expect(text).not.toContain('枝つき')
  })

  it('w-ready は、投稿の前に issue_check で確認する', async () => {
    await explains('`w-ready` の作成の Step のテストです。公式の MCP の `issue_write` で作る手順より前に、`issue_check` の手順が書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '作成'))
    const planned = body.indexOf('`issue_check`')
    const posted = body.indexOf('公式の MCP の `issue_write` で作り')
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(posted).toBeGreaterThan(planned)
  })

  it('issue_check に通した題の番号・前提・置く列を、作る前に示す', async () => {
    await explains('`w-ready` の作成の Step のテストです。`issue_check` に通した題の番号・前提・置く列を、公式の MCP で作る前に利用者へ示すと書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '作成'))
    const shown = body.indexOf('通した題の番号・前提・置く列を、地の文でユーザーに示す')
    expect(shown).toBeGreaterThanOrEqual(0)
    expect(shown).toBeLessThan(body.indexOf('公式の MCP の `issue_write` で作り'))
  })

  it('w-ready の完了報告に、置いた列と、Blocked のときに待つものを入れる', async () => {
    await explains('`w-ready` の完了報告の Step のテストです。`Ready`・`Blocked`・「待つ」が含まれることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '完了報告'))
    for (const word of ['`Ready`', '`Blocked`', '待つ']) expect(body).toContain(word)
  })

  it('w-ready の完了報告は、ボードに足せなかったときや列を書けなかったときに、その理由を伝える', async () => {
    await explains('`w-ready` の完了報告の Step のテストです。ボードに追加できなかった場合や列を書けなかった場合に、そのことと公式のツールが返した理由を伝えると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '完了報告'))
    expect(body).toContain('ボードに足せなかった・列を書けなかったときは、そのことと、公式のツールが返した理由を伝える')
  })

  it('w-ready は、既存の Issue に前提として付ける操作を、前提を付け外しする手順で案内する', async () => {
    await explains('`w-ready` の `SKILL.md` のテストです。既存の Issue に前提を付ける操作の案内として、`issue-write.md` の「前提を付け外しする」の手順が含まれることを確認します。')
    expect(text).toContain('[Issue とコメントを公式の MCP で書く](../w-help/references/issue-write.md) の「前提を付け外しする」で付ける')
  })
})

describe('w-issueize の手順', () => {
  const text = readSkill('w-issueize')
  const headings = stepHeadings(text)

  it('w-issueize は、前提の読み取り、Issue の作成、完了報告の順に並ぶ', async () => {
    await explains('`w-issueize` の Step の順序のテストです。前提の Step、Issue として作成する Step、完了報告の Step が、この順に並んでいることを確認します。')
    expect(titleIndex(headings, '前提')).toBeLessThan(titleIndex(headings, 'Issueとして作成'))
    expect(titleIndex(headings, 'Issueとして作成')).toBeLessThan(titleIndex(headings, '完了報告'))
  })

  it('Step 2 は、4 列の表が存在しない tasks.md の扱いを持つ', async () => {
    await explains('`w-issueize` の Step 2 のテストです。4 列の表が存在しない `tasks.md` では、種類をすべて「スタック可」とし、表が存在しなかった旨を伝えると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '前提'))
    expect(body).toContain('4 列の表が無い tasks.md')
    expect(body).toContain('種類はすべて「スタック可」とする')
    expect(body).toContain('表が無かった旨を伝える')
  })

  it('Step 3 は、issue_check で確認した番号・前提・進め方を、前提の表と並べて表示する', async () => {
    await explains('`w-issueize` の Step 3 のテストです。`issue_check` の結果の番号・前提・進め方を表にして、スタックできる並びとあわせて、前提の表と並べて表示すると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('結果の番号・前提・進め方を表にし')
    expect(body).toContain('スタックできる並びも示す')
    expect(body).toContain('前提の表と並べて')
  })

  it('Step 3 は、前の版の tasks.md の種類の名前を、スタック可・スタック不可と同じに扱う', async () => {
    await explains('`w-issueize` の Step 3 のテストです。前の版の `tasks.md` が使う「積める」や「マージを待つ」などの種類の名前を、現在の「スタック可」と「スタック不可」と同じに扱うと書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('「積める」と「スタックできる」は「スタック可」と、「マージを待つ」は「スタック不可」と同じに扱う')
  })

  it('Step 3 は、書く途中で失敗しても、作った Issue を作り直さないと書く', async () => {
    await explains('`w-issueize` の Step 3 のテストです。公式のツールが書く途中で失敗しても作成済みの Issue は作り直さず、失敗した書き込みを理由とともに利用者に表示すると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('作った Issue は作られている。作り直さない')
    expect(body).toContain('失敗した書き込み（前提・ボードの欄など）だけを、理由とともに利用者に示し')
  })

  it('Step 3 は、作った Issue の番号で、後のフェーズの key を置き換えてから書く', async () => {
    await explains('`w-issueize` の Step 3 のテストです。フェーズの順に 1 件ずつ書き、作成した Issue の番号で、後のフェーズの `{{issue:<key>}}` と `blocked_by` の key を置き換えると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('フェーズの順に 1 件ずつ')
    expect(body).toContain('書いた Issue の番号で、後のフェーズの `{{issue:<key>}}` と `blocked_by` の key を置き換える')
  })

  it('w-issueize は、issue_check の呼び出しを、投稿の呼び出しより前に書く', async () => {
    await explains('`w-issueize` の Step 3 のテストです。全フェーズを `issue_check` に 1 回で通す手順が、公式の MCP で書く手順より前に書かれ、合意を得てから投稿すると書かれていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 3))
    const planned = body.indexOf('`issue_check` に、全フェーズを 1 回で通し')
    const posted = body.indexOf('公式の MCP の `issue_write`')
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(posted).toBeGreaterThan(planned)
    expect(body).toContain('合意を得てから投稿する')
  })

  it('blocked_by を書き、題の番号をフェーズの順に振らせる', async () => {
    await explains('`w-issueize` の Step 3 のテストです。前提を `blocked_by` に写し、題の番号を Epic の sub-issue の題で使っていない番号からフェーズの順に振ると記載されていることを確認します。')
    const body = sectionBody(text, numberIndex(headings, 3))
    expect(body).toContain('`blocked_by`')
    expect(body).toContain('題の番号は、Epic の sub-issue の題で使っていない番号を、フェーズの順に振る')
  })

  it('w-issueize は、段と枝の文字の計算を書かない', async () => {
    await explains('`w-issueize` の `SKILL.md` のテストです。段や枝の文字を使う記述、`続番`、「段を決める」の記述が含まれないことを確認します。')
    expect(text).not.toMatch(/`a`・`b`・`c`/u)
    expect(text).not.toContain('番号が示すのは着手の条件')
    expect(text).not.toContain('続番')
    expect(text).not.toMatch(/段を決める/u)
  })

  it('w-issueize の完了報告に、進め方・スタックできる並び・最初に着手できる Issue を入れる', async () => {
    await explains('`w-issueize` の Step 4 のテストです。完了報告に、進め方・スタックできる並び・最初に着手できる Issue の 3 つが含まれることを確認します。')
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
const MERGE_EXAMPLES_HEADING = '「スタック不可」になる例:'

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

  it('specify、clarify、tasks、前提の表の確認の順に並ぶ', async () => {
    await explains('`w-breakdown` の Step の順序のテストです。specify・clarify・tasks・前提の表を確認する Step が、この順に並んでいることを確認します。')
    expect(titleIndex(headings, 'specify')).toBeLessThan(clarifyStep())
    expect(clarifyStep()).toBeLessThan(tasksStep())
    expect(tasksStep()).toBeLessThan(checkStep())
  })

  it('clarify の Step の工程の順序に、/speckit.tasks が含まれない', async () => {
    await explains('`w-breakdown` の clarify の Step のテストです。「工程の順序」の行に `/speckit.clarify` と `/speckit.plan` が含まれ、`/speckit.tasks` は含まれないことを確認します。')
    const body = sectionBody(text, clarifyStep())
    const order = body.split('\n').find(line => line.startsWith('工程の順序'))
    expect(order).toContain('`/speckit.clarify`')
    expect(order).toContain('`/speckit.plan`')
    expect(order).not.toContain('/speckit.tasks')
  })

  it('clarify の Step は、次に進む・修正を指示する・やり直すの承認 3 択を持つ', async () => {
    await explains('`w-breakdown` の clarify の Step のテストです。承認の選択肢として、「次に進む」「修正を指示する」「やり直す」の 3 つが表に存在することを確認します。')
    const body = sectionBody(text, clarifyStep())
    for (const choice of ['次に進む', '修正を指示する', 'やり直す']) expect(body).toContain(`| ${choice} |`)
  })

  it('本文の Step の番号の参照は、参照先の Step の番号と一致する', async () => {
    await explains('`w-breakdown` の Step の番号の参照のテストです。「Step N へ進む」などの参照が、tasks の Step と clarify の Step の実際の番号と一致することを確認します。')
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

  it('再開の Step の番号の参照は、準備の Step と、続ける工程の Step の番号と一致する', async () => {
    await explains('`w-breakdown` の再開に関する参照のテストです。「Step N で再開」の参照が準備の Step を指し、準備の Step の表が示す続きの Step が、各工程の実際の番号と一致することを確認します。')
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

  it('準備の Step は、承認の commit のメッセージに工程の名前を入れさせ、再開でそれを読む', async () => {
    await explains('`w-breakdown` の準備の Step のテストです。承認時の commit のメッセージに工程の名前を入れ、再開するときに `git log` でその名前を取得すると書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '準備'))
    expect(body).toContain('メッセージに工程の名前（specify・clarify・plan・tasks）を入れる')
    expect(body).toContain('git log --format=%s origin/<開発ブランチ>..HEAD -- specs/<NNN-名前>/')
  })

  it('準備の Step は、develop_branch が null なら止める', async () => {
    await explains('`w-breakdown` の準備の Step のテストです。`develop_branch` が null の場合は止めると書かれていることを確認します。')
    expect(sectionBody(text, titleIndex(headings, '準備'))).toContain('`develop_branch` が null なら止め')
  })

  it('tasks の Step は、/speckit.tasks の引数に、コードブロック 1 つをそのまま貼らせる', async () => {
    await explains('`w-breakdown` の tasks の Step のテストです。`/speckit.tasks` の引数に、コードブロックの中身をそのまま貼ると書かれ、コードブロックが 1 つだけ存在することを確認します。')
    const body = sectionBody(text, tasksStep())
    expect(body).toContain('`/speckit.tasks`')
    expect(body).toContain('中身をそのまま貼る。言い換えない。要約もしない。')
    expect(body.split('\n').filter(line => line.trimStart().startsWith('```'))).toHaveLength(2)
  })

  it('渡す指示は、表の形と置き場を持つ', async () => {
    await explains('tasks の Step のコードブロックのテストです。前提の表の見出しと、`## Dependencies & Execution Order`、`### Phase Dependencies` が含まれることを確認します。')
    const block = tasksBlock()
    for (const word of [TABLE_HEADER, '`## Dependencies & Execution Order`', '`### Phase Dependencies`']) expect(block).toContain(word)
  })

  it('渡す指示は、種類を決める 2 つの問いを、開発ブランチを基準に持つ', async () => {
    await explains('tasks の Step のコードブロックのテストです。「スタック可」と「スタック不可」を決める 2 つの問いが、開発ブランチを基準にして書かれ、`main に入っていない` は含まれないことを確認します。')
    const block = tasksBlock()
    expect(block).toContain('前提の変更を、手元のブランチか試験環境で動かして、このフェーズの実装と確認ができる。このときは「スタック可」')
    expect(block).toContain('前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、このフェーズの実装か確認ができない。このときは「スタック不可」')
    expect(block).toContain('試験環境は、開発ブランチに入れる前の変更を動かして確かめる場所だ。プロジェクトの文書に、その場所で動かす手順があるときだけ使う。無いときは、手元のブランチだけで判断する。')
    expect(block).not.toContain('main に入っていない')
  })

  it('スタック不可になる例は 3 つで、配られるもの・リリースの後・開発ブランチのワークフローを挙げる', async () => {
    await explains('tasks の Step のコードブロックのテストです。「スタック不可」になる例が 3 つあり、既定のブランチから配られるもの、リリースの後の実物、開発ブランチのワークフローをそれぞれ挙げていることを確認します。')
    const examples = linesAfter(tasksBlock(), MERGE_EXAMPLES_HEADING)
    expect(examples).toHaveLength(3)
    expect(examples[0]).toContain('既定のブランチから配られるものを使う')
    expect(examples[0]).not.toContain('プラグイン')
    expect(examples[1]).toContain('リリースの後の実物で確かめる')
    expect(examples[2]).toContain('開発ブランチの CI やリリースのワークフロー')
  })

  it('渡す指示は、読み違いを防ぐための決まりを持つ', async () => {
    await explains('tasks の Step のコードブロックのテストです。前提のないフェーズを表に書かないことや、直接の前提だけを書くことなど、読み違いを防ぐ決まりが含まれることを確認します。')
    const block = tasksBlock()
    for (const word of ['前提の無いフェーズは、表に書かない', '直接の前提だけ', 'すべての行', '見出しの行と区切りの行だけの表']) expect(block).toContain(word)
  })

  it('渡す指示に、行頭が ## の行が含まれない', async () => {
    await explains('tasks の Step のコードブロックのテストです。行頭が `##` で始まる行が存在しないことを確認します。')
    expect(tasksBlock().split('\n').filter(line => line.trimStart().startsWith('##'))).toEqual([])
  })

  it('確認の Step は、表の形・フェーズの番号・種類・理由の 4 つを確認する', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。表の形・フェーズの番号・種類の値・理由の有無という 4 つの確認項目が、番号付きで書かれていることを確認します。')
    const body = sectionBody(text, checkStep())
    expect(body).toContain(`1. \`${TABLE_HEADER}\` の 4 列の表がある`)
    expect(body).toContain('2. `Phase` と `前提` が数字だけで、どれも tasks.md のフェーズの見出し（`## Phase <番号>:`）にある')
    expect(body).toContain('3. `種類` の値が、どの行も「スタック可」か「スタック不可」')
    expect(body).toContain('4. すべての行に `理由` がある')
  })

  it('確認が通らずやり直すときは、tasks の Step のコードブロックを貼り直し、外れた箇所を 1 行追加する', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。確認が通らなかった場合に、コードブロックをもう一度そのまま貼り、通らなかった箇所を 1 行追加して実行すると書かれ、やり直しは 1 回までであることを確認します。')
    const body = sectionBody(text, checkStep())
    expect(body).toContain('のコードブロックをもう一度そのまま貼り、その後ろに、通らなかった確かめと箇所を 1 行足して `/speckit.tasks` を実行する')
    expect(body).toContain('やり直しは 1 回まで')
  })

  it('承認の修正を指示する・やり直すで tasks の工程を実行するときも、コードブロックを貼り直す', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。承認で「修正を指示する」か「やり直す」を選んだ場合も、コードブロックをもう一度そのまま貼ると書かれ、その記述が 2 か所に存在することを確認します。')
    const body = sectionBody(text, checkStep())
    expect(body).toContain('「修正を指示する」「やり直す」で tasks の工程をもう一度実行するときも、')
    expect(body.match(/のコードブロックをもう一度そのまま貼/gu)).toHaveLength(2)
  })

  it('スタック不可の行の理由が空のときは、ユーザーに質問し、答えを main が理由のセルに書く', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。スタック不可の行の理由が空の場合に、エージェントが理由を作成せず、ユーザーの答えを `main` が理由のセルにそのまま書き、tasks の工程はやり直さないと書かれていることを確認します。')
    const body = sectionBody(text, checkStep())
    for (const word of ['開発ブランチに入っていないと進められない訳をユーザーに確かめる', 'エージェントが理由を作らない', 'ユーザーが答えた文を、main がその行の `理由` のセルにそのまま書く', 'tasks の工程はやり直さない', 'やり直しの回数に数えない']) expect(body).toContain(word)
    expect(body).not.toContain('main に入っていない')
  })

  it('スタック可の行の理由が空のときは、tasks の工程をやり直す', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。スタック可の行の理由が空の場合は、tasks の工程をやり直すと書かれていることを確認します。')
    expect(sectionBody(text, checkStep())).toContain('「スタック可」の行の理由が空のとき')
  })

  it('analyze の案内は、確認の Step の承認の文より後ろにある', async () => {
    await explains('`w-breakdown` の前提の表を確認する Step のテストです。`/speckit.analyze` の案内が、`AskUserQuestion` による承認の文より後ろに書かれていることを確認します。')
    const body = sectionBody(text, checkStep())
    const approval = body.indexOf('AskUserQuestion')
    expect(approval).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('/speckit.analyze')).toBeGreaterThan(approval)
  })

  it('起票の Step は、Epic の特定の後、specify の前にある', async () => {
    await explains('`w-breakdown` の Step の順序のテストです。分解のタスクを起票する Step が、対象 Epic を特定する Step より後、specify の Step より前に存在することを確認します。')
    expect(titleIndex(headings, '対象Epic')).toBeLessThan(fileStep())
    expect(fileStep()).toBeLessThan(titleIndex(headings, 'specify'))
  })

  it('起票の Step は、テンプレート無しで issue_check を通し、親 Epic 付きで issue_write で作り、session_start に base を渡さない', async () => {
    await explains('`w-breakdown` の起票の Step のテストです。`template` を渡さずに `issue_check` を通し、親 Epic を `parent_*` に書いて `issue_write` で作成すると書かれていることを確認します。`session_start` には `base` を渡さないことも確認します。')
    const body = sectionBody(text, fileStep())
    for (const word of ['`issue_check` に `template` を渡さずに通し', '`issue_write`', '`parent_owner`・`parent_repo`・`parent_issue_number`: Step 3 で読んだ Epic', '`session_start`', '`base` は渡さない']) expect(body).toContain(word)
  })

  it('起票の Step は、既存の分解のタスクを 3 通りに分けて扱い、2 重に起票しない', async () => {
    await explains('`w-breakdown` の起票の Step のテストです。既存の分解のタスクの状態を 3 通りに分けて扱い、タスクが既に存在する場合は重複して起票しないと書かれていることを確認します。')
    const body = sectionBody(text, fileStep())
    for (const row of ['| タスクと、紐づいたブランチ | 起票しない。', '| タスクだけ（ブランチが無い） | 起票しない。', '| どちらも無い | 起票し、']) expect(body).toContain(row)
    expect(body).toContain('`feat/breakdown-`')
    expect(body.indexOf('題に「speckit で分解する:」を含む OPEN の sub-issue を探す')).toBeLessThan(body.indexOf('紐づいたブランチを確かめる'))
    expect(body).toContain('`speckit で分解する: <Epic の題>`')
  })

  it('specify の Step は、/speckit.specify に追加する指示で、今のブランチ名と --allow-existing-branch を hook に渡す', async () => {
    await explains('`w-breakdown` の specify の Step のテストです。追加する指示のコードブロックに、`GIT_BRANCH_NAME` と `--allow-existing-branch` が含まれ、spec には書かないという文で始まることを確認します。')
    const block = firstCodeBlock(sectionBody(text, titleIndex(headings, 'specify')))
    for (const word of ['GIT_BRANCH_NAME', '--allow-existing-branch', 'create-new-feature-branch.sh --json']) expect(block).toContain(word)
    expect(block.startsWith('次の指示は hook の動かし方で、機能の説明ではない。spec には書かない。')).toBe(true)
  })

  it('specify の Step は、git 拡張の hook が存在しないか無効なリポジトリでは、何も追加しない', async () => {
    await explains('`w-breakdown` の specify の Step のテストです。`enabled` が `false` でないという条件に当たらないリポジトリでは、何も追加しないと書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, 'specify'))
    expect(body).toContain('`enabled` は `false` でない')
    expect(body).toContain('条件に当たらないリポでは、何も足さない')
  })

  it('準備の Step は、再開のときに spec のディレクトリを特定し、.specify/feature.json を書き直す', async () => {
    await explains('`w-breakdown` の準備の Step のテストです。再開する場合に、spec のディレクトリを特定し、`.specify/feature.json` の `feature_directory` を書き直すと書かれていることを確認します。')
    const body = sectionBody(text, titleIndex(headings, '準備'))
    expect(body).toContain('git diff --name-only origin/<開発ブランチ>...HEAD -- specs/')
    expect(body).toContain('"feature_directory": "specs/<NNN-名前>"')
  })

  it('specify・clarify・確認の Step は、承認の後に spec のディレクトリを commit して push させる', async () => {
    await explains('`w-breakdown` の specify・clarify・確認の Step のテストです。3 つの Step のどれにも、承認の後に spec のディレクトリを commit し、タスクのブランチへ push すると書かれていることを確認します。')
    for (const position of [titleIndex(headings, 'specify'), clarifyStep(), checkStep()]) {
      expect(sectionBody(text, position)).toContain('を commit し、タスクのブランチへ push する')
    }
  })

  it('最後の Step は、w-pr を案内し、w-issueize はマージの後に案内する', async () => {
    await explains('`w-breakdown` の最後の Step のテストです。`/pecot-w:w-pr` を案内し、`/pecot-w:w-issueize` は PR のマージの後に案内し、w-pr はこのスキルから起動しないと書かれていることを確認します。')
    const body = sectionBody(text, headings.length - 1)
    expect(body).toContain('`/pecot-w:w-pr`')
    expect(body.indexOf('PR のマージの後')).toBeLessThan(body.indexOf('`/pecot-w:w-issueize`'))
    expect(body).toContain('w-pr は、このスキルから起動しない')
  })

  it('表の列の名前は、w-issueize の Step 2 が読み取る列と一致する', async () => {
    await explains('`w-breakdown` が渡す前提の表の見出しのテストです。列の名前が `Phase`・`前提`・`種類`・`理由` で、`w-issueize` の Step 2 が読み取る 4 列と一致することを確認します。')
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

  it('見出しの行と区切りの行だけの表は、前提が存在しないと読み取り、文から前提を読み取らない', async () => {
    await explains('`w-issueize` の前提の表の読み方のテストです。見出しの行と区切りの行だけの表は「前提が無い」と読み取り、文章からは前提を読み取らないと書かれていることを確認します。')
    expect(body).toContain('見出しの行と区切りの行だけの表')
    expect(body).not.toContain('見出しの行だけの表')
    expect(body).toContain('「前提が無い」と読む')
    expect(body).toContain('文から前提を読まない')
  })

  it('reason は、表の理由の文をそのまま写し、言い換えさせない', async () => {
    await explains('`w-issueize` の Step 3 のテストです。表の理由の文をそのまま `reason` に写して言い換えないと書かれ、例の表の理由と例の `reason` が同じ文であることを確認します。')
    expect(step).toContain('そのまま写した `reason`')
    expect(step).toContain('言い換えない')
    expect(step).not.toContain('1 行で写した')
    // 例の表の理由と、例の reason が同じ文
    const reason = exampleReason(step)
    expect(reason).toBeDefined()
    expect(step).toContain(`| スタック不可 | ${reason ?? ''} |`)
  })

  it('reason を YAML に書くときは、表の \\| を戻してから、バックスラッシュと二重引用符を逃がし、改行しない', async () => {
    await explains('`reason` を YAML に書くときの文字の変換のテストです。表の中の `|` の記号を戻し、バックスラッシュと二重引用符をエスケープし、1 行で書くと記載されていることを確認します。')
    expect(step).toContain('表の `\\|` を `|` に戻してから、`\\` を `\\\\`、`"` を `\\"` にする')
    expect(step).toContain('`reason` は 1 行で書き、改行を入れない')
  })

  it('テンプレートの例の reason は、w-issueize の例の reason と同じ文', async () => {
    await explains('`task-implement.md` のテンプレートのテストです。テンプレートの例の `reason` が、`w-issueize` の Step 3 の例の `reason` と同じ文であることを確認します。')
    const template = readPluginFile('cli/templates/issue/task-implement.md')
    expect(exampleReason(template)).toBe(exampleReason(step))
  })

  it('テンプレートは、表の理由をそのまま写した 1 行の reason を求める', async () => {
    await explains('`task-implement.md` のテンプレートのテストです。表の理由の文をそのまま写した、改行しない `reason` を求める文が含まれ、古い言い方が含まれないことを確認します。')
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
  ])('%s は、スタック可・スタック不可の文に、試験環境の句を持つ', async (file) => {
    await explains(`\`${file}\` のテストです。スタック可とスタック不可を決める文に、試験環境に関する 2 つの句が含まれることを確認します。`)
    const text = readPluginFile(file)
    expect(text).toContain(STACK_PHRASE)
    expect(text).toContain(MERGE_PHRASE)
  })

  it('issue-flow-rules の merge の説明は、プラグインをスタック不可の例に挙げない', async () => {
    await explains('`issue-flow-rules.md` のテストです。`merge`（スタック不可）の説明の行が存在し、その行にプラグインが例として含まれないことを確認します。')
    const line = readPluginFile('skills/w-help/references/issue-flow-rules.md').split('\n').find(text => text.startsWith('- `merge`（スタック不可）'))
    expect(line).toBeDefined()
    expect(line).not.toContain('プラグイン')
  })
})
