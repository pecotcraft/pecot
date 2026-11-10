// draw.io の embed export で得た SVG を、ローカルの headless Chromium で 1 ページの PDF に
// 印刷する I/O 層。commands/drawio/export.ts から DI 経由で注入される。
//
// embed.diagrams.net の export action は format: 'pdf' を渡しても SVG を返すため、PDF は
// 手元で SVG から作る。SVG を inline に置いた HTML を印刷するだけでネットワークには出ない。
//
// inline SVG のまま印刷すると行ボックスの溢れで空白の 2 ページ目が付くため、余白・overflow を
// CSS で消したうえで pageRanges: '1' で 1 ページに固定する。用紙は SVG の px 寸法に合わせる
// (寸法が読めないときは既定の A4 で出さず、エラーにする)。
//
// 環境変数 PECOTV_FORCE_PDF_FAIL=1 を指定すると、Playwright 起動より前に意図的に reject する。
// chromium 未インストール環境でも失敗パスを検証できるようにするため。

/* eslint-disable security/detect-non-literal-fs-filename -- outputPath は呼び出し側で組み立てた信頼境界内のパス */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readSvgPixelSize } from '../../domain/drawio/export.js'
import { launchChromium } from '../playwright/launch.js'

// screenshot.ts の EXPORT_TIMEOUT_MS と揃える。待ちに上限を働かせ、hang させない。
// 上限は setContent と pdf の段ごとに掛かるため、最悪で 2 段分 (120 s) 待つ。
const PDF_TIMEOUT_MS = 60_000

const PRINT_STYLE = '@page{margin:0}'
  + 'html,body{margin:0;padding:0;overflow:hidden}'
  + 'svg{display:block}'

/**
`svg` を 1 ページの PDF にして `outputPath` へ書き出す。
出力ディレクトリの作成と書き込みは印刷の成功後に行い、失敗パスで空ディレクトリを残さない。
*/
export async function exportPdf(svg: string, outputPath: string): Promise<void> {
  if (process.env['PECOTV_FORCE_PDF_FAIL'] === '1') {
    throw new Error('forced PDF failure (PECOTV_FORCE_PDF_FAIL=1)')
  }
  const size = readSvgPixelSize(svg)

  const browser = await launchChromium()
  let pdf: Buffer
  try {
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html><head><style>${PRINT_STYLE}</style></head><body>${svg}</body></html>`,
      { timeout: PDF_TIMEOUT_MS },
    )
    // page.pdf は timeout オプションを持たないため、タイマーとの競争で上限を働かせる。
    // 期限切れ後は finally の browser.close が印刷中のページごと閉じる。
    pdf = await withTimeout(page.pdf({
      width: `${Math.ceil(size.width).toString()}px`,
      height: `${Math.ceil(size.height).toString()}px`,
      // svg ルートの背景色とラベルの背景色 (CSS background) を描かせる。SVG の fill はこれ無しでも描かれる。
      printBackground: true,
      pageRanges: '1',
    }), PDF_TIMEOUT_MS)
  }
  finally {
    await browser.close()
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, pdf)
}

async function withTimeout<T>(promise: Readonly<Promise<T>>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => { reject(new Error(`PDF printing did not finish within ${(milliseconds / 1000).toString()}s`)) },
      milliseconds,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}
/* eslint-enable security/detect-non-literal-fs-filename */
