import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadVersionFromPluginJson, pluginRoot, readVersion } from '../version.js'
import { explains } from '../../tests/_helpers/explains.js'

// version.ts 側の相対解決（src / dist / 配布ツリーで同じ 2 階層上）と独立に組んだ manifest パス。
// 両者が一致することを assert して、version.ts を src 直下から動かす変更を検知する。
const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.claude-plugin/plugin.json',
)

/**
プラグインルート配下のファイルの絶対パス。
*/
function pluginFile(relativePath: string): string {
  return path.join(pluginRoot(), relativePath)
}

describe('readVersion', () => {
  it('CLAUDE_PLUGIN_ROOT が空のときは、同梱の plugin.json の version を返す', async () => {
    // リテラル固定にしない（リリースの bump でテストを壊さない）。
    await explains('プラグインの版を読み取る `readVersion` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` が空の場合に、`readVersion` が同梱の `plugin.json` から読み取った版と一致する値を返すことを確認します。')
    expect(readVersion()).toBe(loadVersionFromPluginJson(manifestPath))
  })

  it('plugin ルートは version.ts の置き場所から 2 階層上になる', async () => {
    await explains('プラグインのルートを求める `pluginRoot` のテストです。`version.ts` の置き場所から 2 階層上のディレクトリを、`plugin.json` の置き場所の親と同じ値として返すことを確認します。')
    expect(pluginRoot()).toBe(path.resolve(path.dirname(manifestPath), '..'))
  })
})

describe('loadVersionFromPluginJson', () => {
  it('有効な plugin.json からは、version の文字列を返す', async () => {
    await explains('plugin.json から版を読み取る `loadVersionFromPluginJson` のテストです。同梱の `plugin.json` を渡した場合に、`数字.数字.数字` の形の版を返すことを確認します。')
    expect(loadVersionFromPluginJson(manifestPath)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('JSON として解析できないファイルを渡すと、undefined を返す', async () => {
    await explains('plugin.json から版を読み取る `loadVersionFromPluginJson` のテストです。TypeScript のソースファイルを渡した場合に、`undefined` を返すことを確認します。')
    expect(loadVersionFromPluginJson(pluginFile('cli/src/version.ts'))).toBeUndefined()
  })

  it('version のキーを持たない JSON を渡すと、undefined を返す', async () => {
    await explains('plugin.json から版を読み取る `loadVersionFromPluginJson` のテストです。`version` を持たない `tsconfig.json` を渡した場合に、`undefined` を返すことを確認します。')
    expect(loadVersionFromPluginJson(pluginFile('cli/tsconfig.json'))).toBeUndefined()
  })

  it('存在しないファイルを渡すと、undefined を返す', async () => {
    await explains('plugin.json から版を読み取る `loadVersionFromPluginJson` のテストです。存在しないファイルのパスを渡した場合に、例外を発生させず `undefined` を返すことを確認します。')
    expect(loadVersionFromPluginJson(pluginFile('no-such.json'))).toBeUndefined()
  })
})
