import { describe, expect, it } from 'vitest'

import { autoContextOf, permissionCandidates } from '../auto-context.js'
import type { IssueCommentRecord } from '../review-finish.js'

function comment(body: string, fields: Partial<IssueCommentRecord> = {}): IssueCommentRecord {
  return { body, userType: 'User', login: 'alice', authorAssociation: 'MEMBER', createdAt: '2026-11-24T00:00:00Z', url: 'https://github.com/acme/demo/issues/7#issuecomment-1', ...fields }
}

const BOT: Partial<IssueCommentRecord> = { userType: 'Bot', login: 'pecot-agent[bot]', authorAssociation: 'NONE' }
const RESULT = '<!-- pecot-auto: result=question run=1 attempt=1 branch=- -->\n\n## Auto result — 質問'
const PLAN = '## Plan\n\n手順を書く。'

describe('autoContextOf', () => {
  it('結果のコメントが無いと、計画と答えを空で返す', () => {
    expect(autoContextOf([comment('こんにちは')], new Set(['alice']))).toEqual({ plan: '', results: [], answers: [], withheld: 0 })
  })

  it('bot の結果のコメントを、古い順で results へ並べる', () => {
    const second = RESULT.replace('question', 'failed')
    const context = autoContextOf([comment(RESULT, BOT), comment('間の話', { login: 'bob' }), comment(second, BOT)], new Set())

    expect(context.results).toEqual([RESULT, second])
  })

  it('人が書いた目印のコメントは、結果に数えない', () => {
    expect(autoContextOf([comment(RESULT)], new Set(['alice'])).results).toEqual([])
  })

  it('最後の結果の後の、書き込み権限のある人のコメントを answers に入れる', () => {
    const context = autoContextOf([comment('前の話'), comment(RESULT, BOT), comment('残す', { login: 'alice' })], new Set(['alice']))

    expect(context.answers).toEqual([{ author: 'alice', body: '残す' }])
    expect(context.withheld).toBe(0)
  })

  it.for([
    { name: 'author_association が CONTRIBUTOR', fields: { authorAssociation: 'CONTRIBUTOR' } },
    { name: '権限を読めなかった', fields: { login: 'carol' } },
  ])('最後の結果の後のコメントで $name の人の本文を出さず、数だけ数える', ({ fields }) => {
    const context = autoContextOf([comment(RESULT, BOT), comment('外の人の話', fields)], new Set(['alice']))

    expect(context.answers).toEqual([])
    expect(context.withheld).toBe(1)
  })

  it('最後の結果の後の bot のコメントは、答えと数のどちらにも入れない', () => {
    const context = autoContextOf([comment(RESULT, BOT), comment('進み具合', BOT)], new Set())

    expect(context).toEqual({ plan: '', results: [RESULT], answers: [], withheld: 0 })
  })

  it('見出し ## Plan で始まる bot のコメントのうち、最後のものを計画にする', () => {
    const later = '## Plan\n\n後の手順。'
    expect(autoContextOf([comment(PLAN, BOT), comment(later, BOT)], new Set()).plan).toBe(later)
  })

  it('書き込み権限のある人の計画も読み、権限の無い人の計画は数だけ数える', () => {
    const trusted = autoContextOf([comment(PLAN, { login: 'alice' })], new Set(['alice']))
    const untrusted = autoContextOf([comment(PLAN, { login: 'mallory', authorAssociation: 'NONE' })], new Set(['alice']))

    expect(trusted).toMatchObject({ plan: PLAN, withheld: 0 })
    expect(untrusted).toMatchObject({ plan: '', withheld: 1 })
  })

  it('最後の結果の後の計画は、答えに重ねて入れない', () => {
    const context = autoContextOf([comment(RESULT, BOT), comment(PLAN, { login: 'alice' })], new Set(['alice']))

    expect(context).toMatchObject({ plan: PLAN, answers: [] })
  })

  it.for([
    { name: '## Plans', body: '## Plans\n\n別の見出し' },
    { name: '本文の途中の ## Plan', body: 'まえがき\n\n## Plan\n\n手順' },
  ])('$name は計画にしない', ({ body }) => {
    expect(autoContextOf([comment(body, BOT)], new Set()).plan).toBe('')
  })
})

describe('permissionCandidates', () => {
  it('計画と最後の結果の後のコメントを書いた人のうち、関係が OWNER・MEMBER・COLLABORATOR の人を 1 度ずつ返す', () => {
    const comments = [
      comment(PLAN, { login: 'alice', authorAssociation: 'OWNER' }),
      comment('前の話', { login: 'dave' }),
      comment(RESULT, BOT),
      comment('答え', { login: 'alice', authorAssociation: 'OWNER' }),
      comment('答え', { login: 'bob', authorAssociation: 'COLLABORATOR' }),
      comment('通りがかり', { login: 'erin', authorAssociation: 'NONE' }),
    ]

    expect(permissionCandidates(comments, 'context')).toEqual(['alice', 'bob'])
  })

  it('plan を渡すと、計画を書いた人だけを返す', () => {
    const comments = [comment(PLAN, { login: 'alice' }), comment(RESULT, BOT), comment('答え', { login: 'bob' })]

    expect(permissionCandidates(comments, 'plan')).toEqual(['alice'])
  })
})
