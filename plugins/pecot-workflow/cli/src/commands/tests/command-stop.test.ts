// コマンドが error の行を出して止める処理（stopWith と requireActiveConfig）のテスト。
import { describe, expect, it } from 'vitest'

import { setEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { requireActiveConfig, requireActiveConfigPlain, stopWith } from '../command-stop.js'
import { createOutput } from '../output.js'
import { capture } from './support.js'
// 案内の文を描くには、コマンドの形の登録が要る
import '../registry.js'

function started(): { readonly io: ReturnType<typeof capture>, readonly output: ReturnType<typeof createOutput> } {
  const io = capture()
  return { io, output: createOutput(false, io) }
}

describe('stopWith', () => {
  it('error の行を出して、原因の名前と既定の終了コード 1 で止める', () => {
    const { io, output } = started()
    expect(() => stopWith(output, 'boom', 'other')).toThrow(expect.objectContaining({ exitCode: 1, kind: 'other' }))
    expect(io.err).toEqual(['error: boom\n'])
  })

  it('終了コードを渡せる', () => {
    const { io, output } = started()
    expect(() => stopWith(output, 'bad usage', 'invalid-input', 2)).toThrow(expect.objectContaining({ exitCode: 2, kind: 'invalid-input' }))
    expect(io.err).toEqual(['error: bad usage\n'])
  })
})

describe('requireActiveConfig', () => {
  it('アクティブなプロジェクトが無ければ、activate の案内を添えて終了コード 1', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory() })
    const { io, output } = started()
    expect(() => requireActiveConfig(output)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
    expect(io.err).toEqual(['error: no active project\n  run: pecot project activate <PROJECT>\n'])
  })
})

describe('requireActiveConfigPlain', () => {
  it('アクティブなプロジェクトが無ければ、案内を添えずに終了コード 1', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory() })
    const { io, output } = started()
    expect(() => requireActiveConfigPlain(output)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'no-active-project' }))
    expect(io.err).toEqual(['error: no active project\n'])
  })
})
