// issue-flow-rules.md への参照と、skills の相対リンクの実在を確かめる。
// 対象は issue-quick のフッター・issue テンプレート・各 SKILL.md・references・hooks のテンプレート・agent 定義の、パス・節の anchor・§ 番号。
//
// anchor の slug は github-slugger のアルゴリズムの部分移植。
// 記号と結合文字の扱いは本体と違う近似。今の文書では本体と同じ結果になることを確かめてある。
// 文字クラスに \p{L}\p{N} を使い、CJK の見出しを残す。ASCII だけにすると全ての CJK の見出しが死んだリンクと誤判定される。
import { globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { pluginRoot, readPluginFile } from './_helpers/documents.js'

const RULES_DOC = 'skills/w-help/references/issue-flow-rules.md'
const FREEFORM_SOURCE = 'cli/src/commands/issue-create.ts'

const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/gu
const INLINE_CODE = /`[^`]*`/gu
// §N は「issue-flow-rules のパスの直後（最大 20 文字、§ を跨がない範囲）」だけを拾う。
// 行内の §N を全部拾うと、別資料の §N が同じ行にあるときも拾ってしまうため。
const SECTION_SIGN_NEAR_PATH = /issue-flow-rules(?:\.md)?[^§\n]{0,20}§(\d+)/gu
// issue-flow-rules.md 本体への repo 内パスは `skills/...` の絶対形で書く規約。
// eslint-disable-next-line security/detect-unsafe-regex -- 入力は数百行の md で、パターンは [^\s#]* と固定の .md だけの線形
const RULES_PATH = /skills\/[^\s#]*\.md(?:#[^\s)>]*)?/gu
// 参照の側では相対形でも書かれるので、§N と節の同一性の検証では、パスの接頭辞を問わず anchor を拾う
const RULES_ANCHOR = /issue-flow-rules(?:\.md)?#([^\s)>]+)/gu

interface Line {
  readonly number: number
  readonly text: string
}

function glob(pattern: string): readonly string[] {
  return globSync(pattern, { cwd: pluginRoot }).toSorted(compareStrings)
}

/**
fence の外の行を、1 始まりの行番号付きで返す。
``` のフェンスだけに対応し、~~~ のフェンスとフェンスの入れ子には対応しない
*/
function nonFencedLines(text: string): readonly Line[] {
  const lines: Line[] = []
  let isInFence = false
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trimStart().startsWith('```')) {
      isInFence = !isInFence
    }
    else if (!isInFence) {
      lines.push({ number: index + 1, text: line })
    }
  }
  return lines
}

/**
GitHub 方式で見出しを slug にする。重複した slug には、ファイル全体の通し番号で -1・-2 を付ける
*/
function githubSlug(heading: string, seen: Map<string, number>): string {
  const slug = heading.toLowerCase().replaceAll('`', '').replaceAll(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-')
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count > 0 ? `${slug}-${String(count)}` : slug
}

function headingText(line: string): string | undefined {
  return /^#{1,6}\s+(\S.*)$/u.exec(line.trim())?.[1]?.trim()
}

function githubSlugs(file: string): ReadonlySet<string> {
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  const lines = nonFencedLines(readPluginFile(file))
  for (const { text } of lines) {
    const heading = headingText(text)
    if (heading !== undefined) slugs.add(githubSlug(heading, seen))
  }
  return slugs
}

/**
`## N. ...` 形式の見出しの番号 N の集合
*/
function headingNumbers(file: string): ReadonlySet<string> {
  const numbers = new Set<string>()
  const lines = nonFencedLines(readPluginFile(file))
  for (const { text } of lines) {
    const number = /^#{1,6}\s+(\d+)\.\s/u.exec(text.trim())?.[1]
    if (number !== undefined) numbers.add(number)
  }
  return numbers
}

/**
見出しの slug から、それを含む直近の `## N.` の節の番号へ。`## N.` より前の見出しは空文字
*/
function slugToSection(file: string): ReadonlyMap<string, string> {
  const seen = new Map<string, number>()
  const mapping = new Map<string, string>()
  let current = ''
  const lines = nonFencedLines(readPluginFile(file))
  for (const { text } of lines) {
    const heading = headingText(text)
    if (heading === undefined) continue
    const section = /^(\d+)\.\s/u.exec(heading)?.[1]
    if (section !== undefined) current = section
    mapping.set(githubSlug(heading, seen), current)
  }
  return mapping
}

function isFile(relative: string): boolean {
  return globSync(relative, { cwd: pluginRoot }).length === 1
}

/**
`skills/...md` のパスと anchor が、プラグインのルート基準で実在するかを確かめ、無い分を `<label>: ...` の形で返す
*/
function missingRulesTargets(label: string, text: string): readonly string[] {
  const offenders: string[] = []
  const targets = text.match(RULES_PATH) ?? []
  for (const raw of targets) {
    const [file = '', anchorPart = ''] = raw.split('#', 2)
    // 末尾の ` -->` などを含めないよう、anchor は空白と > で切る
    const anchor = /^[^\s>]*/u.exec(anchorPart)?.[0] ?? ''
    if (!isFile(file)) offenders.push(`${label}: missing file -> ${raw}`)
    else if (anchor !== '' && !githubSlugs(file).has(anchor)) offenders.push(`${label}: missing anchor -> ${raw}`)
  }
  return offenders
}

describe('skills の相対リンク', () => {
  it('skills/**/*.md の相対 markdown リンクと anchor が実在する', () => {
    const offenders: string[] = []
    let checked = 0
    for (const file of glob('skills/**/*.md')) {
      const lines = nonFencedLines(readPluginFile(file))
      for (const { number, text } of lines) {
        // リンクのテキストに ` を含む例があるので、inline code を除いてからリンクを拾う。除いても (path) の構造は残る
        const scrubbed = text.replaceAll(INLINE_CODE, '')
        for (const match of scrubbed.matchAll(MD_LINK)) {
          const target = (match[1] ?? '').trim()
          if (/^(?:https?:\/\/|mailto:|#)/u.test(target) || !target.includes('.md')) continue
          const [pathPart = '', anchor = ''] = target.split('#', 2)
          const resolved = path.relative(pluginRoot, path.resolve(pluginRoot, path.dirname(file), pathPart))
          const where = `${file}:${String(number)}`
          checked += 1
          if (!isFile(resolved)) offenders.push(`${where}: missing file -> ${target}`)
          else if (anchor !== '' && !githubSlugs(resolved).has(anchor)) offenders.push(`${where}: missing anchor -> ${target}`)
        }
      }
    }
    // 走査が空振りして通るのを止める
    expect(checked).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

describe('起票ルールの参照', () => {
  it('freeform の本文のフッターが指すパスと anchor が実在する', () => {
    const source = readPluginFile(FREEFORM_SOURCE)
    const footer = /const FREEFORM_FOOTER = '([^']*)'/u.exec(source)?.[1]
    expect(footer).toContain('skills/')
    expect(missingRulesTargets('FREEFORM_FOOTER', footer ?? '')).toEqual([])
  })

  it('issue テンプレート内の skills/...md のパスと anchor が実在する', () => {
    const offenders: string[] = []
    for (const file of glob('cli/templates/issue/*.md')) {
      const lines = nonFencedLines(readPluginFile(file))
      for (const { number, text } of lines) {
        offenders.push(...missingRulesTargets(`${file}:${String(number)}`, text))
      }
    }
    expect(offenders).toEqual([])
  })

  it('issue テンプレートの冒頭のコメントに「読者:」と「例:」のラベルがある', () => {
    const files = glob('cli/templates/issue/*.md')
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const text = readPluginFile(file)
      if (!text.includes('読者:')) offenders.push(`${file}: missing \`読者:\` label`)
      if (!text.includes('例:')) offenders.push(`${file}: missing \`例:\` label`)
    }
    expect(offenders).toEqual([])
  })

  it('issue-flow-rules のパスの近くの §N が、`## N.` の見出しと対応し、anchor の節と一致する', () => {
    const numbers = headingNumbers(RULES_DOC)
    const sectionOf = slugToSection(RULES_DOC)
    // hooks のテンプレートと agent 定義も §N で本体を参照する。
    // パスは backtick の外に置く規約。inline code は § の探索の前に除くので、backtick の中に入れると検知から外れる
    const sources = [
      FREEFORM_SOURCE,
      ...glob('skills/**/*.md'),
      ...glob('cli/templates/issue/*.md'),
      ...glob('hooks/templates/*.md'),
      ...glob('agents/*.md'),
    ]
    const offenders: string[] = []

    for (const source of sources) {
      // issue-flow-rules.md 自身は「（§5）」などの自己言及を含むので対象外
      if (source === RULES_DOC) continue
      const text = readPluginFile(source)
      const lines = source.endsWith('.md')
        ? nonFencedLines(text)
        : text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
      for (const { number, text: line } of lines) {
        if (!line.includes('issue-flow-rules')) continue
        const where = `${source}:${String(number)}`
        const sectionNumbers = Array.from(line.replaceAll(INLINE_CODE, '').matchAll(SECTION_SIGN_NEAR_PATH), match => match[1] ?? '')
        for (const value of sectionNumbers) {
          if (!numbers.has(value)) offenders.push(`${where}: §${value} has no \`## ${value}.\``)
        }
        // 同じ行に rules への anchor 付きの参照があれば、その anchor の見出しが §N と同じ `## N.` の節の下にあることを確かめる
        for (const match of line.matchAll(RULES_ANCHOR)) {
          const anchor = match[1] ?? ''
          const anchorSection = sectionOf.get(anchor)
          if (anchorSection === undefined) continue
          for (const value of sectionNumbers) {
            if (anchorSection !== value) offenders.push(`${where}: anchor #${anchor} (§${anchorSection}) mismatches §${value}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
