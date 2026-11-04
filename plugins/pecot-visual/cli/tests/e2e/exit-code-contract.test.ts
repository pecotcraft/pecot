// pecotv 終了コード contract
// CLI contract §1「--help / --version 以外の commander 想定内終了は exit 2」を実プロセスで pin する。
// group command の pptx・slide・drawio・evidence は、commander 14 の addCommand が親の exitOverride を継承しない。
// そのため cli.ts の再帰適用が外れると、素の exit 1 へ退行する。
// vitest worker は process.exit をスタブへ差し替えるため、unit では process.exitCode プロパティまでしか assert できない。
// 実プロセスの終了コード（spawn の status）を保証するのは、本ファイルのみ。

import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { assertCliBuilt } from '../_helpers/pecotv-e2e-run.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')

const GROUPS: readonly string[] = ['pptx', 'slide', 'drawio', 'evidence']

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

// runPecotv は tests/_helpers/pecotv-e2e-run.ts の createPecotvRunner と別実装のまま維持する。
// 共有 runner は戻り値に stderr を含まないが、本ファイルの assertion は stderr（unknown command
// メッセージ）まで見るため共通化できない。
function runPecotv(arguments_: readonly string[]): RunResult {
  const result = spawnSync(BIN_PECOTV, [...arguments_], {
    env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

beforeAll(() => {
  assertCliBuilt()
})

describe('pecotv 終了コード contract', () => {
  it.each(GROUPS)('pecotv %s bogus は exit 2 + stderr に unknown command + stdout 空', (group) => {
    const result = runPecotv([group, 'bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown command \'bogus\'')
    expect(result.stdout).toBe('')
  })

  // 引数なし group は、commander が help をエラー扱いで出す分岐。#994 以前は exit 1 だった
  // 挙動変更をここで pin する。help は stderr に出て stdout は空になる。
  it.each(GROUPS)('pecotv %s (引数なし) は exit 2 + help が stderr に出て stdout 空', (group) => {
    const result = runPecotv([group])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  // unknown option の分岐の代表。group 自身が持たない option を渡した場合も、exit 2 に揃える。
  it.each(GROUPS)('pecotv %s --json は exit 2', (group) => {
    const result = runPecotv([group, '--json'])
    expect(result.status).toBe(2)
  })

  // 引数順違いの代表。余分な operand があっても unknown command 判定が先に立つ。
  it.each(GROUPS)('pecotv %s bogus extra は exit 2', (group) => {
    const result = runPecotv([group, 'bogus', 'extra'])
    expect(result.status).toBe(2)
  })

  it.each(GROUPS)('pecotv %s --help は exit 2 化の対象外で exit 0', (group) => {
    const result = runPecotv([group, '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
  })

  // group command 自体は -V/--version を持たない（`pecotv <group> --help` の Options には -h/--help しかない）。
  // commander は positional option 化していない限り、root の parseOptions が先に --version を拾ってしまう。
  // そのため group 位置で渡しても、root の --version として処理され exit 0 になる。
  // 将来 enablePositionalOptions() を導入すると、この流れは「group に --version という未知オプション」になる。
  // その場合は exit 2 に変わる想定の pin。
  it.each(GROUPS)('pecotv %s --version は root の --version として処理され exit 0', (group) => {
    const result = runPecotv([group, '--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  // group 以外（program.command() で生成される leaf: hello / mcp）の未知オプションの分岐。
  // 棄却案（group 4 件だけへの exitOverride 限定適用）を再現したプローブで確認した。
  // この 2 つは program.addCommand とは別の流れ（program.command() 直下）にある。
  // そのため限定適用のままでも、既存 18 ケースは全部 green のまま通ってしまい、退行を検出できなかった。
  // 全 command への再帰適用でなければ、この 2 ケースだけが exit 1 に戻って落ちる。
  it('pecotv hello --bogus は exit 2', () => {
    const result = runPecotv(['hello', '--bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown option \'--bogus\'')
  })

  it('pecotv mcp --bogus は exit 2', () => {
    const result = runPecotv(['mcp', '--bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown option \'--bogus\'')
  })
})
