// pptx 差分キャッシュの実 I/O（<outDir>/cache 配下の読み書き）。
// キー計算そのものは domain/slidev-to-pptx/cache-key.ts が持つ。
// manifest の型と検証は domain/slidev-to-pptx/cache-manifest.ts が持つ。
// 本モジュールは、slides.md の分解・共有クロージャの走査・成果物の複製・manifest の原子的更新を担う。
//
// 次の 2 つの規則を、本ファイル全体で disable する。
// security/detect-non-literal-fs-filename は、実行時に組み立てたキャッシュ / staging ディレクトリ配下のパスを扱うため。
// 理由は infra/slidev-project/fs.ts と同じ。
// unicorn/name-replacements は、設計基準（specs/009-pptx-diff-cache）の用語 envHash を、実装名にもそのまま使うため。
/* eslint-disable security/detect-non-literal-fs-filename, unicorn/name-replacements */

import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { load } from '@slidev/parser/fs'

import {
  computeEnvHash,
  computeSlideHash,
  type SharedFileDigest,
} from '../../domain/slidev-to-pptx/cache-key.js'
import {
  CACHE_SCHEMA_VERSION,
  computePruneTargets,
  parseCacheManifest,
  readDeclaredSchemaVersion,
  removeEntries,
  serializeCacheManifest,
  type CacheManifest,
  type LetterSpacingEntry,
  type SlideCacheEntry,
} from '../../domain/slidev-to-pptx/cache-manifest.js'
import {
  formatSlideFilename,
  slideViewport,
  timeouts,
  type ExportToPptxOptions,
} from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import { isRecord } from '../../domain/_shared/json.js'
import { DEPENDENCY_RECOVERY_HINT, resolveDependency } from '../_shared/dependency-root.js'
import { prerenderConfig } from './prerender-config.js'
import { compareStrings } from '../../domain/_shared/compare-strings.js'
import { memoizeAsync } from '../../domain/_shared/memoize.js'

const MANIFEST_FILENAME = 'manifest.json'

// research.md R2 の共有クロージャ。ここに挙げたパスの内容だけが envHash の材料になる。
const SHARED_CLOSURE_DIRECTORIES: readonly string[] = [
  'layouts',
  'components',
  'composables',
  'utils',
  'setup',
  'styles',
  'patches',
]
// package.json の依存は、キャレット範囲で宣言される。
// そのため再インストールで依存のマイナーが上がっても、package.json 自体の内容は変わらない。
// すると envHash が一致してしまい、旧描画がヒットし続ける。
// ロックファイルは解決済み実バージョンを固定するため、依存バージョンドリフトを材料に取り込む。
const SHARED_CLOSURE_FILES: readonly string[] = [
  'vite.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
]
const LAYOUTS_DIRECTORY = 'layouts'

// 走査から外すディレクトリ名。走査の入り口は上記 7 ディレクトリに限られる。
// そのため現状の構成では、`node_modules` / `dist` はその配下（例: `components/dist/`）に置かれた場合にだけ働く。
// `pptx` は現状の入り口からは到達しない。
// ただし走査対象を広げたとき、自分が書く `pptx/cache/` を材料に取り込むと、書き込みのたびに envHash が変わる。
// その結果、永久に全変換となる。この不具合を防ぐ多層防御として残す。
const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'pptx'])

/**
envHash の headmatter 材料から落とす、Slidev のスライド単位 frontmatter キー。

slides.md のルート frontmatter は「デッキ設定」と「スライド 1 の frontmatter」を兼ねる。
計測では、テーマを使うデッキの headmatter は theme/canvasWidth と並んで `src: ./pages/cover.md` を持つ。
そのまま材料にすると、表紙の差し替えだけで全キャッシュが無効化される。
ここに挙げたキーは、Slidev がスライド単位の意味しか与えていないもの。
落としても、デッキ全体の描画には影響しない。
スライド 1 の描画変化は、headmatter ブロックを含む slideHash 側で検知される。

逆に allowlist は採らない。
テーマは `$slidev.configs.<任意キー>` で、headmatter の独自キーを全スライドから読める。
計測では、テーマの `useDebug` が `$slidev.configs.debug` を参照していた。
既知キーだけ残す方式では、未知の独自キーの変更を取りこぼし、古い描画が残る。
*/
const SLIDE_SCOPED_HEADMATTER_KEYS: ReadonlySet<string> = new Set([
  'src',
  'layout',
  'clicks',
  'class',
  'zoom',
  'level',
  'hide',
  'hideInToc',
  'disabled',
  'routeAlias',
  'preload',
  'dragPos',
])

/**
cache-store の依存注入。既定は node:fs/promises の実装で、テストでは rename を
失敗させる等の注入に使う（PipelineDependencies と同じ形）。
*/
export interface CacheStoreDeps {
  readonly renameImpl?: (oldPath: string, newPath: string) => Promise<void>
  readonly copyFileImpl?: (source: string, destination: string) => Promise<void>
  readonly writeFileImpl?: (filePath: string, data: string) => Promise<void>
}

/**
デッキ環境ハッシュ / スライドハッシュの算出に必要な入力。
*/
export interface DeckCacheKeyOptions {
  /**
  slides.md を含むプレゼンプロジェクトのルート（talk-dir）
  */
  readonly projectDirectory: string
  /**
  slides.md の絶対パス
  */
  readonly slidesPath: string
  /**
  解決済み dom-to-pptx.bundle.js の絶対パス。実体の内容ハッシュだけを取る
  */
  readonly domToPptxBundlePath: string
  readonly chromiumVersion: string
  readonly pluginVersion: string
  /**
  envHash の材料に加えるビルドオプション（`--theme` 等）。cache-key.ts の EnvHashInput 参照。
  */
  readonly buildOptions: Readonly<Record<string, unknown>>
  /**
  exportToPptx へ渡す変換オプション。同じ slides.md・同じ bundle でも値が違えば出力が変わるため
  envHash の材料に入れる（入れないと疑似要素やフォント埋め込みの設定を変えても旧出力がヒットする）。
  */
  readonly exportOptions: Readonly<ExportToPptxOptions>
  /**
  変換方式。1 パス方式（print ルートを 1 回開く）と現行方式（ステップごとにページを開く）は
  成果物が細部で異なり得るため envHash の材料に入れ、方式を切り替えたら全変換にする。
  並列度は出力を変えないため入れない。

  値は実際に通った方式でなく、要求した方式で決める。1 パス方式の run 内で現行 worker に回した
  ステップや、print ルートが無く run 全体を現行方式で変換した run も `'single-pass'` で保存される。
  そのため未同期の deck で `--no-single-pass` に切り替えると、成果物が同じでも全変換になる。
  */
  readonly route: 'single-pass' | 'per-step'
}

export interface DeckCacheKeys {
  readonly envHash: string
  /**
  slideNumber（1 始まり）→ slideHash
  */
  readonly slideHashes: ReadonlyMap<number, string>
}

/**
キー算出に失敗した理由。呼び出し側（#896）が R4 の警告ログに使う。

- `slides-load-failed`: slides.md を読めない / パーサが例外を投げた。
- `slides-has-errors`: load() が errors を記録した（src 先の不在等でスライドが欠落し得る）。
- `bundle-unreadable`: dom-to-pptx.bundle.js の実体を読めない。
- `invalid-environment`: Chromium / プラグインのバージョン文字列が空。
*/
export type DeckCacheKeyFailure
  = 'slides-load-failed' | 'slides-has-errors' | 'bundle-unreadable' | 'invalid-environment'

/**
キー算出の結果。失敗は例外にせず ok:false で返す（キャッシュ由来のエラーで変換自体を
失敗させない R4 / SC-004 の方針）。`message` は警告ログにそのまま出せる文言。
*/
export type DeckCacheKeyResult
  = | { readonly ok: true, readonly keys: DeckCacheKeys }
    | { readonly ok: false, readonly failure: DeckCacheKeyFailure, readonly message: string }

/**
デッキ全体のスキャン結果であることを呼び出し側に明示させるための型。
`--only` / `--onlySteps` の部分結果で prune すると、キャッシュがほぼ全消去される。
そのため `fullScan: true` を書かないと、`pruneCache` を呼べない形にしている。
*/
export interface FullScanSteps {
  readonly fullScan: true
  readonly stepIndexes: readonly number[]
}

/**
materialize が返す、集約ループにそのまま流せるスライド別マップ断片。
*/
export interface MaterializedSlide {
  readonly letterSpacingMap: Readonly<Record<string, LetterSpacingEntry>>
  readonly hrefMap: Readonly<Record<string, string>>
  /**
  当該ステップのスライドが明示指定のアニメーションを持つか（#1070）
  */
  readonly hasExplicitAnimation: boolean
}

export interface MaterializeOptions {
  readonly cacheDirectory: string
  readonly slidesDirectory: string
  readonly stepIndex: number
  /**
  当該実行の slidePrefix。宛先ファイル名は `${slidePrefix}${stepIndex}.pptx`
  */
  readonly slidePrefix: string
}

export interface SaveOptions {
  readonly cacheDirectory: string
  readonly slidesDirectory: string
  readonly stepIndex: number
  readonly slidePrefix: string
  readonly slideHash: string
  readonly slideNumber: number
  readonly clickStep: number | null
  readonly letterSpacingMap: Readonly<Record<string, LetterSpacingEntry>>
  readonly hrefMap: Readonly<Record<string, string>>
  readonly hasExplicitAnimation: boolean
}

/**
キャッシュストアの配置。staging の `<outDir>/slides` と対称に `<outDir>/cache` を使う。
*/
export function cacheDirectoryOf(outputDirectory: string): string {
  return path.join(outputDirectory, 'cache')
}

async function sha256OfFile(filePath: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(filePath)
    return createHash('sha256').update(buffer).digest('hex')
  }
  catch {
    return undefined
  }
}

async function fileSizeOf(filePath: string): Promise<number | undefined> {
  try {
    const info = await stat(filePath)
    return info.size
  }
  catch {
    return undefined
  }
}

/**
同一ディレクトリの一時ファイルへコピーしてから rename する。

直接上書きすると、コピー中断で「途中サイズの成果物」が正規名で残る。キャッシュは内容ではなく
slideHash 一致で使うため、後でスライドを元の内容に戻した時点で破損 pptx が通知なしで materialize
される。rename は同一 filesystem 内で原子的なので、正規名には完全なファイルしか現れない。
失敗時は一時ファイルを消してから rethrow する。
*/
async function copyAtomic(
  source: string,
  destination: string,
  dependencies: Readonly<CacheStoreDeps>,
): Promise<void> {
  const temporaryPath = `${destination}.tmp-${randomUUID()}`
  try {
    await (dependencies.copyFileImpl ?? copyFile)(source, temporaryPath)
    await (dependencies.renameImpl ?? rename)(temporaryPath, destination)
  }
  catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

/**
ディレクトリ配下のファイルを再帰列挙する。symlink は追わない（talk-dir の
node_modules はプラグインルートへの symlink で、実体はデッキの共有入力ではない）。
*/
async function collectFilesInto(
  directory: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 再帰で積む accumulator
  found: string[],
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch {
    // 最小構成のデッキには layouts/ 等が存在しない。無い入り口は材料 0 件として扱う。
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
      await collectFilesInto(absolutePath, found)
      continue
    }
    found.push(absolutePath)
  }
}

/**
全スライドの描画に影響し得る共有入力を (相対パス, 内容ハッシュ) で列挙する。
一覧は相対パスでソートして返す。
*/
async function collectSharedClosure(projectDirectory: string): Promise<readonly SharedFileDigest[]> {
  const absolutePaths: string[] = []
  for (const name of SHARED_CLOSURE_DIRECTORIES) {
    const collected: string[] = []
    await collectFilesInto(path.join(projectDirectory, name), collected)
    for (const filePath of collected) {
      // layouts/ は R2 の列挙どおり *.vue のみを材料にする。
      if (name === LAYOUTS_DIRECTORY && !filePath.endsWith('.vue')) continue
      absolutePaths.push(filePath)
    }
  }
  for (const name of SHARED_CLOSURE_FILES) {
    absolutePaths.push(path.join(projectDirectory, name))
  }

  const digests: SharedFileDigest[] = []
  for (const absolutePath of absolutePaths) {
    const digest = await sha256OfFile(absolutePath)
    if (digest === undefined) continue
    digests.push({
      path: path.relative(projectDirectory, absolutePath).split(path.sep).join('/'),
      hash: digest,
    })
  }
  return digests.toSorted((left, right) => compareStrings(left.path, right.path))
}

/**
`@slidev/parser/fs` の `load` を依存ルートから動的に取得する。

静的 import にすると、本モジュールを読み込むだけで `@slidev/parser` の解決が要る。
単体配布形態では、`@slidev/parser` は起動層（毎起動 install される配布 package.json の dependencies）に置けない。
`@slidev/types` 経由で monaco-editor / mermaid が乗り、起動層が 466MB・35 秒になる。
これは MCP の接続タイムアウトを超える（計測: `.pecot/work/982/exp`）。
動的 import にすれば、`slide_convert` を実際に呼ぶまで解決を遅らせ、永続層から引ける。

解決結果は 1 プロセス内で使い回す（1 回の変換で複数回呼ばれる）。
*/
function isDeckLoader(value: unknown): value is typeof load {
  return typeof value === 'function'
}

const slidevParserLoad = memoizeAsync(async (): Promise<typeof load> => {
  const entry = resolveDependency('@slidev/parser/fs', import.meta.url)
  if (entry === undefined) {
    throw new Error(`@slidev/parser が解決できません。${DEPENDENCY_RECOVERY_HINT}`)
  }
  const module_: unknown = await import(pathToFileURL(entry).href)
  const loader = isRecord(module_) ? module_['load'] : undefined
  /* c8 ignore next 3 -- 解決できた @slidev/parser/fs が load を持たないのは防御網 */
  if (!isDeckLoader(loader)) {
    throw new Error(`@slidev/parser/fs が load を公開していません (${entry})`)
  }
  return loader
})

/**
load() の戻り値のうち、parse エラー収集に必要な形だけを取り出した型。
*/
type ParsedMarkdownFiles = Readonly<Record<string, {
  readonly filepath: string
  readonly errors?: readonly { readonly row: number, readonly message: string }[]
}>>

/**
load() が記録した parse エラーを 1 行にまとめる。エラーが無ければ undefined。
*/
function collectDeckErrors(markdownFiles: ParsedMarkdownFiles): string | undefined {
  const messages: string[] = []
  for (const markdown of Object.values(markdownFiles)) {
    const markdownErrors = markdown.errors ?? []
    for (const error of markdownErrors) {
      messages.push(`${path.basename(markdown.filepath)}:${error.row.toString()} ${error.message}`)
    }
  }
  return messages.length > 0 ? messages.join(' / ') : undefined
}

/**
headmatter からスライド 1 固有のキーを落とし、デッキ設定として意味を持つキーだけを残す。
詳細は SLIDE_SCOPED_HEADMATTER_KEYS のコメントを参照。
*/
function deckSettingsOf(
  headmatter: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(headmatter).filter(([key]) => !SLIDE_SCOPED_HEADMATTER_KEYS.has(key)),
  )
}

/**
slides.md を分解して envHash と全スライドの slideHash を求める。
分解に失敗した場合、変換エンジン実体が読めない場合、環境情報が欠けている場合は、ok:false を返す。
呼び出し側は、キャッシュ全無視（全変換）へフォールバックする。
*/
export async function computeDeckCacheKeys(
  options: Readonly<DeckCacheKeyOptions>,
): Promise<DeckCacheKeyResult> {
  // 材料が空のままハッシュを作ると、別環境のキャッシュを取り違えても envHash が一致してしまう。
  if (options.chromiumVersion.trim() === '' || options.pluginVersion.trim() === '') {
    return {
      ok: false,
      failure: 'invalid-environment',
      message: 'Chromium / プラグインのバージョンが空のためキャッシュキーを算出できません',
    }
  }

  let deck: Awaited<ReturnType<typeof load>>
  try {
    const loadDeck = await slidevParserLoad()
    // parser 52.16.0 で load() の第 1 引数が userRoot 文字列から LoadRootsInfo へ変わり、
    // 52.18.0 で allowedRoots が加わった。
    // roots は preparserExtensionLoader にしか渡らず、本 CLI は preparser 拡張を注入しない。
    // ただし LoadRootsInfo の必須プロパティなので、userRoot と同じ値を渡す。
    // allowedRoots は、slidev 本体がテーマ・アドオン root と workspace root を含む広い範囲を渡す。
    // [projectDirectory] を渡すとビルド時の解決範囲より狭くなり、
    // テーマ由来の src: を取りこぼして、誤ったキャッシュヒットを作り得る。
    // 省略は広い側（無制限）に倒し、旧版までと同じ解決範囲を保つ。
    deck = await loadDeck(
      { roots: [options.projectDirectory], userRoot: options.projectDirectory },
      options.slidesPath,
    )
  }
  catch (error) {
    return {
      ok: false,
      failure: 'slides-load-failed',
      message: `slides.md を分解できません (${options.slidesPath}): ${errorMessage(error)}`,
    }
  }

  // load() は parse エラーを throw せず errors に積む。src 先が無いスライドは通知なしに
  // 欠落するため、errors がある状態のスキャン結果でキャッシュを判定してはいけない。
  const deckErrors = collectDeckErrors(deck.markdownFiles)
  if (deckErrors !== undefined) {
    return {
      ok: false,
      failure: 'slides-has-errors',
      message: `slides.md に解析エラーがあります: ${deckErrors}`,
    }
  }

  const bundleHash = await sha256OfFile(options.domToPptxBundlePath)
  if (bundleHash === undefined) {
    return {
      ok: false,
      failure: 'bundle-unreadable',
      message: `dom-to-pptx.bundle.js を読めません: ${options.domToPptxBundlePath}`,
    }
  }

  const envHash = computeEnvHash({
    headmatter: deckSettingsOf(deck.headmatter),
    sharedFiles: await collectSharedClosure(options.projectDirectory),
    bundleHash,
    chromiumVersion: options.chromiumVersion,
    conversionConstants: {
      prerender: prerenderConfig,
      timeouts,
      viewport: slideViewport,
      exportOptions: options.exportOptions,
      route: options.route,
    },
    buildOptions: options.buildOptions,
    pluginVersion: options.pluginVersion,
    schemaVersion: CACHE_SCHEMA_VERSION,
  })

  const slideHashes = new Map<number, string>()
  for (const [index, slide] of deck.slides.entries()) {
    // src 分離時は importChain に slides.md 側のブロックが積まれ、source が本文ファイル側。
    // inline スライドは importChain が空で source 自身がブロック本体。
    const importChain = slide.importChain ?? []
    const slideNumber = index + 1
    slideHashes.set(slideNumber, computeSlideHash(
      importChain.length > 0
        ? {
            slideNumber,
            // 入れ子 import では、import 元から順に積まれる。
            // 境界が曖昧にならないよう、markdown 本文に現れない NUL で連結する。
            blockRaw: importChain.map(source => source.raw).join('\0'),
            bodyRaw: slide.source.raw,
          }
        : { slideNumber, blockRaw: slide.source.raw },
    ))
  }

  return { ok: true, keys: { envHash, slideHashes } }
}

/**
manifest.json の読み取り結果。呼び出し側は「まだ無い」と「あるが使えない」を区別して
無効化の種別（`none` / `all:manifest`）を報告する必要があるため、undefined にまとめない。

「使えない」は破損（`invalid`）とスキーマ版の不一致（`outdated`）に分かれる。後者は
プラグインを更新した直後の初回 run で必ず起きる正常事象で、破損と同じ文言で報告すると
利用者がキャッシュの破損を想定する。
*/
export type CacheManifestRead
  = | { readonly status: 'missing' }
    | { readonly status: 'invalid' }
    | { readonly status: 'outdated', readonly schemaVersion: number }
    | { readonly status: 'ok', readonly manifest: CacheManifest }

/**
manifest.json を読む。
結果は 3 種ある。
`missing` は不在、`outdated` はスキーマ版の不一致、`invalid` は破損・読み取り失敗。
いずれも全 miss になる点は同じで、違うのは報告される無効化の種別と文言だけ。
*/
export async function readCacheManifest(cacheDirectory: string): Promise<CacheManifestRead> {
  let text: string
  try {
    text = await readFile(path.join(cacheDirectory, MANIFEST_FILENAME), 'utf8')
  }
  catch (error) {
    // 不在以外の読み取り失敗（権限・I/O）は「キャッシュが無い」ではなく「使えない」。
    const isNotFound = isRecord(error) && error['code'] === 'ENOENT'
    return isNotFound ? { status: 'missing' } : { status: 'invalid' }
  }
  const manifest = parseCacheManifest(text)
  if (manifest !== undefined) return { status: 'ok', manifest }
  // JSON としては読めて版だけが違う manifest は破損ではない。版が読めない（JSON として
  // 破損している / schemaVersion が数値でない）ものだけを invalid に残す。
  const declared = readDeclaredSchemaVersion(text)
  return declared === undefined || declared === CACHE_SCHEMA_VERSION ? { status: 'invalid' } : { status: 'outdated', schemaVersion: declared }
}

/**
manifest.json を一時ファイル + rename で原子的に書き換える。

Phase 1 は並列実行されるため、ステップごとに read-modify-write すると last-write-wins で
エントリが欠落する。本関数は変換完了後の終端 1 回だけ呼び、全体を書き換える。
一時ファイルは rename が同一 filesystem 内で完結するよう cache/ 直下に作る。
*/
export async function writeCacheManifest(
  cacheDirectory: string,
  manifest: Readonly<CacheManifest>,
  dependencies: Readonly<CacheStoreDeps> = {},
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true })
  const temporaryPath = path.join(cacheDirectory, `${MANIFEST_FILENAME}.tmp-${randomUUID()}`)
  // write / rename のどちらで失敗しても、一時ファイルを残さない。
  // 残骸は読み取りを壊さないが、失敗のたび cache/ に溜まる。
  try {
    await (dependencies.writeFileImpl ?? writeFile)(temporaryPath, serializeCacheManifest(manifest))
    await (dependencies.renameImpl ?? rename)(temporaryPath, path.join(cacheDirectory, MANIFEST_FILENAME))
  }
  catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

/**
キャッシュ済み成果物を staging（slides/）へ複製する。
エントリの指す実体が 1 つでも欠けている / 0 バイトなら、undefined を返してミス扱いにする。

prerender 画像は、連番の最初の欠番で走査が打ち切られる（domain/pptx-ooxml の findPrerenderImages）。
そのため部分復元は、通知なしの差し替え抜けとなる。
よって複製途中で失敗した場合は、書いた分をすべて撤去してから undefined を返す。
事前の存在確認と複製の間に実体が消える競合も、この流れに合流してミス扱いになる。
*/
export async function materializeCacheEntry(
  options: Readonly<MaterializeOptions>,
  entry: Readonly<SlideCacheEntry>,
  dependencies: Readonly<CacheStoreDeps> = {},
): Promise<MaterializedSlide | undefined> {
  for (const name of [entry.pptxFile, ...entry.prerenderFiles]) {
    const size = await fileSizeOf(path.join(options.cacheDirectory, name))
    if (size === undefined || size === 0) return undefined
  }

  await mkdir(options.slidesDirectory, { recursive: true })
  const pptxDestination = path.join(
    options.slidesDirectory,
    formatSlideFilename(options.stepIndex, options.slidePrefix),
  )
  const written: string[] = []
  try {
    await copyAtomic(path.join(options.cacheDirectory, entry.pptxFile), pptxDestination, dependencies)
    written.push(pptxDestination)
    for (const name of entry.prerenderFiles) {
      const destination = path.join(options.slidesDirectory, name)
      await copyAtomic(path.join(options.cacheDirectory, name), destination, dependencies)
      written.push(destination)
    }
  }
  catch {
    for (const target of written) {
      await rm(target, { force: true })
    }
    return undefined
  }

  return {
    letterSpacingMap: entry.letterSpacingMap,
    hrefMap: entry.hrefMap,
    hasExplicitAnimation: entry.hasExplicitAnimation,
  }
}

/**
変換成功したステップの成果物を cache/ へ保存し、エントリを作る。manifest は触らない
（並列実行中の書き換えを避けるため、manifest は終端 1 回で書く）。

prerender ファイルの列挙は変換結果からの導出ではなくディレクトリ走査で行う。
boundingBox が null の要素では PNG だけを書き、meta.json は作らない。この状態は正常に発生するため。

保存に失敗した場合は、書きかけを撤去して undefined を返す。
エントリが作られないだけで、変換自体は成功のまま進む。
各ファイルの複製は temp + rename で行うため、中断しても正規名に途中サイズのファイルは現れない。
*/
export async function saveSlideToCache(
  options: Readonly<SaveOptions>,
  dependencies: Readonly<CacheStoreDeps> = {},
): Promise<SlideCacheEntry | undefined> {
  const stepIndex = options.stepIndex.toString()
  const sourcePptx = path.join(
    options.slidesDirectory,
    formatSlideFilename(options.stepIndex, options.slidePrefix),
  )
  const size = await fileSizeOf(sourcePptx)
  if (size === undefined || size === 0) return undefined

  await mkdir(options.cacheDirectory, { recursive: true })
  const pptxFile = `slide-${stepIndex}.pptx`

  // 区切りの `-` まで含めて比較する。含めないとスライド 5（500）が 50（5000）の
  // prerender ファイルを前方一致で拾ってしまう。
  const prerenderPrefix = `prerender-slide${stepIndex}-`
  const stagingNames = await readdir(options.slidesDirectory)
  const prerenderFiles = stagingNames.filter(name => name.startsWith(prerenderPrefix)).toSorted(compareStrings)

  const written: string[] = []
  try {
    const pptxDestination = path.join(options.cacheDirectory, pptxFile)
    await copyAtomic(sourcePptx, pptxDestination, dependencies)
    written.push(pptxDestination)
    for (const name of prerenderFiles) {
      const destination = path.join(options.cacheDirectory, name)
      await copyAtomic(path.join(options.slidesDirectory, name), destination, dependencies)
      written.push(destination)
    }
  }
  catch {
    for (const target of written) {
      await rm(target, { force: true })
    }
    return undefined
  }

  return {
    slideHash: options.slideHash,
    slideNumber: options.slideNumber,
    clickStep: options.clickStep,
    pptxFile,
    prerenderFiles,
    letterSpacingMap: options.letterSpacingMap,
    hrefMap: options.hrefMap,
    hasExplicitAnimation: options.hasExplicitAnimation,
  }
}

// manifest 破損時の掃除で削除してよいと判定する既知パターン。saveSlideToCache /
// materializeCacheEntry が作るファイル名の形（cache-store.ts 内で完結）とだけ一致させる。
const KNOWN_CACHE_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /^slide-\d+\.pptx$/,
  /^prerender-slide\d+-.+$/,
]

/** 掃除対象として安全な既知パターンか判定する。
manifest.json と rename 途中の一時ファイル（`*.tmp-*`）は対象外にする。
一時ファイルは、並行実行中の別プロセスの書きかけの可能性がある。 */
function isKnownCacheArtifact(name: string): boolean {
  return !name.includes('.tmp-') && KNOWN_CACHE_ARTIFACT_PATTERNS.some(pattern => pattern.test(name))
}

/**
manifest.json が破損して読めない（invalid）場合に、既知パターンの成果物ファイルを cache/ から一括で消す。
manifest が読めないと、「前回どのエントリが生きていたか」を prune / removeUnreferencedArtifacts が判定できない。
その結果、削除済みスライドの成果物が `pptx/cache/` に恒久残留する（FR-010）。
本関数はその救済として、manifest が使えない状態そのものを起点に既知パターンを掃除する。
今回の run で改めて保存されるため、生存分は saveSlideToCache が復元する。
*/
export async function clearOrphanedCacheArtifacts(cacheDirectory: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(cacheDirectory)
  }
  catch {
    // cache/ 自体が無ければ掃除対象も無い。
    return
  }
  for (const name of names) {
    if (!isKnownCacheArtifact(name)) continue
    await rm(path.join(cacheDirectory, name), { force: true })
  }
}

/**
今回のスキャン結果に無いエントリの成果物を消し、prune 済み manifest を返す
（書き込みは呼び出し側が writeCacheManifest で行う）。

引数が `FullScanSteps`（`fullScan: true` 必須）なのは契約の担保のため。`--only` /
`--onlySteps` の部分スキャン結果をそのまま渡すとキャッシュがほぼ全消去されるので、
呼び出し側に「これは全走査の結果である」と明示させる。部分実行時は本関数を呼ばない。

manifest に載っていない孤児ファイルは v1 では削除しない。cache/ 直下の未知ファイルを
消す責務を持たせると、並行実行中の別プロセスが書いた一時ファイルまで巻き込むため。
*/
export async function pruneCache(
  cacheDirectory: string,
  manifest: Readonly<CacheManifest>,
  liveSteps: Readonly<FullScanSteps>,
): Promise<CacheManifest> {
  const targets = computePruneTargets(manifest, liveSteps.stepIndexes)
  for (const name of targets.files) {
    await rm(path.join(cacheDirectory, name), { force: true })
  }
  return removeEntries(manifest, targets.stepKeys)
}
