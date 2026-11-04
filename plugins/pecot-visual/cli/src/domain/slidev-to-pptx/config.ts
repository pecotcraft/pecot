// Slidev → PPTX pipeline の純粋な設定型と timeout 定数。parseArgs は本ファイルには含めず、
// 旧 sub-package 削除 (Step 6) と同時に消滅させる方針。

export const timeouts = {
  slidevReady: 30_000,
  scanStepNavigation: 5000,
  slideVisibility: 30_000,
  // Windows + WSL の 1 パス方式では注入に 18 s かかって成功した計測がある（#1161）
  domToPptxInject: 30_000,
  slideRetryCount: 1,
  slideRetryDelay: 2000,
  cssAnimationSettle: 3000,
  iframeLoad: 5000,
  // Web フォントの読み込み待ちの上限。取得が滞る環境でも変換を止めない
  fontsReady: 5000,
  // コンポーネントが data-waitfor で示す描画完了（グラフの描き直し等）の待ちの上限。超えても変換は続行する
  dataWaitfor: 15_000,
} satisfies Readonly<Record<string, number>>

// スキャン / スライド変換で開く Playwright ページのビューポート。両者で同一値を使う。
// pptx 差分キャッシュの envHash 材料でもあり、変更すると全キャッシュが無効化される。
export const slideViewport = {
  width: 960,
  height: 540,
} satisfies Readonly<Record<string, number>>

/**
`exportToPptx` の `fonts` に渡す 1 書体分の指定。`url` は woff / woff2 / ttf の取得先。
*/
export interface ExportToPptxFont {
  readonly name: string
  /**
  CSS の `font-weight` は数値（`400`）とキーワード（`bold`）の両方を取るため union。
  */
  readonly weight?: string | number
  readonly style?: string
  readonly url: string
}

/**
dom-to-pptx のブラウザ bundle `exportToPptx(element, options)` へ渡す変換オプションのうち、
出力形を変えるもの。`fileName` / `skipDownload` は呼び出しごとに決まる値なので含めない。

pptx 差分キャッシュの envHash 材料でもあり（cache-store.ts の conversionConstants）、
値を変えると全キャッシュが無効化される。未指定のキーは dom-to-pptx の既定に委ねる
（既定値そのものは版で変わり得るため、ここで写し取って固定しない）。
*/
export interface ExportToPptxOptions {
  /**
  疑似要素（`::before` / `::after`）を出力に含めるか。
  */
  readonly includePseudoElements?: boolean
  /**
  描画に使われている書体を検出して pptx へ埋め込むか。
  */
  readonly autoEmbedFonts?: boolean
  /**
  明示的に埋め込む書体。autoEmbedFonts の検出結果とは独立に加算される。
  */
  readonly fonts?: readonly ExportToPptxFont[]
}

/**
`exportToPptx` オプションの既定値。
dom-to-pptx 2.1.1 の既定挙動を、51 枚のデッキ全件の変換で計測して決めた（#1062）。

- `includePseudoElements`: ON / OFF で出力に差が出なかった。
  sp 1115 件・テキストあり sp 718 件・pic 304 件・`a:t` の集合・xfrm がすべて同一だった。
  ライブラリ既定は ON だが、既定が変わっても出力が動かないよう true を明示する。
- `autoEmbedFonts`: 2.x は cross-origin の `@import`（Google Fonts）も埋め込み対象にする。
  そのため、従来の見出し書体の regular に加えて、同じ書体の bold と Inter の regular が入る。
  埋め込みフォントは 178,250 B → 472,972 B になる。
  deck 全体では 13.37 MB → 13.46 MB（×1.007）で、変換時間は +4〜5 秒。
  テンプレート非依存に「画面で使った書体が pptx にも入る」挙動なので採る。
*/
export const defaultExportToPptxOptions = {
  includePseudoElements: true,
  autoEmbedFonts: true,
} satisfies ExportToPptxOptions

/**
Phase 1 が出す単スライド PPTX のファイル名 prefix（`<prefix><N>.pptx`）の既定値。

`pecotv slide convert` はこの値を pipeline へ渡し、同じ値で merge 入力を走査する
（commands/slidev-to-pptx/convert.ts）。出力側と走査側で別々の prefix を使うと merge 入力が
0 件になり「slides/ に slide-<N>.pptx が存在しません」という原因の分かりにくいエラーになる。
名前の組み立て / 読み取りは下の formatSlideFilename / parseSlideFilename に閉じる。
*/
export const DEFAULT_SLIDE_PREFIX = 'slide-'

const SLIDE_FILENAME_SUFFIX = '.pptx'

/**
Phase 1 出力の単スライド PPTX のファイル名を組み立てる。
読み直す側は `parseSlideFilename` を使い、形式の知識を本ファイルだけに置く。
*/
export function formatSlideFilename(slideNumber: number, prefix: string): string {
  return `${prefix}${slideNumber.toString()}${SLIDE_FILENAME_SUFFIX}`
}

/**
`formatSlideFilename` が作る名前から N を取り出す。形式に合わない名前は undefined
（merge 入力の走査が slides/ 内の無関係なファイルを拾わないようにするため）。

正規表現へ prefix を埋め込むとエスケープの考慮が要るので文字列操作で書く。
*/
export function parseSlideFilename(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith(SLIDE_FILENAME_SUFFIX)) return undefined
  const digits = name.slice(prefix.length, -SLIDE_FILENAME_SUFFIX.length)
  return /^\d+$/.test(digits) ? Math.trunc(Number(digits)) : undefined
}

/**
Phase 1 が staging へ書く `slides/animation-policy.json` のスキーマ版（#1070）。
書き手（infra/slidev-to-pptx/pipeline.ts）と読み手（commands/slidev-to-pptx/convert.ts）が同じ形を見ていることを確認する。
同一 run 内であっても、明示的に確認するために持たせる。
形式を変えたらここを上げる。読み手は不一致を拒否する。
*/
export const ANIMATION_POLICY_SCHEMA_VERSION = 1

export interface OnlySlideSpec {
  readonly slide: number
  // click 未指定 (--only N) は null、click=0 と区別が必要
  readonly click: number | null
}

export interface PipelineConfig {
  readonly presDir: string
  readonly templatePath: string
  readonly outputDir: string
  readonly slidePrefix: string
  readonly port: number
  // onlySlide 未指定は null で表現する (旧 lib 仕様の踏襲)
  readonly onlySlide: OnlySlideSpec | null
  readonly concurrency: number
  readonly logLevel: string
  // Phase 2+3 (旧 Python pptx-postprocess による merge) を skip する。
  // pecotv slide convert (TS 方式) は Phase 1 のみで完結する。
  // merge は cli 側の domain/pptx-ooxml/merge.ts + post-process.ts で実施するため、true で呼ぶ。
  readonly skipPostprocess?: boolean
  // 変換対象 slide 番号を絞り込む (各 slide の click 0 のみ)。指定時は scan/onlySlide
  // 双方を bypass し、与えた番号配列をそのまま step とする。
  readonly onlySteps?: readonly number[]
  // exportToPptx へ渡す変換オプション。未指定は defaultExportToPptxOptions。
  // envHash の材料でもあるため、値を変えると全キャッシュが無効化される。
  readonly exportOptions?: ExportToPptxOptions
  // 1 パス方式（#1141 で試作、#1147 で既定 on）。print ルートを 1 回開いて全ステップを同じページ
  // から変換する。全走査の run でだけ有効（history / hash どちらのルータも対象）で、それ以外・
  // 前提が欠ける場合（print ルートの無い build 等）は現行方式へ退避する。既定 on の決定と env
  // （PECOTV_SINGLE_PASS）・`--no-single-pass` の解釈は index.ts の組み立てだけが行い、ここでは
  // true のときだけ有効。現行方式と同じ browser・同じ staging・同じキャッシュディレクトリを使うが、
  // envHash には方式（route）が入るため、方式を切り替えた run は全変換になる。
  readonly singlePass?: boolean
  // 1 パス方式のグループ数（= 同時に開くページ A / B のペア数）。未指定は concurrency。
  // 1 なら全ステップを 1 ペアで直列に変換する。env（PECOTV_SINGLE_PASS_CONCURRENCY）を読むのは index.ts だけ。
  readonly singlePassConcurrency?: number
  // pptx 差分キャッシュの設定。未指定なら判定と保存の両方をしない (全変換のみ)。
  // 指定しても、onlySlide / onlySteps の部分実行では読み書きしない。
  // 部分スキャン結果でキャッシュを判定・prune すると、生存エントリまで消えるため。
  readonly cache?: {
    // envHash の材料。空文字なら cache-store が invalid-environment で拒否する。
    readonly pluginVersion: string
    // envHash の材料になるビルドオプション（`--theme` 等）。未指定は null。
    readonly theme: string | null
    // true にすると hit 判定だけを行わず全ステップを変換する (`--no-cache`)。
    // 保存・prune・manifest 更新は通常どおり動くため、完了時にキャッシュは
    // 今回の変換結果で再構築される (未指定の「cache 無し」= 保存もしない、とは別物)。
    // 部分実行 (onlySlide / onlySteps) はそもそも読み書きしないため本フラグの影響を受けない。
    readonly skipRead?: boolean
  }
}
