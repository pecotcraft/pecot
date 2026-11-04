// テーマの参照（references/*.yaml）の examples から、pages/ の初期ページを作る。
// 文面はテーマが持ち、本体は持たない。本体が知っているのは、先頭に置く慣例のレイアウト名
// （表紙・目次・章扉・終わりの cover・agenda・section・end）だけです。
// 4 つは、宣言があれば並べ、無ければ名前順の先頭のレイアウトを 1 ページだけ置く。
// レイアウト名はファイル名になるため、pages/ の外に書ける名前は警告して飛ばす。

import { extractSkeleton } from '../slidev-theme/skeleton.js'
import type { ThemeFiles } from '../slidev-theme/ports.js'
import type { LayoutReference } from '../slidev-theme/references.js'

export interface InitialPage {
  readonly filename: string
  readonly content: string
}

export interface InitialPages {
  readonly pages: readonly InitialPage[]
  /**
  利用者に伝える警告。初期ページを examples から作れなかったときに入る。
  */
  readonly warnings: readonly string[]
}

// ページのファイル名として使える名前。slide_page (mcp/tools/slide-page.ts) の検証と同じ。
// 参照 yaml の `layout:` は外部のテーマの値です。`/` や `..` を含む名前で pages/ の外へ書けないようにします。
const PAGE_STEM = /^\w[\w.-]*$/u

// 初期ページの候補。この順に、宣言があり examples を持つものを並べる。
const PREFERRED_LAYOUTS: readonly string[] = ['cover', 'agenda', 'section', 'end']

async function readSkeleton(files: ThemeFiles, entry: Readonly<LayoutReference>): Promise<string | undefined> {
  // 宣言の無いテーマでは file が vue を指す。vue に examples は無い。
  if (!entry.file.endsWith('.yaml')) return undefined
  const text = await files.readText(entry.file)
  return text === undefined ? undefined : extractSkeleton(text)
}

/**
テーマのレイアウト参照から初期ページを作る。

1. `cover`・`agenda`・`section`・`end` の順に、宣言があり examples を持つものの 1 件目を書く。
2. 1 つも無ければ、examples を持つ名前順で最初のレイアウトの 1 件目を、1 ページだけ書く。
3. examples が 1 つも無ければ、先頭のレイアウトを `layout:` だけで 1 ページ書き、警告を返す。
4. レイアウトが 1 つも無ければ、ページは空で警告を返す。

@param references 名前順のレイアウト参照（`resolveLayoutReferences` の entries）
*/
export async function buildInitialPages(
  references: readonly Readonly<LayoutReference>[],
  files: ThemeFiles,
): Promise<InitialPages> {
  const warnings: string[] = []
  const usable = references.filter((entry) => {
    const isUsable = PAGE_STEM.test(entry.name)
    if (!isUsable) warnings.push(`レイアウト名 '${entry.name}' はページのファイル名に使えないため、初期ページから除きました`)
    return isUsable
  })
  const sorted = usable.toSorted((a, b) => a.name.localeCompare(b.name))

  const preferred: InitialPage[] = []
  for (const name of PREFERRED_LAYOUTS) {
    const entry = sorted.find(candidate => candidate.name === name)
    if (entry === undefined) continue
    const skeleton = await readSkeleton(files, entry)
    if (skeleton !== undefined) preferred.push({ filename: `${name}.md`, content: skeleton })
  }
  if (preferred.length > 0) return { pages: preferred, warnings }

  for (const entry of sorted) {
    const skeleton = await readSkeleton(files, entry)
    if (skeleton !== undefined) {
      return { pages: [{ filename: `${entry.name}.md`, content: skeleton }], warnings }
    }
  }

  const [first] = sorted
  if (first === undefined) {
    return {
      pages: [],
      warnings: [...warnings, 'テーマにレイアウトが無いため、初期ページを作れませんでした。テーマの layouts/ を確認してください。'],
    }
  }
  return {
    pages: [{ filename: `${first.name}.md`, content: `---\nlayout: ${first.name}\n---\n` }],
    warnings: [
      ...warnings,
      `テーマの参照に examples が無いため、初期ページは layout: ${first.name} だけにしました。`
      + 'テーマの references/ に examples を足すと、雛形の入った初期ページが作られます。',
    ],
  }
}

/**
プレゼン名（dest dir のベース名）を表示用 title に変換する。
Python 版 `name_to_title` (cli/pecotv/slidev/create.py:238-240) と意味等価。
ハイフンをスペースに置換し、各単語の先頭を大文字化する。
*/
export function nameToTitle(name: string): string {
  return name
    .replaceAll('-', ' ')
    .replaceAll(/\b\w/g, m => m.toUpperCase())
}
