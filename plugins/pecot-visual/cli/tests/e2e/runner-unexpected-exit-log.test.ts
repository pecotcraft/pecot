// 共有 runner（createPecotvRunner）が想定外終了時に残す一次情報の契約。
//
// ツールの失敗理由（`slide.convert.error` 等）は structuredContent として stdout に出ます。
// このとき stderr が空のことがあります（slide_convert に不存在の dir を渡すと exit 1・stderr 0 バイト）。stderr tail だけを
// ログへ出していた頃は、push 時の 1 回きりの失敗から原因を読めなかった（#1131）。
// ここでは実サーバを起動して、想定外終了時に stdout tail が失敗の event と kind を保って出ること、
// 想定どおりの終了では何も足されないことを守る。切り出し関数そのものの契約は
// tests/unit/helpers/pecotv-run-output.test.ts が持つ。
//
// 実 slidev build / Chromium を起こさない軽いケースだけで組むため describe の skip は無い。

import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { assertCliBuilt, createPecotvRunner } from '../_helpers/pecotv-e2e-run.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const MINIMAL_DRAWIO = path.resolve(import.meta.dirname, '..', 'fixtures', 'drawio', 'minimal.drawio')
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
  ]
}

describe('createPecotvRunner の想定外終了ログ', () => {
  it('想定外の exit 1 では stdout tail にツールの失敗理由（event と kind）が載る', () => {
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status !== 0 })

    const result = runPecotv('convert-missing', convertMissingProjectArguments())

    expect(result.status).toBe(1)
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('stdout tail:'))
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('"event":"slide.convert.error"'))
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('"kind":"project-not-found"'))
  })

  it('exit 0 では console.error を呼ばず、どの console 出力にも stdout を載せない', () => {
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status !== 0 })

    const result = runPecotv('drawio-url', ['drawio', 'url', MINIMAL_DRAWIO])

    expect(result.status).toBe(0)
    const marker = 'drawio.url.done'
    expect(result.stdout).toContain(marker)
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.info).toHaveBeenCalledTimes(1)
    for (const [method, spy] of Object.entries(spies)) {
      const leaked = stringArgumentsOf(spy.mock.calls).filter(argument => argument.includes(marker))
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
