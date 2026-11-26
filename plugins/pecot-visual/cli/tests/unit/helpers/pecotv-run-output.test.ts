// e2e の共有 runner（tests/_helpers/pecotv-e2e-run.ts）が想定外終了時にログへ足す tail の契約。
//
// 子プロセスを起動しない純関数なので、e2e lane ではなく unit で常に評価する。
// 実 CLI を起動して runner のログ出力を見るのは tests/e2e/runner-unexpected-exit-log.test.ts。

import { describe, expect, it } from 'vitest'

import { OUTPUT_TAIL_LIMIT, formatOutputTails, stdoutTail } from '../../_helpers/pecotv-e2e-run.js'
import { explains } from '../../_helpers/explains.js'

describe('stdoutTail', () => {
  it('標準出力が長さの上限に収まる場合は、省略の印を付けず、末尾の改行だけ取り除いて返す', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。2 行の JSON が上限以内の場合は、末尾の改行を除いて、内容をそのまま返すことを確認します。')
    const startLine = JSON.stringify({ event: 'slide.convert.start' })
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    expect(stdoutTail(`${startLine}\n${errorLine}\n`)).toBe(`${startLine}\n${errorLine}`)
  })

  it('標準出力の長さがちょうど上限と同じ場合も、省略の印を付けない', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。内容の長さが `OUTPUT_TAIL_LIMIT` とちょうど同じ場合に、省略の印を付けず、末尾の改行だけ取り除いて返すことを確認します。')
    const firstLine = 'a'.repeat(OUTPUT_TAIL_LIMIT / 2)
    const lastLine = 'b'.repeat(OUTPUT_TAIL_LIMIT / 2 - 1)

    expect(stdoutTail(`${firstLine}\n${lastLine}\n`)).toBe(`${firstLine}\n${lastLine}`)
  })

  it('最後の 1 行だけで上限を超える場合は、行の先頭を残して切り詰め、次の行に省略した文字数を表示する', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。長さが上限の 2 倍を超える 1 行を渡した場合に、先頭の `event` と `reason` を残して上限の長さに切り詰めることを確認します。')
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

  it('複数行で上限を超える場合は、古い行をまとめて除き、先頭に除いた行数を表示する', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。4 行の合計が上限を超える場合に、古い 2 行を除いて新しい 2 行だけを残し、先頭に `(省略: 古い 2 行)` を表示し、残した行の長さが上限以下になることを確認します。')
    const startLine = JSON.stringify({ event: 'slide.convert.start', padding: 'p'.repeat(OUTPUT_TAIL_LIMIT) })
    const progressLine = JSON.stringify({ event: 'slide.convert.progress', padding: 'q'.repeat(OUTPUT_TAIL_LIMIT / 2) })
    const middleLine = JSON.stringify({ event: 'slide.convert.progress', padding: 'r'.repeat(OUTPUT_TAIL_LIMIT / 2) })
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    const tail = stdoutTail(`${startLine}\n${progressLine}\n${middleLine}\n${errorLine}\n`)

    // progressLine は middleLine / errorLine と合わせると枠を超えるため、それより古い startLine ごと落ちる。
    expect(tail).toBe(`(省略: 古い 2 行)\n${middleLine}\n${errorLine}`)
    expect(tail.slice(tail.indexOf('\n') + 1).length).toBeLessThanOrEqual(OUTPUT_TAIL_LIMIT)
  })

  it('古い行があり、最後の行も上限を超える場合は、先頭と末尾の両方に省略の印を付ける', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。短い 1 行の後に、上限を超える長い行がある場合に、先頭に古い行の省略、最後の行の後に切り詰めた文字数の省略を表示することを確認します。')
    const startLine = JSON.stringify({ event: 'slide.convert.start' })
    const longLine = JSON.stringify({ event: 'slide.convert.error', detail: 'x'.repeat(OUTPUT_TAIL_LIMIT) })

    const tail = stdoutTail(`${startLine}\n${longLine}\n`)

    expect(tail).toBe(
      `(省略: 古い 1 行)\n${longLine.slice(0, OUTPUT_TAIL_LIMIT)}\n`
      + `(省略: 上の行の末尾 ${String(longLine.length - OUTPUT_TAIL_LIMIT)} 文字)`,
    )
  })

  it('空文字列を渡した場合は、空文字列を返す', async () => {
    await explains('e2e の実行ログの、標準出力の末尾を作る `stdoutTail` のテストです。空文字列を渡した場合に、省略の印も付けず、空文字列を返すことを確認します。')
    expect(stdoutTail('')).toBe('')
  })
})

describe('formatOutputTails', () => {
  it('標準出力の節の後ろに、標準エラーの節を並べて返す', async () => {
    await explains('想定外の終了のログに載せる文字列を作る `formatOutputTails` のテストです。`stdout tail:` の節に標準出力、続けて `stderr tail:` の節に標準エラーを並べた文字列を返すことを確認します。')
    const errorLine = JSON.stringify({ event: 'slide.convert.error', reason: 'project-not-found' })

    expect(formatOutputTails(`${errorLine}\n`, 'warn: something\n')).toBe(
      `stdout tail:\n${errorLine}\nstderr tail:\nwarn: something\n`,
    )
  })

  it('標準出力の節には、stdoutTail で切り詰めた内容を使う', async () => {
    await explains('想定外の終了のログに載せる文字列を作る `formatOutputTails` のテストです。上限を超える標準出力を渡した場合に、`stdoutTail` で切り詰めた内容が `stdout tail:` の節に入ることを確認します。')
    const longLine = JSON.stringify({ event: 'slide.convert.error', detail: 'x'.repeat(OUTPUT_TAIL_LIMIT) })

    expect(formatOutputTails(longLine, '')).toBe(`stdout tail:\n${stdoutTail(longLine)}\nstderr tail:\n`)
  })

  it('標準エラーが上限を超える場合は、末尾の OUTPUT_TAIL_LIMIT 文字だけを使う', async () => {
    await explains('想定外の終了のログに載せる文字列を作る `formatOutputTails` のテストです。標準エラーが上限を超える場合に、先頭を除いた末尾の `OUTPUT_TAIL_LIMIT` 文字だけが `stderr tail:` の節に入ることを確認します。')
    const stderr = `head\n${'e'.repeat(OUTPUT_TAIL_LIMIT)}`

    expect(formatOutputTails('', stderr)).toBe(`stdout tail:\n\nstderr tail:\n${'e'.repeat(OUTPUT_TAIL_LIMIT)}`)
  })
})
