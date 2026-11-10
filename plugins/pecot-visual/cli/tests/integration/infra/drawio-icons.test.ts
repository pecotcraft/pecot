// infra/drawio/icons.ts の I/O 検証。実 SVG を fixture として読み込み、
// data URI 化と path traversal 防御を確認する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createIconResolver } from '../../../src/infra/drawio/icons.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const BUNDLED_ICON_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'assets', 'drawio-icons')

const temporaryRoot = useTemporaryDirectory('pecotv-icons-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('createIconResolver', () => {
  it('SVG ファイルを data URI に変換する', () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="currentColor"/></svg>'
    writeFileSync(temporaryRoot('foo.svg'), svgContent, 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    const result = resolve('foo')
    expect(result).toMatch(/^data:image\/svg\+xml,/)
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(svgContent)
  })

  it('color 指定時に currentColor を置換する', () => {
    const svgContent = '<svg><circle fill="currentColor"/></svg>'
    writeFileSync(temporaryRoot('foo.svg'), svgContent, 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    const result = resolve('foo', '4f46e5')
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    expect(Buffer.from(base64, 'base64').toString('utf8')).toContain('#4f46e5')
  })

  it('.svg 拡張子の有無にかかわらず解決する', () => {
    writeFileSync(temporaryRoot('foo.svg'), '<svg/>', 'utf8')
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('foo')).toMatch(/^data:image\/svg\+xml,/)
    expect(resolve('foo.svg')).toMatch(/^data:image\/svg\+xml,/)
  })

  it('見つからない時は undefined を返し warn を呼ぶ', () => {
    const warnings: string[] = []
    const resolve = createIconResolver(temporaryRoot(), {
      warn: (m) => {
        warnings.push(m)
      },
    })
    expect(resolve('missing')).toBeUndefined()
    expect(warnings.some(w => w.includes('icon not found'))).toBe(true)
  })

  it('iconRoot 外への path traversal は undefined を返し warn を呼ぶ', () => {
    mkdirSync(temporaryRoot('sub'), { recursive: true })
    const warnings: string[] = []
    const resolve = createIconResolver(temporaryRoot('sub'), {
      warn: (m) => { warnings.push(m) },
    })
    // ../foo は sub の親に出る (許可されない)
    expect(resolve('../foo')).toBeUndefined()
    expect(warnings.some(w => w.includes('outside iconRoot'))).toBe(true)
  })

  it('warn 未指定の場合は警告を捨てる（throw しない）', () => {
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('missing')).toBeUndefined()
  })

  it('空文字 relativePath は早期 reject + warn (`.svg` ファイル単独解決を防止)', () => {
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

  it('/ 単独 relativePath も早期 reject', () => {
    const resolve = createIconResolver(temporaryRoot())
    expect(resolve('/')).toBeUndefined()
  })

  it('同梱カタログの線画アイコンは、色指定で線の色を替え、currentColor を残さない', () => {
    const resolve = createIconResolver(BUNDLED_ICON_ROOT)
    const result = resolve('weather/cloud', '4f46e5')
    const base64 = result?.replace('data:image/svg+xml,', '') ?? ''
    const svg = Buffer.from(base64, 'base64').toString('utf8')
    expect(svg).toContain('stroke="#4f46e5"')
    expect(svg).not.toContain('currentColor')
  })

  it('同梱カタログは、分類ディレクトリの下に <名前>.svg を置き、ライセンスを同梱する', () => {
    const categories = readdirSync(BUNDLED_ICON_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory())
    expect(categories.length).toBeGreaterThan(0)
    const names = readdirSync(path.join(BUNDLED_ICON_ROOT, 'weather'))
    expect(names).toContain('cloud.svg')
    expect(readdirSync(BUNDLED_ICON_ROOT)).toContain('LICENSE')
  })
})
