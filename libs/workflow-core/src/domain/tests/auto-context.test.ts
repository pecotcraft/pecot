import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { autoContextOf, permissionCandidates } from '../auto-context.js'
import type { IssueCommentRecord } from '../review-finish.js'

function comment(body: string, fields: Partial<IssueCommentRecord> = {}): IssueCommentRecord {
  return { body, userType: 'User', login: 'alice', authorAssociation: 'MEMBER', createdAt: '2026-11-24T00:00:00Z', url: 'https://github.com/acme/demo/issues/7#issuecomment-1', ...fields }
}

const BOT: Partial<IssueCommentRecord> = { userType: 'Bot', login: 'pecot-agent[bot]', authorAssociation: 'NONE' }
const RESULT = '<!-- pecot-auto: result=question run=1 attempt=1 branch=- -->\n\n## Auto result — 質問'
const PLAN = '## Plan\n\n手順を書く。'

describe('autoContextOf', () => {
  it('結果のコメントが存在しない場合は、計画・結果・答えを空にして返す', async () => {
    await explains('Issue のコメントから自動処理の文脈を作成する関数（`autoContextOf`）のテストです。結果のコメントが存在しない場合に、計画が空文字、結果と答えが空の配列、保留した件数が 0 になることを確認します。')
    expect(autoContextOf([comment('こんにちは')], new Set(['alice']))).toEqual({ plan: '', results: [], answers: [], withheld: 0 })
  })

  it('bot の結果のコメントを、古い順に results へ並べる', async () => {
    await explains('bot の結果のコメントが 2 件ある場合のテストです。間に人のコメントがあっても、結果のコメントだけが古い順に `results` へ並ぶことを確認します。')
    const second = RESULT.replace('question', 'failed')
    const context = autoContextOf([comment(RESULT, BOT), comment('間の話', { login: 'bob' }), comment(second, BOT)], new Set())

    expect(context.results).toEqual([RESULT, second])
  })

  it('人が書いたコメントに結果の目印が含まれていても、結果として扱わない', async () => {
    await explains('人が書いたコメントに、結果を示す目印（`pecot-auto: result=…`）が含まれる場合のテストです。bot のコメントではないため、`results` に含まれないことを確認します。')
    expect(autoContextOf([comment(RESULT)], new Set(['alice'])).results).toEqual([])
  })

  it('最後の結果より後の、書き込み権限を持つ人のコメントを answers に入れる', async () => {
    await explains('最後の結果のコメントより後に、書き込み権限を持つ人のコメントがある場合のテストです。その本文が投稿者の名前とともに `answers` に入り、結果より前のコメントは入らないことを確認します。')
    const context = autoContextOf([comment('前の話'), comment(RESULT, BOT), comment('残す', { login: 'alice' })], new Set(['alice']))

    expect(context.answers).toEqual([{ author: 'alice', body: '残す' }])
    expect(context.withheld).toBe(0)
  })

  it('最後の結果より後のコメントのうち、書き込み権限を確認できない人のコメントは、本文を含めず件数だけ数える', async () => {
    await explains('書き込み権限を持つと確認できない人が、最後の結果より後にコメントした場合のテストです。本文は `answers` に含めず、件数だけを `withheld` に数えることを確認します。')
    const context = autoContextOf([comment(RESULT, BOT), comment('外の人の話', { login: 'carol' })], new Set(['alice']))

    expect(context.answers).toEqual([])
    expect(context.withheld).toBe(1)
  })

  it('author_association が CONTRIBUTOR でも、書き込み権限を持つ人のコメントは answers に入れる', async () => {
    await explains('組織の非公開のメンバーの `author_association` が `CONTRIBUTOR` になる場合（App のトークンで取得した場合）のテストです。関係では絞り込まず、書き込み権限で判断して `answers` に入れることを確認します。')
    const context = autoContextOf([comment(RESULT, BOT), comment('答え', { authorAssociation: 'CONTRIBUTOR' })], new Set(['alice']))

    expect(context.answers).toEqual([{ author: 'alice', body: '答え' }])
    expect(context.withheld).toBe(0)
  })

  it('最後の結果より後の bot のコメントは、answers と withheld のどちらにも入れない', async () => {
    await explains('最後の結果のコメントより後に、bot のコメントがある場合のテストです。bot のコメントは `answers` に入らず、`withheld` の件数にも数えないことを確認します。')
    const context = autoContextOf([comment(RESULT, BOT), comment('進み具合', BOT)], new Set())

    expect(context).toEqual({ plan: '', results: [RESULT], answers: [], withheld: 0 })
  })

  it('見出し ## Plan で始まる bot のコメントのうち、最後のものを計画として扱う', async () => {
    await explains('見出し `## Plan` で始まる bot のコメントが 2 件ある場合のテストです。後のコメントの本文が `plan` になることを確認します。')
    const later = '## Plan\n\n後の手順。'
    expect(autoContextOf([comment(PLAN, BOT), comment(later, BOT)], new Set()).plan).toBe(later)
  })

  it('書き込み権限を持つ人の計画は使い、権限を持たない人の計画は件数だけ数える', async () => {
    await explains('人が書いた計画のコメントのテストです。書き込み権限を持つ人のコメントは `plan` として使い、権限を持たない人のコメントは使わず、件数だけ `withheld` へ数えることを確認します。')
    const trusted = autoContextOf([comment(PLAN, { login: 'alice' })], new Set(['alice']))
    const untrusted = autoContextOf([comment(PLAN, { login: 'mallory', authorAssociation: 'NONE' })], new Set(['alice']))

    expect(trusted).toMatchObject({ plan: PLAN, withheld: 0 })
    expect(untrusted).toMatchObject({ plan: '', withheld: 1 })
  })

  it('最後の結果より後の計画のコメントは、計画としてだけ扱い、answers には入れない', async () => {
    await explains('最後の結果のコメントより後に、書き込み権限を持つ人が計画を書いた場合のテストです。そのコメントは `plan` になり、`answers` には入らないことを確認します。')
    const context = autoContextOf([comment(RESULT, BOT), comment(PLAN, { login: 'alice' })], new Set(['alice']))

    expect(context).toMatchObject({ plan: PLAN, answers: [] })
  })

  it.for([
    { name: '## Plans', body: '## Plans\n\n別の見出し' },
    { name: '本文の途中の ## Plan', body: 'まえがき\n\n## Plan\n\n手順' },
  ])('$name は、計画として扱わない', async ({ name, body }) => {
    await explains(`bot のコメントが、見出し \`## Plan\` で始まらない場合のテストです。${name}の場合に、\`plan\` が空文字になることを確認します。`)
    expect(autoContextOf([comment(body, BOT)], new Set()).plan).toBe('')
  })
})

describe('permissionCandidates', () => {
  it('計画と最後の結果より後のコメントを書いた人を、関係にかかわらず 1 人ずつ返す', async () => {
    await explains('書き込み権限を確認する対象を求める関数（`permissionCandidates`）のテストです。計画と最後の結果より後のコメントの投稿者を、リポジトリとの関係にかかわらず、重複なく返すことを確認します。')
    const comments = [
      comment(PLAN, { login: 'alice', authorAssociation: 'OWNER' }),
      comment('前の話', { login: 'dave' }),
      comment(RESULT, BOT),
      comment('答え', { login: 'alice', authorAssociation: 'OWNER' }),
      comment('答え', { login: 'bob', authorAssociation: 'CONTRIBUTOR' }),
      comment('通りがかり', { login: 'erin', authorAssociation: 'NONE' }),
      comment('進み具合', BOT),
    ]

    expect(permissionCandidates(comments, 'context')).toEqual(['alice', 'bob', 'erin'])
  })

  it('対象に plan を指定した場合は、計画を書いた人だけを返す', async () => {
    await explains('対象に `plan` を指定した場合のテストです。計画のコメントの投稿者だけを返し、結果より後の答えの投稿者は含まないことを確認します。')
    const comments = [comment(PLAN, { login: 'alice' }), comment(RESULT, BOT), comment('答え', { login: 'bob' })]

    expect(permissionCandidates(comments, 'plan')).toEqual(['alice'])
  })
})
