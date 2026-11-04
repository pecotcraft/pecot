// e2e の共有 runner（tests/_helpers/pecotv-e2e-run.ts）が想定外終了時にログへ足す tail の契約。
//
// 子プロセスを起動しない純関数なので、e2e lane ではなく unit で常に評価する。
// 実 CLI を起動して runner のログ出力を見るのは tests/e2e/runner-unexpected-exit-log.test.ts。

import { describe, expect, it } from 'vitest'

import { OUTPUT_TAIL_LIMIT, formatOutputTails, stdoutTail } from '../../_helpers/pecotv-e2e-run.js'

describe('stdoutTail', () => {
  it('枠に収まる stdout は印を付けず、末尾の改行だけ除いてそのまま返す', () => {
    const startLine = JSON.stringify({ event: 'slide.convert.start' })
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    expect(stdoutTail(`${startLine}\n${errorLine}\n`)).toBe(`${startLine}\n${errorLine}`)
  })

  it('内容がちょうど枠に達しても印を付けない', () => {
    const firstLine = 'a'.repeat(OUTPUT_TAIL_LIMIT / 2)
    const lastLine = 'b'.repeat(OUTPUT_TAIL_LIMIT / 2 - 1)

    expect(stdoutTail(`${firstLine}\n${lastLine}\n`)).toBe(`${firstLine}\n${lastLine}`)
  })

  it('枠を 1 行で超える末尾の行は行頭の event / reason を残して切り詰め、次の行に切り詰めた文字数の印を付ける', () => {
    const longLine = JSON.stringify({
      event: 'slide.convert.error',
      reason: 'build-failed',
      detail: 'x'.repeat(OUTPUT_TAIL_LIMIT * 2),
    })

    const tail = stdoutTail(`${longLine}\n`)

    const [content, marker, ...rest] = tail.split('\n')
    // 印は枠に数えないため、内容は枠いっぱいまで残る。
    expect(content).toHaveLength(OUTPUT_TAIL_LIMIT)
    expect(content?.startsWith('{"event":"slide.convert.error","reason":"build-failed"')).toBe(true)
    expect(marker).toBe(`(省略: 上の行の末尾 ${String(longLine.length - OUTPUT_TAIL_LIMIT)} 文字)`)
    expect(rest).toStrictEqual([])
  })

  it('複数行で枠を超えると古い行を丸ごと落とし、先頭に落とした行数の印を付ける', () => {
    const startLine = JSON.stringify({ event: 'slide.convert.start', padding: 'p'.repeat(OUTPUT_TAIL_LIMIT) })
    const progressLine = JSON.stringify({ event: 'slide.convert.progress', padding: 'q'.repeat(OUTPUT_TAIL_LIMIT / 2) })
    const middleLine = JSON.stringify({ event: 'slide.convert.progress', padding: 'r'.repeat(OUTPUT_TAIL_LIMIT / 2) })
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    const tail = stdoutTail(`${startLine}\n${progressLine}\n${middleLine}\n${errorLine}\n`)

    // progressLine は middleLine / errorLine と合わせると枠を超えるため、それより古い startLine ごと落ちる。
    expect(tail).toBe(`(省略: 古い 2 行)\n${middleLine}\n${errorLine}`)
    expect(tail.slice(tail.indexOf('\n') + 1).length).toBeLessThanOrEqual(OUTPUT_TAIL_LIMIT)
  })

  it('古い行があり末尾の行も枠を超えるときは、先頭と末尾の両方に印を付ける', () => {
    const startLine = JSON.stringify({ event: 'slide.convert.start' })
    const longLine = JSON.stringify({ event: 'slide.convert.error', detail: 'x'.repeat(OUTPUT_TAIL_LIMIT) })

    const tail = stdoutTail(`${startLine}\n${longLine}\n`)

    expect(tail).toBe(
      `(省略: 古い 1 行)\n${longLine.slice(0, OUTPUT_TAIL_LIMIT)}\n`
      + `(省略: 上の行の末尾 ${String(longLine.length - OUTPUT_TAIL_LIMIT)} 文字)`,
    )
  })

  it('空文字列は空文字列を返す', () => {
    expect(stdoutTail('')).toBe('')
  })
})

describe('formatOutputTails', () => {
  it('stdout tail の節、stderr tail の節の順に並べる', () => {
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    expect(formatOutputTails(`${errorLine}\n`, 'warn: something\n')).toBe(
      `stdout tail:\n${errorLine}\nstderr tail:\nwarn: something\n`,
    )
  })

  it('stdout に stdoutTail の切り出しを使う', () => {
    const longLine = JSON.stringify({ event: 'slide.convert.error', detail: 'x'.repeat(OUTPUT_TAIL_LIMIT) })

    expect(formatOutputTails(longLine, '')).toBe(`stdout tail:\n${stdoutTail(longLine)}\nstderr tail:\n`)
  })

  it('枠を超える stderr は末尾 OUTPUT_TAIL_LIMIT 文字を切り出す', () => {
    const stderr = `head\n${'e'.repeat(OUTPUT_TAIL_LIMIT)}`

    expect(formatOutputTails('', stderr)).toBe(`stdout tail:\n\nstderr tail:\n${'e'.repeat(OUTPUT_TAIL_LIMIT)}`)
  })
})
