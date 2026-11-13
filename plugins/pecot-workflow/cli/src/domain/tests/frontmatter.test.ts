import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'
import { PecotError } from '../errors.js'
import {
  FrontmatterError,
  parseCommentContent,
  parseFrontmatter,
  parsePullRequestContent,
  setFrontmatterValue,
  stripFrontmatter,
  stripLeadingHtmlComment,
  validateCommentFrontmatter,
  validateIssueFrontmatter,
  validatePullRequestFrontmatter,
} from '../frontmatter.js'

function catchFrontmatterError(run: () => unknown): FrontmatterError {
  try {
    run()
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return error
    throw error
  }
  throw new Error('FrontmatterError was not thrown')
}

const ISSUE_BASE = { title: 'テスト', type: 'task', repository: 'owner/repo', status: 'ready' }

describe('FrontmatterError', () => {
  it('PecotError を継承する', () => {
    expect(new FrontmatterError('x')).toBeInstanceOf(PecotError)
  })
})

describe('validateIssueFrontmatter', () => {
  it('必須のフィールドだけを渡すと、labels を空配列、parent_epic を undefined にして返す', () => {
    const fm = validateIssueFrontmatter({ title: 'テスト機能の実装', type: 'task', repository: 'owner/repo', status: 'ready' })
    expect(fm.title).toBe('テスト機能の実装')
    expect(fm.type).toBe('task')
    expect(fm.repository).toBe('owner/repo')
    expect(fm.status).toBe('ready')
    expect(fm.labels).toEqual([])
    expect(fm.parent_epic).toBeUndefined()
  })

  it('すべてのフィールドを渡すと、渡した値をそのまま返す', () => {
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

  it('parent_epic と order を両方渡すと、検証を通して両方の値を返す', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 1 })
    expect(fm.parent_epic).toBe(353)
    expect(fm.order).toBe(1)
  })

  it('parent_epic だけを渡すと、order を undefined にして返す', () => {
    const fm = validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353 })
    expect(fm.parent_epic).toBe(353)
    expect(fm.order).toBeUndefined()
  })

  it('status を省くと、undefined にして返す', () => {
    expect(validateIssueFrontmatter({ title: 'T', type: 'task', repository: 'owner/repo' }).status).toBeUndefined()
  })

  it('blocked_by を省くと、空の一覧にして返す', () => {
    expect(validateIssueFrontmatter({ ...ISSUE_BASE }).blocked_by).toEqual([])
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, blocked_by: [] }).blocked_by).toEqual([])
    expect(validateIssueFrontmatter({ ...ISSUE_BASE, blocked_by: JSON_NULL }).blocked_by).toEqual([])
  })
})

describe('validateIssueFrontmatter の blocked_by', () => {
  const NO_STATUS = { title: 'テスト', type: 'task', repository: 'owner/repo' }

  it('wait を省くと stack にし、issue と reason を渡した値で返す', () => {
    const fm = validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1' }, { issue: 'acme/demo/3', wait: 'merge', reason: '  既定のブランチから配られる  ' }] })
    expect(fm.blocked_by).toEqual([
      { issue: 'phase1', wait: 'stack', reason: undefined },
      { issue: 'acme/demo/3', wait: 'merge', reason: '既定のブランチから配られる' },
    ])
  })

  it('blocked_by があって status が blocked のとき、通す', () => {
    expect(validateIssueFrontmatter({ ...NO_STATUS, status: 'blocked', blocked_by: [{ issue: 'phase1' }] }).status).toBe('blocked')
  })

  it('stack の前提に reason があっても、通す', () => {
    expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'stack', reason: '理由' }] })).not.toThrow()
  })

  it('reason の無い wait: merge は、種類 merge-without-reason の誤りにする', () => {
    const error = catchFrontmatterError(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge' }] }))
    expect(error.kind).toBe('merge-without-reason')
  })

  it('空白だけの reason の wait: merge も、reason の無い誤りにする', () => {
    const error = catchFrontmatterError(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge', reason: ' '.repeat(3) }] }))
    expect(error.kind).toBe('merge-without-reason')
  })

  it('複数行の reason は、検証の誤りにする', () => {
    expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge', reason: '一行目\n二行目' }] }))
      .toThrow('validation error:\n  - blocked_by.0.reason: Value error, reason must be a single line')
  })

  it('wait が stack か merge でないとき、選択肢を出す', () => {
    expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'later' }] }))
      .toThrow('  - blocked_by.0.wait: Input should be \'stack\' or \'merge\'')
  })

  it.for([
    { name: 'issue が文字列でない', entry: { issue: 12 }, expected: '  - blocked_by.0.issue: Input should be a valid string' },
    { name: 'issue が無い', entry: { wait: 'stack' }, expected: '  - blocked_by.0.issue: Field required' },
    { name: 'issue が空', entry: { issue: ' ' }, expected: '  - blocked_by.0.issue: String should have at least 1 character' },
  ])('$name とき、検証の誤りにする', ({ entry, expected }) => {
    expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [entry] })).toThrow(expected)
  })

  it('blocked_by が一覧でないとき、検証の誤りにする', () => {
    expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: 'phase1' })).toThrow('  - blocked_by: Input should be a valid list')
  })

  it.for([
    { name: 'blocked_by と status: ready を併記した', input: { ...NO_STATUS, status: 'ready', blocked_by: [{ issue: 'phase1' }] }, expected: 'status: ready cannot be set together with blocked_by' },
    { name: 'blocked_by の無い status: blocked の', input: { ...NO_STATUS, status: 'blocked' }, expected: 'status: blocked requires blocked_by' },
    { name: 'blocked_by が空の status: blocked の', input: { ...NO_STATUS, status: 'blocked', blocked_by: [] }, expected: 'status: blocked requires blocked_by' },
    { name: 'Epic の blocked_by の', input: { ...NO_STATUS, type: 'epic', blocked_by: [{ issue: 'phase1' }] }, expected: 'blocked_by cannot be set for type epic' },
    { name: 'Tracker の blocked_by の', input: { ...NO_STATUS, type: 'tracker', blocked_by: [{ issue: 'phase1' }] }, expected: 'blocked_by cannot be set for type tracker' },
  ])('$name とき、検証の誤りにする', ({ input, expected }) => {
    expect(() => validateIssueFrontmatter(input)).toThrow(`validation error:\n  - : Value error, ${expected}`)
  })
})

describe('validateIssueFrontmatter の parallel と order', () => {
  it('parallel に値があると、種類 parallel の誤りにする', () => {
    const error = catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 4, parallel: 'b' }))
    expect(error.kind).toBe('parallel')
  })

  it('type の誤りなどほかの誤りと重なっても、種類 parallel の誤りを先にする', () => {
    expect(catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, type: 'nope', parallel: 'a' })).kind).toBe('parallel')
  })

  it('order が無くても、parallel に値があれば種類 parallel の誤りにする', () => {
    expect(catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, parallel: 'a' })).kind).toBe('parallel')
  })

  it.for(['', JSON_NULL])('parallel が %j のとき、通す', (value) => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 4, parallel: value })).not.toThrow()
  })

  it('order 指定時に parent_epic がないとエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, order: 1 })).toThrow('parent_epic is required when order is set')
  })

  it('order が 0 の場合はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 0 })).toThrow('integer of 1 or more')
  })

  it('order が負の場合はエラー', () => {
    expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: -1 })).toThrow('integer of 1 or more')
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

  it('エラー文は「validation error:」の後に項目ごとの行が続く', () => {
    expect(() => validateIssueFrontmatter({ title: 'T' })).toThrow(
      'validation error:\n  - type: Field required\n  - repository: Field required',
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
  it('title・type・repository・status と本文のあるコンテンツを渡すと、フロントマターと本文を取り出す', () => {
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

  it('priority・size・labels・parent_epic・order まで書いたコンテンツを渡すと、すべての値を取り出す', () => {
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
    expect(() => parseFrontmatter('# タイトル\n\n本文のみ\n')).toThrow('frontmatter not found (does not start with ---)')
  })

  it('閉じられていないフロントマターはエラー', () => {
    const content = `---
title: テスト
type: task
repository: owner/repo

本文（閉じタグなし）
`
    expect(() => parseFrontmatter(content)).toThrow('frontmatter is not closed (missing closing ---)')
  })

  it('無効な YAML はエラー', () => {
    const content = `---
title: テスト
type: epic: invalid
---

本文
`
    expect(() => parseFrontmatter(content)).toThrow(/^failed to parse YAML: /u)
  })

  it('マッピングでない YAML はエラー', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\n\n本文\n')).toThrow('frontmatter must be a mapping (key: value)')
    expect(() => parseFrontmatter('---\n# コメントだけ\n---\n\n本文\n')).toThrow('frontmatter must be a mapping (key: value)')
  })

  it('必須フィールドがない場合はエラー', () => {
    expect(() => parseFrontmatter('---\ntitle: テスト\n---\n\n本文\n')).toThrow('validation error')
  })

  it('priority・size・parent_epic・order が空文字列のとき、いずれも undefined にする', () => {
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

  it('template を書いたコンテンツを渡すと、template の値を取り出す', () => {
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

  it('template を書かないコンテンツを渡すと、template は undefined になる', () => {
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

  it('本文が空のとき、body を空文字列にする', () => {
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
  it('issue_ref だけを渡すと、template を undefined にして返す', () => {
    const fm = validateCommentFrontmatter({ issue_ref: 'owner/repo/123' })
    expect(fm.issue_ref).toBe('owner/repo/123')
    expect(fm.template).toBeUndefined()
  })

  it('issue_ref と template を渡すと、両方の値を返す', () => {
    const fm = validateCommentFrontmatter({ issue_ref: 'owner/repo/456', template: 'merge-diff' })
    expect(fm.issue_ref).toBe('owner/repo/456')
    expect(fm.template).toBe('merge-diff')
  })

  it('issue_ref がない場合はエラー', () => {
    expect(() => validateCommentFrontmatter({})).toThrow('  - issue_ref: Field required')
  })

  it('comment_url を渡すと、その値を返し、省くと undefined にする', () => {
    expect(validateCommentFrontmatter({ issue_ref: 'o/r/1', comment_url: 'https://x/1' }).comment_url).toBe('https://x/1')
    expect(validateCommentFrontmatter({ issue_ref: 'o/r/1' }).comment_url).toBeUndefined()
  })
})

describe('parseCommentContent', () => {
  it('issue_ref と本文のあるコンテンツを渡すと、issue_ref と本文を取り出す', () => {
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

  it('issue_ref・template・本文のあるコンテンツを渡すと、3 つとも取り出す', () => {
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
    expect(() => parseCommentContent('# タイトル\n\n本文のみ\n')).toThrow('frontmatter not found')
  })

  it('issue_ref がない場合はエラー', () => {
    expect(() => parseCommentContent('---\ntemplate: merge-diff\n---\n\n本文\n')).toThrow('validation error')
  })
})

describe('validatePullRequestFrontmatter', () => {
  it('title・repository・base だけを渡すと、head を undefined、draft を false にして返す', () => {
    const fm = validatePullRequestFrontmatter({ title: '機能追加', repository: 'owner/repo', base: 'develop-aist' })
    expect(fm.title).toBe('機能追加')
    expect(fm.repository).toBe('owner/repo')
    expect(fm.base).toBe('develop-aist')
    expect(fm.head).toBeUndefined()
    expect(fm.draft).toBe(false)
  })

  it('head と draft まで渡すと、渡した値をそのまま返す', () => {
    const fm = validatePullRequestFrontmatter({ title: 'バグ修正PR', repository: 'org/project', base: 'develop', head: 'feat/issue-123-fix-bug', draft: true })
    expect(fm.head).toBe('feat/issue-123-fix-bug')
    expect(fm.draft).toBe(true)
  })

  it('screenshot は前後の空白を落とし、空や未指定なら undefined にする', () => {
    const base = { title: 'T', repository: 'o/r', base: 'develop' }
    expect(validatePullRequestFrontmatter({ ...base, screenshot: '  画面は変わらない  ' }).screenshot).toBe('画面は変わらない')
    expect(validatePullRequestFrontmatter({ ...base, screenshot: '  ' }).screenshot).toBeUndefined()
    expect(validatePullRequestFrontmatter({ ...base, screenshot: JSON_NULL }).screenshot).toBeUndefined()
    expect(validatePullRequestFrontmatter(base).screenshot).toBeUndefined()
  })

  it('screenshot が文字列でなければエラー', () => {
    expect(() => validatePullRequestFrontmatter({ title: 'T', repository: 'o/r', base: 'develop', screenshot: 5 })).toThrow('  - screenshot: Input should be a valid string')
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
  it('title・repository・base と本文のあるコンテンツを渡すと、head を undefined、draft を false にして取り出す', () => {
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

  it('head と draft まで書いたコンテンツを渡すと、その値を取り出す', () => {
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
    expect(() => parsePullRequestContent('# PR\n\n本文のみ\n')).toThrow('frontmatter not found')
  })

  it('title がない場合はエラー', () => {
    expect(() => parsePullRequestContent('---\nrepository: "owner/repo"\nbase: "develop"\n---\n\n本文\n')).toThrow('validation error')
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

describe('setFrontmatterValue', () => {
  it('同じ値のキーの行がもうあるとき、行を足さずそのまま返す', () => {
    const content = '---\nissue_ref: "o/r/1"\ncomment_url: "https://x/1"\n---\n\n## Plan\n'
    expect(setFrontmatterValue(content, 'comment_url', 'https://x/1')).toBe(content)
  })

  it('新しいキーを末尾に足し、本文はそのまま残す', () => {
    const content = '---\nissue_ref: "o/r/1"\n---\n\n## Plan\n'
    expect(setFrontmatterValue(content, 'comment_url', 'https://x/1')).toBe('---\nissue_ref: "o/r/1"\ncomment_url: "https://x/1"\n---\n\n## Plan\n')
  })

  it('同じキーの行があれば置き換える', () => {
    const content = '---\ncomment_url: "old"\nissue_ref: "o/r/1"\n---\nbody\n'
    expect(setFrontmatterValue(content, 'comment_url', 'new')).toBe('---\ncomment_url: "new"\nissue_ref: "o/r/1"\n---\nbody\n')
  })

  it('キーに正規表現の記号があっても、その文字どおりの行だけを置き換える', () => {
    const content = '---\na.c: "1"\nabc: "2"\n---\nbody\n'
    expect(setFrontmatterValue(content, 'a.c', 'x')).toBe('---\na.c: "x"\nabc: "2"\n---\nbody\n')
  })

  it('フロントマターが無ければ FrontmatterError を投げる', () => {
    expect(() => setFrontmatterValue('## Plan\n', 'comment_url', 'x')).toThrow(new FrontmatterError('frontmatter not found'))
  })
})
