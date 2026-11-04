// 図が属する talk-dir を、図のパスの祖先から探す純粋関数。
// 祖先 D が `slides.md` を持ち、図が `D/public/` の下にあるときだけ、D を talk-dir とみなす。
// `public/` の外の図（`.pecotv/work` やリポジトリ root 直下）は当たらない。

import path from 'node:path'

import type { ThemeFiles } from './ports.js'

const PUBLIC_DIRECTORY = 'public'
const SLIDES_FILE_NAME = 'slides.md'

/**
図の絶対パスから、最も近い talk-dir を返す。当たらなければ undefined。
*/
export async function findDiagramTalkDirectory(files: ThemeFiles, diagramPath: string): Promise<string | undefined> {
  let current = path.dirname(diagramPath)
  for (;;) {
    const relative = path.relative(current, diagramPath).split(path.sep)
    if (relative[0] === PUBLIC_DIRECTORY && relative.length > 1 && (await files.readText(path.join(current, SLIDES_FILE_NAME))) !== undefined) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
