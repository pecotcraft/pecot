import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolResult } from '../../result.js'
import { createWarningCollector, warningsOf } from '../../warnings.js'
import { captureCommandOutput, withCapturedOutput, withSpawnOutput, type CommandOutput } from '../_shared.js'

const LIMIT_BYTES = 64 * 1024

const MARKER_HEAD = '[pecotv] output exceeded'

const SUCCEEDED: ToolResult = { ok: true, data: { event: 'done' }, message: 'done' }

const FAILED: ToolResult = {
  ok: false,
  kind: 'export-failed',
  detail: 'export failed: the whole text',
  data: { event: 'export.error' },
}

describe('warningsOf', () => {
  it('warning の行だけを、接頭辞を外した文の配列にする', () => {
    expect(warningsOf('note: started\nwarning: icon not found\nerror: other\nwarning: font missing\n'))
      .toEqual(['icon not found', 'font missing'])
  })

  it('続きの行 (先頭に空白 2 つ) を同じ文に含める', () => {
    expect(warningsOf('warning: first line\n  second line\nnote: next\n')).toEqual(['first line\nsecond line'])
  })

  it('warning の行が無ければ空の配列を返す', () => {
    expect(warningsOf('')).toEqual([])
  })

  it('接頭辞だけの warning の行は空の文として捨てる', () => {
    expect(warningsOf('warning: \nwarning: real one\n')).toEqual(['real one'])
  })

  it('同じ文の warning は 1 つにまとめる', () => {
    expect(warningsOf('warning: same\nnote: x\nwarning: same\n')).toEqual(['same'])
  })
})

describe('createWarningCollector', () => {
  it('件数の上限を超えると、100 件を保ち、省いた件数を最後の 1 文で知らせる', () => {
    const collector = createWarningCollector()
    for (let index = 0; index < 105; index += 1) collector.addLine(`warning: w${String(index)}`)

    const warnings = collector.list()

    expect(warnings).toHaveLength(101)
    expect(warnings[99]).toBe('w99')
    expect(warnings[100]).toMatch(/^5 more warnings were omitted/v)
  })

  it('文の合計が 64KB を超えると、超えた warning を省いて知らせる', () => {
    const collector = createWarningCollector()
    collector.addLine(`warning: ${'a'.repeat(LIMIT_BYTES - 1)}`)
    collector.addLine('warning: b')
    collector.addLine('warning: c')

    expect(collector.list()).toEqual(['a'.repeat(LIMIT_BYTES - 1), 'b', expect.stringMatching(/^1 more warnings/v)])
  })

  it('list に渡した最後の行は、状態に残さない', () => {
    const collector = createWarningCollector()

    expect(collector.list('warning: pending')).toEqual(['pending'])
    expect(collector.list()).toEqual([])
  })
})

describe('withCapturedOutput', () => {
  it('成功のときは、warning の行を warnings に入れ、log を足さない', () => {
    const result = withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'warning: icon not found\n' })

    expect(result.data).toEqual({ event: 'done', warnings: ['icon not found'] })
  })

  it('成功で warning の行が無ければ、ツールの項目を変えない', () => {
    expect(withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'note: x\n' }).data).toEqual({ event: 'done' })
  })

  it('ツールの項目に文の warnings があれば、捕捉した warning を後ろに重ね、同じ文は 1 つにする', () => {
    const result = withCapturedOutput(
      { ...SUCCEEDED, data: { warnings: ['from data', 'shared'] } },
      { stdout: '', stderr: 'warning: shared\nwarning: from stderr\n' },
    )

    expect(result.data.warnings).toEqual(['from data', 'shared', 'from stderr'])
  })

  it('ツールの項目にある空の warnings は空のまま残す', () => {
    expect(withCapturedOutput({ ...SUCCEEDED, data: { warnings: [] } }, { stdout: '', stderr: '' }).data).toEqual({ warnings: [] })
  })

  it('失敗のときは、stdout と stderr をつないで log に入れ、ツールの項目を残す', () => {
    const result = withCapturedOutput(FAILED, { stdout: 'out line', stderr: 'error: boom\n' })

    expect(result.data).toEqual({
      event: 'export.error',
      log: 'out line\nerror: boom\n',
    })
  })

  it('失敗で出力が空なら log を足さない', () => {
    expect(withCapturedOutput(FAILED, { stdout: '', stderr: '' }).data).not.toHaveProperty('log')
  })

  it('log は 64KB を超えると先頭を捨て、切り詰めたことを冒頭に書く', () => {
    const log = String(withCapturedOutput(FAILED, { stdout: 'x'.repeat(64 * 1024), stderr: 'END' }).data['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.endsWith('END')).toBe(true)
  })

  it('log がちょうど 64KB なら切り詰めない', () => {
    const stdout = 'x'.repeat(LIMIT_BYTES - 4)

    expect(withCapturedOutput(FAILED, { stdout, stderr: 'END' }).data['log']).toBe(`${stdout}\nEND`)
  })

  it('マルチバイトの文字が上限の境界にかかると、その 1 文字だけを U+FFFD にして後ろを保つ', () => {
    // 3 バイトの文字を 21846 個 (65538 バイト) にし、先頭の 2 バイトを落とさせる
    const log = String(withCapturedOutput(FAILED, { stdout: '', stderr: 'あ'.repeat(21_846) }).data['log'])

    expect(log.split('\n', 2)[1]).toBe(`\u{FFFD}${'あ'.repeat(21_845)}`)
  })

  it('失敗のときも、stderr の warning を warnings に入れる', () => {
    const result = withCapturedOutput(FAILED, { stdout: '', stderr: 'warning: font missing\nerror: boom\n' })

    expect(result.data['warnings']).toEqual(['font missing'])
    expect(result.data['log']).toBe('warning: font missing\nerror: boom\n')
  })

  it('渡した warnings があれば、stderr から取り直さずにそれを使う', () => {
    const result = withCapturedOutput(SUCCEEDED, { stdout: '', stderr: 'warning: truncated away\n', warnings: ['kept early'] })

    expect(result.data['warnings']).toEqual(['kept early'])
  })
})

describe('captureCommandOutput', () => {
  it('finish は捕捉した出力を最上位の項目へ移し、stdout と stderr を足さない', async () => {
    const output = captureCommandOutput()
    output.stdout.write('result line\n')
    output.stderr.write('warning: careful\n')
    await new Promise<void>((resolve) => {
      output.stderr.end(resolve)
    })

    const result = output.finish(SUCCEEDED)

    expect(result.structuredContent).toStrictEqual({ event: 'done', warnings: ['careful'] })
  })

  it('出力が上限を超えても、早く出た warning を warnings に残す', async () => {
    const output = captureCommandOutput()
    output.stderr.write('warning: early one\n  continued\n')
    output.stderr.write(`${'x'.repeat(LIMIT_BYTES * 2)}\n`)
    output.stderr.write('warning: late one\n')
    await finished(output)

    const data = dataOf(output.finish(FAILED).structuredContent)

    expect(String(data['log']).includes('early one')).toBe(false)
    expect(data['warnings']).toEqual(['early one\ncontinued', 'late one'])
  })

  it('chunk の途中で切れた warning の行と、改行で終わらない最後の行も拾う', async () => {
    const output = captureCommandOutput()
    output.stderr.write('warn')
    output.stderr.write('ing: 分割')
    output.stderr.write(Buffer.from('された行\nwarning: 最後', 'utf8'))
    await finished(output)

    expect(output.warnings()).toEqual(['分割された行', '最後'])
  })

  it('message に使う warnings の件数は、warnings の長さと同じ', async () => {
    const output = captureCommandOutput()
    output.stderr.write('warning: a\nwarning: b\nwarning: a\n')
    await finished(output)

    const count = output.warnings().length

    expect(count).toBe(2)
    expect(dataOf(output.finish(SUCCEEDED).structuredContent)['warnings']).toHaveLength(count)
  })

  it('stdout と stderr がどちらも上限を超えても、log の切り詰めの印は冒頭の 1 つだけ', async () => {
    const output = captureCommandOutput()
    output.stdout.write('o'.repeat(LIMIT_BYTES + 10))
    output.stderr.write('e'.repeat(LIMIT_BYTES + 10))
    await finished(output)

    const log = String(dataOf(output.finish(FAILED).structuredContent)['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.split(MARKER_HEAD)).toHaveLength(2)
    expect(log.endsWith('e')).toBe(true)
  })

  it('片方だけが上限を超え、つないだ後は上限に収まるときも、切り詰めの印を冒頭に残す', async () => {
    const output = captureCommandOutput()
    output.stderr.write('e'.repeat(LIMIT_BYTES + 10))
    await finished(output)

    const log = String(dataOf(output.finish(FAILED).structuredContent)['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.split(MARKER_HEAD)).toHaveLength(2)
  })
})

describe('withSpawnOutput', () => {
  it('失敗のときは、子プロセスの出力を log に入れる', () => {
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(FAILED, { exitCode: 1, signal: null, stdout: 'pw-out', stderr: 'ECONNREFUSED', timedOut: false })

    expect(result.data['log']).toBe('pw-out\nECONNREFUSED')
  })

  it('成功のときは log を足さず、warning だけを warnings に入れる', () => {
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(SUCCEEDED, { exitCode: 0, signal: null, stdout: 'done', stderr: 'warning: deprecated\n', timedOut: false })

    expect(result.data).toEqual({ event: 'done', warnings: ['deprecated'] })
  })

  it('stderr が上限を超えても、早く出た warning を warnings に残す', () => {
    const stderr = `warning: early\n${'x'.repeat(LIMIT_BYTES * 2)}\n`
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(FAILED, { exitCode: 1, signal: null, stdout: '', stderr, timedOut: false })

    expect(result.data['warnings']).toEqual(['early'])
    expect(String(result.data['log']).startsWith(MARKER_HEAD)).toBe(true)
  })
})

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Writable の end を呼ぶ
async function finished(output: CommandOutput): Promise<void> {
  await Promise.all([output.stdout, output.stderr].map(async stream => new Promise<void>((resolve) => {
    stream.end(resolve)
  })))
}

function dataOf(structuredContent: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(structuredContent)
}
