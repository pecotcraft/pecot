// cli-surface.md §3 の廃止コマンド/オプションが exit 2 で拒否されることを
// table-driven で網羅する。
// createProgram() を直接呼ぶことで、bin/pecotv のシェル分岐に依存しない。
// commander の `unknown command` / `unknown option` ルートを assert する。

import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { applyExitOverrideRecursively, createProgram } from '../../../src/cli.js'

const HERE = import.meta.dirname
// repo の plugins/pecot-visual が plugin-root（cli/.. = plugins/pecot-visual）。
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')

beforeAll(() => {
  // unknown option ルートで writeErr フックから呼ばれる *DefaultDependencies()
  // が CLAUDE_PLUGIN_ROOT を要求するため、先に設定する。
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

type ExpectedCode = 'commander.unknownCommand' | 'commander.unknownOption'

interface Case {
  readonly name: string
  readonly argv: readonly string[]
  readonly expectedCode: ExpectedCode
}

const CASES: readonly Case[] = [
  // 廃止サブコマンド: commander が `unknownCommand` で reject する
  { name: 'pecotv slidev create', argv: ['slidev', 'create', '/tmp/foo'], expectedCode: 'commander.unknownCommand' },
  { name: 'pecotv slidev convert', argv: ['slidev', 'convert', '/tmp/foo', '--out', '/tmp/o.pptx'], expectedCode: 'commander.unknownCommand' },
  { name: 'pecotv slidev pptx-postprocess', argv: ['slidev', 'pptx-postprocess', '/tmp/in.pptx', '--out', '/tmp/o.pptx'], expectedCode: 'commander.unknownCommand' },
  { name: 'pecotv slidev pptx', argv: ['slidev', 'pptx', '/tmp/in.pptx', '--out', '/tmp/o.pptx'], expectedCode: 'commander.unknownCommand' },
  { name: 'pecotv pptx postprocess', argv: ['pptx', 'postprocess', '/tmp/in.pptx', '--out', '/tmp/o.pptx'], expectedCode: 'commander.unknownCommand' },
  // 廃止オプション: 既存 subcommand 配下に未定義の option → `unknownOption`
  { name: 'pecotv drawio url <f> --build', argv: ['drawio', 'url', '/tmp/in.drawio', '--build'], expectedCode: 'commander.unknownOption' },
  { name: 'pecotv slide create <d> --legacy-runtime', argv: ['slide', 'create', '/tmp/d', '--theme', 'file:/tmp/theme', '--legacy-runtime'], expectedCode: 'commander.unknownOption' },
]

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

describe('cli-surface.md §3 廃止リスト: 全件 commander エラーで拒否', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} は ${testCase.expectedCode} で拒否される`, () => {
      const program = createProgram()
      // main() と同じ再帰適用。
      // group command 配下の unknown subcommand は、親だけに exitOverride を掛けても CommanderError として伝播しない。
      // group command は pptx / slide 等。
      applyExitOverrideRecursively(program)
      // commander の writeOut/writeErr を捕捉して stdout/stderr 汚染を防ぐ
      const stdout = makeStream()
      const stderr = makeStream()
      program.configureOutput({
        writeOut: (s: string) => { stdout.chunks.push(s) },
        writeErr: (s: string) => { stderr.chunks.push(s) },
      })
      let thrown: unknown
      try {
        program.parse([...testCase.argv], { from: 'user' })
      }
      catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeDefined()
      // CommanderError の code / exitCode を直接確認する。
      // bin/pecotv 経由の main() では exitCode > 0 を 2 にマップする。
      // 本テストは createProgram() 直接呼出のため、commander の生 exitCode を観測する。
      // thrown を CommanderError 互換のオブジェクトとして narrowing。
      // eslint-disable-next-line no-restricted-syntax
      const error = thrown as { code?: string, exitCode?: number, message?: string }
      expect(error.code).toBe(testCase.expectedCode)
      expect(error.exitCode).toBeGreaterThan(0)
    })
  }
})
