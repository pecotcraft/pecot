// CUJ: 利用者が `node dist/cli.js --version` で plugin.json の版数を得る。
//
// unit テストは src を直接 import する。
// そのため、tsc の出力（dist 平坦化後の相対解決）と、
// self-execution ガード（symlink / cwd に依らず main() へ入るか）を見られるのは、このテストだけになる。
/* eslint-disable security/detect-non-literal-fs-filename -- import.meta.url 相対と mkdtemp の戻り値のみ扱う */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { loadVersionFromPluginJson } from '../../src/version.js'

import type { SpawnSyncReturns } from 'node:child_process'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cliEntry = path.join(cliRoot, 'dist/cli.js')
const pluginManifest = path.join(cliRoot, '../.claude-plugin/plugin.json')
// 版数はリテラル固定にしない（リリースの bump でテストを壊さない）。
const expectedVersion = loadVersionFromPluginJson(pluginManifest)

function runCli(entry: string, options: Readonly<{ cwd?: string }> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  })
}

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(`cli dist が存在しません: ${cliEntry}\n先に \`pnpm build\` を実行してください`)
  }
})

describe('pecot-tools --version', () => {
  it('plugin.json の版数を stdout へ出して exit 0 で終わる', () => {
    const result = runCli(cliEntry)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expectedVersion)
  })

  it('symlink 経由で起動しても直接起動と同じ結果になる', () => {
    // self-execution ガードが argv[1] を realpath に揃えているかを見る。
    // 揃っていないと main() へ入らず、無出力の exit 0 になる。
    const linkRoot = mkdtempSync(path.join(tmpdir(), 'pecot-tools-e2e-symlink-'))
    try {
      const link = path.join(linkRoot, 'cli.js')
      symlinkSync(cliEntry, link)
      const result = runCli(link)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(expectedVersion)
    }
    finally {
      rmSync(linkRoot, { recursive: true, force: true })
    }
  })

  it('cli 外の cwd から起動しても同じ結果になる', () => {
    // plugin.json の解決が cwd ではなく import.meta.url 相対であることを見る。
    const result = runCli(cliEntry, { cwd: tmpdir() })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expectedVersion)
  })
})
