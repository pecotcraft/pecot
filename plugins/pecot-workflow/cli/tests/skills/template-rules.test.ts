// 配布するテンプレートの形と、冒頭のコメントの「例:」を確かめる。
// `--prepare` が配る 12 本（issue 5・comment 5・pr 2）は、冒頭のコメントに「読者:」と本文の手本の「例:」を持つ。
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
} from '../../src/domain/sections.js'
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
  it('issue 5 種・comment 5 種・pr 2 種の 12 本がそろっている', () => {
    expect(TEMPLATES).toHaveLength(12)
  })
})

describe.each(TEMPLATES)('%s', (template) => {
  it('冒頭のコメントに「読者:」と「例:」があり、例に見出しがある', () => {
    expect(comment(template).startsWith('読者: ')).toBe(true)
    expect(example(template)).toMatch(/^#{2,3} /mu)
  })

  it('見出しの横のサマリ（名前 — サマリ）は、PR・plan・task-implement 以外のテンプレートだけが使う', () => {
    const hasSummary = /^#{2,3} .+ — /mu.test(body(template))
    expect(hasSummary).toBe(!NAME_ONLY_TEMPLATES.has(template))
  })

  it('「例:」の本文が、そのテンプレートで投稿したときの検証を通る', () => {
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
  it('<summary> は全て PLAN_FOLD_SUMMARY の形', () => {
    const lines = body(PLAN_TEMPLATE).match(/^<summary.*$/gmu) ?? []
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter(line => line !== PLAN_FOLD_SUMMARY)).toEqual([])
  })

  it.each(['### Approach', '### Files', '### Notes', '### E2E'])('%s は、要約を外に置き、末尾に <details> を 1 つ置く', (heading) => {
    const lines = planSection(heading)
    expect(lines[0]).not.toBe('<details>')
    expect(lines.filter(line => line === '<details>')).toHaveLength(1)
    expect(lines.at(-1)).toBe('</details>')
  })

  it.each(['## Plan', '### Context', '## PECOT-Workflow'])('%s は、要約だけを置き、<details> を持たない', (heading) => {
    const lines = planSection(heading)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines).not.toContain('<details>')
  })

  it('Files は外に触る代表ファイル、<details> の中にファイルごとのどう触るかを書く', () => {
    const rules = writingRules(PLAN_TEMPLATE)
    expect(rules).toContain('Files は、外に触る代表ファイルを並べ')
    expect(rules).toContain('ファイルごとのどう触るかを詳しく書く')
  })

  it('Claude Code の plan mode の標準 5 項目の置き場を書く', () => {
    expect(writingRules(PLAN_TEMPLATE)).toContain('標準 5 項目')
  })

  it('CUJ の定義（3 要素と、CUJ にしないもの）が雛形にある', () => {
    const rules = writingRules(PLAN_TEMPLATE)
    expect(rules).toContain('CUJ = 利用者')
    expect(rules).toContain('「誰が・起点・観測結果」の 3 要素を必須とし')
    expect(rules).toContain('健全性確認のための dry-run は CUJ にしない')
  })

  it('E2E の詳細は、「CUJ 1」の行の下に 誰が・起点・テスト手順・合格基準 を並べる', () => {
    const lines = planSection('### E2E')
    const start = lines.indexOf('CUJ 1')
    expect(start).toBeGreaterThanOrEqual(0)
    const missing = ['- 誰が — ', '- 起点 — ', '- テスト手順', '- 合格基準 — '].filter(label => lines.slice(start).every(line => !line.startsWith(label)))
    expect(missing).toEqual([])
  })
})

describe('pr/create テンプレート', () => {
  it('Changes に振る舞いの変化を書くことと、Closes # に入れる番号を書く', () => {
    const rules = writingRules(PR_CREATE_TEMPLATE)
    expect(rules).toContain('Changes には振る舞いの変化を書く')
    expect(rules).toContain('どのファイル・関数をどう直したかは書かない')
    expect(rules).toContain('`Closes #` には sub-issue の番号だけを入れる')
  })

  it('フロントマターに screenshot があり、撮る変更と理由の書き方を書く', () => {
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
