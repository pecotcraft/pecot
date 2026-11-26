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
import { explains } from '../_helpers/explains.js'

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
  it('想定外の終了コード 1 では、標準出力の末尾にツールの失敗の理由を `event`・`kind` の順で載せる', async () => {
    await explains('`createPecotvRunner` の想定外の終了のログのテストです。終了コード 1 が想定外の場合に、`console.error` の出力が、失敗の結果の `event` と `kind` を含むことを確認します。')
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status !== 0 })

    const result = runPecotv('convert-missing', convertMissingProjectArguments())

    expect(result.status).toBe(1)
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('stdout tail:'))
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('"event":"slide.convert.error"'))
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining('"kind":"project-not-found"'))
  })

  it('終了コード 0 では `console.error` を呼ばず、どのコンソール出力にも標準出力の内容を載せない', async () => {
    await explains('`createPecotvRunner` の正常な終了のログのテストです。終了コード 0 の場合に、`console.error` を呼ばず、どのコンソール出力にも標準出力の版の番号が含まれないことを確認します。')
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

  it('終了コード 1 を想定どおりとする判定では、`console.error` を呼ばない', async () => {
    await explains('`createPecotvRunner` の判定の指定のテストです。終了コード 1 を想定外としない判定の場合に、終了コード 1 で終わっても、`console.error` を呼ばないことを確認します。')
    const spies = silenceConsole()
    const runPecotv = createPecotvRunner({ logPrefix: 'runner-log', isUnexpectedExit: status => status === null })

    const result = runPecotv('convert-missing', convertMissingProjectArguments())

    expect(result.status).toBe(1)
    expect(spies.error).not.toHaveBeenCalled()
  })
})
