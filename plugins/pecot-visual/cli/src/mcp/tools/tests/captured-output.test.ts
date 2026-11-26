import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolResult } from '../../result.js'
import { createWarningCollector, warningsOf } from '../../warnings.js'
import { captureCommandOutput, withCapturedOutput, withSpawnOutput, type CommandOutput } from '../_shared.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('warning の行だけを、接頭辞を外した文の配列にする', async () => {
    await explains('標準出力や標準エラー出力から警告を取り出す `warningsOf` のテストです。`warning:` で始まる行だけが取り出され、接頭辞を除いた文の配列になることを確認します。')
    expect(warningsOf('note: started\nwarning: icon not found\nerror: other\nwarning: font missing\n'))
      .toEqual(['icon not found', 'font missing'])
  })

  it('続きの行（先頭に空白が 2 つある行）は、同じ警告の文に含める', async () => {
    await explains('`warning:` の次の行が、空白 2 つで始まる場合の `warningsOf` のテストです。その行が前の警告の続きとして、改行でつながった 1 つの文になることを確認します。')
    expect(warningsOf('warning: first line\n  second line\nnote: next\n')).toEqual(['first line\nsecond line'])
  })

  it('warning の行が存在しない場合は、空の配列を返す', async () => {
    await explains('`warningsOf` に空の文字列を渡した場合のテストです。警告がないため、空の配列を返すことを確認します。')
    expect(warningsOf('')).toEqual([])
  })

  it('接頭辞だけの warning の行は、空の文として取り除く', async () => {
    await explains('`warning:` だけの行を含む入力を、`warningsOf` に渡した場合のテストです。空の警告は取り除かれ、内容のある警告だけが残ることを確認します。')
    expect(warningsOf('warning: \nwarning: real one\n')).toEqual(['real one'])
  })

  it('同じ文の warning は、1 つにまとめる', async () => {
    await explains('同じ内容の `warning:` の行が 2 回ある入力を、`warningsOf` に渡した場合のテストです。重複が取り除かれ、1 つの文だけになることを確認します。')
    expect(warningsOf('warning: same\nnote: x\nwarning: same\n')).toEqual(['same'])
  })
})

describe('createWarningCollector', () => {
  it('件数の上限を超えた場合は、100 件を保ち、省いた件数を最後の 1 文で知らせる', async () => {
    await explains('警告を集める `createWarningCollector` のテストです。105 件を追加した場合に、先頭の 100 件が保たれ、101 件目に「5 件を省いた」ことを示す文が追加されることを確認します。')
    const collector = createWarningCollector()
    for (let index = 0; index < 105; index += 1) collector.addLine(`warning: w${String(index)}`)

    const warnings = collector.list()

    expect(warnings).toHaveLength(101)
    expect(warnings[99]).toBe('w99')
    expect(warnings[100]).toMatch(/^5 more warnings were omitted/v)
  })

  it('文の合計が 64KB を超えた場合は、超えた warning を省き、省いたことを知らせる', async () => {
    await explains('`createWarningCollector` に、上限に近い大きさの警告と、小さな警告を 2 件追加した場合のテストです。上限を超えた分は省かれ、省いた件数を示す文が最後に追加されることを確認します。')
    const collector = createWarningCollector()
    collector.addLine(`warning: ${'a'.repeat(LIMIT_BYTES - 1)}`)
    collector.addLine('warning: b')
    collector.addLine('warning: c')

    expect(collector.list()).toEqual(['a'.repeat(LIMIT_BYTES - 1), 'b', expect.stringMatching(/^1 more warnings/v)])
  })

  it('list に渡した最後の行は、状態として保持しない', async () => {
    await explains('`createWarningCollector` の `list` に、最後の行（改行で終わらない行）を渡した場合のテストです。その行が警告として返されても、次に `list` を呼び出した場合には含まれないことを確認します。')
    const collector = createWarningCollector()

    expect(collector.list('warning: pending')).toEqual(['pending'])
    expect(collector.list()).toEqual([])
  })
})

describe('withCapturedOutput', () => {
  it('成功のときは、warning の行を warnings に入れ、log は追加しない', async () => {
    await explains('出力を結果に反映する `withCapturedOutput` の、成功時のテストです。標準エラー出力の警告が `warnings` に入り、`log` が追加されないことを確認します。')
    const result = withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'warning: icon not found\n' })

    expect(result.data).toEqual({ event: 'done', warnings: ['icon not found'] })
  })

  it('成功のときに warning の行がない場合は、ツールの項目を変更しない', async () => {
    await explains('警告を含まない出力を、`withCapturedOutput` に渡した場合のテストです。成功の結果のツールの項目が、そのまま変更されないことを確認します。')
    expect(withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'note: x\n' }).data).toEqual({ event: 'done' })
  })

  it('ツールの項目に warnings がある場合は、捕捉した warning をその後ろに追加し、同じ文は 1 つにまとめる', async () => {
    await explains('ツールの項目にすでに `warnings` があり、出力にも警告が含まれる場合のテストです。ツールの項目の警告の後ろに出力の警告が追加され、重複する文は 1 つになることを確認します。')
    const result = withCapturedOutput(
      { ...SUCCEEDED, data: { warnings: ['from data', 'shared'] } },
      { stdout: '', stderr: 'warning: shared\nwarning: from stderr\n' },
    )

    expect(result.data.warnings).toEqual(['from data', 'shared', 'from stderr'])
  })

  it('ツールの項目にある空の warnings は、空のまま残す', async () => {
    await explains('ツールの項目に空の `warnings` があり、出力が空である場合のテストです。`warnings` が空の配列のまま残ることを確認します。')
    expect(withCapturedOutput({ ...SUCCEEDED, data: { warnings: [] } }, { stdout: '', stderr: '' }).data).toEqual({ warnings: [] })
  })

  it('失敗のときは、標準出力と標準エラー出力をつないで log に入れ、ツールの項目は残す', async () => {
    await explains('`withCapturedOutput` の、失敗時のテストです。標準出力と標準エラー出力が改行でつながって `log` に入り、元のツールの項目も残ることを確認します。')
    const result = withCapturedOutput(FAILED, { stdout: 'out line', stderr: 'error: boom\n' })

    expect(result.data).toEqual({
      event: 'export.error',
      log: 'out line\nerror: boom\n',
    })
  })

  it('失敗のときに出力が空の場合は、log を追加しない', async () => {
    await explains('出力が空の状態で、失敗の結果を `withCapturedOutput` に渡した場合のテストです。結果に `log` が追加されないことを確認します。')
    expect(withCapturedOutput(FAILED, { stdout: '', stderr: '' }).data).not.toHaveProperty('log')
  })

  it('log は 64KB を超えた場合に、先頭を捨てて、切り詰めたことを冒頭に書く', async () => {
    await explains('出力が 64KB を超える失敗の結果を、`withCapturedOutput` に渡した場合のテストです。`log` の冒頭に切り詰めを示す表示が付き、末尾の内容（`END`）が残ることを確認します。')
    const log = String(withCapturedOutput(FAILED, { stdout: 'x'.repeat(64 * 1024), stderr: 'END' }).data['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.endsWith('END')).toBe(true)
  })

  it('log がちょうど 64KB の場合は、切り詰めない', async () => {
    await explains('`log` の大きさが、ちょうど 64KB になる出力を渡した場合のテストです。切り詰められず、標準出力と標準エラー出力がそのままつながって `log` に入ることを確認します。')
    const stdout = 'x'.repeat(LIMIT_BYTES - 4)

    expect(withCapturedOutput(FAILED, { stdout, stderr: 'END' }).data['log']).toBe(`${stdout}\nEND`)
  })

  it('マルチバイトの文字が上限の境界にかかる場合は、その 1 文字だけを U+FFFD にして、後ろの内容は保つ', async () => {
    await explains('3 バイトの文字を上限を超えるまで並べた出力を、`withCapturedOutput` に渡した場合のテストです。境界にかかった先頭の 1 文字だけが `U+FFFD` になり、後ろの文字は破損せずに残ることを確認します。')
    // 3 バイトの文字を 21846 個 (65538 バイト) にし、先頭の 2 バイトを落とさせる
    const log = String(withCapturedOutput(FAILED, { stdout: '', stderr: 'あ'.repeat(21_846) }).data['log'])

    expect(log.split('\n', 2)[1]).toBe(`\u{FFFD}${'あ'.repeat(21_845)}`)
  })

  it('失敗のときも、標準エラー出力の warning を warnings に入れる', async () => {
    await explains('警告とエラーを含む標準エラー出力を、失敗の結果と一緒に `withCapturedOutput` へ渡した場合のテストです。警告が `warnings` に入り、出力全体が `log` に入ることを確認します。')
    const result = withCapturedOutput(FAILED, { stdout: '', stderr: 'warning: font missing\nerror: boom\n' })

    expect(result.data['warnings']).toEqual(['font missing'])
    expect(result.data['log']).toBe('warning: font missing\nerror: boom\n')
  })

  it('warnings を渡した場合は、標準エラー出力から取り直さずに、渡した値を使う', async () => {
    await explains('`warnings` を一緒に渡した場合の、`withCapturedOutput` のテストです。標準エラー出力の警告ではなく、渡した `warnings` が結果に入ることを確認します。')
    const result = withCapturedOutput(SUCCEEDED, { stdout: '', stderr: 'warning: truncated away\n', warnings: ['kept early'] })

    expect(result.data['warnings']).toEqual(['kept early'])
  })
})

describe('captureCommandOutput', () => {
  it('finish は捕捉した出力を最上位の項目へ移し、stdout と stderr を足さない', async () => {
    await explains('出力を捕捉する `captureCommandOutput` の `finish` のテストです。捕捉した警告が `structuredContent` の最上位の `warnings` に移り、`stdout` と `stderr` の項目が追加されないことを確認します。')
    const output = captureCommandOutput()
    output.stdout.write('result line\n')
    output.stderr.write('warning: careful\n')
    await new Promise<void>((resolve) => {
      output.stderr.end(resolve)
    })

    const result = output.finish(SUCCEEDED)

    expect(result.structuredContent).toStrictEqual({ event: 'done', warnings: ['careful'] })
  })

  it('出力が上限を超えても、先に出力された warning は warnings に残す', async () => {
    await explains('警告の後に、上限を超える出力を書き込み、その後にも警告を書き込んだ場合のテストです。上限を超えて `log` から消えた先頭の警告も、`warnings` に残ることを確認します。')
    const output = captureCommandOutput()
    output.stderr.write('warning: early one\n  continued\n')
    output.stderr.write(`${'x'.repeat(LIMIT_BYTES * 2)}\n`)
    output.stderr.write('warning: late one\n')
    await finished(output)

    const data = dataOf(output.finish(FAILED).structuredContent)

    expect(String(data['log']).includes('early one')).toBe(false)
    expect(data['warnings']).toEqual(['early one\ncontinued', 'late one'])
  })

  it('書き込みの途中で区切られた warning の行と、改行で終わらない最後の行も、警告として取り出す', async () => {
    await explains('警告の行を複数回に分けて書き込み、最後の行を改行なしで書き込んだ場合のテストです。分割された行がつながった 1 つの警告になり、最後の行も警告として取り出されることを確認します。')
    const output = captureCommandOutput()
    output.stderr.write('warn')
    output.stderr.write('ing: 分割')
    output.stderr.write(Buffer.from('された行\nwarning: 最後', 'utf8'))
    await finished(output)

    expect(output.warnings()).toEqual(['分割された行', '最後'])
  })

  it('メッセージに使う warnings の件数は、warnings の長さと同じになる', async () => {
    await explains('同じ内容を含む警告を書き込んだ場合のテストです。重複を除いた件数（2 件）が、結果の `warnings` の長さと一致することを確認します。')
    const output = captureCommandOutput()
    output.stderr.write('warning: a\nwarning: b\nwarning: a\n')
    await finished(output)

    const count = output.warnings().length

    expect(count).toBe(2)
    expect(dataOf(output.finish(SUCCEEDED).structuredContent)['warnings']).toHaveLength(count)
  })

  it('標準出力と標準エラー出力がどちらも上限を超えても、log の切り詰めの表示は冒頭の 1 つだけにする', async () => {
    await explains('標準出力と標準エラー出力の両方に、上限を超える出力を書き込んだ場合のテストです。`log` の冒頭に切り詰めの表示が 1 つだけ付き、末尾が標準エラー出力の内容になることを確認します。')
    const output = captureCommandOutput()
    output.stdout.write('o'.repeat(LIMIT_BYTES + 10))
    output.stderr.write('e'.repeat(LIMIT_BYTES + 10))
    await finished(output)

    const log = String(dataOf(output.finish(FAILED).structuredContent)['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.split(MARKER_HEAD)).toHaveLength(2)
    expect(log.endsWith('e')).toBe(true)
  })

  it('片方だけが上限を超えた場合は、つないだ結果が上限内でも、切り詰めの表示を冒頭に残す', async () => {
    await explains('標準エラー出力だけが上限を超える出力を書き込んだ場合のテストです。つないだ後の `log` が上限に収まる場合でも、冒頭に切り詰めの表示が 1 つ付くことを確認します。')
    const output = captureCommandOutput()
    output.stderr.write('e'.repeat(LIMIT_BYTES + 10))
    await finished(output)

    const log = String(dataOf(output.finish(FAILED).structuredContent)['log'])

    expect(log.startsWith(MARKER_HEAD)).toBe(true)
    expect(log.split(MARKER_HEAD)).toHaveLength(2)
  })
})

describe('withSpawnOutput', () => {
  it('失敗のときは、子プロセスの出力を log に入れる', async () => {
    await explains('子プロセスの結果を反映する `withSpawnOutput` の、失敗時のテストです。子プロセスの標準出力と標準エラー出力が、改行でつながって `log` に入ることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(FAILED, { exitCode: 1, signal: null, stdout: 'pw-out', stderr: 'ECONNREFUSED', timedOut: false })

    expect(result.data['log']).toBe('pw-out\nECONNREFUSED')
  })

  it('成功のときは、log を追加せず、warning だけを warnings に入れる', async () => {
    await explains('`withSpawnOutput` の、成功時のテストです。`log` を追加せず、標準エラー出力の警告だけが `warnings` に入ることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(SUCCEEDED, { exitCode: 0, signal: null, stdout: 'done', stderr: 'warning: deprecated\n', timedOut: false })

    expect(result.data).toEqual({ event: 'done', warnings: ['deprecated'] })
  })

  it('標準エラー出力が上限を超えても、先に出力された warning は warnings に残す', async () => {
    await explains('標準エラー出力が上限を超える、失敗した子プロセスの結果を、`withSpawnOutput` に渡した場合のテストです。先頭の警告が `warnings` に残り、`log` の冒頭に切り詰めの表示が付くことを確認します。')
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
