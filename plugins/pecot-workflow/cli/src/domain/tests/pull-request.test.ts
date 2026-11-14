import { describe, expect, it } from 'vitest'

import {
  appendIssueCloseIfNeeded,
  collectPreflightWarnings,
  describePushStatus,
  extractClosingIssueNumbers,
  formatPreflightWarning,
  formatPullRequestMarkdown,
  formatPullRequestWithReviewsMarkdown,
  formatReviewsMarkdown,
  formatReviewThreadsMarkdown,
  hasIssueReference,
  isReleasePullRequest,
  SCREENSHOT_MISSING_ERROR,
  hasStashEntries,
  hasStatusChanges,
  validatePullRequestContent,
} from '../pull-request.js'
import type { PullRequestContentOptions, PullRequestSlimView, PullRequestWithReviewsView } from '../pull-request.js'
import '../../commands/registry.js'
import { formatHinted } from '../command-hint.js'
import { JSON_NULL } from '../json-null.js'
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
  ])('%j から閉じる Issue 番号を取り出す', (body, expected) => {
    expect(extractClosingIssueNumbers(body)).toEqual(expected)
  })
})

describe('appendIssueCloseIfNeeded', () => {
  it('参照が無ければ末尾に Closes を足す', () => {
    expect(appendIssueCloseIfNeeded('Changes', 123)).toBe('Changes\n\nCloses #123')
  })

  it('末尾の空白を落としてから足す', () => {
    expect(appendIssueCloseIfNeeded('Changes \n\n', 123)).toBe('Changes\n\nCloses #123')
  })

  it.each([
    ['Closes #123'],
    ['#123 を直す'],
    ['先頭\n#123'],
  ])('%j は参照があるのでそのまま返す', (body) => {
    expect(appendIssueCloseIfNeeded(body, 123)).toBe(body)
  })

  it.each([
    ['https://example.com/#123'],
    ['#1234'],
    ['#12'],
  ])('%j は別の参照なので足す', (body) => {
    expect(appendIssueCloseIfNeeded(body, 123)).toBe(`${body}\n\nCloses #123`)
  })
})

describe('hasIssueReference', () => {
  it.each([
    ['Closes #12'],
    ['#12'],
    ['owner/repo#12'],
    ['a #1'],
  ])('%j は参照あり', (body) => {
    expect(hasIssueReference(body)).toBe(true)
  })

  it.each([
    ['参照なし'],
    ['https://example.com/#12'],
    ['# 見出し'],
    ['#abc'],
  ])('%j は参照なし', (body) => {
    expect(hasIssueReference(body)).toBe(false)
  })
})

describe('isReleasePullRequest', () => {
  it('release テンプレートはリリース PR', () => {
    expect(isReleasePullRequest('release', 'x', 'y', 'develop', 'main')).toBe(true)
  })

  it('develop から release への PR はリリース PR', () => {
    expect(isReleasePullRequest('default', 'main', 'develop', 'develop', 'main')).toBe(true)
  })

  it('head が develop でなければリリース PR ではない', () => {
    expect(isReleasePullRequest('default', 'main', 'feat/x', 'develop', 'main')).toBe(false)
  })

  it('base が release でなければリリース PR ではない', () => {
    expect(isReleasePullRequest('default', 'develop', 'develop', 'develop', 'main')).toBe(false)
  })

  it('release ブランチが未設定または空ならリリース PR ではない', () => {
    expect(isReleasePullRequest('default', 'main', undefined, undefined, undefined)).toBe(false)
    expect(isReleasePullRequest('default', '', '', '', '')).toBe(false)
  })

  it('head と develop が未設定なら、base が release のときリリース PR', () => {
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
  it('問題が無ければ空', () => {
    expect(validatePullRequestContent(options())).toEqual([])
  })

  it('Issue 参照が無いと止める。skipIssueReferenceCheck なら止めない', () => {
    const body = `## Summary\n\n${IMAGE}\n\n## Changes\n\n- 変更\n`
    const errors = validatePullRequestContent(options({ body }))
    expect(errors.map(error => formatHinted(error, 'cli'))).toEqual(['PR body has no Issue reference `#N` (use `--no-issue-ref` for a PR not tied to an Issue)'])
    expect(errors.map(error => formatHinted(error, 'mcp'))).toEqual(['PR body has no Issue reference `#N` (use `no_issue_ref: true` for a PR not tied to an Issue)'])
    expect(validatePullRequestContent(options({ body, skipIssueReferenceCheck: true }))).toEqual([])
  })

  it('必須の節が欠けていると節の名前を並べる', () => {
    const errors = validatePullRequestContent(options({ body: '## Summary\n\n![shot](./a.png) #12\n' }))
    expect(errors).toEqual(['missing sections: ## Changes'])
  })

  it('必須の節が空なら節の検証をしない', () => {
    expect(validatePullRequestContent(options({ body: '## Summary\n\n![shot](./a.png) #12\n', requiredSections: [] }))).toEqual([])
  })

  it('見出しの要約の規則違反を並べる', () => {
    const body = `## Summary — English only\n\n${IMAGE}\n\n## Changes\n\n- 変更 #12\n`
    const errors = validatePullRequestContent(options({ body, requiredSections: [{ level: 2, name: 'Summary — <要点>' }, { level: 2, name: 'Changes' }] }))
    expect(errors).toEqual(['heading summary rule violations: ## Summary — the summary must be written in Japanese'])
  })

  it('許さない記法を並べる', () => {
    const errors = validatePullRequestContent(options({ body: `${GOOD_BODY}\n- [ ] 未完了\n` }))
    expect(errors).toEqual(['disallowed syntax: checkbox syntax (- [ ] / 1. [ ]) is not allowed'])
  })

  it('Summary に画像が無く screenshot の理由も無いと止める', () => {
    const body = '## Summary\n\n文のみ。\n\n## Changes\n\n- 変更 #12\n'
    expect(validatePullRequestContent(options({ body }))).toEqual([SCREENSHOT_MISSING_ERROR])
    expect(validatePullRequestContent(options({ body, screenshot: '画面は変わらない' }))).toEqual([])
    expect(validatePullRequestContent(options({ body, screenshot: '' }))).toEqual([SCREENSHOT_MISSING_ERROR])
  })

  it('screenshot の理由の案内は、CLI ではフラグ名、MCP では入力名で出す', () => {
    expect(formatHinted(SCREENSHOT_MISSING_ERROR, 'cli')).toMatch(/\(`--screenshot` with `--message`\)$/u)
    expect(formatHinted(SCREENSHOT_MISSING_ERROR, 'mcp')).toMatch(/\(`screenshot` with `message`\)$/u)
  })

  it('base が develop でないと止める。develop 未設定なら比べない', () => {
    expect(validatePullRequestContent(options({ base: 'main' }))).toEqual(['base branch must be develop (given: main)'])
    expect(validatePullRequestContent(options({ base: 'main', developBranch: undefined }))).toEqual([])
    expect(validatePullRequestContent(options({ base: 'main', developBranch: '' }))).toEqual([])
  })

  it('リリース PR は Issue 参照と画像を求めず、base が release でないと止める', () => {
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
      { author: 'alice', body: '行1\n行2\n', created_at: '2026-11-02T00:00:00Z' },
      { author: JSON_NULL, body: '', created_at: JSON_NULL },
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
  it('メタ情報・ブランチ・Issue・レビュー・本文を並べる', () => {
    expect(formatPullRequestMarkdown(SLIM)).toBe(
      '## PR #7 題\n\n**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2\n\n**Branch:** `feat/x/7` → `main`\n\n'
      + '**Closing Issues:**\n  - #7 T7\n\n**Referenced Issues:**\n  - #8\n  - #9 T9\n\n**Reviews:**\n  - alice: APPROVED\n  - None: COMMENTED\n\n---\n\n本文',
    )
  })

  it('Issue とレビューが無ければ節を出さない', () => {
    expect(formatPullRequestMarkdown(BARE)).toBe('## PR #1 t\n\n**State:** MERGED\n\n**Branch:** `a` → `b`\n\n---\n\n')
  })
})

describe('formatPullRequestWithReviewsMarkdown', () => {
  it('Issue ごとに詳細のコマンドを添え、レビューと行コメントを続ける', () => {
    expect(formatPullRequestWithReviewsMarkdown(FULL, 'o', 'r')).toBe(
      '## PR #7 題\n\n**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2\n\n**Branch:** `feat/x/7` → `main`\n\n'
      + '**Closing Issues:**\n  - #7 T7\n    → details: issue show o/r/7\n\n'
      + '**Referenced Issues:**\n  - #8\n    → details: issue show o/r/8\n  - #9 T9\n    → details: issue show o/r/9\n\n'
      + '---\n\n本文\n\n---\n\n## Reviews\n\n### @alice (APPROVED) - 2026-11-01\n\nOK\n\n### @(unknown) (COMMENTED)\n\n### @bob (COMMENTED)\n\n'
      + '---\n\n## Line Comments\n\n### `a.ts:12` [Resolved]\n\n**@alice** (2026-11-02):\n> 行1\n> 行2\n\n**@(unknown)**:\n\n### `(unknown file)` [Open]\n',
    )
  })

  it('Issue・レビュー・行コメントが無ければ本文で終わる', () => {
    expect(formatPullRequestWithReviewsMarkdown(BARE, 'o', 'r')).toBe('## PR #1 t\n\n**State:** MERGED\n\n**Branch:** `a` → `b`\n\n---\n\n\n')
  })
})

describe('formatReviewsMarkdown と formatReviewThreadsMarkdown', () => {
  it('空なら空文字', () => {
    expect(formatReviewsMarkdown([])).toBe('')
    expect(formatReviewThreadsMarkdown([])).toBe('')
  })

  it('author が空文字でも不明として出す', () => {
    expect(formatReviewsMarkdown([{ state: 'COMMENTED', author: '', body: '', submitted_at: '' }])).toBe('## Reviews\n\n### @(unknown) (COMMENTED)\n')
    expect(formatReviewThreadsMarkdown([{ is_resolved: false, path: '', line: JSON_NULL, comments: [{ author: '', body: '', created_at: '' }] }]))
      .toBe('## Line Comments\n\n### `(unknown file)` [Open]\n\n**@(unknown)**:\n')
  })

  it('日付は 10 文字以上のときだけ先頭 10 文字を出す', () => {
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
  ])('hasStatusChanges(%j) は %s', (status, expected) => {
    expect(hasStatusChanges(status)).toBe(expected)
  })

  it.each([
    ['(no stash)', false],
    ['(git stash list failed)', false],
    ['stash@{0}: WIP', true],
  ])('hasStashEntries(%j) は %s', (list, expected) => {
    expect(hasStashEntries(list)).toBe(expected)
  })
})

describe('describePushStatus', () => {
  it.each([
    [0, 0, true, 'in sync with origin/feat'],
    [3, 0, false, '3 unpushed commits'],
    [0, 2, true, 'origin/feat is 2 commits ahead (pull recommended)'],
    [3, 2, false, 'diverged: local is 3 commits ahead, origin/feat is 2 ahead'],
  ])('手元が %i 先・%i 後ろ', (ahead, behind, isPushed, message) => {
    expect(describePushStatus('origin', 'feat', ahead, behind)).toEqual({ isPushed, message })
  })
})

describe('collectPreflightWarnings', () => {
  const clean = { gitStatus: 'nothing to commit, working tree clean', stashList: '(no stash)', isPushed: true, pushMessage: 'in sync' }

  it('問題が無ければ空', () => {
    expect(collectPreflightWarnings(clean)).toEqual([])
  })

  it('push・status・stash の順に警告を返し、stash は空行を数えない', () => {
    const warnings = collectPreflightWarnings({ gitStatus: ' M a.ts', stashList: 'stash@{0}: a\n\nstash@{1}: b\r\nstash@{2}: c', isPushed: false, pushMessage: '2 unpushed commits' })
    expect(warnings).toEqual([
      { label: 'Push Status', message: '2 unpushed commits', fixHint: 'git push' },
      { label: 'Git Status', message: 'modified or untracked files', fixHint: 'commit' },
      { label: 'Stash List', message: '3 stash entries', fixHint: 'check them' },
    ])
  })

  it('警告 1 行の文を作る', () => {
    expect(formatPreflightWarning({ label: 'Push Status', message: 'm', fixHint: 'git push' })).toBe('Push Status: m (fix: git push)')
  })
})
