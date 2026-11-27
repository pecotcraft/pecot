// infra/drawio/icons.ts の I/O 検証。実 SVG を fixture として読み込み、
// data URI 化と path traversal 防御を確認する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createIconResolver } from '../../../src/infra/drawio/icons.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const BUNDLED_ICON_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'assets', 'drawio-icons')

const temporaryRoot = useTemporaryDirectory('pecotv-icons-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('createIconResolver', () => {
  it('SVG ファイルを解決すると、中身を data URI に変換して返す', async () => {
    await explains('アイコンの解決のテストです。`foo.svg` を置いたディレクトリで `foo` を解決した場合に、`data:image/svg+xml,` で始まる値が返り、デコードした中身が元の SVG と一致することを確認します。')
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="currentColor"/></svg>'
    writeFileSync(temporaryRoot('foo.svg'), svgContent, 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    const result = resolve('foo')
    expect(result).toMatch(/^data:image\/svg\+xml,/)
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(svgContent)
  })

  it('色を指定すると、SVG の currentColor を指定した色に置換する', async () => {
    await explains('アイコンの色指定のテストです。`currentColor` を含む SVG に色 `4f46e5` を指定して解決した場合に、デコードした中身に `#4f46e5` が含まれることを確認します。')
    const svgContent = '<svg><circle fill="currentColor"/></svg>'
    writeFileSync(temporaryRoot('foo.svg'), svgContent, 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    const result = resolve('foo', '4f46e5')
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    expect(Buffer.from(base64, 'base64').toString('utf8')).toContain('#4f46e5')
  })

  it('拡張子 .svg の有無にかかわらず、同じアイコンを解決する', async () => {
    await explains('アイコン名の解決のテストです。`foo` と `foo.svg` のどちらを指定した場合も、`data:image/svg+xml,` で始まる値が返ることを確認します。')
    writeFileSync(temporaryRoot('foo.svg'), '<svg/>', 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('foo')).toMatch(/^data:image\/svg\+xml,/)
    expect(resolve('foo.svg')).toMatch(/^data:image\/svg\+xml,/)
  })

  it('アイコンが存在しない場合は、undefined を返し、warn を呼び出す', async () => {
    await explains('存在しないアイコンの解決のテストです。存在しない名前 `missing` を解決した場合に、`undefined` が返り、`icon not found` を含む警告が `warn` へ渡されることを確認します。')
    const warnings: string[] = []
    const resolve = createIconResolver(temporaryRoot(), {
      warn: (m) => {
        warnings.push(m)
      },
    })
    expect(resolve('missing')).toBeUndefined()
    expect(warnings.some(w => w.includes('icon not found'))).toBe(true)
  })

  it('iconRoot の外を指すパスを指定すると、undefined を返し、warn を呼び出す', async () => {
    await explains('パスの検証のテストです。`../foo` のように `iconRoot` の外を指す名前を解決した場合に、`undefined` が返り、`outside iconRoot` を含む警告が `warn` へ渡されることを確認します。')
    mkdirSync(temporaryRoot('sub'), { recursive: true })
    const warnings: string[] = []
    const resolve = createIconResolver(temporaryRoot('sub'), {
      warn: (m) => { warnings.push(m) },
    })
    // ../foo は sub の親に出る (許可されない)
    expect(resolve('../foo')).toBeUndefined()
    expect(warnings.some(w => w.includes('outside iconRoot'))).toBe(true)
  })

  it('warn を指定しない場合は、警告を破棄し、例外を発生させない', async () => {
    await explains('`warn` を指定しない場合のテストです。存在しないアイコンを解決した場合に、例外が発生せず、`undefined` が返ることを確認します。')
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('missing')).toBeUndefined()
  })

  it('空文字のパスを指定すると、.svg という名前のファイルがあっても解決せず、undefined を返し、warn を呼び出す', async () => {
    await explains('アイコンを解決する `createIconResolver` のテストです。空文字のパスを指定した場合に、`.svg` という名前のファイルがあっても解決せず `undefined` を返し、`warn` を呼び出すことを確認します。')
    // `.svg` という名前のファイルが iconRoot 直下に在っても誤マッチしないことを担保
    writeFileSync(temporaryRoot('.svg'), '<svg/>', 'utf8')
    const warnings: string[] = []
    const resolve = createIconResolver(temporaryRoot(), {
      warn: (m) => {
        warnings.push(m)
      },
    })
    expect(resolve('')).toBeUndefined()
    expect(warnings.some(w => w.includes('empty icon path'))).toBe(true)
  })

  it('スラッシュだけのパスを指定すると、アイコンを解決せず undefined を返す', async () => {
    await explains('スラッシュだけのパスの検証のテストです。`/` を解決した場合に、`undefined` が返ることを確認します。')
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('/')).toBeUndefined()
  })

  it('同梱カタログの線画アイコンは、色を指定すると線の色が変わり、currentColor が残らない', async () => {
    await explains('同梱のアイコンの色指定のテストです。`weather/cloud` に色 `4f46e5` を指定して解決した場合に、`stroke="#4f46e5"` が含まれ、`currentColor` が含まれないことを確認します。')
    const resolve = createIconResolver(BUNDLED_ICON_ROOT)
    const result = resolve('weather/cloud', '4f46e5')
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    const svg = Buffer.from(base64, 'base64').toString('utf8')
    expect(svg).toContain('stroke="#4f46e5"')
    expect(svg).not.toContain('currentColor')
  })

  it('同梱カタログは、分類ディレクトリの下に <名前>.svg を置き、ライセンスを同梱する', async () => {
    await explains('同梱のアイコンの配置のテストです。分類ごとのディレクトリが存在し、`weather` の下に `cloud.svg` があり、ルートに `LICENSE` が含まれることを確認します。')
    const categories = readdirSync(BUNDLED_ICON_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory())
    expect(categories.length).toBeGreaterThan(0)
    const names = readdirSync(path.join(BUNDLED_ICON_ROOT, 'weather'))
    expect(names).toContain('cloud.svg')
    expect(readdirSync(BUNDLED_ICON_ROOT)).toContain('LICENSE')
  })
})
