// slide_page ツール。指定レイアウトのスケルトンページを talk-dir の pages/ 配下に生成し、
// そのレイアウトの使い方 (参照 yaml 全文 + includes) を応答で返す。
//
// 対応する CLI サブコマンドは持たない (`slide_dev` / `setup` と同じ MCP 専用ツール)。
// 目的はエージェントの「`pages/_references/<layout>.yaml` を Read してから手書きする」ルートを
// 1 回の呼び出しに畳むことなので、CLI から使う需要が無い。
//
// 参照 yaml は `slide theme` と同じ解釈（executeSlideTheme）で探す。
// talk-dir の references/ が先、次にテーマの references/ で、lint の no-unknown-props などが読む場所と同じ。
// レイアウト名の一致確認も executeSlideTheme が返す一覧に通す。
// `_` 始まりと status: hidden の除外規則を書き写すと片方だけ古くなるため、実装は 1 本に保つ。

// 開くのは引数で受けた talk-dir の下の pages/ と、executeSlideTheme が返した参照 yaml の絶対パス、参照 yaml が宣言した include 名だけ。
/* eslint-disable security/detect-non-literal-fs-filename */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  errorToReason as slideThemeErrorToReason,
  executeSlideTheme,
} from '../../commands/slidev-project/theme.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { extractSkeleton, isFrontmatterBlock } from '../../domain/slidev-theme/skeleton.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { ToolResult } from '../result.js'
import type { ToolDefinition } from '../server.js'
import {
  captureCommandOutput,
  formatError,
  TOOL_OUTPUT_SCHEMA,
  WINDOWS_PATH_NOTE,
  type CommandOutput,
} from './_shared.js'

/**
ページを生成できなかったときの exit code (各コマンドの RuntimeError と同じ 1)。
*/
const SLIDE_PAGE_EXIT_CODE = 1

/**
生成するページの拡張子。省略された `file` にはこれを補う。
*/
const PAGE_EXTENSION = '.md'

/**
ページファイル名の先頭が数字かの判定。

slidev-pages-lint の `no-numeric-filename-prefix` と同一ロジック (拡張子を除いた stem に
`/^\d/`) を生成時に適用する。eslint プラグインは talk-dir 側の dist を実行時に解決する
別ルートなので import できず、regex をここに持つ。同値性は unit テストで pin する。
*/
const LEADING_DIGIT_REGEX = /^\d/

/**
pages/ 直下限定にするため、パス区切りを含む名前は受け付けない。
*/
const PATH_SEPARATOR_REGEX = /[/\\]/

/**
拡張子を除いた stem に許す文字。

先頭を `\w` に限るのは `..md` (stem が `.`) や ` .md` (stem が空白) のような、
拡張子だけ揃っていて名前として成立しない指定を弾くため。
*/
const PAGE_STEM_REGEX = /^\w[\w.-]*$/

/**
共通仕様 yaml の宣言ブロック (`includes:` の直下に `- _common` が並ぶ)。
*/
const INCLUDES_REGEX = /^includes:[ \t]*$/m
const INCLUDE_ITEM_REGEX = /^[ \t]*-[ \t]*([\w-]+)[ \t]*$/
/**
includes ブロック内の yaml コメント行。項目の間に挟まっても宣言は続く。
*/
const YAML_COMMENT_REGEX = /^[ \t]*#/

const slidePageInput = z.object({
  layout: z.string()
    .describe('レイアウト名。slide_create / slide_sync 応答の見せ方の分類 (data.categories) で'
      + '見せ方を決め、その分類に属する data.layouts の名前から選ぶ'),
  dir: z.string()
    .describe('ページを生成する talk-dir の絶対パス。相対パスは受け付けない。' + WINDOWS_PATH_NOTE),
  file: z.string()
    .describe('pages/ 直下に生成するファイル名 (.md は省略可)。パス区切りと数字始まりの名前は受け付けない'),
  force: z.boolean().default(false)
    .describe('同名のページが既にある場合に上書きする'),
})

/**
失敗時の ToolResult (stdout / stderr は呼び出し側が付ける)。
*/
function failure(
  reason: string,
  detail: string,
  extra: Readonly<Record<string, unknown>> = {},
): Omit<ToolResult, 'stdout' | 'stderr'> {
  return {
    ok: false,
    exitCode: SLIDE_PAGE_EXIT_CODE,
    artifacts: [],
    data: { event: 'slide.page.error', reason, detail, ...extra },
    message: detail,
  }
}

type PageFileName
  = | { readonly ok: true, readonly filename: string }
    | { readonly ok: false, readonly reason: string, readonly detail: string }

/**
`file` を pages/ 直下のファイル名へ正規化する。

拒否するのは次の 3 つ。
(1) パス区切りを含む名前 = pages/ の外や下位ディレクトリを指すもの。
(2) 名前として成立しない stem = 空・記号始まりなど。
(3) 数字始まりの stem = lint の no-numeric-filename-prefix 違反になるもの。
(3) を生成時に弾くのは、書けてしまうと直後の lint で必ず落ちてリネームのやり直しになるため。
*/
export function normalizePageFileName(file: string): PageFileName {
  if (PATH_SEPARATOR_REGEX.test(file)) {
    return {
      ok: false,
      reason: 'invalid-file-name',
      detail: `file にパス区切りを含められません: ${file}。ページは talk-dir の pages/ 直下にだけ生成します。`,
    }
  }

  const filename = file.endsWith(PAGE_EXTENSION) ? file : `${file}${PAGE_EXTENSION}`
  const stem = filename.slice(0, filename.length - PAGE_EXTENSION.length)
  if (stem === '') {
    return {
      ok: false,
      reason: 'invalid-file-name',
      detail: 'file が空です。生成するページのファイル名を指定してください。',
    }
  }
  if (!PAGE_STEM_REGEX.test(stem)) {
    return {
      ok: false,
      reason: 'invalid-file-name',
      detail: `file にファイル名として使えない文字が含まれています: ${file}。`
        + '英数字で始まり、英数字・アンダースコア・ハイフン・ドットだけからなる名前 '
        + '(例: cover.md) を指定してください。',
    }
  }
  if (LEADING_DIGIT_REGEX.test(stem)) {
    return {
      ok: false,
      reason: 'numeric-filename-prefix',
      detail: `file を数字で始められません: ${filename}。`
        + 'スライドの順序は slides.md の src: エントリの並びだけで管理するため、'
        + '数字で始まらない英語名 (例: cover.md) を指定してください。',
    }
  }
  return { ok: true, filename }
}

type IncludedReferences
  = | { readonly ok: true, readonly includes: Record<string, string> }
    | { readonly ok: false, readonly missing: string }

/**
参照 yaml が `includes:` で宣言した共通仕様 yaml を全文で読む。

件数は固定しない (`_header` を持たないレイアウトが cover / end の 2 件ある)。宣言されて
いるのにファイルが無い talk-dir は参照が破損しているので、握り潰さず失敗に倒す。

蓄積先を Map にするのは、参照 yaml 由来のキー (`__proto__` 等) がオブジェクトリテラルの
特別扱いに吸われて取りこぼされないようにするため。
*/
async function readIncludedReferences(
  referencesDirectories: readonly string[],
  referenceText: string,
): Promise<IncludedReferences> {
  const includes = new Map<string, string>()
  const declaration = INCLUDES_REGEX.exec(referenceText)
  if (declaration === null) return { ok: true, includes: Object.fromEntries(includes) }

  for (const line of referenceText.slice(declaration.index).split('\n').slice(1)) {
    if (line.trim() === '') break
    // 項目の間に挟まるコメント行では宣言は終わらない (後続の項目まで読み切る)。
    if (YAML_COMMENT_REGEX.test(line)) continue
    const item = INCLUDE_ITEM_REGEX.exec(line)
    if (item === null) break
    /* c8 ignore next -- regex の group 1 は必ずキャプチャされるため、空文字への代替の右辺は到達不能 */
    const name = item[1] ?? ''
    // lint が読む順（talk-dir の references/ が先）で探す。
    const included = referencesDirectories
      .map(directory => path.join(directory, `${name}.yaml`))
      .find(candidate => existsSync(candidate))
    if (included === undefined) return { ok: false, missing: `${name}.yaml` }
    includes.set(name, await readFile(included, 'utf8'))
  }
  return { ok: true, includes: Object.fromEntries(includes) }
}

/**
`wx` で開いた書き込みが既存ファイルに当たったか。
*/
function isAlreadyExistsError(error: unknown): boolean {
  /* c8 ignore next -- fs が投げるのは code を持つ Error だけで、true 分岐は防御網のみ */
  if (!(error instanceof Error) || !('code' in error)) return false
  const { code } = error
  return typeof code === 'string' && code === 'EEXIST'
}

type ReferenceReader = (file: string) => Promise<string>

/**
テーマの解決・宣言の失敗を、slide_page の失敗応答にする。reason は `slide theme` と同じ。
復旧の案内（CLI と MCP の両方の手順）は、例外の文言が持つ。
*/
function themeFailure(error: unknown): Omit<ToolResult, 'stdout' | 'stderr'> {
  return failure(slideThemeErrorToReason(error), formatError(error))
}

/**
引数検証後の実処理。stdout / stderr は呼び出し側が一括で載せる。

実行時依存 (永続層) と Chromium は要らない。参照 yaml の読み取りと 1 ファイルの書き込み
だけなので、`setup` 前の環境でも通る。
*/
async function generatePage(
  input: Readonly<z.infer<typeof slidePageInput>>,
  readReferenceText: ReferenceReader,
  // CommandOutput の stderr は WritableStream で write が mutate のため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  output: Readonly<CommandOutput>,
): Promise<Omit<ToolResult, 'stdout' | 'stderr'>> {
  const file = normalizePageFileName(input.file)
  if (!file.ok) return failure(file.reason, file.detail)

  // テーマの解決・宣言の読み取りに失敗したら、そのまま原因を返す。
  // 参照 yaml の置き場は executeSlideTheme が決めるので、ここで固定の場所を探さない。
  let execution: Awaited<ReturnType<typeof executeSlideTheme>>
  try {
    execution = await executeSlideTheme({ dir: input.dir }, { files: new NodeThemeFiles() })
  }
  catch (error: unknown) {
    return themeFailure(error)
  }
  const { data: theme, references } = execution
  for (const warning of theme.warnings) output.stderr.write(`[warn] ${warning}\n`)

  // 一致確認はファイルを開く前に済ませる。layout は利用者入力なので、パストラバーサル・
  // hidden 名・大文字違いはここで構造的に落とす (一致確認を後ろに回すと任意ファイル読みになる)。
  const entry = theme.layouts.find(candidate => candidate.layout === input.layout)
  const reference = references.entries.find(candidate => candidate.name === input.layout)
  if (entry === undefined || reference === undefined) {
    return failure(
      'unknown-layout',
      `レイアウト '${input.layout}' は ${input.dir} が参照するテーマ ${theme.theme.name} にありません。`
      + 'data.categories で見せ方を決め、その分類の data.layouts の中から選んでください。',
      { categories: theme.categories, layouts: theme.layouts },
    )
  }
  if (!reference.file.endsWith('.yaml')) {
    return failure(
      'skeleton-unavailable',
      `テーマ ${theme.theme.name} は ${entry.layout} の参照 yaml（references/${entry.layout}.yaml）を持たないため、`
      + '雛形を書き出せません。テーマに参照 yaml を足すか、talk-dir の references/ に置いてください。',
    )
  }

  // catalog の確認と読み取りの間に参照 yaml が消える競合は、書き込みの失敗と分けて報告する。
  let referenceText: string
  try {
    referenceText = await readReferenceText(reference.file)
  }
  catch (error: unknown) {
    return failure(
      'reference-read-failed',
      `参照 yaml を読めませんでした (${reference.file}): ${formatError(error)}`,
    )
  }
  const skeleton = extractSkeleton(referenceText)
  if (skeleton === undefined) {
    return failure(
      'skeleton-unavailable',
      `${entry.filename} から雛形フロントマターを取り出せません (examples が空です)。`
      + `参照 yaml が破損しています。テーマ ${theme.theme.name} の ${reference.file} を直してください。`,
    )
  }
  if (!isFrontmatterBlock(skeleton)) {
    return failure(
      'skeleton-unavailable',
      `${entry.filename} の examples が \`---\` で囲まれていないため、雛形として書き出せません。`
      + `参照 yaml が破損しています。テーマ ${theme.theme.name} の ${reference.file} を直してください。`,
    )
  }

  const included = await readIncludedReferences(theme.lint.referencesDirectories, referenceText)
  if (!included.ok) {
    return failure(
      'broken-reference',
      `${entry.filename} が include する ${included.missing} が ${theme.lint.referencesDirectories.join(' , ')} にありません。`
      + `テーマ ${theme.theme.name} の references/ に ${included.missing} を足してください。`,
    )
  }

  // 既存ページの保護は open のフラグに任せる (事前の存在確認と書き込みの間に別プロセスが
  // 作ったページを上書きしないため)。force のときだけ `w` で上書きを許す。
  const target = path.join(input.dir, 'pages', file.filename)
  try {
    await writeFile(target, skeleton, { encoding: 'utf8', flag: input.force ? 'w' : 'wx' })
  }
  catch (error: unknown) {
    if (!isAlreadyExistsError(error)) throw error
    return failure(
      'file-exists',
      `${target} は既にあります。上書きするなら force: true を、別ページを作るなら別の file を指定してください。`,
    )
  }

  return {
    ok: true,
    exitCode: 0,
    artifacts: [target],
    data: {
      event: 'slide.page.done',
      layout: entry.layout,
      category: entry.category,
      deprecated: entry.deprecated,
      path: target,
      skeleton,
      reference: referenceText,
      includes: included.includes,
    },
    message: `slide page: 生成しました (${target})。`
      + 'data.reference の props / text_constraints に従って中身を埋めたうえで、'
      + `slides.md へ "src: ./pages/${file.filename}" の登録が別途必要です`,
  }
}

/**
`slide_page` のハンドラ。

実処理の例外はすべてここで失敗応答へ畳む。SDK へ抜けると structuredContent の無い
応答になり、outputSchema を宣言したツールの契約が破れる (slide.ts / drawio.ts と同じ流儀)。
*/
async function handleSlidePage(
  arguments_: Readonly<Record<string, unknown>>,
  readReferenceText: ReferenceReader,
): Promise<CallToolResult> {
  const validated = parsePathArguments(slidePageInput, arguments_, ['dir'])
  if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)

  // テーマの警告を stderr へ出す。捕捉先を用意して
  // 「捕捉したなら空でもキーを残す」契約 (tools/_shared.ts) を全 return ルートで満たす。
  const output = captureCommandOutput()
  try {
    return toCallToolResult({ ...await generatePage(validated.input, readReferenceText, output), ...output.part() })
  }
  catch (error: unknown) {
    return toCallToolResult({ ...failure('write-failed', formatError(error)), ...output.part() })
  }
}

/**
`slide_page` のツール定義。
*/
export function slidePageTool(
  // 参照 yaml の読み取り。catalog の確認と読み取りの間に消える競合を、テストが再現するために差し替える。
  readReferenceText: ReferenceReader = file => readFile(file, 'utf8'),
): ToolDefinition {
  return {
    name: 'slide_page',
    config: {
      title: 'Slidev ページ生成',
      description: '指定した 1 レイアウトのスケルトンページを talk-dir の pages/ 配下に生成し、'
        + 'そのレイアウトの仕様 (props / text_constraints / clicks / best_practices / anti_patterns / examples) を返す。'
        + '返却先は data.reference と data.includes。'
        + 'レイアウト名は slide_create / slide_sync 応答の見せ方の分類 (data.categories) で'
        + '見せ方を決めてから、その分類の data.layouts の中から選ぶ'
        + ' (未知の名前を渡すと data.categories と data.layouts が応答に載る)。'
        + '生成したページは slides.md への src: 登録が別途必要。',
      inputSchema: slidePageInput,
      outputSchema: TOOL_OUTPUT_SCHEMA,
      // talk-dir 配下の読み取りと 1 ファイルの書き込みだけで、ネットワークには到達しない。
      annotations: { openWorldHint: false },
    },
    handler: arguments_ => handleSlidePage(arguments_, readReferenceText),
  }
}
