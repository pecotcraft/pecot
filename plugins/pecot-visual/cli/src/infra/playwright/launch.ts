// headless Chromium の起動と、起動できないときの取得手順の案内。
//
// 利用者を同じ文言で誘導するための共有点。
// 使うのは draw.io の embed export (infra/drawio/screenshot.ts)。
// SVG → PDF 変換 (infra/drawio/pdf.ts) と slidev-to-pptx の pipeline も使う。

import { chromium, type Browser } from 'playwright'

import { isMissingHostDependencies, missingSharedLibraries } from './host-dependencies.js'

/**
Chromium の起動失敗を、利用者が次に取る手順を添えたエラーへ包み直す。
手順を示せない失敗 (Chromium と無関係な例外) は undefined を返し、呼び出し元がそのまま投げる。

OS のライブラリ不足は実行ファイルの再取得では直らないため、取得の案内とは分ける (#1217)。
*/
export function chromiumLaunchError(message: string, cause: unknown): Error | undefined {
  if (isMissingHostDependencies(message)) {
    const libraries = missingSharedLibraries(message)
    const libraryList = libraries.length > 0 ? ` (${libraries.join(', ')})` : ''
    return new Error(
      `Playwright Chromium の起動に要る OS のライブラリが足りません${libraryList}: ${message}\n`
      + '  pecotv の setup (plugins/pecot-visual/setup.sh、MCP では setup ツール) を実行すると、sudo を使える環境では自動で入ります。'
      + ' sudo を使えない環境では、setup が示すコマンドを管理者に実行してもらってください。',
      { cause },
    )
  }
  return /Executable doesn't exist|browserType\.launch|playwright\S*chromium/i.test(message)
    ? new Error(
        `Playwright Chromium が起動できません: ${message}\n`
        + '  pnpm --filter @pecot/pecotv-cli exec playwright install chromium を実行してください。',
        { cause },
      )
    : undefined
}

/**
headless Chromium を起動する。実行ファイルが無い・OS のライブラリが足りない等で
起動できないときは、次の手順を添えたエラーへ包み直す。
*/
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true })
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw chromiumLaunchError(message, error) ?? error
  }
}
