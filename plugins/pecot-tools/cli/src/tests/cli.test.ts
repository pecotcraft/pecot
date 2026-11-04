import { CommanderError } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { applyExitOverrideRecursively, createProgram, main } from '../cli.js'
import { suggestedNodeVersion } from '../node-runtime.js'
import { readVersion } from '../version.js'

describe('createProgram', () => {
  it('name と version を持つ', () => {
    const program = createProgram()
    expect(program.name()).toBe('pecot-tools')
    expect(program.version()).toBe(readVersion())
  })

  it('mcp サブコマンドを登録する', () => {
    // action 本体（dynamic import して実 stdio へ接続する処理）は tests/e2e/mcp-stdio.test.ts が担保する。
    const program = createProgram()
    const mcp = program.commands.find(command => command.name() === 'mcp')

    expect(mcp).toBeDefined()
    expect(mcp?.description()).toContain('stdio')
  })

  it('applyExitOverrideRecursively が process.exit を例外へ振り替える', () => {
    const program = createProgram()
    applyExitOverrideRecursively(program)
    expect(() => {
      program.parse(['node', 'cli', '--unknown'])
    }).toThrow(CommanderError)
  })

  it('applyExitOverrideRecursively がサブコマンドにも再帰適用される', () => {
    const program = createProgram()
    program.command('child')
    applyExitOverrideRecursively(program)
    expect(() => {
      program.parse(['node', 'cli', 'child', '--unknown'])
    }).toThrow(CommanderError)
  })
})

describe('main', () => {
  // 実行中の Node.js の版に結果を左右させないため、許可される版を明示して渡す。
  const allowedNodeVersion = suggestedNodeVersion()

  it('修正版未満の Node.js では案内を stderr に出し exitCode 1 で終える', () => {
    const previousArgv = process.argv
    const previousExit = process.exitCode
    process.argv = ['node', 'cli', '--version']
    const writes: string[] = []
    const isStderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const isStdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      main('24.20.0')
      expect(process.exitCode).toBe(1)
      expect(writes.join('')).toContain('pecot-tools: Node.js 24.20.0 は既知の脆弱性の修正を含まない')
      expect(isStdoutSpy).not.toHaveBeenCalled()
    }
    finally {
      isStderrSpy.mockRestore()
      isStdoutSpy.mockRestore()
      process.exitCode = previousExit
      process.argv = previousArgv
    }
  })

  it('未知オプションを exitCode 2 にする', () => {
    const previousArgv = process.argv
    process.argv = ['node', 'cli', '--unknown']
    try {
      main(allowedNodeVersion)
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = 0
      process.argv = previousArgv
    }
  })

  it('--version は exitCode 0 で終わる', () => {
    const previousArgv = process.argv
    process.argv = ['node', 'cli', '--version']
    // 非 0 を仕込む。main() が exitCode へ書かないと 9 のまま残り、このケースが落ちる
    // （前ケースの finally が 0 に戻す副作用で assert が通過するのを防ぐ）。
    process.exitCode = 9
    try {
      main(allowedNodeVersion)
      expect(process.exitCode).toBe(0)
    }
    finally {
      process.exitCode = 0
      process.argv = previousArgv
    }
  })
})
