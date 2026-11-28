import { describe, expect, it, vi } from 'vitest'
import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { TransportFailure } from '../../infra/github/client.js'
import { GitHubAPIError } from '../../infra/github/errors.js'
import { createOutput } from '../output.js'
import { apiErrorDetail, isBodyUnchanged, todayUtc, warnExtraTrackers } from '../tracker-shared.js'

function warnings(trackerNumber: number | undefined, others: readonly number[]): string {
  const chunks: string[] = []
  const stderr = (text: string): void => {
    chunks.push(text)
  }
  warnExtraTrackers(createOutput(false, { stdout: vi.fn(), stderr }), trackerNumber === undefined ? undefined : { number: trackerNumber, body: '' }, others)
  return chunks.join('')
}

describe('warnExtraTrackers', () => {
  it('ほかに open の Tracker があると、使う番号と残す番号を警告する', async () => {
    await explains('open の Tracker が複数ある場合の警告文のテストです。使う番号（いちばん小さい番号）と、open のまま残す番号を並べた警告文を作成することを確認します。')
    stepSync('結果を確認する', () => {
      expect(warnings(3, [5, 8])).toBe('warning: multiple open Trackers; using #3 (lowest number) and leaving #5, #8 open\n')
    })
  })

  it('ほかに無いときと、Tracker が無いときは、何も出さない', async () => {
    await explains('open の Tracker が複数ある場合の警告文のテストです。ほかに open の Tracker が無い場合と、Tracker が存在しない場合に、何も出力しないことを確認します。')
    stepSync('結果を確認する', () => {
      expect(warnings(3, [])).toBe('')
      expect(warnings(undefined, [5])).toBe('')
    })
  })
})

describe('apiErrorDetail', () => {
  it('API のエラーと通信のエラーなら文を、ほかの例外なら undefined を返す', async () => {
    await explains('例外から API のエラーの文を取り出す `apiErrorDetail` のテストです。GitHub の API のエラーと通信のエラーでは文を返し、ほかの例外では `undefined` を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(apiErrorDetail(new GitHubAPIError('not found'))).toBe('not found')
      expect(apiErrorDetail(new TransportFailure('timed out'))).toBe('timed out')
      expect(apiErrorDetail(new Error('other'))).toBeUndefined()
    })
  })
})

describe('isBodyUnchanged', () => {
  it('改行を LF にそろえて同じなら、変わっていないとみなす', async () => {
    await explains('Tracker の本文が変わったかを判定する `isBodyUnchanged` のテストです。改行を LF にそろえて同じ場合だけ変わっていないとみなし、本文が無い場合は変わったとみなすことを確認します。')
    stepSync('結果を確認する', () => {
      expect(isBodyUnchanged('a\nb', 'a\r\nb')).toBe(true)
      expect(isBodyUnchanged('a\nb', 'a\nc')).toBe(false)
      expect(isBodyUnchanged('a', undefined)).toBe(false)
    })
  })
})

describe('todayUtc', () => {
  it('UTC の日付を YYYY-MM-DD で返す', async () => {
    await explains('Tracker に書く日付を作る `todayUtc` のテストです。タイムゾーンの付いた時刻を、UTC の日付の `YYYY-MM-DD` の形で返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(todayUtc(new Date('2026-11-26T23:30:00-05:00'))).toBe('2026-11-27')
    })
  })
})
