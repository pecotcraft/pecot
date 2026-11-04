// CUJ: 利用者が `pecotv --version` / `node dist/cli.js --version` で plugin.json の版数を得る。
//
// unit テストは src を直接 import する。
// そのため、tsc の出力と self-execution ガードを見られるのは、このテストだけになる。
// ガードの確認対象は、symlink を含むパスで起動しても main() へ入るかどうか。
// ガードが argv[1] を realpath に揃えていないと main() へ入らず、無出力の exit 0 になる。
/* eslint-disable security/detect-non-literal-fs-filename -- import.meta.dirname 相対と mkdtemp の戻り値のみ扱う */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { loadVersionFromPluginJson } from '../../src/version.js'

import type { SpawnSyncReturns } from 'node:child_process'

const cliRoot = path.resolve(import.meta.dirname, '../..')
const pluginRoot = path.resolve(cliRoot, '..')
const cliEntry = path.join(cliRoot, 'dist/cli.js')
// 版数はリテラル固定にしない（リリースの bump でテストを壊さない）。
const expectedVersion = loadVersionFromPluginJson(path.join(pluginRoot, '.claude-plugin/plugin.json'))

function runNode(entry: string): Readonly<SpawnSyncReturns<string>> {
  const environment = { ...process.env }
  delete environment['CLAUDE_PLUGIN_ROOT']
  return spawnSync(process.execPath, [entry, '--version'], { env: environment, encoding: 'utf8', timeout: 30_000 })
}

// プラグインルートへの symlink を一時ディレクトリに作り、callback へ渡して終わったら消す。
function withPluginLink<T>(callback: (pluginLink: string) => T): T {
  const linkDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-e2e-symlink-'))
  try {
    const pluginLink = path.join(linkDirectory, 'pecot-visual')
    symlinkSync(pluginRoot, pluginLink, 'dir')
    return callback(pluginLink)
  }
  finally {
    rmSync(linkDirectory, { recursive: true, force: true })
  }
}

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(`cli dist が存在しません: ${cliEntry}\n先に \`pnpm build\` を実行してください`)
  }
})

describe('pecotv --version', () => {
  it('dist/cli.js の直接起動で plugin.json の版数を出して exit 0 で終わる', () => {
    const result = runNode(cliEntry)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expectedVersion)
  })

  it('プラグインルートへの symlink を通した dist/cli.js の直接起動でも同じ結果になる', () => {
    const result = withPluginLink(pluginLink => runNode(path.join(pluginLink, 'cli/dist/cli.js')))
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expectedVersion)
  })

  it('symlink を通した bin/pecotv の起動でも同じ結果になる', () => {
    const result = withPluginLink(pluginLink => spawnSync(path.join(pluginLink, 'bin/pecotv'), ['--version'], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginLink, PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    }))
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expectedVersion)
  })
})
