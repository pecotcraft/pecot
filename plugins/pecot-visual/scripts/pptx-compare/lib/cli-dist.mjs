/**
 * pecotv-cli のビルド成果物（cli/dist）の位置解決を 1 か所に閉じる。
 *
 * 解決順（本番・テストで同じ 1 本の流れ）:
 *   1. 環境変数 `PECOTV_CLI_DIST`（dist ディレクトリの絶対パス）。
 *   2. 本ファイルからの相対 `../../../cli/dist/`。
 *
 * 相対の段数をこのモジュールだけに閉じる。
 * そのため、先頭の mjs / lib / tests は cli/dist を直接 import せず、必ず `loadCliDist()` を通す。
 * dist が無い場合と、dist 内の import に失敗した場合は、例外を投げる。
 * 他 lib と同じく、process.exit はここでは呼ばない。
 * 呼び出し側の先頭の mjs が catch して、stderr 出力 + exit 2 に倒す。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** dist の実在判定に使う代表ファイル。 */
const PROBE_FILE = 'infra/pptx-ooxml/archive.js'

/** cli/dist ディレクトリの絶対パス。実在は確認しない。 */
export function resolveCliDist() {
  const fromEnv = process.env.PECOTV_CLI_DIST
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return fileURLToPath(new URL('../../../cli/dist/', import.meta.url))
}

/**
 * cli/dist から本スクリプト群が使う 4 つの実装を読み込む。
 *
 * 依存は、cli/dist と node 組み込みだけに閉じる。
 * jszip / fast-xml-parser / js-yaml と、TypeScript の型ストリップ import は使わない。
 * cli/package.json が、xmldom / xpath / yauzl / yazl を自前 dependencies に宣言している。
 * そのため、dist 内の bare specifier は、import 元の位置に依らず解決される。
 */
export async function loadCliDist() {
  const dist = resolveCliDist()
  if (!existsSync(join(dist, PROBE_FILE))) {
    throw new Error(
      [
        `pecotv-cli の dist が見つかりません: ${dist}`,
        '  build 手順:',
        '    cd plugins/pecot-visual \\',
        '      && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm --filter @pecot/pecotv-cli run build',
        '  別の場所の dist を使う場合は環境変数 PECOTV_CLI_DIST に絶対パスを指定する。',
      ].join('\n'),
    )
  }
  const href = (relative) => pathToFileURL(join(dist, relative)).href
  const [archive, engine, postProcess, previewNormalize] = await Promise.all([
    import(href('infra/pptx-ooxml/archive.js')),
    import(href('infra/pptx-ooxml/xml-engine.js')),
    import(href('domain/pptx-ooxml/post-process.js')),
    import(href('domain/pptx-ooxml/preview-normalize.js')),
  ])
  return {
    dist,
    PptxArchive: archive.YauzlYazlPptxArchive,
    XmlEngine: engine.XmldomXmlEngine,
    NAMESPACES: postProcess.NAMESPACES,
    detectPreviewDivergence: previewNormalize.detectPreviewDivergence,
  }
}
