import { describe, expect, it } from 'vitest'

import {
  appendIssueCloseIfNeeded,
  collectPreflightWarnings,
  decidePullRequestBase,
  describeBaseStop,
  describePushStatus,
  extractClosingIssueNumbers,
  formatPreflightWarning,
  formatPullRequestMarkdown,
  formatPullRequestWithReviewsMarkdown,
  formatReviewsMarkdown,
  formatReviewThreadsMarkdown,
  hasIssueReference,
  forkPushFixHint,
  isReleasePullRequest,
  parseHeadReference,
  pickLowerPullRequest,
  pushFixHintOf,
  SCREENSHOT_MISSING_ERROR,
  hasStashEntries,
  hasStatusChanges,
  validatePullRequestContent,
} from '../pull-request.js'
import { explains } from '../../../tests/_helpers/explains.js'
import type { PullRequestBaseDecision, PullRequestContentOptions, PullRequestSlimView, PullRequestWithReviewsView } from '../pull-request.js'
import type { PullRequestReadout } from '../issue-readout.js'
import '../../../tests/_helpers/hint-commands.js'
import { formatHinted } from '../command-hint.js'
import { JSON_NULL } from '../json-null.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import type { BaseReading } from '../state.js'
import type { RestackDecision } from '../restack.js'
import type { SectionHeading } from '../sections.js'

describe('extractClosingIssueNumbers', () => {
  it.each([
    ['Closes #123, Fixes #456', [123, 456]],
    ['Closes owner/repo#789', [789]],
    ['closes #1 and CLOSED #2 and fix #3 fixed #4 fixes #5 resolve #6 resolved #7 resolves #8', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['Closes #5\nFixes #5\nCloses #4', [5, 4]],
    ['Closes\u{3000}#9', [9]],
    ['Closes #１２', [12]],
    ['Refs #10, see #11', []],
    ['Closes # 12', []],
    ['', []],
    ['```console\nCloses #1\n```\nCloses #2', [2]],
    ['~~~\nCloses #1\n~~~\nCloses #2', [2]],
    ['> ```\n> Closes #1\n> ```\n> Closes #2', [2]],
    ['`Closes #1` と Closes #2', [2]],
    ['``Closes #1 ` x`` Closes #2', [2]],
    ['<!-- Closes #1 -->\nCloses #2', [2]],
    ['Closes #2\n```\nCloses #1', [2]],
    ['text\n\n    Closes #1\n\nCloses #2', [2]],
    ['    Closes #1\n\tCloses #3\nCloses #2', [2]],
    ['text\n    Closes #1', [1]],
    ['> ```\n> x\n\nCloses #2', [2]],
    ['> > ```\n> > Closes #1\n> > ```\n> Closes #2', [2]],
    ['Closes other/repo#1, Closes Owner/Repo#2, Closes owner/repo#3', [2, 3]],
  ])('本文 %j から、閉じる Issue の番号を取り出す', async (body, expected) => {
    await explains('PR の本文から、マージ時に閉じる Issue の番号を取り出す、`extractClosingIssueNumbers` のテストです。本文に `Closes #123` などのキーワードと Issue の番号がある場合に、その番号を重複なく出現順に返し、コードの中や別のリポジトリの参照は含めないことを確認します。')
    expect(extractClosingIssueNumbers(body, { owner: 'owner', repository: 'repo' })).toEqual(expected)
  })
})

describe('appendIssueCloseIfNeeded', () => {
  it('参照が存在しない本文には、末尾に Closes を追加する', async () => {
    await explains('PR の本文へ、Issue を閉じる記述を追加する、`appendIssueCloseIfNeeded` のテストです。Issue の参照が存在しない本文を渡した場合に、末尾に空行を挟んで `Closes #123` を追加することを確認します。')
    expect(appendIssueCloseIfNeeded('Changes', 123)).toBe('Changes\n\nCloses #123')
  })

  it('本文の末尾の空白を除いてから、Closes を追加する', async () => {
    await explains('PR の本文へ、Issue を閉じる記述を追加する、`appendIssueCloseIfNeeded` のテストです。本文の末尾に空白や空行がある場合に、それらを除いてから `Closes #123` を追加することを確認します。')
    expect(appendIssueCloseIfNeeded('Changes \n\n', 123)).toBe('Changes\n\nCloses #123')
  })

  it.each([
    ['Closes #123'],
    ['#123 を直す'],
    ['先頭\n#123'],
  ])('本文 %j には参照があるため、そのまま返す', async (body) => {
    await explains(`PR の本文へ、Issue を閉じる記述を追加する、\`appendIssueCloseIfNeeded\` のテストです。本文 \`${JSON.stringify(body)}\` のように、すでに Issue の参照がある場合に、追加せず本文をそのまま返すことを確認します。`)
    expect(appendIssueCloseIfNeeded(body, 123)).toBe(body)
  })

  it.each([
    ['https://example.com/#123'],
    ['#1234'],
    ['#12'],
  ])('本文 %j は別の参照のため、Closes を追加する', async (body) => {
    await explains(`PR の本文へ、Issue を閉じる記述を追加する、\`appendIssueCloseIfNeeded\` のテストです。本文 \`${JSON.stringify(body)}\` のように、対象の Issue の参照として扱えない記述の場合に、\`Closes #123\` を追加することを確認します。`)
    expect(appendIssueCloseIfNeeded(body, 123)).toBe(`${body}\n\nCloses #123`)
  })
})

describe('hasIssueReference', () => {
  it.each([
    ['Closes #12'],
    ['#12'],
    ['owner/repo#12'],
    ['a #1'],
  ])('本文 %j は、参照があると判定する', async (body) => {
    await explains(`PR の本文に Issue の参照があるかを判定する、\`hasIssueReference\` のテストです。本文 \`${JSON.stringify(body)}\` の場合に、Issue の参照があるとして \`true\` を返すことを確認します。`)
    expect(hasIssueReference(body)).toBe(true)
  })

  it.each([
    ['参照なし'],
    ['https://example.com/#12'],
    ['# 見出し'],
    ['#abc'],
  ])('本文 %j は、参照がないと判定する', async (body) => {
    await explains(`PR の本文に Issue の参照があるかを判定する、\`hasIssueReference\` のテストです。本文 \`${JSON.stringify(body)}\` の場合に、Issue の参照がないとして \`false\` を返すことを確認します。`)
    expect(hasIssueReference(body)).toBe(false)
  })
})

describe('isReleasePullRequest', () => {
  it('テンプレートが release の場合は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。テンプレートが `release` の場合に、ブランチにかかわらず `true` を返すことを確認します。')
    expect(isReleasePullRequest('release', 'x', 'y', 'develop', 'main')).toBe(true)
  })

  it('develop から release のブランチへの PR は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head が develop のブランチ、base が release のブランチの場合に、`true` を返すことを確認します。')
    expect(isReleasePullRequest('default', 'main', 'develop', 'develop', 'main')).toBe(true)
  })

  it('head が develop のブランチでない場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head が develop のブランチでない場合に、`false` を返すことを確認します。')
    expect(isReleasePullRequest('default', 'main', 'feat/x', 'develop', 'main')).toBe(false)
  })

  it('base が release のブランチでない場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。base が release のブランチでない場合に、`false` を返すことを確認します。')
    expect(isReleasePullRequest('default', 'develop', 'develop', 'develop', 'main')).toBe(false)
  })

  it('release のブランチが未設定か空の場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。release のブランチが `undefined` または空文字の場合に、`false` を返すことを確認します。')
    expect(isReleasePullRequest('default', 'main', undefined, undefined, undefined)).toBe(false)
    expect(isReleasePullRequest('default', '', '', '', '')).toBe(false)
  })

  it('head と develop が未設定でも、base が release のブランチの場合は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head と develop のブランチが未設定で、base が release のブランチの場合に、`true` を返すことを確認します。')
    expect(isReleasePullRequest('default', 'main', undefined, undefined, 'main')).toBe(true)
  })
})

const SECTIONS: readonly SectionHeading[] = [{ level: 2, name: 'Summary' }, { level: 2, name: 'Changes' }]
const IMAGE = '![shot](./a.png)'
const GOOD_BODY = `## Summary\n\n${IMAGE}\n\n## Changes\n\n- 変更 #12\n`

function options(override: Partial<PullRequestContentOptions> = {}): PullRequestContentOptions {
  return {
    body: GOOD_BODY,
    base: 'develop',
    developBranch: 'develop',
    releaseBranch: 'main',
    head: 'feat/x/12',
    template: 'default',
    skipIssueReferenceCheck: false,
    screenshot: undefined,
    requiredSections: SECTIONS,
    ...override,
  }
}

describe('validatePullRequestContent', () => {
  it('問題がない場合は、空の配列を返す', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。本文・base・節がすべて規則を満たす場合に、空の配列を返すことを確認します。')
    expect(validatePullRequestContent(options())).toEqual([])
  })

  it('Issue の参照が存在しない場合はエラーとし、skipIssueReferenceCheck を指定した場合はエラーにしない', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。本文に Issue の参照が存在しない場合に、入力 `no_issue_ref` を案内するエラーを返し、`skipIssueReferenceCheck` の指定時は返さないことを確認します。')
    const body = `## Summary\n\n${IMAGE}\n\n## Changes\n\n- 変更\n`
    const errors = validatePullRequestContent(options({ body }))
    expect(errors.map(error => formatHinted(error))).toEqual(['PR body has no Issue reference `#N` (use `no_issue_ref: true` for a PR not tied to an Issue)'])
    expect(validatePullRequestContent(options({ body, skipIssueReferenceCheck: true }))).toEqual([])
  })

  it('必須の節が欠けている場合は、欠けている節の名前を示す', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。本文から必須の節が欠けている場合に、`missing sections:` の後ろへ欠けている節の見出しを示すことを確認します。')
    const errors = validatePullRequestContent(options({ body: '## Summary\n\n![shot](./a.png) #12\n' }))
    expect(errors).toEqual(['missing sections: ## Changes'])
  })

  it('必須の節の指定が空の場合は、節を検証しない', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。必須の節の指定が空の配列の場合に、節が存在しなくてもエラーにならないことを確認します。')
    expect(validatePullRequestContent(options({ body: '## Summary\n\n![shot](./a.png) #12\n', requiredSections: [] }))).toEqual([])
  })

  it('見出しの要約が規則に違反している場合は、違反の内容を示す', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。見出しの要約が日本語でない場合に、`heading summary rule violations:` に続けて違反の内容を示すことを確認します。')
    const body = `## Summary — English only\n\n${IMAGE}\n\n## Changes\n\n- 変更 #12\n`
    const errors = validatePullRequestContent(options({ body, requiredSections: [{ level: 2, name: 'Summary — <要点>' }, { level: 2, name: 'Changes' }] }))
    expect(errors).toEqual(['heading summary rule violations: ## Summary — the summary must be written in Japanese'])
  })

  it('許可しない記法がある場合は、その内容を示す', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。本文にチェックボックスの記法がある場合に、`disallowed syntax:` に続けて許可しない記法の内容を示すことを確認します。')
    const errors = validatePullRequestContent(options({ body: `${GOOD_BODY}\n- [ ] 未完了\n` }))
    expect(errors).toEqual(['disallowed syntax: checkbox syntax (- [ ] / 1. [ ]) is not allowed'])
  })

  it('Summary に画像が存在せず、screenshot の理由も指定していない場合は、エラーにする', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。Summary に画像がなく、`screenshot` の理由も指定しない場合に、エラーを返し、理由を指定した場合はエラーを返さないことを確認します。')
    const body = '## Summary\n\n文のみ。\n\n## Changes\n\n- 変更 #12\n'
    expect(validatePullRequestContent(options({ body }))).toEqual([SCREENSHOT_MISSING_ERROR])
    expect(validatePullRequestContent(options({ body, screenshot: '画面は変わらない' }))).toEqual([])
    expect(validatePullRequestContent(options({ body, screenshot: '' }))).toEqual([SCREENSHOT_MISSING_ERROR])
  })

  it('screenshot の理由の案内は、入力名で表示する', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。screenshot が不足している場合の案内が、入力の名前（`screenshot` と `message`）で表示されることを確認します。')
    expect(formatHinted(SCREENSHOT_MISSING_ERROR)).toMatch(/\(`screenshot` with `message`\)$/u)
  })

  it('base が develop でない場合はエラーとし、develop が未設定の場合は検証しない', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。base が develop のブランチでない場合に、`base branch must be develop` を含むエラーを返し、未設定か空の場合は検証しないことを確認します。')
    expect(validatePullRequestContent(options({ base: 'main' }))).toEqual(['base branch must be develop (given: main)'])
    expect(validatePullRequestContent(options({ base: 'main', developBranch: undefined }))).toEqual([])
    expect(validatePullRequestContent(options({ base: 'main', developBranch: '' }))).toEqual([])
  })

  it('スタックの記録の base を渡した場合は、その base と開発ブランチを許可し、どちらでもない base はエラーにする', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。スタックの記録の base を渡した場合に、その base と開発ブランチは許可し、どちらでもない base はエラーにすることを確認します。')
    expect(validatePullRequestContent(options({ base: 'feat/a/11', stackedBase: 'feat/a/11' }))).toEqual([])
    expect(validatePullRequestContent(options({ base: 'develop', stackedBase: 'feat/a/11' }))).toEqual([])
    expect(validatePullRequestContent(options({ base: 'main', stackedBase: 'feat/a/11' }))).toEqual(['base branch must be develop or feat/a/11 (given: main)'])
  })

  it('スタックの記録の base が開発ブランチと同じ場合は、従来と同じ文でエラーにする', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。スタックの記録の base が開発ブランチと同じ場合に、開発ブランチだけを求める従来の文でエラーを返すことを確認します。')
    expect(validatePullRequestContent(options({ base: 'main', stackedBase: 'develop' }))).toEqual(['base branch must be develop (given: main)'])
  })

  it('リリース PR は Issue の参照と画像を求めず、base が release のブランチでない場合はエラーにする', async () => {
    await explains('PR の内容を検証する、`validatePullRequestContent` のテストです。リリース PR の場合に、Issue の参照と画像を検証せず、base が release のブランチでないときだけエラーを返すことを確認します。')
    const release = options({ body: '## Summary\n\n文のみ。\n\n## Changes\n\n- 変更\n', template: 'release' })
    expect(validatePullRequestContent({ ...release, base: 'main' })).toEqual([])
    expect(validatePullRequestContent({ ...release, base: 'develop' })).toEqual(['release PR base branch must be main (given: develop)'])
    expect(validatePullRequestContent({ ...release, base: 'develop', releaseBranch: undefined })).toEqual([])
    expect(validatePullRequestContent({ ...release, base: 'develop', releaseBranch: '' })).toEqual([])
  })
})

const SLIM: PullRequestSlimView = {
  number: 7,
  title: '題',
  state: 'OPEN',
  body: '本文',
  head_ref: 'feat/x/7',
  base_ref: 'main',
  is_draft: true,
  mergeable: 'MERGEABLE',
  comments: 2,
  closing_issues: [{ number: 7, title: 'T7' }],
  referenced_issues: [{ number: 8, title: '' }, { number: 9, title: 'T9' }],
  reviews: [{ state: 'APPROVED', author: 'alice' }, { state: 'COMMENTED', author: JSON_NULL }],
}

const FULL: PullRequestWithReviewsView = {
  ...SLIM,
  reviews: [
    { state: 'APPROVED', author: 'alice', body: '  OK  \n', submitted_at: '2026-11-01T10:00:00Z' },
    { state: 'COMMENTED', author: JSON_NULL, body: '', submitted_at: JSON_NULL },
    { state: 'COMMENTED', author: 'bob', body: ' ', submitted_at: '2026-11' },
  ],
  review_threads: [
    { is_resolved: true, path: 'a.ts', line: 12, comments: [
      { author: 'alice', body: '行1\n行2\n', created_at: '2026-11-02T00:00:00Z', url: 'https://github.com/o/r/pull/7#discussion_r1' },
      { author: JSON_NULL, body: '', created_at: JSON_NULL, url: JSON_NULL },
    ] },
    { is_resolved: false, path: JSON_NULL, line: 0, comments: [] },
  ],
}

const BARE: PullRequestWithReviewsView = {
  number: 1,
  title: 't',
  state: 'MERGED',
  body: '',
  head_ref: 'a',
  base_ref: 'b',
  is_draft: false,
  mergeable: '',
  comments: 0,
  closing_issues: [],
  referenced_issues: [],
  reviews: [],
  review_threads: [],
}

describe('formatPullRequestMarkdown', () => {
  it('メタ情報・ブランチ・Issue・レビュー・本文を順に並べる', async () => {
    await explains('PR の情報を Markdown にする、`formatPullRequestMarkdown` のテストです。すべての情報を持つ PR を渡した場合に、状態などのメタ情報、ブランチ、閉じる Issue、参照する Issue、レビュー、本文の順に並ぶことを確認します。')
    expect(formatPullRequestMarkdown(SLIM)).toBe(
      '## PR #7 題\n\n**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2\n\n**Branch:** `feat/x/7` → `main`\n\n'
      + '**Closing Issues:**\n  - #7 T7\n\n**Referenced Issues:**\n  - #8\n  - #9 T9\n\n**Reviews:**\n  - alice: APPROVED\n  - None: COMMENTED\n\n---\n\n本文',
    )
  })

  it('Issue とレビューが存在しない場合は、その節を表示しない', async () => {
    await explains('PR の情報を Markdown にする、`formatPullRequestMarkdown` のテストです。Issue とレビューを持たない PR を渡した場合に、それらの節を含めず、メタ情報・ブランチ・本文だけを返すことを確認します。')
    expect(formatPullRequestMarkdown(BARE)).toBe('## PR #1 t\n\n**State:** MERGED\n\n**Branch:** `a` → `b`\n\n---\n\n')
  })
})

describe('formatPullRequestWithReviewsMarkdown', () => {
  it('メタ情報・ブランチ・Issue・本文の後に、レビューと行コメントを続ける', async () => {
    await explains('レビューを含めた PR の情報を Markdown にする、`formatPullRequestWithReviewsMarkdown` のテストです。レビューと行コメントを持つ PR を渡した場合に、閉じる Issue と参照する Issue を並べ、本文の後にレビューと行コメントを続けることを確認します。')
    expect(formatPullRequestWithReviewsMarkdown(FULL)).toBe(
      '## PR #7 題\n\n**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2\n\n**Branch:** `feat/x/7` → `main`\n\n'
      + '**Closing Issues:**\n  - #7 T7\n\n'
      + '**Referenced Issues:**\n  - #8\n  - #9 T9\n\n'
      + '---\n\n本文\n\n---\n\n## Reviews\n\n### @alice (APPROVED) - 2026-11-01\n\nOK\n\n### @(unknown) (COMMENTED)\n\n### @bob (COMMENTED)\n\n'
      + '---\n\n## Line Comments\n\n### `a.ts:12` [Resolved]\n\n**@alice** (2026-11-02) https://github.com/o/r/pull/7#discussion_r1:\n> 行1\n> 行2\n\n**@(unknown)**:\n\n### `(unknown file)` [Open]\n',
    )
  })

  it('Issue・レビュー・行コメントが存在しない場合は、本文で終える', async () => {
    await explains('レビューを含めた PR の情報を Markdown にする、`formatPullRequestWithReviewsMarkdown` のテストです。Issue・レビュー・行コメントを持たない PR を渡した場合に、本文までで出力が終わることを確認します。')
    expect(formatPullRequestWithReviewsMarkdown(BARE)).toBe('## PR #1 t\n\n**State:** MERGED\n\n**Branch:** `a` → `b`\n\n---\n\n\n')
  })
})

describe('formatReviewsMarkdown と formatReviewThreadsMarkdown', () => {
  it('レビューと行コメントのどちらも空の場合は、空文字を返す', async () => {
    await explains('レビューと行コメントを Markdown にする、`formatReviewsMarkdown` と `formatReviewThreadsMarkdown` のテストです。レビューと行コメントが空の配列の場合に、どちらも空文字を返すことを確認します。')
    expect(formatReviewsMarkdown([])).toBe('')
    expect(formatReviewThreadsMarkdown([])).toBe('')
  })

  it('author が空文字の場合も、不明として表示する', async () => {
    await explains('レビューと行コメントを Markdown にする、`formatReviewsMarkdown` と `formatReviewThreadsMarkdown` のテストです。投稿者（`author`）が空文字の場合に、`(unknown)` として表示することを確認します。')
    expect(formatReviewsMarkdown([{ state: 'COMMENTED', author: '', body: '', submitted_at: '' }])).toBe('## Reviews\n\n### @(unknown) (COMMENTED)\n')
    expect(formatReviewThreadsMarkdown([{ is_resolved: false, path: '', line: JSON_NULL, comments: [{ author: '', body: '', created_at: '', url: '' }] }]))
      .toBe('## Line Comments\n\n### `(unknown file)` [Open]\n\n**@(unknown)**:\n')
  })

  it('日付は 10 文字以上の場合だけ、先頭の 10 文字を表示する', async () => {
    await explains('レビューと行コメントを Markdown にする、`formatReviewsMarkdown` と `formatReviewThreadsMarkdown` のテストです。投稿日時が 10 文字以上の場合は先頭の 10 文字を日付として表示し、10 文字に満たない場合は表示しないことを確認します。')
    expect(formatReviewsMarkdown([{ state: 'APPROVED', author: 'a', body: '', submitted_at: '2026-11-01' }])).toContain('### @a (APPROVED) - 2026-11-01')
    expect(formatReviewsMarkdown([{ state: 'APPROVED', author: 'a', body: '', submitted_at: '2026-11-0' }])).toContain('### @a (APPROVED)\n')
  })
})

describe('hasStatusChanges と hasStashEntries', () => {
  it.each([
    ['', false],
    ['  \n', false],
    ['(git status failed)', false],
    ['On branch x\nnothing to commit, working tree clean', false],
    ['On branch x\nnothing to commit', true],
    ['On branch x\nChanges not staged', true],
  ])('git status の出力が %j の場合は、変更の有無を %s で返す', async (status, expected) => {
    await explains(`手元の git の状態を判定する、\`hasStatusChanges\` と \`hasStashEntries\` のテストです。\`git status\` の出力が \`${JSON.stringify(status)}\` の場合に、変更の有無として \`${String(expected)}\` を返すことを確認します。`)
    expect(hasStatusChanges(status)).toBe(expected)
  })

  it.each([
    ['(no stash)', false],
    ['(git stash list failed)', false],
    ['stash@{0}: WIP', true],
  ])('git stash list の出力が %j の場合は、stash の有無を %s で返す', async (list, expected) => {
    await explains(`手元の git の状態を判定する、\`hasStatusChanges\` と \`hasStashEntries\` のテストです。\`git stash list\` の出力が \`${JSON.stringify(list)}\` の場合に、stash の有無として \`${String(expected)}\` を返すことを確認します。`)
    expect(hasStashEntries(list)).toBe(expected)
  })
})

describe('parseHeadReference', () => {
  it.for([
    { head: 'feat/x/12', expected: { owner: undefined, branch: 'feat/x/12' } },
    { head: 'someone:feat/x/12', expected: { owner: 'someone', branch: 'feat/x/12' } },
    { head: ':feat/x/12', expected: undefined },
    { head: 'someone:', expected: undefined },
    { head: '', expected: undefined },
  ])('head が $head の場合は、$expected に分ける', async ({ head, expected }) => {
    await explains(`PR の head の指定を分解する、\`parseHeadReference\` のテストです。head が \`${JSON.stringify(head)}\` の場合に、\`owner:branch\` は owner とブランチ名に分け、不正なら \`undefined\` を返すことを確認します。`)
    expect(parseHeadReference(head)).toEqual(expected)
  })
})

describe('forkPushFixHint', () => {
  it('ローカルと remote がずれていない場合は、remote とブランチ名を付けた git push を案内する', async () => {
    await explains('fork へ push するときの直し方を案内する、`forkPushFixHint` のテストです。ローカルと remote が分岐していない場合に、`git push fork feat/x` のように remote とブランチ名を付けた `git push` を案内することを確認します。')
    expect(formatHinted(forkPushFixHint('fork', 'feat/x', false))).toBe('git push fork feat/x')
  })

  it('ローカルと remote がずれている場合は、取り込みか lease 付きの上書きを案内する', async () => {
    await explains('fork へ push するときの直し方を案内する、`forkPushFixHint` のテストです。ローカルと remote が分岐している場合に、取り込みの `git pull --rebase` か、上書きの `git push --force-with-lease` を案内することを確認します。')
    expect(formatHinted(forkPushFixHint('fork', 'feat/x', true))).toBe('git pull --rebase fork feat/x, or git push --force-with-lease fork feat/x if you rewrote pushed commits')
  })
})

describe('describePushStatus', () => {
  it.each([
    [0, 0, true, 'in sync with origin/feat', false],
    [3, 0, false, '3 unpushed commits', false],
    [0, 2, true, 'origin/feat is 2 commits ahead (pull recommended)', false],
    [3, 2, false, 'diverged: local is 3 commits ahead, origin/feat is 2 ahead', true],
  ])('ローカルが remote より %i 件先、%i 件後ろの場合の状態を返す', async (ahead, behind, isPushed, message, isDiverged) => {
    await explains(`push の状態を説明する、\`describePushStatus\` のテストです。ローカルが remote より ${String(ahead)} 件先、${String(behind)} 件後ろの場合に、push の状態を説明するメッセージと、分岐しているかどうかの判定を返すことを確認します。`)
    expect(describePushStatus('origin', 'feat', ahead, behind)).toEqual({ isPushed, message, isDiverged })
  })
})

describe('pushFixHintOf', () => {
  const rows: readonly { readonly name: string, readonly decision: RestackDecision | undefined, readonly expected: string }[] = [
    { name: '親ブランチが動いた', decision: { kind: 'moved', base: 'feat/1' }, expected: 'pr_restack' },
    { name: '親 PR がマージ済み', decision: { kind: 'merged', base: 'main', pullRequest: 1 }, expected: 'pr_restack' },
    { name: 'スタックし直し済みで記録だけが古い', decision: { kind: 'rebased', base: 'main' }, expected: 'pr_restack' },
    { name: '親ブランチが動いていない', decision: { kind: 'up-to-date', base: 'feat/1' }, expected: `git pull --rebase, or ${['git', 'push', '--force-with-lease'].join(' ')} if you rewrote pushed commits` },
    { name: '親ブランチが消えた', decision: { kind: 'gone', base: 'feat/1', pullRequest: undefined }, expected: 'pr_restack with check: true' },
    { name: '判断を読めない', decision: undefined, expected: 'pr_restack with check: true' },
  ]

  it.for(rows)('$name の場合は、$expected を案内する', async (row) => {
    await explains(`push の問題の直し方を案内する、\`pushFixHintOf\` のテストです。${row.name}の場合に、\`${row.expected}\` を案内することを確認します。`)
    expect(formatHinted(pushFixHintOf(row.decision))).toBe(row.expected)
  })
})

describe('collectPreflightWarnings', () => {
  const clean = { gitStatus: 'nothing to commit, working tree clean', stashList: '(no stash)', isPushed: true, pushMessage: 'in sync' }

  it('問題がない場合は、空の配列を返す', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push 済みで、変更と stash のどちらもない場合に、空の配列を返すことを確認します。')
    expect(collectPreflightWarnings(clean)).toEqual([])
  })

  it('警告は push・status・stash の順に返し、stash の件数に空行を含めない', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push 前・未コミットの変更・stash のすべてがある場合に、その順の警告を返し、stash の件数から空行を除くことを確認します。')
    const warnings = collectPreflightWarnings({ gitStatus: ' M a.ts', stashList: 'stash@{0}: a\n\nstash@{1}: b\r\nstash@{2}: c', isPushed: false, pushMessage: '2 unpushed commits' })
    expect(warnings.map(warning => ({ ...warning, fixHint: formatHinted(warning.fixHint) }))).toEqual([
      { label: 'Push Status', message: '2 unpushed commits', fixHint: 'git push' },
      { label: 'Git Status', message: 'modified or untracked files', fixHint: 'commit' },
      { label: 'Stash List', message: '3 stash entries', fixHint: 'check them' },
    ])
  })

  it('Push Status の直し方を渡した場合は、その直し方を使う', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push の問題の直し方を渡した場合に、既定の `git push` の案内ではなく、渡した直し方を `Push Status` の警告に使うことを確認します。')
    const [warning] = collectPreflightWarnings({ ...clean, isPushed: false, pushMessage: 'diverged', pushFixHint: pushFixHintOf({ kind: 'moved', base: 'feat/1' }) })
    expect(warning === undefined ? undefined : formatHinted(warning.fixHint)).toBe('pr_restack')
  })

  it('警告を 1 行の文にする', async () => {
    await explains('PR を作成する前の警告を 1 行の文にする、`formatPreflightWarning` のテストです。ラベル・メッセージ・直し方を渡した場合に、`Push Status: m (fix: git push)` の形の文を返すことを確認します。')
    expect(formatHinted(formatPreflightWarning({ label: 'Push Status', message: 'm', fixHint: ['git push'] }))).toBe('Push Status: m (fix: git push)')
  })
})

const STACKED_ON = createIssueReference(createRepositoryReference('acme', 'app'), 11)
const SHA = 'a'.repeat(40)
const STACKED: BaseReading = { kind: 'stacked', record: { branch: 'feat/a/11', sha: SHA, stackedOn: STACKED_ON }, stackedOn: STACKED_ON }

function lower(state: PullRequestReadout['state']): PullRequestReadout {
  return { repository: createRepositoryReference('acme', 'app'), number: 21, state, headRefName: 'feat/a/11', baseRefName: 'develop', isDraft: false, isCrossRepository: false }
}

const NO_RECORD: BaseReading = { kind: 'development', record: undefined }
const DEVELOPMENT_RECORD: BaseReading = { kind: 'development', record: { branch: 'develop', sha: SHA, stackedOn: undefined } }

function decide(reading: BaseReading, base: string, lowerPullRequest?: PullRequestReadout): PullRequestBaseDecision {
  return decidePullRequestBase({ reading, base, developBranch: 'develop', lowerPullRequest })
}

describe('decidePullRequestBase', () => {
  it.for([
    { name: '記録が無い', reading: NO_RECORD },
    { name: '開発ブランチからの着手の記録', reading: DEVELOPMENT_RECORD },
  ])('$name の場合は、渡された base をそのまま使い、スタックに登録しない', async ({ name, reading }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。${name}の場合に、渡された base をそのまま使い、スタックに登録しないことを確認します。`)
    expect(decide(reading, 'develop')).toEqual({ kind: 'use', base: 'develop', stackOn: undefined, stackedBase: undefined, isLowerMerged: false })
  })

  it('スタックの記録があり、親 PR が開いている場合は、親ブランチを base にして、その PR のスタックに登録する', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。スタックの記録があり、親 PR が開いている場合に、親ブランチを base に使い、その PR のスタックに登録することを確認します。')
    expect(decide(STACKED, 'feat/a/11', lower('OPEN'))).toEqual({ kind: 'use', base: 'feat/a/11', stackOn: 21, stackedBase: 'feat/a/11', isLowerMerged: false })
  })

  it.for([
    { name: '記録の base', base: 'feat/a/11' },
    { name: '開発ブランチ', base: 'develop' },
  ])('親 PR がマージ済みで $name を渡した場合は、開発ブランチを base にして、スタックに登録しない', async ({ name, base }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。親 PR がマージ済みの場合に、${name}を渡しても、開発ブランチを base に使い、スタックに登録しないことを確認します。`)
    expect(decide(STACKED, base, lower('MERGED'))).toEqual({ kind: 'use', base: 'develop', stackOn: undefined, stackedBase: 'feat/a/11', isLowerMerged: true })
  })

  it.for([
    { name: '親 PR が無い', pullRequest: undefined },
    { name: '親 PR がマージされずに閉じた', pullRequest: lower('CLOSED') },
  ])('$name の場合は、PR を作成せずに止める', async ({ name, pullRequest }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。${name}の場合に、PR を作成せず、開いている PR が存在しないことを理由に止めることを確認します。`)
    expect(decide(STACKED, 'feat/a/11', pullRequest)).toEqual({ kind: 'stop', reason: 'no-open-pr', branch: 'feat/a/11' })
  })

  it('記録が不正な形式の場合は、止める', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。スタックの記録が読み取れない形式（`malformed`）の場合に、内容を添えて止めることを確認します。')
    expect(decide({ kind: 'malformed', content: 'broken' }, 'develop')).toEqual({ kind: 'stop', reason: 'malformed', content: 'broken' })
  })

  it('親 PR が開いているのに開発ブランチを渡した場合は、止める', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。親 PR が開いているのに、base に開発ブランチを渡した場合に、親ブランチの情報を添えて止めることを確認します。')
    expect(decide(STACKED, 'develop', lower('OPEN'))).toEqual({ kind: 'stop', reason: 'lower-open', branch: 'feat/a/11', pullRequest: 21, base: 'develop' })
  })

  it('記録の base でも開発ブランチでもない base は、そのまま返し、内容の検証に任せる', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。記録の base でも開発ブランチでもない base を渡した場合に、止めずにそのまま使い、エラーの判断を内容の検証に任せることを確認します。')
    expect(decide(STACKED, 'main', lower('OPEN'))).toEqual({ kind: 'use', base: 'main', stackOn: undefined, stackedBase: 'feat/a/11', isLowerMerged: false })
  })
})

// 親ブランチの PR。番号と状態と fork かを変える
function pullRequestIn(number: number, state: PullRequestReadout['state'], isCrossRepository = false): PullRequestReadout {
  return { ...lower(state), number, isCrossRepository }
}

describe('pickLowerPullRequest', () => {
  it.for([
    { name: '閉じた PR が新しく、マージ済みの PR が古い', pullRequests: [pullRequestIn(30, 'CLOSED'), pullRequestIn(21, 'MERGED')], expected: 21 },
    { name: '開いた PR が閉じた PR とマージ済みの PR より古い', pullRequests: [pullRequestIn(31, 'CLOSED'), pullRequestIn(30, 'MERGED'), pullRequestIn(21, 'OPEN')], expected: 21 },
    { name: '閉じた PR しか無い', pullRequests: [pullRequestIn(31, 'CLOSED'), pullRequestIn(30, 'CLOSED')], expected: 31 },
    { name: 'fork の開いた PR と、自分のリポのマージ済みの PR がある', pullRequests: [pullRequestIn(40, 'OPEN', true), pullRequestIn(21, 'MERGED')], expected: 21 },
  ])('$name の場合は、開いている PR・マージ済みの PR・閉じた PR の順に選ぶ', async ({ name, pullRequests, expected }) => {
    await explains(`親ブランチの PR を選ぶ、\`pickLowerPullRequest\` のテストです。${name}の場合に、開いている PR・マージ済みの PR・閉じた PR の順に優先して選び、番号が \`${String(expected)}\` の PR を返すことを確認します。`)
    expect(pickLowerPullRequest(pullRequests)?.number).toBe(expected)
  })

  it('fork の PR しか存在しない場合は、undefined を返す', async () => {
    await explains('親ブランチの PR を選ぶ、`pickLowerPullRequest` のテストです。候補が fork のリポジトリからの PR だけの場合に、`undefined` を返すことを確認します。')
    expect(pickLowerPullRequest([pullRequestIn(40, 'OPEN', true)])).toBeUndefined()
  })
})

describe('describeBaseStop', () => {
  it('親 PR が存在しない場合は、止めた理由と、pr_create を呼び直す直し方の 2 行を返す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。開いている親 PR が存在しない場合に、止めた理由と、`pr_create` を呼び直す直し方の 2 行を返すことを確認します。')
    expect(describeBaseStop({ kind: 'stop', reason: 'no-open-pr', branch: 'feat/a/11' }).map(line => formatHinted(line))).toEqual([
      'base branch feat/a/11 has no open PR',
      'reopen the PR of feat/a/11, or create a new one, then call pr_create again',
    ])
  })

  it('記録が不正な形式の場合は、記録の内容を示す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。スタックの記録が読み取れない形式の場合に、記録の内容を含む 1 行を返すことを確認します。')
    expect(describeBaseStop({ kind: 'stop', reason: 'malformed', content: 'broken' })).toEqual(['.pecot-base is malformed: broken'])
  })

  it('親 PR が開いているのに開発ブランチを渡した場合は、使うべき base を示す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。親 PR が開いているのに base に開発ブランチを渡した場合に、使うべき親ブランチと PR の番号を示す 1 行を返すことを確認します。')
    expect(describeBaseStop({ kind: 'stop', reason: 'lower-open', branch: 'feat/a/11', pullRequest: 21, base: 'develop' })).toEqual([
      'base branch must be feat/a/11 while its PR #21 is open (given: develop)',
    ])
  })
})
