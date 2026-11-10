/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  extractSectionsFromTemplate,
  validateBodyStyle,
  validateClosedHeadings,
  validateHeadingSummaries,
  validateSections,
} from '../../domain/sections.js'
import type { SectionHeading } from '../../domain/sections.js'
import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { readTemplateSections, templateFile, templatesDirectory } from '../template-store.js'
import type { TemplateKind } from '../template-store.js'

useIsolatedEnvironment()

function writeTemplate(content: string): string {
  const file = path.join(makeTemporaryDirectory(), 'test.md')
  writeFileSync(file, content, 'utf8')
  return file
}

const DISTRIBUTED_TEMPLATES: readonly (readonly [TemplateKind, string])[] = [['issue', 'task'], ['issue', 'epic'], ['comment', 'plan'], ['pr', 'create'], ['pr', 'release']]

// 配布テンプレート実体の必須セクション。CLAUDE_PLUGIN_ROOT の隔離後に読むため、呼ぶたびに読む
function createSections(): readonly SectionHeading[] {
  return readTemplateSections(templateFile('pr', 'create'))
}

function releaseSections(): readonly SectionHeading[] {
  return readTemplateSections(templateFile('pr', 'release'))
}

function epicSections(): readonly SectionHeading[] {
  return readTemplateSections(templateFile('issue', 'epic'))
}

function epicBodyWith(heading: string): string {
  return `${heading}\n\n現状の事実\n\n## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n`
}

// (level, "名前 — <summary>") から em-dash サマリを落として (level, 名前) にする
function sectionNames(sections: readonly SectionHeading[]): readonly (readonly [number, string])[] {
  return sections.map(({ level, name }) => [level, name.split(' — ', 1)[0] ?? name])
}

describe('templatesDirectory・templateFile', () => {
  it('プラグインの cli/templates の下にある', () => {
    expect(templatesDirectory('pr')).toMatch(/plugins\/pecot-workflow\/cli\/templates\/pr$/u)
    expect(templateFile('comment', 'plan')).toMatch(/plugins\/pecot-workflow\/cli\/templates\/comment\/plan\.md$/u)
  })

  it('配布テンプレートの実体がある', () => {
    for (const [kind, name] of DISTRIBUTED_TEMPLATES) {
      expect(readTemplateSections(templateFile(kind, name)).length).toBeGreaterThan(0)
    }
  })

  it('CLAUDE_PLUGIN_ROOT があればそちらの下を指す', () => {
    const root = makeTemporaryDirectory()
    process.env['CLAUDE_PLUGIN_ROOT'] = root
    expect(templatesDirectory('issue')).toBe(path.join(root, 'cli', 'templates', 'issue'))
  })
})

describe('readTemplateSections', () => {
  it('ファイルから見出しレベルを抽出する', () => {
    const file = writeTemplate('---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n')
    expect(readTemplateSections(file)).toEqual([{ level: 3, name: '完了した作業' }, { level: 4, name: '残タスク' }])
  })

  it('ファイルが存在しない場合は空リスト', () => {
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    expect(readTemplateSections(file)).toEqual([])
  })

  it('読めないファイル（ディレクトリ）は空リスト', () => {
    const directory = path.join(makeTemporaryDirectory(), 'dir.md')
    mkdirSync(directory)
    expect(readTemplateSections(directory)).toEqual([])
  })
})

describe('pr/create.md の実体と検証器の結合', () => {
  it('create.md からは h2 の Summary / Changes / Verified / Risks の 4 件だけが抽出される', () => {
    expect(sectionNames(createSections())).toEqual([[2, 'Summary'], [2, 'Changes'], [2, 'Verified'], [2, 'Risks']])
  })

  it('抽出セクションが全部そろって初めて通り、欠けた分だけ不足が返る', () => {
    const summary = '## Summary\n\n本文だけで変更が分かる。\n'
    const changes = '## Changes\n\nなし\n'
    const verified = '## Verified\n\n- xxx\n'
    const risks = '## Risks\n\nなし'

    expect(validateSections(`${summary}\n${changes}\n${verified}\n${risks}`, createSections())).toEqual([])
    expect(validateSections(`${changes}\n${verified}\n${risks}`, createSections())).toEqual(['## Summary'])
    expect(validateSections(`${summary}\n${verified}\n${risks}`, createSections())).toEqual(['## Changes'])
    expect(validateSections(`${summary}\n${changes}\n${risks}`, createSections())).toEqual(['## Verified'])
    expect(validateSections(`${summary}\n${changes}\n${verified}`, createSections())).toEqual(['## Risks'])
  })

  it('見出しの後ろの文には規則を掛けず、本文の未編集プレースホルダは弾く', () => {
    // プレースホルダは validateBodyStyle が見る（#958 F-03 / #962 / #1185 で検出責務を分離）
    const body = `## Summary\n\nテスト用の本文。\n\n## Changes\n\nなし\n\n## Verified — ${'あ'.repeat(51)}\n\n## Risks\n\n<レビューで見てほしい点>`

    expect(validateSections(body, createSections())).toEqual([])
    expect(validateHeadingSummaries(body, createSections())).toEqual([])
    expect(validateBodyStyle(body).some(message => message.includes('unedited placeholder'))).toBe(true)
  })
})

describe('pr/release.md の実体から抽出した必須セクション（#958 F-06）', () => {
  // 全件必須セマンティクスのため、release.md への見出し追加は「全リリース PR に必須節が増える」ことを意味する。増減をここで検出する。

  it('release.md からは h2 の 4 見出しだけが抽出される', () => {
    expect(sectionNames(releaseSections())).toEqual([[2, 'Summary'], [2, 'Changes'], [2, 'Migration'], [2, 'Verified']])
  })

  it('4 見出しがそろって初めて通り、1 つ欠けると不足が返る', () => {
    const full = '## Summary\n\n本文\n\n'
      + '## Changes\n\n本文\n\n'
      + '## Migration\n\nなし\n\n'
      + '## Verified\n\n- テスト — pass\n'

    expect(validateSections(full, releaseSections())).toEqual([])
    const withoutMigration = full.replace('## Migration\n\nなし\n\n', '')
    expect(validateSections(withoutMigration, releaseSections())).toEqual(['## Migration'])
  })
})

describe('issue/epic.md の実体（AS-IS / TO-BE / GAP）と検証器の結合', () => {
  it('epic.md からは h2 の AS-IS / TO-BE / GAP の 3 件だけが抽出される', () => {
    expect(epicSections().map(({ level }) => level)).toEqual([2, 2, 2])
    expect(epicSections().map(({ name }) => name.split(' — ', 1)[0])).toEqual(['AS-IS', 'TO-BE', 'GAP'])
  })

  it('3 見出しをサマリ付きで埋めた本文は不足なしと判定される', () => {
    const body = '## AS-IS — 現状\n\n現状の事実\n\n## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n'
    expect(validateSections(body, epicSections())).toEqual([])
  })

  it('区切りが半角ハイフンの見出しは不足として報告される', () => {
    expect(validateSections(epicBodyWith('## AS-IS - 現状'), epicSections())).toEqual(['## AS-IS — <summary>'])
  })

  it('サマリの上限超過は不足ではなくサマリの規則違反として報告される', () => {
    const body = epicBodyWith(`## AS-IS — ${'あ'.repeat(51)}`)
    expect(validateSections(body, epicSections())).toEqual([])
    expect(validateHeadingSummaries(body, epicSections())).toEqual(['## AS-IS — the summary is 51 characters (limit: 50)'])
  })
})

describe('comment/plan.md の実体の見出しの集合（#1330）', () => {
  it('見出しは 8 つで、先頭のガイドコメントの見出しを含まない', () => {
    const sections = readTemplateSections(templateFile('comment', 'plan'))
    expect(sectionNames(sections)).toEqual([
      [2, 'Plan'],
      [3, 'Context'],
      [3, 'Approach'],
      [3, 'Files'],
      [3, 'Notes'],
      [2, 'PECOT-Workflow'],
      [3, 'E2E'],
    ])
  })

  it('その見出しだけの本文は validateClosedHeadings を通る', () => {
    const sections = readTemplateSections(templateFile('comment', 'plan'))
    const body = sections.map(({ level, name }) => `${'#'.repeat(level)} ${name}`).join('\n')
    expect(validateClosedHeadings(body, sections)).toEqual([])
  })
})

describe('domain との整合', () => {
  it('テンプレートファイルの内容を domain の抽出関数に渡した結果と同じ', () => {
    const file = writeTemplate('## A — <a>\n### B\n')
    expect(readTemplateSections(file)).toEqual(extractSectionsFromTemplate('## A — <a>\n### B\n'))
  })
})
