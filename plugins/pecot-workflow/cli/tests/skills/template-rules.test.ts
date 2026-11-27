// 配布するテンプレートの形と、冒頭のコメントの「例:」を確かめる。
// MCP の resource が配る 12 本は、冒頭のコメントに「読者:」と本文の手本の「例:」を持つ。actions/ に移した review-stopped・auto-result は、actions のテストが確かめる。
// 投稿時に弾く記法は、テンプレートに規則として書かない。
//
// 固定するもの
// 1. 見出しの横にサマリを書く形は issue と comment のテンプレート（plan・task-implement を除く）。PR・plan・task-implement は見出しの名前だけ
// 2. 各テンプレートの「例:」は、そのテンプレートで投稿したときの検証を通る
// 3. plan テンプレートの折りたたみのサマリの形と区分・Files の書き方・CUJ の規則が雛形にある
// 4. PR テンプレートの Changes には、振る舞いの変化を書く
//
// 見出しの順（plan の 7 見出し）は src/infra/tests/template-store.test.ts が確かめる。
// release の docs PR の例は release-pr-body-examples.test.ts が確かめる。
import { globSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  extractSectionsFromTemplate,
  PLAN_FOLD_SUMMARY,
  validateBodyStyle,
  validateClosedHeadings,
  validateFoldBalance,
  validateFoldSummaries,
  validateHeadingSummaries,
  validateSections,
} from '@pecot/workflow-core/domain/sections.js'
import { explains } from '../_helpers/explains.js'
import { compareStrings } from '../parity/baseline.js'
import { pluginRoot, readPluginFile } from './_helpers/documents.js'

const TEMPLATES = ['issue', 'comment', 'pr']
  .flatMap(kind => globSync(`cli/templates/${kind}/*.md`, { cwd: pluginRoot }))
  .toSorted(compareStrings)

const PLAN_TEMPLATE = 'cli/templates/comment/plan.md'
const PR_CREATE_TEMPLATE = 'cli/templates/pr/create.md'

// 見出しの名前だけを使うテンプレート（全文を読む PR、本文に要約を書いて折りたたむ plan、tasks.md を写す task-implement）
const NAME_ONLY_TEMPLATES: ReadonlySet<string> = new Set([PR_CREATE_TEMPLATE, 'cli/templates/pr/release.md', PLAN_TEMPLATE, 'cli/templates/issue/task-implement.md'])

function comment(template: string): string {
  const match = /<!--\n([\s\S]*?)\n-->/u.exec(readPluginFile(template))
  if (match?.[1] === undefined) throw new Error(`${template}: 冒頭コメントがありません`)
  return match[1]
}

/**
冒頭のコメントの「例:」より後ろの本文
*/
function example(template: string): string {
  const text = comment(template)
  const at = text.indexOf('\n例:\n')
  if (at === -1) throw new Error(`${template}: 「例:」がありません`)
  return text.slice(at + '\n例:\n'.length)
}

/**
冒頭のコメントの「書き方:」の本文。無ければ空
*/
function writingRules(template: string): string {
  return /^書き方:\n([\s\S]*?)(?=^フィールド:|^例:|(?![\s\S]))/mu.exec(comment(template))?.[1] ?? ''
}

function body(template: string): string {
  return readPluginFile(template).split('\n-->\n').slice(1).join('\n-->\n')
}

/**
plan テンプレートの本文の見出しから、次の ## / ### の見出しの手前までの、空行を除いた行
*/
function planSection(heading: string): readonly string[] {
  const text = body(PLAN_TEMPLATE)
  const start = text.indexOf(`\n${heading}\n`) + 1
  const rest = text.slice(start).split('\n').slice(1).join('\n')
  return (rest.split(/\n(?=#{2,3} )/u, 1)[0] ?? '').split('\n').filter(line => line.trim() !== '')
}

describe('テンプレートの一式', () => {
  it('issue 5 種・comment 5 種・pr 2 種の 12 本がそろっている', async () => {
    await explains('配布するテンプレートの一覧のテストです。`cli/templates` の `issue`・`comment`・`pr` の Markdown が合わせて 12 本存在することを確認します。')
    expect(TEMPLATES).toHaveLength(12)
  })
})

describe.each(TEMPLATES)('%s', (template) => {
  it('冒頭のコメントに「読者:」と「例:」があり、例に見出しがある', async () => {
    await explains(`テンプレート \`${template}\` の冒頭のコメントのテストです。コメントが「読者: 」で始まり、「例:」の本文に見出しが含まれることを確認します。`)
    expect(comment(template).startsWith('読者: ')).toBe(true)
    expect(example(template)).toMatch(/^#{2,3} /mu)
  })

  it('PR・plan・task-implement 以外のテンプレートだけが、見出しの横にサマリ（名前 — サマリ）を書く', async () => {
    await explains(`テンプレート \`${template}\` の見出しの書き方のテストです。見出しの横にサマリを書く形を、PR・plan・task-implement 以外のテンプレートだけが使うことを確認します。`)
    const hasSummary = /^#{2,3} .+ — /mu.test(body(template))
    expect(hasSummary).toBe(!NAME_ONLY_TEMPLATES.has(template))
  })

  it('「例:」の本文が、そのテンプレートで投稿したときの検証を通る', async () => {
    await explains(`テンプレート \`${template}\` の「例:」のテストです。例の本文が、そのテンプレートで投稿するときの節・見出しのサマリ・書式の検証を通り、plan テンプレートでは折りたたみの検証も通ることを確認します。`)
    const text = example(template)
    const sections = extractSectionsFromTemplate(readPluginFile(template))
    expect(validateSections(text, sections)).toEqual([])
    expect(validateHeadingSummaries(text, sections)).toEqual([])
    expect(validateBodyStyle(text)).toEqual([])
    if (template !== PLAN_TEMPLATE) {
      return
    }

    expect(validateClosedHeadings(text, sections)).toEqual([])
    expect(validateFoldBalance(text)).toEqual([])
    expect(validateFoldSummaries(text, PLAN_FOLD_SUMMARY)).toEqual([])
  })
})

describe('plan テンプレート', () => {
  it('すべての <summary> が PLAN_FOLD_SUMMARY と同じ形になっている', async () => {
    await explains('plan テンプレートの折りたたみのテストです。本文のすべての `<summary>` の行が、`PLAN_FOLD_SUMMARY` と一致することを確認します。')
    const lines = body(PLAN_TEMPLATE).match(/^<summary.*$/gmu) ?? []
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter(line => line !== PLAN_FOLD_SUMMARY)).toEqual([])
  })

  it.each(['### Approach', '### Files', '### Notes', '### E2E'])('%s の節は、要約を外に置き、末尾に <details> を 1 つ置く', async (heading) => {
    await explains(`plan テンプレートの \`${heading}\` の節のテストです。節の先頭が \`<details>\` ではなく、\`<details>\` が 1 つだけあり、節の末尾が \`</details>\` であることを確認します。`)
    const lines = planSection(heading)
    expect(lines[0]).not.toBe('<details>')
    expect(lines.filter(line => line === '<details>')).toHaveLength(1)
    expect(lines.at(-1)).toBe('</details>')
  })

  it.each(['## Plan', '### Context', '## PECOT-Workflow'])('%s の節は、要約だけを置き、<details> を持たない', async (heading) => {
    await explains(`plan テンプレートの \`${heading}\` の節のテストです。節に要約の行が存在し、\`<details>\` を含まないことを確認します。`)
    const lines = planSection(heading)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines).not.toContain('<details>')
  })

  it('Files の節は、外に触る代表ファイルを並べ、<details> の中にファイルごとの変更内容を書く', async () => {
    await explains('plan テンプレートの「書き方」のテストです。Files は外に代表ファイルを並べ、`<details>` の中でファイルごとの変更内容を詳しく書くことが記載されていることを確認します。')
    const rules = writingRules(PLAN_TEMPLATE)
    expect(rules).toContain('Files は、外に触る代表ファイルを並べ')
    expect(rules).toContain('ファイルごとのどう触るかを詳しく書く')
  })

  it('Files の先頭に作業単位の表（実装者・モデル・担当）を書き、モデルの基準の参照先を示す', async () => {
    await explains('plan テンプレートの Files の節のテストです。先頭に作業単位の表（実装者・モデル・担当）を書くことと、モデルの基準の参照先 `agent-models.md` が記載され、その参照先に該当の節が存在することを確認します。')
    const rules = writingRules(PLAN_TEMPLATE)
    expect(rules).toContain('作業単位の表（実装者・モデル・担当）')
    expect(rules).toContain('skills/w-help/references/agent-models.md')
    expect(readPluginFile('skills/w-help/references/agent-models.md')).toContain('## 実装者のモデルの基準')
    const files = planSection('### Files')
    expect(files).toContain('作業単位')
    expect(files).toContain('| 実装者 | モデル | 担当 |')
  })

  it('利用者の判断が要る点は聞いて決めてから書かせ、「判断を仰ぐ点」を書く欄を持たない', async () => {
    await explains('plan テンプレートの「書き方」のテストです。利用者の判断が要る点は聞いて決めてから書くことが記載され、「判断を仰ぐ点」の欄が存在しないことを確認します。')
    expect(writingRules(PLAN_TEMPLATE)).toContain('利用者の判断が要る点は、利用者に聞いて決めてから書く。決まっていない点を計画に残さない')
    expect(body(PLAN_TEMPLATE)).toContain('利用者に聞いて決めた点')
    expect(readPluginFile(PLAN_TEMPLATE)).not.toContain('判断を仰ぐ点')
  })

  it('Claude Code の plan mode の標準 5 項目の置き場を書く', async () => {
    await explains('plan テンプレートの「書き方」のテストです。Claude Code の plan mode の標準 5 項目の置き場が記載されていることを確認します。')
    expect(writingRules(PLAN_TEMPLATE)).toContain('標準 5 項目')
  })

  it('CUJ の定義（3 要素と、CUJ にしないもの）がテンプレートに記載されている', async () => {
    await explains('plan テンプレートの CUJ の規則のテストです。CUJ の定義、必須の 3 要素（誰が・起点・観測結果）、dry-run を CUJ にしない旨、「流す先」を書く旨が記載されていることを確認します。')
    const rules = writingRules(PLAN_TEMPLATE)
    expect(rules).toContain('CUJ = 利用者')
    expect(rules).toContain('「誰が・起点・観測結果」の 3 要素を必須とし')
    expect(rules).toContain('健全性確認のための dry-run は CUJ にしない')
    expect(rules).toContain('CUJ ごとに「流す先」を書く。')
  })

  it('E2E の詳細は、「CUJ 1」の行の下に 誰が・起点・流す先・テスト手順・合格基準 をこの順に並べる', async () => {
    await explains('plan テンプレートの E2E の節のテストです。「CUJ 1」の行の下に、誰が・起点・流す先・テスト手順・合格基準の項目が、この順に並んでいることを確認します。')
    const lines = planSection('### E2E')
    const start = lines.indexOf('CUJ 1')
    expect(start).toBeGreaterThanOrEqual(0)
    const labels = ['- 誰が — ', '- 起点 — ', '- 流す先 — ', '- テスト手順', '- 合格基準 — ']
    const found = labels.map(label => ({ label, at: lines.slice(start).findIndex(line => line.startsWith(label)) }))
    expect(found.filter(({ at }) => at === -1).map(({ label }) => label)).toEqual([])
    expect(found.toSorted((a, b) => a.at - b.at).map(({ label }) => label)).toEqual(labels)
  })

  it('例の CUJ は、どれも流す先を「手元」と書く', async () => {
    await explains('plan テンプレートの「例:」のテストです。例に書かれたすべての CUJ で、流す先が「手元」と記載されていることを確認します。')
    const text = example(PLAN_TEMPLATE)
    const cujCount = text.match(/^CUJ \d+$/gmu)?.length ?? 0
    expect(cujCount).toBeGreaterThan(0)
    expect(text.match(/^- 流す先 — 手元$/gmu)?.length ?? 0).toBe(cujCount)
  })
})

describe.each(['cli/templates/issue/task.md', 'cli/templates/issue/bug.md'])('%s のフロントマター', (template) => {
  const keys = (readPluginFile(template).split('---\n', 2)[1] ?? '').split('\n').map(line => line.split(':', 1)[0])

  it('blocked_by を持ち、status と order を持たない（置く列と番号は issue_create が決める）', async () => {
    await explains(`\`${template}\` のフロントマターのテストです。\`blocked_by\` が含まれ、\`status\` と \`order\` が含まれないことを確認します。`)
    expect(keys).toContain('blocked_by')
    expect(keys).not.toContain('status')
    expect(keys).not.toContain('order')
  })

  it('フィールドの説明に、blocked_by と、order・status を書かない旨がある', async () => {
    await explains(`\`${template}\` の冒頭のコメントのテストです。フィールドの説明に \`blocked_by\` の項目と、\`order\` と \`status\` は書かない旨が記載されていることを確認します。`)
    const text = comment(template)
    expect(text).toContain('- blocked_by: ')
    expect(text).toContain('- order・status: 書かない')
  })
})

describe('pr/create テンプレート', () => {
  it('Changes に振る舞いの変化を書くことと、Closes # に入れる番号を書く', async () => {
    await explains('`pr/create` テンプレートの「書き方」のテストです。Changes には振る舞いの変化を書くことと、`Closes #` には sub-issue の番号だけを入れることが記載されていることを確認します。')
    const rules = writingRules(PR_CREATE_TEMPLATE)
    expect(rules).toContain('Changes には振る舞いの変化を書く')
    expect(rules).toContain('どのファイル・関数をどう直したかは書かない')
    expect(rules).toContain('`Closes #` には sub-issue の番号だけを入れる')
  })

  it('フロントマターに screenshot があり、撮る変更と理由の書き方を書く', async () => {
    await explains('`pr/create` テンプレートの `screenshot` のテストです。フロントマターに空の `screenshot` があり、画像を入れない理由の書き方と、画像の対象にしない変更が記載されていることを確認します。')
    const frontmatter = readPluginFile(PR_CREATE_TEMPLATE).split('---\n', 2)[1] ?? ''
    const text = comment(PR_CREATE_TEMPLATE)
    expect(frontmatter.split('\n')).toContain('screenshot: ""')
    expect(text).toContain('- screenshot: 画像を Summary に入れたら空のまま')
    expect(text).toContain('入れない理由を')
    const rules = writingRules(PR_CREATE_TEMPLATE)
    expect(rules).toContain('ツールが生成して利用者が GitHub で見る Markdown')
    expect(rules).toContain('CHANGELOG・README・SKILL.md の文の変更は含めない')
  })
})
