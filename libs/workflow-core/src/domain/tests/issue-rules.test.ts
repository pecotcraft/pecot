// 起票の決まり（題の接頭辞と番号・起票時の status・Epic の起票先）のテスト
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { buildIssueTitle, epicTargetRepository, splitIssueTitle, statusViolation } from '../issue-rules.js'

const prefixRows: readonly (readonly [string, string, string])[] = [
  ['task', 'タイトル', '[Task] タイトル'],
  ['task', '[Task] タイトル', '[Task] タイトル'],
  ['bug', 'x', '[Bug] x'],
  ['unknown', 'x', 'x'],
]

describe('buildIssueTitle', () => {
  it.for(prefixRows)('Issue の種類 $0 とタイトル $1 に接頭辞を付けると、$2 になる', async ([issueType, title, expected]) => {
    await explains(`Issue のタイトルに、種類ごとの接頭辞を付ける関数（\`buildIssueTitle\`）のテストです。種類 \`${issueType}\` とタイトル \`${title}\` の場合に、\`${expected}\` になることを確認します。`)
    stepSync('buildIssueTitle を呼び、結果を比べる', () => {
      expect(buildIssueTitle(issueType, title)).toBe(expected)
    })
  })

  it('親 Epic の番号と order を指定した場合は、タイトルに Epic の番号と order を付ける', async () => {
    await explains('親 Epic の番号と order を指定した場合のテストです。接頭辞の後ろに `#353-01:` のような番号が付き、タイトルがすでに接頭辞で始まっていても重複しないことを確認します。')
    stepSync('buildIssueTitle を呼び、結果を比べる', () => {
      expect(buildIssueTitle('task', 'タイトル', { parentEpic: 353, order: 1 })).toBe('[Task] #353-01: タイトル')
      expect(buildIssueTitle('task', '[Task] タイトル', { parentEpic: 353, order: 12 })).toBe('[Task] #353-12: タイトル')
    })
  })

  it('接頭辞を持たない種類の場合は、番号だけをタイトルに付ける', async () => {
    await explains('接頭辞を持たない種類（`unknown`）に、親 Epic の番号と order を指定した場合のテストです。接頭辞は付けず、`#50-01:` の番号だけが付くことを確認します。')
    stepSync('buildIssueTitle を呼び、結果を比べる', () => {
      expect(buildIssueTitle('unknown', 'タイトル', { parentEpic: 50, order: 1 })).toBe('#50-01: タイトル')
    })
  })

  it('order は 2 桁に揃えて、タイトルに付ける', async () => {
    await explains('order が 1 桁の場合のテストです。`04` のように 0 で埋めた 2 桁になり、2 桁の `10` はそのまま付くことを確認します。')
    stepSync('buildIssueTitle を呼び、結果を比べる', () => {
      expect(buildIssueTitle('task', 'タイトル', { parentEpic: 189, order: 4 })).toBe('[Task] #189-04: タイトル')
      expect(buildIssueTitle('task', 'タイトル', { parentEpic: 189, order: 10 })).toBe('[Task] #189-10: タイトル')
    })
  })
})

describe('splitIssueTitle', () => {
  it('接頭辞と番号を持つ題は、親 Epic の番号・order・残りに分ける', async () => {
    await explains('題を接頭辞・番号・残りに分ける関数（`splitIssueTitle`）のテストです。`[Task] #353-04a: 題` を、接頭辞あり・親 Epic 353・order 4・残り `題` に分けることを確認します。')
    stepSync('splitIssueTitle を呼び、結果を比べる', () => {
      expect(splitIssueTitle('task', '[Task] #353-04a: 題')).toEqual({ hasPrefix: true, parentEpic: 353, order: 4, orderText: '#353-04a: ', rest: '題' })
    })
  })

  it('接頭辞の無い題も番号を読み、番号が無ければ残りを題全体にする', async () => {
    await explains('接頭辞の無い題のテストです。`#12-01: 題` は接頭辞なしで番号を読み、`[Task] 題` は番号なしで残りが `題` になることを確認します。')
    stepSync('splitIssueTitle を呼び、結果を比べる', () => {
      expect(splitIssueTitle('task', '#12-01: 題')).toEqual({ hasPrefix: false, parentEpic: 12, order: 1, orderText: '#12-01: ', rest: '題' })
      expect(splitIssueTitle('task', '[Task] 題')).toEqual({ hasPrefix: true, parentEpic: undefined, order: undefined, orderText: '', rest: '題' })
    })
  })
})

describe('statusViolation', () => {
  it('Issue の種類の既定の status と同じ値の場合は、違反にしない', async () => {
    await explains('起票時の status を検証する関数（`statusViolation`）のテストです。`task` に `ready`、`epic` に `backlog` を指定した場合に、違反が無い（`undefined`）ことを確認します。')
    stepSync('statusViolation を呼び、結果を比べる', () => {
      expect(statusViolation('task', 'ready')).toBeUndefined()
      expect(statusViolation('epic', 'backlog')).toBeUndefined()
    })
  })

  it('既定の status と異なる場合は、既定の値と、作成後に動かす手順を案内する', async () => {
    await explains('`bug` に `ready` 以外の status を指定した場合のテストです。許される値と、作成後にボードで動かす手順を案内する文を返すことを確認します。')
    stepSync('statusViolation を呼び、結果を比べる', () => {
      expect(statusViolation('bug', 'backlog')).toBe('the status at creation for type \'bug\' is only \'ready\' (given: backlog)\nhint: move it to pending or another status on the board after creation')
    })
  })

  it('許可する値を指定した場合は、その値も受け付け、それ以外の場合は許可する値を並べて案内する', async () => {
    await explains('許可する値の一覧（`ready` と `blocked`）を指定した場合のテストです。`blocked` は受け付け、`active` の場合は許可する値を並べた文を返すことを確認します。')
    stepSync('statusViolation を呼び、結果を比べる', () => {
      expect(statusViolation('task', 'blocked', ['ready', 'blocked'])).toBeUndefined()
      expect(statusViolation('task', 'active', ['ready', 'blocked'])).toBe('the status at creation for type \'task\' is only \'ready\' or \'blocked\' (given: active)\nhint: move it to pending or another status on the board after creation')
    })
  })

  it('許可する値を指定しない場合は、blocked は既定の status ではないため違反にする', async () => {
    await explains('許可する値を指定せず、`task` に `blocked` を指定した場合のテストです。`blocked` は既定の status ではないため、違反の文を返すことを確認します。')
    stepSync('statusViolation を呼び、結果を比べる', () => {
      expect(statusViolation('task', 'blocked')).toMatch(/^the status at creation for type 'task' is only 'ready' \(given: blocked\)/u)
    })
  })

  it('定義外の status は、種類ごとの検証より先に違反とする', async () => {
    await explains('`task` に定義外の status（`foo`）を指定した場合のテストです。種類ごとの検証より前に、`invalid status: foo` と有効な値の一覧を返すことを確認します。')
    stepSync('statusViolation を呼び、結果を比べる', () => {
      expect(statusViolation('task', 'foo')).toBe('invalid status: foo\nvalid values: backlog/pending/blocked/ready/active/in_review/archived')
    })
  })
})

describe('epicTargetRepository', () => {
  it('リポジトリを指定せず aggregation_repo も無い場合は、作成先を決められない', async () => {
    await explains('Epic の作成先のリポジトリを決める関数（`epicTargetRepository`）のテストです。`repo` が空白だけで `aggregation_repo` も無い場合は、決められない（`undecidable`）ことを確認します。')
    stepSync('epicTargetRepository を呼び、結果を比べる', () => {
      expect(epicTargetRepository(' ', undefined)).toEqual({ kind: 'undecidable' })
    })
  })

  it('リポジトリを指定しない場合は、aggregation_repo を作成先にする', async () => {
    await explains('`repo` を指定しない場合のテストです。`aggregation_repo` のリポジトリが作成先になり、例外ではないことを確認します。')
    stepSync('epicTargetRepository を呼び、結果を比べる', () => {
      expect(epicTargetRepository(undefined, 'o/agg')).toEqual({ kind: 'resolved', repository: 'o/agg', isException: false })
    })
  })

  it('指定したリポジトリが aggregation_repo と異なる場合だけ、例外とする', async () => {
    await explains('`repo` を指定した場合のテストです。`aggregation_repo` が無い場合や同じ場合は例外にせず、異なる場合だけ例外（`isException` が `true`）になることを確認します。')
    stepSync('epicTargetRepository を呼び、結果を比べる', () => {
      expect(epicTargetRepository('o/impl', undefined)).toEqual({ kind: 'resolved', repository: 'o/impl', isException: false })
      expect(epicTargetRepository('o/agg', 'o/agg')).toEqual({ kind: 'resolved', repository: 'o/agg', isException: false })
      expect(epicTargetRepository('o/impl', 'o/agg')).toEqual({ kind: 'resolved', repository: 'o/impl', isException: true })
    })
  })
})
