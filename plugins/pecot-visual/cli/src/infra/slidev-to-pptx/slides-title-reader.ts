// slides.md を読み取り frontmatter の title を返す fs 境界ヘルパー。
// title 抽出そのものは domain の parseSlidesTitle (fs 非依存の純粋関数) に委譲し、
// ここでは「ファイル読取 + 失敗ハンドリング」だけを担う。
// convert コマンド (既定の出力名の決定) と dom-converter (pipeline debug ログ) の双方から再利用する。
// 呼び出し元ごとのロギング差は、onReadError コールバックで吸収する。
import { readFile } from 'node:fs/promises'

import { parseSlidesTitle } from '../../domain/slidev-to-pptx/slides-title.js'

/**
slidesPath を読み取り frontmatter の title を返す。
ファイルを読めない場合、または title を持たない場合は undefined。
読取に失敗した場合 (ENOENT 含む) は、onReadError へ error を渡してから undefined を返す。
ENOENT を警告とみなすか無視するかは呼び出し元の関心事のため、フィルタは行わない。
*/
export async function readSlidesTitleFromFile(
  slidesPath: string,
  onReadError?: (error: Readonly<NodeJS.ErrnoException>) => void,
): Promise<string | undefined> {
  let content: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- slidesPath は project 内のパス
    content = await readFile(slidesPath, 'utf8')
  }
  catch (error) {
    // eslint-disable-next-line no-restricted-syntax -- Node の fs error は ErrnoException として narrowing
    onReadError?.(error as NodeJS.ErrnoException)
    return undefined
  }
  return parseSlidesTitle(content)
}
