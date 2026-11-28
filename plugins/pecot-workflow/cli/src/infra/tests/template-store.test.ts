/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは配布テンプレートと一時ディレクトリ配下のみ */
import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import type { IssueFrontmatter } from '@pecot/workflow-core/domain/frontmatter.js'
import {
  validateBodyStyle,
  validateClosedHeadings,
  validateHeadingSummaries,
  validateSections,
} from '@pecot/workflow-core/domain/sections.js'
import type { SectionHeading } from '@pecot/workflow-core/domain/sections.js'
import { readTemplateSections } from '@pecot/workflow-core/infra/template-sections.js'
import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { COMMENT_TEMPLATES } from '../../commands/issue-comment-check.js'
import { templateFile, templatesDirectory } from '../template-store.js'
import type { TemplateKind } from '../template-store.js'

useIsolatedEnvironment()

const DISTRIBUTED_TEMPLATES: readonly (readonly [TemplateKind, string])[] = [['issue', 'task'], ['issue', 'epic'], ['comment', 'plan'], ['pr', 'create'], ['pr', 'release']]

// 配布テンプレート実体の必須セクション。呼ぶたびに読む
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
  it('テンプレートのパスは、プラグインの cli/templates の下を指す', async () => {
    await explains('テンプレートの場所を求める `templatesDirectory` と `templateFile` のテストです。`pr` のディレクトリと `comment` の `plan` のファイルが、`plugins/pecot-workflow/cli/templates` の下を指すことを確認します。')
    const paths = stepSync('テンプレートのパスを求める', () => ({ directory: templatesDirectory('pr'), file: templateFile('comment', 'plan') }))
    stepSync('パスを比べる', () => {
      expect(paths.directory).toMatch(/plugins\/pecot-workflow\/cli\/templates\/pr$/u)
      expect(paths.file).toMatch(/plugins\/pecot-workflow\/cli\/templates\/comment\/plan\.md$/u)
    })
  })

  it('配布するテンプレートのファイルが存在し、見出しを 1 つ以上持つ', async () => {
    await explains('配布するテンプレートの `issue/task`・`issue/epic`・`comment/plan`・`pr/create`・`pr/release` のテストです。どのファイルからも、1 つ以上の見出しを読み込めることを確認します。')
    const counts = stepSync('配布するテンプレートの見出しを読む', () => DISTRIBUTED_TEMPLATES.map(([kind, name]) => readTemplateSections(templateFile(kind, name)).length))
    stepSync('見出しの数を比べる', () => {
      for (const count of counts) {
        expect(count).toBeGreaterThan(0)
      }
    })
  })

  it('環境変数 CLAUDE_PLUGIN_ROOT を指定しても、ソースからの相対位置のテンプレートを指す', async () => {
    await explains('テンプレートの場所を求める `templatesDirectory` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` に別のディレクトリを設定しても、`plugins/pecot-workflow/cli/templates/issue` を返すことを確認します。')
    stepSync('CLAUDE_PLUGIN_ROOT に別のディレクトリを設定する', () => {
      process.env['CLAUDE_PLUGIN_ROOT'] = makeTemporaryDirectory()
    })
    const directory = stepSync('テンプレートのディレクトリを求める', () => templatesDirectory('issue'))
    stepSync('パスを比べる', () => {
      expect(directory).toMatch(/plugins\/pecot-workflow\/cli\/templates\/issue$/u)
    })
  })
})

// 検証に渡すテンプレートの名前の全部。readTemplateSections は無いファイルで空を返し、検証が何も止めなくなるため、実在を確かめる
const ISSUE_TEMPLATE_NAMES: Readonly<Record<NonNullable<IssueFrontmatter['template']> | IssueFrontmatter['type'], true>> = { 'task': true, 'bug': true, 'epic': true, 'tracker': true, 'task-implement': true }

describe('検証に渡すテンプレートのパス', () => {
  it.each(Object.keys(ISSUE_TEMPLATE_NAMES))('Issue の %s のテンプレートは、ファイルが存在し、見出しを 1 つ以上持つ', async (name) => {
    await explains('検証に使う Issue のテンプレートのテストです。`task`・`bug`・`epic`・`tracker`・`task-implement` のそれぞれについて、ファイルが存在し、見出しを 1 つ以上持つことを確認します。')
    const loaded = stepSync('テンプレートのファイルと見出しを読む', () => ({ exists: existsSync(templateFile('issue', name)), count: readTemplateSections(templateFile('issue', name)).length }))
    stepSync('ファイルの有無と見出しの数を比べる', () => {
      expect(loaded.exists).toBe(true)
      expect(loaded.count).toBeGreaterThan(0)
    })
  })

  it.each(COMMENT_TEMPLATES)('コメントの %s のテンプレートは、ファイルが存在し、見出しを 1 つ以上持つ', async (name) => {
    await explains('検証に使うコメントのテンプレートのテストです。`plan`・`merge-diff`・`review-findings` などのそれぞれについて、ファイルが存在し、見出しを 1 つ以上持つことを確認します。')
    const loaded = stepSync('テンプレートのファイルと見出しを読む', () => ({ exists: existsSync(templateFile('comment', name)), count: readTemplateSections(templateFile('comment', name)).length }))
    stepSync('ファイルの有無と見出しの数を比べる', () => {
      expect(loaded.exists).toBe(true)
      expect(loaded.count).toBeGreaterThan(0)
    })
  })
})

describe('pr/create.md の実体と検証器の結合', () => {
  it('create.md からは、h2 の Summary・Changes・Verified・Risks の 4 件だけを抽出する', async () => {
    await explains('PR のテンプレート `pr/create.md` から必須の見出しを読み込むテストです。h2 の `Summary`・`Changes`・`Verified`・`Risks` の 4 件だけが、この順に抽出されることを確認します。')
    const names = stepSync('create.md の見出しを抽出する', () => sectionNames(createSections()))
    stepSync('見出しを比べる', () => {
      expect(names).toEqual([[2, 'Summary'], [2, 'Changes'], [2, 'Verified'], [2, 'Risks']])
    })
  })

  it('抽出した見出しがすべて含まれる場合だけ検証を通り、不足している見出しがあればその見出しを返す', async () => {
    await explains('`pr/create.md` の見出しを使う `validateSections` のテストです。4 つの見出しがすべて含まれる場合は空の配列を返し、1 つだけ不足している場合は、その見出し（`## Summary` など）を返すことを確認します。')
    const summary = '## Summary\n\n本文だけで変更が分かる。\n'
    const changes = '## Changes\n\nなし\n'
    const verified = '## Verified\n\n- xxx\n'
    const risks = '## Risks\n\nなし'

    const missing = stepSync('見出しを 1 つずつ欠いた 5 通りの本文を検証する', () => [
      `${summary}\n${changes}\n${verified}\n${risks}`,
      `${changes}\n${verified}\n${risks}`,
      `${summary}\n${verified}\n${risks}`,
      `${summary}\n${changes}\n${risks}`,
      `${summary}\n${changes}\n${verified}`,
    ].map(body => validateSections(body, createSections())))
    stepSync('不足している見出しを比べる', () => {
      expect(missing).toEqual([[], ['## Summary'], ['## Changes'], ['## Verified'], ['## Risks']])
    })
  })

  it('見出しの後ろの文には規則を適用せず、本文の未編集のプレースホルダは検出する', async () => {
    await explains('`pr/create.md` の見出しを使う検証のテストです。見出しの後ろの文が長くても `validateSections` は指摘せず、`validateBodyStyle` は未編集のプレースホルダを指摘することを確認します。')
    // プレースホルダは validateBodyStyle が見る（#958 F-03 / #962 / #1185 で検出責務を分離）
    const body = `## Summary\n\nテスト用の本文。\n\n## Changes\n\nなし\n\n## Verified — ${'あ'.repeat(51)}\n\n## Risks\n\n<レビューで見てほしい点>`

    const results = stepSync('本文を 3 つの検証にかける', () => ({
      sections: validateSections(body, createSections()),
      summaries: validateHeadingSummaries(body, createSections()),
      style: validateBodyStyle(body),
    }))
    stepSync('指摘を比べる', () => {
      expect(results.sections).toEqual([])
      expect(results.summaries).toEqual([])
      expect(results.style.some(message => message.includes('unedited placeholder'))).toBe(true)
    })
  })
})

describe('pr/release.md の実体から抽出した必須セクション（#958 F-06）', () => {
  // 全件必須セマンティクスのため、release.md への見出し追加は「全リリース PR に必須節が増える」ことを意味する。増減をここで検出する。

  it('release.md からは、h2 の 4 つの見出しだけを抽出する', async () => {
    await explains('リリース PR のテンプレート `pr/release.md` から必須の見出しを読み込むテストです。h2 の `Summary`・`Changes`・`Migration`・`Verified` の 4 件だけが、この順に抽出されることを確認します。')
    const names = stepSync('release.md の見出しを抽出する', () => sectionNames(releaseSections()))
    stepSync('見出しを比べる', () => {
      expect(names).toEqual([[2, 'Summary'], [2, 'Changes'], [2, 'Migration'], [2, 'Verified']])
    })
  })

  it('4 つの見出しがすべて含まれる場合だけ検証を通り、1 つ不足していればその見出しを返す', async () => {
    await explains('`pr/release.md` の見出しを使う `validateSections` のテストです。4 つの見出しがすべて含まれる場合は空の配列を返し、`## Migration` が不足している場合は、その見出しを返すことを確認します。')
    const full = '## Summary\n\n本文\n\n'
      + '## Changes\n\n本文\n\n'
      + '## Migration\n\nなし\n\n'
      + '## Verified\n\n- テスト — pass\n'

    const withoutMigration = full.replace('## Migration\n\nなし\n\n', '')
    const results = stepSync('全部ある本文と Migration を欠いた本文を検証する', () => [validateSections(full, releaseSections()), validateSections(withoutMigration, releaseSections())])
    stepSync('不足している見出しを比べる', () => {
      expect(results).toEqual([[], ['## Migration']])
    })
  })
})

describe('issue/epic.md の実体（AS-IS / TO-BE / GAP）と検証器の結合', () => {
  it('epic.md からは、h2 の AS-IS・TO-BE・GAP の 3 件だけを抽出する', async () => {
    await explains('Epic のテンプレート `issue/epic.md` から必須の見出しを読み込むテストです。レベルがすべて 2 で、名前が `AS-IS`・`TO-BE`・`GAP` の 3 件だけが抽出されることを確認します。')
    const sections = stepSync('epic.md の見出しを抽出する', () => epicSections())
    stepSync('レベルと名前を比べる', () => {
      expect(sections.map(({ level }) => level)).toEqual([2, 2, 2])
      expect(sections.map(({ name }) => name.split(' — ', 1)[0])).toEqual(['AS-IS', 'TO-BE', 'GAP'])
    })
  })

  it('3 つの見出しに要約を付けた本文は、不足なしと判定する', async () => {
    await explains('`issue/epic.md` の見出しを使う `validateSections` のテストです。`AS-IS`・`TO-BE`・`GAP` の 3 つの見出しに `—` で要約を付けて本文を書いた場合に、空の配列を返すことを確認します。')
    const body = '## AS-IS — 現状\n\n現状の事実\n\n## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n'
    const missing = stepSync('本文を検証する', () => validateSections(body, epicSections()))
    stepSync('不足している見出しが無いことを比べる', () => {
      expect(missing).toEqual([])
    })
  })

  it('区切りが半角ハイフンの見出しは、不足している見出しとして返す', async () => {
    await explains('`issue/epic.md` の見出しを使う `validateSections` のテストです。見出しの区切りが `—` ではなく半角ハイフンの `## AS-IS - 現状` の場合に、`## AS-IS — <summary>` が不足していると返すことを確認します。')
    const missing = stepSync('半角ハイフンの見出しを含む本文を検証する', () => validateSections(epicBodyWith('## AS-IS - 現状'), epicSections()))
    stepSync('不足している見出しを比べる', () => {
      expect(missing).toEqual(['## AS-IS — <summary>'])
    })
  })

  it('要約が上限を超える場合は、不足ではなく要約の規則違反として返す', async () => {
    await explains('`issue/epic.md` の見出しを使う検証のテストです。`AS-IS` の要約が 51 文字の場合に、`validateSections` は空の配列を返し、`validateHeadingSummaries` は上限超過を返すことを確認します。')
    const body = epicBodyWith(`## AS-IS — ${'あ'.repeat(51)}`)
    const results = stepSync('本文を 2 つの検証にかける', () => ({ sections: validateSections(body, epicSections()), summaries: validateHeadingSummaries(body, epicSections()) }))
    stepSync('指摘を比べる', () => {
      expect(results.sections).toEqual([])
      expect(results.summaries).toEqual(['## AS-IS — the summary is 51 characters (limit: 50)'])
    })
  })
})

describe('comment/plan.md の実体の見出しの集合（#1330）', () => {
  it('plan.md の見出しは 7 つで、先頭のガイドコメントの見出しは含まない', async () => {
    await explains('コメントのテンプレート `comment/plan.md` から見出しを読み込むテストです。`Plan` と `PECOT-Workflow` の h2 と、`Context`・`Approach`・`Files`・`Notes`・`E2E` の h3 の 7 件が、この順に抽出されることを確認します。')
    const sections = stepSync('plan.md の見出しを読む', () => readTemplateSections(templateFile('comment', 'plan')))
    stepSync('見出しを比べる', () => {
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
  })

  it('抽出した見出しだけの本文は、validateClosedHeadings の検証を通る', async () => {
    await explains('`comment/plan.md` の見出しを使う `validateClosedHeadings` のテストです。抽出した見出しだけを並べた本文を渡した場合に、指摘がなく空の配列を返すことを確認します。')
    const sections = stepSync('plan.md の見出しを読む', () => readTemplateSections(templateFile('comment', 'plan')))
    const body = stepSync('見出しだけの本文を組み立てる', () => sections.map(({ level, name }) => `${'#'.repeat(level)} ${name}`).join('\n'))
    const findings = stepSync('本文を検証する', () => validateClosedHeadings(body, sections))
    stepSync('指摘が無いことを比べる', () => {
      expect(findings).toEqual([])
    })
  })
})
