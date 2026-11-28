import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { decideBlock, decideUnblock } from '../blocked-by-change.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'

const HOME = createRepositoryReference('acme', 'demo')

const BY = createIssueReference(HOME, 5)

const SECTION = '## Waits for merge\n\n- #5: main の版が要る\n'

describe('decideBlock', () => {
  const base = { home: HOME, by: BY, reason: undefined, isLinked: false }

  it('stack で新しく前提を付ける場合は、本文を変えずに add を返す', async () => {
    await explains('前提を付ける変更を決める関数（`decideBlock`）のテストです。前提がまだ付いていない Issue に、`stack` で付ける場合に、本文を変えず `add` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
    })
  })

  it('merge で新しく前提を付ける場合は、節に行を追加した本文で add を返す', async () => {
    await explains('前提がまだ付いていない Issue に、`merge` で理由を添えて付ける場合のテストです。本文に `Waits for merge` の節を作成して、前提と理由の行を追加した本文で `add` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'add', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
    })
  })

  it('stack で前提を付ける場合は、節に残った同じ前提の行を取り除く', async () => {
    await explains('`Waits for merge` の節に、同じ前提の行が残っている場合のテストです。`stack` で付けるときは、節からその行を取り除いた本文で `add` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
    })
  })

  it('前提が付いていて、種類と理由が同じ場合は、unchanged を返す', async () => {
    await explains('前提がすでに付いている Issue に、同じ種類と同じ理由で付けようとした場合のテストです。変更は不要なため、`merge` と `stack` のどちらでも `unchanged` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: 'main の版が要る' })).toEqual({ kind: 'unchanged' })
      expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'unchanged' })
    })
  })

  it('前提が付いていて、理由が違う場合は、行の理由だけを書き換えて update を返す', async () => {
    await explains('`merge` の前提がすでに付いている Issue に、別の理由で付けようとした場合のテストです。節の行の理由だけを書き換えた本文で、`update` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '別の理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 別の理由\n' })
    })
  })

  it('前提が付いていて、stack から merge に変える場合は、節に行を追加して update を返す', async () => {
    await explains('`stack` の前提がすでに付いている Issue を、`merge` に変える場合のテストです。節に前提と理由の行を追加した本文で、`update` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
    })
  })

  it('前提が付いていて、merge から stack に変える場合は、節から行を取り除いて update を返す', async () => {
    await explains('`merge` の前提がすでに付いている Issue を、`stack` に変える場合のテストです。節からその行を取り除いた本文で、`update` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'update', body: '本文\n' })
    })
  })

  it('前後の空白だけが違う理由は、同じ理由として扱う', async () => {
    await explains('指定した理由の前後に、空白が含まれる場合のテストです。空白を取り除いて比較し、同じ理由とみなして `unchanged` を返すことを確認します。')
    stepSync('`decideBlock` を呼び、結果を比べる', () => {
      expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '  main の版が要る ' })).toEqual({ kind: 'unchanged' })
    })
  })

  it('節を解釈できない場合は、理由を添えて malformed を返す', async () => {
    await explains('`Waits for merge` の節に、リストの形ではない文章が含まれる場合のテストです。節を解釈できないため、理由（`not a list item`）を添えて `malformed` を返すことを確認します。')
    const result = stepSync('`decideBlock` を呼ぶ', () => decideBlock({ ...base, body: '## Waits for merge\n\nplain text\n', wait: 'stack' }))

    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'malformed', reason: 'not a list item: plain text' })
    })
  })
})

describe('decideUnblock', () => {
  const base = { home: HOME, by: BY, isLinked: true }

  it('前提が付いていない場合は、unchanged を返し、節の古い行は書き換えない', async () => {
    await explains('前提を外す変更を決める関数（`decideUnblock`）のテストです。前提が付いていない Issue では、節に古い行が残っていても、本文は書き換えず `unchanged` を返すことを確認します。')
    stepSync('`decideUnblock` を呼び、結果を比べる', () => {
      expect(decideUnblock({ ...base, isLinked: false, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'unchanged' })
    })
  })

  it('前提が付いていて、節に行がある場合は、行を取り除いた本文で remove を返す', async () => {
    await explains('前提が付いていて、`Waits for merge` の節にその行がある場合のテストです。節からその行を取り除いた本文で、`remove` を返すことを確認します。')
    stepSync('`decideUnblock` を呼び、結果を比べる', () => {
      expect(decideUnblock({ ...base, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
    })
  })

  it('前提が付いていて、節に行が存在しない場合は、本文を変えずに remove を返す', async () => {
    await explains('前提が付いていて、`Waits for merge` の節が存在しない場合のテストです。取り除く行がないため、本文は変えず `remove` を返すことを確認します。')
    stepSync('`decideUnblock` を呼び、結果を比べる', () => {
      expect(decideUnblock({ ...base, body: '本文\n' })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
    })
  })

  it('節を解釈できなくても remove を返し、本文は変えずに理由を添える', async () => {
    await explains('前提が付いていて、`Waits for merge` の節を解釈できない場合のテストです。本文は変えず、解釈できなかった理由を添えて `remove` を返すことを確認します。')
    const body = stepSync('入力を用意する', () => '## Waits for merge\n\nplain text\n')

    stepSync('結果を比べる', () => {
      expect(decideUnblock({ ...base, body })).toEqual({ kind: 'remove', body, malformedReason: 'not a list item: plain text' })
    })
  })
})
