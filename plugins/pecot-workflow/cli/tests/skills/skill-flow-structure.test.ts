/* eslint-disable security/detect-non-literal-fs-filename -- 確かめるのはプラグイン内のリンク先のみ */
// w-active・w-quick・w-revise・w-issueize・w-breakdown の手順（Step の順序と見出し）が崩れていないことを確かめる。
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

  it('kind が dependency-unreadable で止まったときは、出力を利用者に示して止まる', () => {
    const body = sectionBody(text, titleIndex(headings, '事前確認'))
    for (const word of ['dependency-unreadable', 'could not read blocked-by', 'could not judge readiness', '利用者に示して止まる']) expect(body).toContain(word)
  })

  it('Step 2 では、判定が blocked の Issue を選んだら、列が Ready でも止める', () => {
    expect(text).toContain('判定が `blocked` の Issue（列が `Ready` でも）が選ばれたら、理由を伝えて止める。')
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

  it('Step 1 は、起票の前に session_show で確かめ、issue_create（freeform）で起票する', () => {
    const body = sectionBody(text, numberIndex(headings, 1))
    expect(body).toContain('`session_show` を `directory: "."` で呼び')
    expect(body.indexOf('`session_show`')).toBeLessThan(body.indexOf('`issue_create` を `freeform: true`'))
  })

  it('Step 2 は、session_start（issue_ref・branch）でブランチを作り、切り替える', () => {
    const body = sectionBody(text, numberIndex(headings, 2))
    expect(body).toContain('`session_start` を `issue_ref: "owner/repo/N"`・`branch: "feat/description"` で呼ぶ')
    expect(body).toContain('git checkout')
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

  it('Step 5 は、割り当て表の書式とモデルの基準へのリンクを持ち、リンク先が実在する', () => {
    const body = sectionBody(text, numberIndex(headings, 5))
    expect(body).toContain('実装者名 / モデル / 担当 F-NN / 担当ファイル群')
    const link = '../w-help/references/agent-models.md'
    expect(body).toContain(link)
    expect(existsSync(path.join(pluginRoot, 'skills', 'w-revise', link))).toBe(true)
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
    expect(body).toContain('種類はすべて「積める」とする')
    expect(body).toContain('表が無かった旨を伝える')
  })

  it('Step 3 は、dry_run: true の出力を前提の表と並べて示す', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('前提の表と並べて')
  })

  it('Step 3 は、ok が false でも URL の行があれば呼び直さないと書く', () => {
    const body = sectionBody(text, titleIndex(headings, 'Issueとして作成'))
    expect(body).toContain('`stdout` に URL の行が出ていれば Issue は作られている')
    expect(body).toContain('同じ `files` で呼び直さない')
    expect(body).toContain('`stdout` に URL の行が 1 つも出ずに `stderr` の `error:` で止まったときは')
  })

  it('dry_run: true の呼び出しは、投稿の呼び出しより前にある', () => {
    const body = sectionBody(text, numberIndex(headings, 3))
    const planned = body.indexOf('`dry_run: true`')
    const posted = body.indexOf('`dry_run` なしで')
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

  it('完了報告に、進め方・積める並び・最初に着手できる Issue を入れる', () => {
    const body = sectionBody(text, numberIndex(headings, 4))
    for (const word of ['進め方', '積める並び', '最初に着手できる Issue']) expect(body).toContain(word)
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
    expect(block).toContain('前提の変更が手元のブランチの下にあれば、このフェーズの実装と確認ができる。このときは「積める」')
    expect(block).toContain('前提の変更が開発ブランチに入っていないと、このフェーズの実装か確認ができない。このときは「マージを待つ」')
    expect(block).not.toContain('main に入っていない')
  })

  it('マージを待つになる例は 3 つで、配られるもの・リリースの後・開発ブランチのワークフローを挙げる', () => {
    const examples = linesAfter(tasksBlock(), MERGE_EXAMPLES_HEADING)
    expect(examples).toHaveLength(3)
    expect(examples[0]).toContain('既定のブランチから配られるものを使う')
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
    expect(body).toContain('3. `種類` の値が、どの行も「積める」か「マージを待つ」')
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

  it('積める行の理由が空のときは、tasks の工程をやり直す', () => {
    expect(sectionBody(text, checkStep())).toContain('積める行の理由が空のとき')
  })

  it('analyze と w-issueize の案内は、確かめの Step の承認の文より後ろにある', () => {
    const body = sectionBody(text, checkStep())
    const approval = body.indexOf('AskUserQuestion')
    expect(approval).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('/speckit.analyze')).toBeGreaterThan(approval)
    expect(body.indexOf('/pecot-w:w-issueize')).toBeGreaterThan(approval)
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
