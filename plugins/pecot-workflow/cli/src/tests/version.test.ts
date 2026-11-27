/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../tests/_helpers/explains.js'
import { loadVersionFromPluginJson, pluginRoot, readVersion } from '../version.js'

// version.ts 側の相対解決（src / dist / 配布ツリーで同じ 2 階層上）と独立に組んだ manifest パス。
// 両者が一致することを assert して、version.ts を src 直下から動かす変更を検知する。
const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.claude-plugin/plugin.json',
)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('readVersion', () => {
  it('同梱の plugin.json の version を返す', async () => {
    await explains('バージョンを取得する `readVersion` のテストです。`CLAUDE_PLUGIN_ROOT` が空の場合に、同梱の `plugin.json` の `version` を返し、`x.y.z` の形になっていることを確認します。')
    // リテラル固定にしない（リリースの bump でテストを壊さない）。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    expect(readVersion()).toBe(loadVersionFromPluginJson(manifestPath))
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('CLAUDE_PLUGIN_ROOT があれば、そちらの plugin.json の version を返す', async () => {
    await explains('バージョンを取得する `readVersion` のテストです。`CLAUDE_PLUGIN_ROOT` に別のディレクトリを設定した場合に、そのディレクトリの `plugin.json` の `version` を返すことを確認します。')
    const root = mkdtempSync(path.join(tmpdir(), 'pecot-workflow-version-'))
    try {
      mkdirSync(path.join(root, '.claude-plugin'))
      writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.8.7' }))
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', root)

      expect(pluginRoot()).toBe(root)
      expect(readVersion()).toBe('9.8.7')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('plugin.json を読めなければ、開発用の既定値を返す', async () => {
    await explains('バージョンを取得する `readVersion` のテストです。`plugin.json` が存在しない場合に、開発用の既定値 `0.0.0+dev` を返すことを確認します。')
    const root = mkdtempSync(path.join(tmpdir(), 'pecot-workflow-version-'))
    try {
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', root)

      expect(readVersion()).toBe('0.0.0+dev')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pluginRoot', () => {
  it('CLAUDE_PLUGIN_ROOT が空白だけなら、ソースからの相対位置のプラグインのルートを返す', async () => {
    await explains('プラグインのルートを求める `pluginRoot` のテストです。`CLAUDE_PLUGIN_ROOT` が空白だけの場合に、ソースファイルからの相対位置にあるプラグインのルートを返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', ' '.repeat(3))

    expect(pluginRoot()).toBe(path.resolve(path.dirname(manifestPath), '..'))
  })
})

describe('loadVersionFromPluginJson', () => {
  it('有効な plugin.json から、version の文字列を返す', async () => {
    await explains('`plugin.json` から version を読み取る `loadVersionFromPluginJson` のテストです。有効な `plugin.json` を渡した場合に、`x.y.z` の形の `version` を返すことを確認します。')
    expect(loadVersionFromPluginJson(manifestPath)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('JSON として読めないファイルなら、undefined を返す', async () => {
    await explains('`plugin.json` から version を読み取る `loadVersionFromPluginJson` のテストです。JSON として解釈できないファイルを渡した場合に、`undefined` を返すことを確認します。')
    const target = path.join(pluginRoot(), 'cli/src/version.ts')
    expect(loadVersionFromPluginJson(target)).toBeUndefined()
  })

  it('version のキーを持たない JSON なら、undefined を返す', async () => {
    await explains('`plugin.json` から version を読み取る `loadVersionFromPluginJson` のテストです。`version` のキーを含まない JSON ファイルを渡した場合に、`undefined` を返すことを確認します。')
    const target = path.join(pluginRoot(), 'cli/tsconfig.json')
    expect(loadVersionFromPluginJson(target)).toBeUndefined()
  })

  it('ファイルが存在しなければ、undefined を返す', async () => {
    await explains('`plugin.json` から version を読み取る `loadVersionFromPluginJson` のテストです。存在しないファイルのパスを渡した場合に、`undefined` を返すことを確認します。')
    const target = path.join(pluginRoot(), 'no-such.json')
    expect(loadVersionFromPluginJson(target)).toBeUndefined()
  })
})
