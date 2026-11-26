import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadVersionFromPluginJson, pluginRoot, readVersion } from '../version.js'

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
  it('同梱 plugin.json の version を返す', () => {
    // リテラル固定にしない（リリースの bump でテストを壊さない）。
    expect(readVersion()).toBe(loadVersionFromPluginJson(manifestPath))
  })

  it('plugin ルートは version.ts の置き場所から 2 階層上になる', () => {
    expect(pluginRoot()).toBe(path.resolve(path.dirname(manifestPath), '..'))
  })
})

describe('loadVersionFromPluginJson', () => {
  it('有効な plugin.json から version 文字列を返す', () => {
    expect(loadVersionFromPluginJson(manifestPath)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('JSON として読めないファイルなら undefined', () => {
    expect(loadVersionFromPluginJson(pluginFile('cli/src/version.ts'))).toBeUndefined()
  })

  it('version キーを持たない JSON なら undefined', () => {
    expect(loadVersionFromPluginJson(pluginFile('cli/tsconfig.json'))).toBeUndefined()
  })

  it('ファイルが存在しなければ undefined', () => {
    expect(loadVersionFromPluginJson(pluginFile('no-such.json'))).toBeUndefined()
  })
})
