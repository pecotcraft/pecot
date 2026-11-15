import { describe, expect, it } from 'vitest'

import type { ToolResult } from '../../result.js'
import { captureCommandOutput, warningsOf, withCapturedOutput, withSpawnOutput } from '../_shared.js'

const SUCCEEDED: ToolResult = { ok: true, exitCode: 0, artifacts: [], data: { event: 'done' }, message: 'done' }

const FAILED: ToolResult = {
  ok: false,
  exitCode: 1,
  kind: 'export-failed',
  artifacts: [],
  data: { reason: 'export-failed', detail: 'export failed: the whole text' },
  message: 'export failed',
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
})

describe('withCapturedOutput', () => {
  it('成功のときは、warning の行を data.warnings に入れ、data.log を足さない', () => {
    const result = withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'warning: icon not found\n' })

    expect(result.data).toEqual({ event: 'done', warnings: ['icon not found'] })
  })

  it('成功で warning の行が無ければ、data を変えない', () => {
    expect(withCapturedOutput(SUCCEEDED, { stdout: 'progress\n', stderr: 'note: x\n' }).data).toEqual({ event: 'done' })
  })

  it('data に文の warnings があれば、捕捉した warning を後ろに重ね、同じ文は 1 つにする', () => {
    const result = withCapturedOutput(
      { ...SUCCEEDED, data: { warnings: ['from data', 'shared'] } },
      { stdout: '', stderr: 'warning: shared\nwarning: from stderr\n' },
    )

    expect(result.data['warnings']).toEqual(['from data', 'shared', 'from stderr'])
  })

  it('data にある空の warnings は空のまま残す', () => {
    expect(withCapturedOutput({ ...SUCCEEDED, data: { warnings: [] } }, { stdout: '', stderr: '' }).data).toEqual({ warnings: [] })
  })

  it('失敗のときは、stdout と stderr をつないで data.log に入れ、reason と detail を残す', () => {
    const result = withCapturedOutput(FAILED, { stdout: 'out line', stderr: 'error: boom\n' })

    expect(result.data).toEqual({
      reason: 'export-failed',
      detail: 'export failed: the whole text',
      log: 'out line\nerror: boom\n',
    })
  })

  it('失敗で出力が空なら data.log を足さない', () => {
    expect(withCapturedOutput(FAILED, { stdout: '', stderr: '' }).data).not.toHaveProperty('log')
  })

  it('data.log は 64KB を超えると先頭を捨て、切り詰めたことを冒頭に書く', () => {
    const log = String(withCapturedOutput(FAILED, { stdout: 'x'.repeat(64 * 1024), stderr: 'END' }).data['log'])

    expect(log.startsWith('[pecotv] output exceeded')).toBe(true)
    expect(log.endsWith('END')).toBe(true)
  })
})

describe('captureCommandOutput', () => {
  it('finish は捕捉した出力を data へ移し、最上位に stdout と stderr を足さない', async () => {
    const output = captureCommandOutput()
    output.stdout.write('result line\n')
    output.stderr.write('warning: careful\n')
    await new Promise<void>((resolve) => {
      output.stderr.end(resolve)
    })

    const result = output.finish(SUCCEEDED)

    expect(result.structuredContent).toEqual({ ...SUCCEEDED, data: { event: 'done', warnings: ['careful'] } })
  })
})

describe('withSpawnOutput', () => {
  it('失敗のときは、子プロセスの出力を data.log に入れる', () => {
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal を null で表す
    const result = withSpawnOutput(FAILED, { exitCode: 1, signal: null, stdout: 'pw-out', stderr: 'ECONNREFUSED', timedOut: false })

    expect(result.data['log']).toBe('pw-out\nECONNREFUSED')
  })
})
