import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'
import { PecotError } from '../errors.js'
import {
  FrontmatterError,
  parseCommentContent,
  parseFrontmatter,
  parsePullRequestContent,
  stripFrontmatter,
  stripLeadingHtmlComment,
  validateCommentFrontmatter,
  validateIssueFrontmatter,
  validatePullRequestFrontmatter,
} from '../frontmatter.js'

const ISSUE_BASE = { title: 'テスト', type: 'task', repository: 'owner/repo', status: 'ready' }

describe('FrontmatterError', () => {
  it('PecotError を継承する', () => {
    expect(new FrontmatterError('x')).toBeInstanceOf(PecotError)
  })
})

describe('validateIssueFrontmatter', () => {
  it('最小限のフィールドでインスタンス化できる', () => {
    const fm = validateIssueFrontmatter({ title: 'テスト機能の実装', type: 'task', repository: 'owner/repo', status: 'ready' })
    expect(fm.title).toBe('テスト機能の実装')
    expect(fm.type).toBe('task')
    expect(fm.repository).toBe('owner/repo')
    expect(fm.status).toBe('ready')
    expect(fm.labels).toEqual([])
    expect(fm.parent_epic).toBeUndefined()
  })

  it('すべてのフィールドを持つインスタンス', () => {
    const fm = validateIssueFrontmatter({
      title: 'バグ修正',
      type: 'bug',
      repository: 'owner/repo',
      status: 'active',
      priority: 'high',
      size: 'm',
      labels: ['bug', 'urgent'],
      parent_epic: 123,
      order: 1,
    })
    expect(fm.type).toBe('bug')
    expect(fm.status).toBe('active')
    expect(fm.priority).toBe('high')
    expect(fm.size).toBe('m')
    expect(fm.labels).toEqual(['bug', 'urgent'])
    expect(fm.parent_epic).toBe(123)
    expect(fm.order).toBe(1)
  })

  it('無効な type はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, type: 'invalid' })).toThrow(FrontmatterError)
  })

  it('無効な status はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, status: 'invalid' })).toThrow(FrontmatterError)
  })

  it('空文字列のフィールドは未指定になる', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, priority: '', size: '', parent_epic: '', order: '' })
    expect(fm.priority).toBeUndefined()
    expect(fm.size).toBeUndefined()
    expect(fm.parent_epic).toBeUndefined()
    expect(fm.order).toBeUndefined()
  })

  it('parent_epic と order の両方が指定されている場合は正常', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 1 })
    expect(fm.parent_epic).toBe(353)
    expect(fm.order).toBe(1)
  })

  it('parent_epic 指定時に order がないとエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353 })).toThrow('orderは必須です')
  })

  it('order 指定時に parent_epic がないとエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, order: 1 })).toThrow('parent_epicも指定してください')
  })

  it('order が 0 の場合はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 0 })).toThrow('1以上の整数')
  })

  it('order が負の場合はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: -1 })).toThrow('1以上の整数')
  })

  it('parent_epic に owner/repo/N 形式を指定できる（文字列のまま保持）', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 'acme-labs/aist-roadmap/21', order: 1 })
    expect(fm.parent_epic).toBe('acme-labs/aist-roadmap/21')
    expect(fm.order).toBe(1)
  })

  it('parent_epic の数字文字列は整数に正規化される', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: '21', order: 1 })
    expect(fm.parent_epic).toBe(21)
  })

  it('parent_epic の整数はそのまま保持される', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 21, order: 1 })
    expect(fm.parent_epic).toBe(21)
  })

  it('template の既定は未指定', () => {
    expect(validateIssueFrontmatter(ISSUE_BASE).template).toBeUndefined()
  })

  it('template=task-implement が有効', () => {
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, title: 'フェーズ1', template: 'task-implement' }).template).toBe('task-implement')
  })

  it('template が type と同じ値でも有効', () => {
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, template: 'task' }).template).toBe('task')
  })

  it('無効な template はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, template: 'invalid-template' })).toThrow(FrontmatterError)
  })

  it('空文字列の template は未指定になる', () => {
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, template: '' }).template).toBeUndefined()
  })

  it('null の項目は未指定になる', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, template: JSON_NULL, priority: JSON_NULL, size: JSON_NULL, parent_epic: JSON_NULL, order: JSON_NULL })
    expect(fm.template).toBeUndefined()
    expect(fm.priority).toBeUndefined()
    expect(fm.size).toBeUndefined()
    expect(fm.parent_epic).toBeUndefined()
    expect(fm.order).toBeUndefined()
  })

  it('読んだ値は凍結されている', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, labels: ['a'] })
    expect(Object.isFrozen(fm)).toBe(true)
    expect(Object.isFrozen(fm.labels)).toBe(true)
  })

  it('エラー文は「バリデーションエラー:」の後に項目ごとの行が続く', () => {
    expect(() => validateIssueFrontmatter({ title: 'T' })).toThrow(
      'バリデーションエラー:\n  - type: Field required\n  - repository: Field required\n  - status: Field required',
    )
  })

  it('整数の変換: 前後の空白・小数部が 0 の文字列・数字の間の _ を受ける', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: ' 1_0 ' })
    expect(fm.order).toBe(10)
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: '2.0' }).order).toBe(2)
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: true }).order).toBe(1)
  })
})

describe('parseFrontmatter', () => {
  it('シンプルなフロントマターをパース', () => {
    const content = `---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

## 概要

これは本文です。
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.title).toBe('テスト機能の実装')
    expect(result.frontmatter.type).toBe('task')
    expect(result.frontmatter.repository).toBe('owner/repo')
    expect(result.frontmatter.status).toBe('ready')
    expect(result.body).toContain('## 概要')
    expect(result.body).toContain('これは本文です。')
  })

  it('フル構成のフロントマターをパース', () => {
    const content = `---
title: Epic実装
type: epic
repository: org/project
status: backlog
priority: high
size: l
labels:
  - enhancement
  - epic
parent_epic: 42
order: 1
---

本文
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.title).toBe('Epic実装')
    expect(result.frontmatter.type).toBe('epic')
    expect(result.frontmatter.status).toBe('backlog')
    expect(result.frontmatter.priority).toBe('high')
    expect(result.frontmatter.size).toBe('l')
    expect(result.frontmatter.labels).toEqual(['enhancement', 'epic'])
    expect(result.frontmatter.parent_epic).toBe(42)
    expect(result.frontmatter.order).toBe(1)
  })

  it('フロントマターがない場合はエラー', () => {
    expect(() => parseFrontmatter('# タイトル\n\n本文のみ\n')).toThrow('フロントマターが見つかりません（---で始まっていない）')
  })

  it('閉じられていないフロントマターはエラー', () => {
    const content = `---
title: テスト
type: task
repository: owner/repo

本文（閉じタグなし）
`
    expect(() => parseFrontmatter(content)).toThrow('フロントマターが閉じられていません（終端の---がない）')
  })

  it('無効な YAML はエラー', () => {
    const content = `---
title: テスト
type: epic: invalid
---

本文
`
    expect(() => parseFrontmatter(content)).toThrow(/^YAMLのパースに失敗しました: /u)
  })

  it('マッピングでない YAML はエラー', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\n\n本文\n')).toThrow('フロントマターはマッピング（key: value）形式である必要があります')
    expect(() => parseFrontmatter('---\n# コメントだけ\n---\n\n本文\n')).toThrow('フロントマターはマッピング（key: value）形式である必要があります')
  })

  it('必須フィールドがない場合はエラー', () => {
    expect(() => parseFrontmatter('---\ntitle: テスト\n---\n\n本文\n')).toThrow('バリデーションエラー')
  })

  it('空文字列の parent_epic をパース', () => {
    const content = [
      '---',
      'title: Epic実装',
      'type: epic',
      'repository: org/project',
      'status: backlog',
      'priority: ""',
      'size: ""',
      'parent_epic: ""',
      'order: ""',
      '---',
      '',
      'Epic本文',
      '',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result.frontmatter.parent_epic).toBeUndefined()
    expect(result.frontmatter.priority).toBeUndefined()
    expect(result.frontmatter.size).toBeUndefined()
    expect(result.frontmatter.order).toBeUndefined()
  })

  it('template フィールド付きのフロントマターをパース', () => {
    const content = `---
title: フェーズ1実装
type: task
template: task-implement
repository: owner/repo
status: ready
---

## タスク概要

フェーズ1の実装タスク
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.template).toBe('task-implement')
    expect(result.frontmatter.type).toBe('task')
  })

  it('template フィールドなしのフロントマターをパース', () => {
    const content = `---
title: 通常タスク
type: task
repository: owner/repo
status: ready
---

## タスク概要

通常のタスク
`
    expect(parseFrontmatter(content).frontmatter.template).toBeUndefined()
  })

  it('本文の前後の空白は除去される', () => {
    const content = `---
title: テスト
type: task
repository: owner/repo
status: ready
---


   本文


`
    expect(parseFrontmatter(content).body).toBe('本文')
  })

  it('本文が空でも動作する', () => {
    const content = `---
title: テスト
type: task
repository: owner/repo
status: ready
---
`
    expect(parseFrontmatter(content).body).toBe('')
  })

  it('YAML の型の決め方は Python と同じ（y は文字列、yes は真偽値）', () => {
    const content = '---\ntitle: y\ntype: task\nrepository: o/r\nstatus: ready\nlabels: [n, "yes"]\n---\n\n本文\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter.title).toBe('y')
    expect(result.frontmatter.labels).toEqual(['n', 'yes'])
    expect(() => parseFrontmatter('---\ntitle: yes\ntype: task\nrepository: o/r\nstatus: ready\n---\n')).toThrow('  - title: Input should be a valid string')
  })

  it('CRLF の本文でもフロントマターを認識する', () => {
    const result = parseFrontmatter('---\r\ntitle: T\r\ntype: task\r\nrepository: o/r\r\nstatus: ready\r\n---\r\n\r\n本文\r\n')
    expect(result.frontmatter.title).toBe('T')
    expect(result.body).toBe('本文')
  })
})

describe('validateCommentFrontmatter', () => {
  it('最小限のフィールドでインスタンス化できる', () => {
    const fm = validateCommentFrontmatter({ issue_ref: 'owner/repo/123' })
    expect(fm.issue_ref).toBe('owner/repo/123')
    expect(fm.template).toBeUndefined()
  })

  it('すべてのフィールドを持つインスタンス', () => {
    const fm = validateCommentFrontmatter({ issue_ref: 'owner/repo/456', template: 'merge-diff' })
    expect(fm.issue_ref).toBe('owner/repo/456')
    expect(fm.template).toBe('merge-diff')
  })

  it('issue_ref がない場合はエラー', () => {
    expect(() => validateCommentFrontmatter({})).toThrow('  - issue_ref: Field required')
  })
})

describe('parseCommentContent', () => {
  it('シンプルなコメントフロントマターをパース', () => {
    const content = `---
issue_ref: "owner/repo/123"
---

## 進捗報告

これは本文です。
`
    const result = parseCommentContent(content)
    expect(result.frontmatter.issue_ref).toBe('owner/repo/123')
    expect(result.body).toContain('## 進捗報告')
    expect(result.body).toContain('これは本文です。')
  })

  it('フル構成のコメントフロントマターをパース', () => {
    const content = `---
issue_ref: "org/project/42"
template: merge-diff
---

### Completed

- タスク1
`
    const result = parseCommentContent(content)
    expect(result.frontmatter.issue_ref).toBe('org/project/42')
    expect(result.frontmatter.template).toBe('merge-diff')
    expect(result.body).toContain('### Completed')
  })

  it('フロントマターがない場合はエラー', () => {
    expect(() => parseCommentContent('# タイトル\n\n本文のみ\n')).toThrow('フロントマターが見つかりません')
  })

  it('issue_ref がない場合はエラー', () => {
    expect(() => parseCommentContent('---\ntemplate: merge-diff\n---\n\n本文\n')).toThrow('バリデーションエラー')
  })
})

describe('validatePullRequestFrontmatter', () => {
  it('最小限のフィールドでインスタンス化できる', () => {
    const fm = validatePullRequestFrontmatter({ title: '機能追加', repository: 'owner/repo', base: 'develop-aist' })
    expect(fm.title).toBe('機能追加')
    expect(fm.repository).toBe('owner/repo')
    expect(fm.base).toBe('develop-aist')
    expect(fm.head).toBeUndefined()
    expect(fm.draft).toBe(false)
  })

  it('すべてのフィールドを持つインスタンス', () => {
    const fm = validatePullRequestFrontmatter({ title: 'バグ修正PR', repository: 'org/project', base: 'develop', head: 'feat/issue-123-fix-bug', draft: true })
    expect(fm.head).toBe('feat/issue-123-fix-bug')
    expect(fm.draft).toBe(true)
  })

  it('title がない場合はエラー', () => {
    expect(() => validatePullRequestFrontmatter({ repository: 'owner/repo', base: 'develop' })).toThrow('  - title: Field required')
  })

  it('repository がない場合はエラー', () => {
    expect(() => validatePullRequestFrontmatter({ title: 'テストPR', base: 'develop' })).toThrow('  - repository: Field required')
  })

  it('base がない場合はエラー', () => {
    expect(() => validatePullRequestFrontmatter({ title: 'テストPR', repository: 'owner/repo' })).toThrow('  - base: Field required')
  })
})

describe('parsePullRequestContent', () => {
  it('シンプルな PR フロントマターをパース', () => {
    const content = `---
title: "機能追加PR"
repository: "owner/repo"
base: "develop-aist"
---

## Changed — テスト用本文

- 機能Aを追加

Refs #123
`
    const result = parsePullRequestContent(content)
    expect(result.frontmatter.title).toBe('機能追加PR')
    expect(result.frontmatter.repository).toBe('owner/repo')
    expect(result.frontmatter.base).toBe('develop-aist')
    expect(result.frontmatter.head).toBeUndefined()
    expect(result.frontmatter.draft).toBe(false)
    expect(result.body).toContain('## Changed — テスト用本文')
    expect(result.body).toContain('Refs #123')
  })

  it('フル構成の PR フロントマターをパース', () => {
    const content = `---
title: "バグ修正"
repository: "org/project"
base: "develop"
head: "fix/issue-456"
draft: true
---

## Changed — テスト用本文

- バグ修正
`
    const result = parsePullRequestContent(content)
    expect(result.frontmatter.title).toBe('バグ修正')
    expect(result.frontmatter.head).toBe('fix/issue-456')
    expect(result.frontmatter.draft).toBe(true)
  })

  it('フロントマターがない場合はエラー', () => {
    expect(() => parsePullRequestContent('# PR\n\n本文のみ\n')).toThrow('フロントマターが見つかりません')
  })

  it('title がない場合はエラー', () => {
    expect(() => parsePullRequestContent('---\nrepository: "owner/repo"\nbase: "develop"\n---\n\n本文\n')).toThrow('バリデーションエラー')
  })
})

describe('stripLeadingHtmlComment（冒頭ガイドコメント除去 #958 F-02）', () => {
  it('冒頭のコメントとその前後の空行を落とす', () => {
    const body = '\n<!--\n読者: だれか\n書き方:\n- なにか\n-->\n\n## Goal — 目標\n\n本文\n'
    expect(stripLeadingHtmlComment(body)).toBe('## Goal — 目標\n\n本文\n')
  })

  it('先頭の 1 ブロックだけ落とす（本文途中の HTML には触れない）', () => {
    const body = '<!-- guide -->\n\n## Goal — 目標\n\n<!-- 本文中のメモ -->\n'
    expect(stripLeadingHtmlComment(body)).toBe('## Goal — 目標\n\n<!-- 本文中のメモ -->\n')
  })

  it('冒頭にコメントがない本文はそのまま', () => {
    const body = '## Goal — 目標\n\n<details><summary>log</summary>x</details>\n'
    expect(stripLeadingHtmlComment(body)).toBe(body)
  })

  it('issue のパースで冒頭コメントを落とす', () => {
    const content = '---\ntitle: "T"\ntype: task\nrepository: "owner/repo"\nstatus: ready\n---\n\n<!--\n読者: 実装者\n-->\n\n## Goal — 目標\n'
    expect(parseFrontmatter(content).body).toBe('## Goal — 目標')
  })

  it('comment のパースで冒頭コメントを落とす', () => {
    const content = '---\nissue_ref: "owner/repo/1"\ntemplate: merge-diff\n---\n\n<!--\n書き方: なにか\n-->\n\n## Merge — 現在地\n'
    expect(parseCommentContent(content).body).toBe('## Merge — 現在地')
  })

  it('pr のパースで冒頭コメントを落とす', () => {
    const content = '---\ntitle: "T"\nrepository: "owner/repo"\nbase: "main"\n---\n\n<!--\nフィールド: なにか\n-->\n\n## Verified — 検証済み\n'
    expect(parsePullRequestContent(content).body).toBe('## Verified — 検証済み')
  })

  it('CRLF の改行も 1 ブロックとして落とす', () => {
    expect(stripLeadingHtmlComment('<!-- g -->\r\n\r\n## A — あ\r\n')).toBe('## A — あ\r\n')
  })
})

describe('stripFrontmatter（frontmatter 除去ヘルパ）', () => {
  it('フロントマターを落とした本文を返す', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\n\n## Goal — 目標\n')).toBe('## Goal — 目標\n')
  })

  it('フロントマターがなければ原文を返す', () => {
    const content = '## Goal — 目標\n'
    expect(stripFrontmatter(content)).toBe(content)
  })

  it('閉じていないフロントマターも原文を返す', () => {
    const content = '---\ntitle: x\n本文\n'
    expect(stripFrontmatter(content)).toBe(content)
  })
})
