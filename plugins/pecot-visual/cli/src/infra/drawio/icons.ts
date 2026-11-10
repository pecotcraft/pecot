// drawio の `icon://` 参照を SVG ファイルから解決する I/O 層。
// domain/drawio/url.ts の prepareDrawioXml に DI で注入する。

/* eslint-disable security/detect-non-literal-fs-filename -- iconRoot は plugin-root から組み立てた信頼境界内のパス */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { IconResolver } from '../../domain/drawio/types.js'

/**
プラグイン同梱の icon カタログ（プラグイン形態・単体配布形態のどちらでも plugin-root 直下）。

`path.resolve` を使うのは、plugin-root が env 由来で相対値になり得るため
（pluginDependencyRoot() は trim しか行わない）。既定の icons root は
`parsePathArguments` を通らない場面で使われるので、絶対パスであることをここで保証する。
*/
export function defaultIconRoot(pluginRoot: string): string {
  return path.resolve(pluginRoot, 'assets', 'drawio-icons')
}

export interface CreateIconResolverOptions {
  /**
  警告 sink（見つからない icon の通知）。未指定なら警告を捨てる。
  */
  readonly warn?: (message: string) => void
}

/**
`iconRoot` を起点に icon:// 参照を data URI に解決する関数を返す。
見つからなかった場合は undefined を返し、ドメイン側が `icon://...` 文字列を温存する。
*/
export function createIconResolver(
  iconRoot: string,
  options: Readonly<CreateIconResolverOptions> = {},
): IconResolver {
  return (relativePath: string, color?: string): string | undefined => {
    // 空文字 / `/` 単独は `.svg` 単一ファイル名 (`iconRoot/.svg`) を解決してしまうため早期 reject
    if (relativePath === '' || relativePath === '/') {
      options.warn?.(`empty icon path: ${relativePath}`)
      return undefined
    }
    const withExtension = relativePath.endsWith('.svg') ? relativePath : `${relativePath}.svg`
    // path traversal 防御: iconRoot 配下に正規化後も収まることを確認
    const resolved = path.resolve(iconRoot, withExtension)
    const normalizedRoot = path.resolve(iconRoot)
    if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
      options.warn?.(`icon path resolves outside iconRoot: ${relativePath}`)
      return undefined
    }
    if (!existsSync(resolved)) {
      options.warn?.(`icon not found: ${resolved}`)
      return undefined
    }
    let svgText = readFileSync(resolved, 'utf8')
    if (color !== undefined && color !== '') {
      svgText = svgText.replaceAll('currentColor', () => `#${color}`)
    }
    const base64 = Buffer.from(svgText, 'utf8').toString('base64')
    return `data:image/svg+xml,${base64}`
  }
}
