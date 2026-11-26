import { describe, expect, it, vi } from 'vitest'

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
  it('ほかに open の Tracker があると、使う番号と残す番号を警告する', () => {
    expect(warnings(3, [5, 8])).toBe('warning: multiple open Trackers; using #3 (lowest number) and leaving #5, #8 open\n')
  })

  it('ほかに無いときと、Tracker が無いときは、何も出さない', () => {
    expect(warnings(3, [])).toBe('')
    expect(warnings(undefined, [5])).toBe('')
  })
})

describe('apiErrorDetail', () => {
  it('API のエラーと通信のエラーなら文を、ほかの例外なら undefined を返す', () => {
    expect(apiErrorDetail(new GitHubAPIError('not found'))).toBe('not found')
    expect(apiErrorDetail(new TransportFailure('timed out'))).toBe('timed out')
    expect(apiErrorDetail(new Error('other'))).toBeUndefined()
  })
})

describe('isBodyUnchanged', () => {
  it('改行を LF にそろえて同じなら、変わっていないとみなす', () => {
    expect(isBodyUnchanged('a\nb', 'a\r\nb')).toBe(true)
    expect(isBodyUnchanged('a\nb', 'a\nc')).toBe(false)
    expect(isBodyUnchanged('a', undefined)).toBe(false)
  })
})

describe('todayUtc', () => {
  it('UTC の日付を YYYY-MM-DD で返す', () => {
    expect(todayUtc(new Date('2026-11-26T23:30:00-05:00'))).toBe('2026-11-27')
  })
})
