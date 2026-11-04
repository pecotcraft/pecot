// 共有 runner（createPecotvRunner）が想定外終了時に残す一次情報の契約。
//
// `--json` の失敗理由（`slide.convert.error` 等）は stdout に出ます。
// このとき stderr が空のことがあります（`slide convert <不存在dir> --json` は exit 1・stderr 0 バイト）。stderr tail だけを
// ログへ出していた頃は、push 時の 1 回きりの失敗から原因を読めなかった（#1131）。
// ここでは実 CLI を起動して、想定外終了時に stdout tail が行頭の event / reason を保って出ること、
// 想定どおりの終了では何も足されないことを守る。切り出し関数そのものの契約は
// tests/unit/helpers/pecotv-run-output.test.ts が持つ。
//
// 実 slidev build / Chromium を起こさない軽いケースだけで組むため describe の skip は無い。

import { rmSync } from 'node:fs'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { assertCliBuilt, createPecotvRunner } from '../_helpers/pecotv-e2e-run.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const workDirectory = useTemporaryDirectory('pecotv-runner-log-e2e-', { hook: 'all' })

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (workDirectory() !== '') rmSync(workDirectory(), { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

type ConsoleSpies = Readonly<Record<'error' | 'info' | 'log' | 'warn', MockInstance<(...data: readonly unknown[]) => void>>>

function silenceConsole(): ConsoleSpies {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => { /* noop */ }),
    info: vi.spyOn(console, 'info').mockImplementation(() => { /* noop */ }),
    log: vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ }),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ }),
  }
}

/**
spy が受け取った引数のうち文字列だけを、呼び出し・引数の区別なく平らに並べる。
*/
function stringArgumentsOf(calls: readonly (readonly unknown[])[]): readonly string[] {
  return calls.flat().filter((argument): argument is string => typeof argument === 'string')
}

function convertMissingProjectArguments(): readonly string[] {
  return [
    'slide',
    'convert',
    workDirectory('missing-project'),
    '--out',
    workDirectory('out.pptx'),
    '--json',
  ]
}

describe('createPecotvRunner の想定外終了ログ', () => {
  it('想定外の exit 1 では stdout tail に --json の失敗理由が行頭の event / reason の順で載る', () => {
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status !== 0 })

    const result = runPecotv('convert-missing', convertMissingProjectArguments())

    expect(result.status).toBe(1)
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('stdout tail:'))
    // 切り出しは行頭を残す設計で、実 CLI のキーが event → reason → detail の順に並ぶことを前提とする。
    expect(spies.error).toHaveBeenCalledWith(
      expect.stringContaining('{"event":"slide.convert.error","reason":"project-not-found"'),
    )
  })

  it('exit 0 では console.error を呼ばず、どの console 出力にも stdout を載せない', () => {
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status !== 0 })

    const result = runPecotv('version', ['--version'])

    expect(result.status).toBe(0)
    const version = result.stdout.trim()
    expect(version).not.toBe('')
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.info).toHaveBeenCalledTimes(1)
    for (const [method, spy] of Object.entries(spies)) {
      const leaked = stringArgumentsOf(spy.mock.calls).filter(argument => argument.includes(version))
      expect(leaked, `console.${method}`).toStrictEqual([])
    }
  })

  it('exit 1 を期待する判定では console.error を呼ばない', () => {
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status === null })

    const result = runPecotv('convert-missing', convertMissingProjectArguments())

    expect(result.status).toBe(1)
    expect(spies.error).not.toHaveBeenCalled()
  })
})
