// issue_comment_check の振る舞いを、MCP のツールの結果で確かめる。前後比較（FR-020）の入力は、消した issue_comment の golden の本文を写したもの。
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { ISSUE_COMMENT_CHECK_TOOLS } from '../../src/commands/issue-comment-check.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { step } from '../_helpers/step.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'

useIsolatedEnvironment()

const MERGE_DIFF_BODY = [
  '## Merge — 実装は半分まで進んだ',
  '',
  '### Variance — 一覧の取得を検証した',
  '',
  '- 一覧を取得できる — テストで確認した',
  '',
  '### Impact — 画面の表示に着手する',
  '',
  '- 画面を作る — 判断は不要',
].join('\n')

const TARGET = { owner: 'acme', repo: 'demo', issue_number: 7 }
const MERGE_DIFF = 'pecot-template://comment/merge-diff'
const COMMENT_URL = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-1'
const READ_COMMENTS = { comments: [{ id: 1, html_url: COMMENT_URL, body: '古い本文', user: { login: 'octocat' } }] }

const PROBLEMS = z.array(z.record(z.string(), z.unknown()))

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_COMMENT_CHECK_TOOLS, 'issue_comment_check', { method: 'add', ...TARGET, body: MERGE_DIFF_BODY, template: MERGE_DIFF, ...arguments_ })
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  expect(outcome.isError).toBe(false)
  expect(outcome.structured['problems']).not.toEqual([])
  return PROBLEMS.parse(outcome.structured['problems'])
}

describe('issue_comment_check', () => {
  it.for([
    { name: '末尾に改行の無い本文', body: MERGE_DIFF_BODY },
    { name: '末尾に改行のある本文', body: `${MERGE_DIFF_BODY}\n` },
  ])('消した issue_comment が投稿できた $name を渡すと、problem の無い結果を返す', async ({ name, body }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-01')
    await explains(`消した \`issue_comment\` の golden が投稿できた ${name}を、\`merge-diff\` のテンプレートで確認するテストです。問題の無い結果を返すことを確認します。`)
    const outcome = await check({ body })
    await step('problem が無く ok と返ることを確かめる', () => {
      expect(outcome).toMatchObject({ isError: false, structured: { problems: [] }, text: 'ok' })
    })
  })

  it('本文がテンプレートの見出しを持たないと、不足している見出しを 1 つずつ problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-02')
    await explains('`merge-diff` のテンプレートの見出しを持たない本文を渡した場合のテストです。ツールの失敗にせず、不足している見出しごとに `missing-section` の問題を返すことを確認します。')
    const outcome = await check({ body: '進捗です' })
    await step('不足している見出しごとの problem を確かめる', () => {
      const problems = problemsOf(outcome)
      expect(problems.map(problem => [problem['field'], problem['code']])).toEqual([
        ['body', 'missing-section'],
        ['body', 'missing-section'],
        ['body', 'missing-section'],
      ])
      expect(problems[0]?.['message']).toBe(`missing section (${MERGE_DIFF}): ## Merge — <summary>; the em dash must be U+2014; hyphen-minus (-) and EN DASH (U+2013) are not allowed`)
    })
  })

  it('plan のテンプレートに無い見出しがあると、extra-heading の problem に置き場所の案内を添える', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-02')
    await explains('`plan` のテンプレートに無い見出しを持つ本文のテストです。`extra-heading` の問題を返し、その文に `### Notes` へ書く案内を含めることを確認します。')
    const outcome = await check({ template: 'pecot-template://comment/plan', body: '## Plan\n\n### Extra\n\n余分です。\n' })
    await step('extra-heading の problem と案内を確かめる', () => {
      const extra = problemsOf(outcome).find(problem => problem['code'] === 'extra-heading')
      expect(extra?.['message']).toContain('### Extra')
      expect(extra?.['message']).toContain('put content that fits no other heading under ### Notes')
    })
  })

  it('同梱に無いコメントのテンプレートを指定すると、同梱のテンプレートを候補に添えて problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-02')
    await explains('`pecot-template://` で始まるが同梱に存在しないテンプレートを指定した場合のテストです。`template` の問題を返し、同梱の 5 つのテンプレートを候補に含めることを確認します。')
    const outcome = await check({ template: 'pecot-template://comment/unknown' })
    await step('unknown-template の problem と候補を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'template', code: 'unknown-template', candidates: [
        'pecot-template://comment/plan',
        'pecot-template://comment/merge-diff',
        'pecot-template://comment/review-findings',
        'pecot-template://comment/review-resolution',
        'pecot-template://comment/precede-notify',
      ] })])
    })
  })

  it.for([
    { name: '差し替えたテンプレートのパス', template: '.github/pecot/comment/merge-diff.md' },
    { name: 'テンプレートの省略', template: undefined },
  ])('$name では、本文にテンプレートの決まりを当てずに problem の無い結果を返す', async ({ name, template }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-03')
    await explains(`${name}の場合のテストです。同梱のテンプレートの決まりを当てず、見出しの無い本文でも問題の無い結果を返すことを確認します。`)
    const outcome = await check({ template, body: '進捗です' })
    await step('problem が無いことを確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [] })
    })
  })

  it('add に comment_id を渡すと、comment_id の problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-04')
    await explains('`method` が `add` で `comment_id` を渡した場合のテストです。新しいコメントを作る操作に不要な `comment_id` を、`unexpected` の問題として返すことを確認します。')
    const outcome = await check({ comment_id: 1 })
    await step('unexpected の problem を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'comment_id', code: 'unexpected' })])
    })
  })

  it('update に comment_id が無いと、comment_id の problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-04')
    await explains('`method` が `update` で `comment_id` を渡さない場合のテストです。書き換えるコメントを示す `comment_id` が不足している問題を返すことを確認します。')
    const outcome = await check({ method: 'update' })
    await step('required の problem を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'comment_id', code: 'required' })])
    })
  })

  it('update に reads.comments が無いと、issue_read の get_comments で読むよう problem で案内する', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-05')
    await explains('`method` が `update` でコメントの読み取りの結果を渡さない場合のテストです。`issue_read` の `get_comments` で読んで `reads.comments` に渡すよう案内する問題を返すことを確認します。')
    const outcome = await check({ method: 'update', comment_id: 1 })
    await step('read-required の problem と案内を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([{ field: 'reads.comments', code: 'read-required', message: 'read the comments of acme/demo/7 with issue_read (method get_comments) and pass its result as reads.comments' }])
    })
  })

  it('update で comment_id が読み取りの結果にあり、同じ Issue のコメントなら problem の無い結果を返す', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-06')
    await explains('`method` が `update` で、`comment_id` のコメントが `reads.comments` に存在し、URL が対象の Issue を指す場合のテストです。問題の無い結果を返すことを確認します。')
    const outcome = await check({ method: 'update', comment_id: 1, reads: { comments: READ_COMMENTS } })
    await step('problem が無いことを確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [] })
    })
  })

  it('update で comment_id が読み取りの結果に無いと、not-found の problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-06')
    await explains('`method` が `update` で、`comment_id` のコメントが `reads.comments` に存在しない場合のテストです。別の Issue のコメントか、未読のページにある旨の `not-found` の問題を返すことを確認します。')
    const outcome = await check({ method: 'update', comment_id: 2, reads: { comments: READ_COMMENTS } })
    await step('not-found の problem を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'comment_id', code: 'not-found' })])
    })
  })

  it('update で読み取ったコメントの URL が別の Issue を指すと、other-issue の problem にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-06')
    await explains('`method` が `update` で、`reads.comments` のコメントの URL が別の Issue（`acme/demo/8`）を指す場合のテストです。`other-issue` の問題を返すことを確認します。')
    const comments = { comments: [{ id: 1, html_url: 'https://ghes.example.com/acme/demo/pull/8#issuecomment-1' }] }
    const outcome = await check({ method: 'update', comment_id: 1, reads: { comments } })
    await step('other-issue の problem を確かめる', () => {
      expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'comment_id', code: 'other-issue' })])
    })
  })

  it('method に add・update のほかの値を渡すと、誤りの文だけを detail に入れて invalid-input の失敗にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-08')
    await verifies(context, 'PW-COMMON-28')
    await explains('`method` に `delete` を渡した場合のテストです。種別 `invalid-input` のツールの失敗を返し、`detail` に使い方の表示を含めず、誤りの文だけを入れることを確認します。')
    const outcome = await check({ method: 'delete' })
    await step('invalid-input の失敗と detail を確かめる', () => {
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('method')
      expect(outcome.structured['detail']).not.toMatch(/Usage:|[╭│╰]/u)
    })
  })

  it('reads.comments が公式の MCP の結果の形でないと、github-mcp-shape の失敗にする', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-CHECK-07')
    await explains('`reads.comments` のコメントが必須の `html_url` を持たない場合のテストです。公式の GitHub MCP の結果の形と異なるため、種別 `github-mcp-shape` のツールの失敗を返すことを確認します。')
    const outcome = await check({ method: 'update', comment_id: 1, reads: { comments: { comments: [{ id: 1 }] } } })
    await step('github-mcp-shape の失敗と detail を確かめる', () => {
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-mcp-shape')
      expect(outcome.structured['detail']).toContain('reads.comments')
    })
  })
})
