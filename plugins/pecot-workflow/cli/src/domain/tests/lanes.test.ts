import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'
import { summarizeLanes } from '../lanes.js'

const issue = (lane: string | null, isStartable = false): { lane: string | null, isStartable: boolean } => ({ lane, isStartable })

describe('summarizeLanes', () => {
  it('選択肢の順に並べ、Issue の数と着手できる数を数える', () => {
    expect(summarizeLanes(['beta', 'alpha'], [issue('alpha', true), issue('beta'), issue('alpha')])).toEqual([
      { name: 'beta', count: 1, startable: 0 },
      { name: 'alpha', count: 2, startable: 1 },
    ])
  })

  it('Issue の無い選択肢も 0 件で出す', () => {
    expect(summarizeLanes(['alpha', 'beta'], [issue('alpha')])).toEqual([
      { name: 'alpha', count: 1, startable: 0 },
      { name: 'beta', count: 0, startable: 0 },
    ])
  })

  it('値の無い Issue があると、name が null の組を末尾に足す', () => {
    expect(summarizeLanes(['alpha'], [issue(JSON_NULL, true), issue('alpha'), issue(JSON_NULL)])).toEqual([
      { name: 'alpha', count: 1, startable: 0 },
      { name: JSON_NULL, count: 2, startable: 1 },
    ])
  })

  it('値の無い Issue が無ければ、name が null の組を出さない', () => {
    expect(summarizeLanes(['alpha'], [])).toEqual([{ name: 'alpha', count: 0, startable: 0 }])
  })

  it('選択肢に無い値は、出てきた順で選択肢の後、null の組の前に足す', () => {
    expect(summarizeLanes(['alpha'], [issue(JSON_NULL), issue('gone'), issue('old', true), issue('gone')])).toEqual([
      { name: 'alpha', count: 0, startable: 0 },
      { name: 'gone', count: 2, startable: 0 },
      { name: 'old', count: 1, startable: 1 },
      { name: JSON_NULL, count: 1, startable: 0 },
    ])
  })

  it('選択肢が undefined なら、Issue があっても空を返す', () => {
    expect(summarizeLanes(undefined, [issue('alpha'), issue(JSON_NULL)])).toEqual([])
  })

  it('値の名前は大文字と小文字を分けて数える', () => {
    expect(summarizeLanes(['Alpha'], [issue('alpha')])).toEqual([
      { name: 'Alpha', count: 0, startable: 0 },
      { name: 'alpha', count: 1, startable: 0 },
    ])
  })
})
