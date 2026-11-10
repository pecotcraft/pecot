// pecotv help snapshot
// `pecotv --help` と 4 つのサブコマンドの Usage 行を CUJ として保持する。
// サブコマンドは `drawio url` / `slide create` / `slide convert` / `evidence create`。
// メイン help はトップレベルのコマンド一覧 (drawio / slide / pptx / mcp) も対象にする。
// mcp は cli.ts で dynamic import 化されているので、外形が help に載ることをここで pin する。
// Phase 4 (#391) で Python ランタイム分岐を撤去済のため env 受渡は不要。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
const CLI_TS_DIST = path.join(CLI_TS_ROOT, 'dist', 'cli.js')

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

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
  if (!existsSync(CLI_TS_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_TS_DIST}\n先に \`pnpm build\` を実行してください`)
  }
})

describe('pecotv help snapshot', () => {
  it('pecotv --help が exit 0 + Usage を含む', () => {
    const result = runPecotv(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('drawio')
    expect(result.stdout).toContain('slide')
    expect(result.stdout).toContain('pptx')
    expect(result.stdout).toContain('mcp')
  })

  it('pecotv drawio url --help が exit 0 + --mode と --json を案内する', () => {
    const result = runPecotv(['drawio', 'url', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--mode')
    expect(result.stdout).toContain('view')
    expect(result.stdout).toContain('edit')
    expect(result.stdout).toContain('--json')
  })

  it('pecotv slide create --help が exit 0 + --theme/--force/--json', () => {
    const result = runPecotv(['slide', 'create', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--theme')
    expect(result.stdout).toContain('--force')
    expect(result.stdout).toContain('--json')
  })

  it('pecotv slide convert --help が exit 0 + --out + --no-cache + --no-single-pass', () => {
    const result = runPecotv(['slide', 'convert', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--out')
    expect(result.stdout).toMatch(/--no-cache\s+convert all slides without reading the cache/)
    expect(result.stdout).toMatch(/--no-single-pass\s+convert with the per-step route/)
  })

  it('pecotv evidence create --help が exit 0 + --input/--out/--json', () => {
    const result = runPecotv(['evidence', 'create', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--input')
    expect(result.stdout).toContain('--out')
    expect(result.stdout).toContain('--json')
  })

  // サブコマンド文脈の --version が親 program の定義を継承して exit 0 になることを pin する
  // (contracts §1)。cli.ts の main は CommanderError の exitCode 0 だけを 0 に落とすため、
  // ここが退行すると usage エラー扱いの exit 2 になる。
  it('pecotv evidence create --version が exit 0 + バージョン文字列', () => {
    const result = runPecotv(['evidence', 'create', '--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  // --input が requiredOption であることを pin する。`.option` へ退行すると commander が
  // 引数を通して action を実行し、spec を読めずに exit 1 で終わる。exit 2 + commander の
  // required 文言で「commander 側で弾いている」ことを判別する。
  it('pecotv evidence create は --input 未指定で exit 2 + required option 文言', () => {
    const result = runPecotv(['evidence', 'create'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('required option \'--input <path>\' not specified')
  })
})
