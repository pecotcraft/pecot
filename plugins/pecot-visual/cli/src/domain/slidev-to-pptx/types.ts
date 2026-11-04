// Slidev → PPTX pipeline が返す結果型。infra/slidev-to-pptx/ の実装とテストが共通参照する。

export interface SlideStep {
  readonly slideNumber: number
  // clickStep 未指定は null で表現する (旧 lib 仕様の踏襲)
  readonly clickStep: number | null
  readonly url: string
}

export interface PipelineError {
  readonly level: string
  readonly slideNumber?: number
  readonly selector?: string
  readonly message: string
}

/**
1 ステップの変換の工程別所要（ms）。
現行方式はステップごとにページを開くため、全キーが計測値になる。
1 パス方式ではページの用意（newPage〜inject）を全体で 1 回だけ行うため、それらは 0 になる。
全体分は `PipelineTiming.singlePass` に載る。
prerender は、1 パス方式では「撮影・差し替え」だけの時間。
1 パス方式の run でも、現行の worker へ回したステップ（`SinglePassTiming.fallbackSteps`）は、
newPage〜inject に計測値が入る。
そのため同じ run の中で、0 のステップと計測値のステップが混在する。
*/
export interface SlidePhases {
  readonly newPage: number
  readonly goto: number
  readonly visible: number
  readonly cssSettle: number
  readonly iframeLoad: number
  readonly inject: number
  readonly prerender: number
  readonly convert: number
  readonly restore: number
}

/**
1 パス方式の 1 グループ（print ページ A / B の 1 ペア）の所要（ms）。
*/
export interface SinglePassGroupTiming {
  /**
  このグループが扱うスライド番号（昇順）
  */
  readonly slides: readonly number[]
  /**
  このグループのステップ数（= コンテナ数）
  */
  readonly steps: number
  /**
  変換ページ。用意の途中で退避したグループでは undefined
  */
  readonly pageA?: Readonly<{
    goto: number
    visible: number
    cssSettle: number
    iframeLoad: number
    inject: number
  }>
  /**
  prerender 用の高解像度ページ。prerender 対象が無いグループでは開かないため undefined
  */
  readonly pageB?: Readonly<{
    goto: number
    wait: number
    scrollWarmup: number
  }>
  /**
  グループごと現行の worker に回したときの理由
  */
  readonly fallback?: string
  /**
  用意の時点では prerender 対象を検出できず、ステップ処理中に高解像度ページを開いた
  */
  readonly lazyPageB?: boolean
}

/**
1 パス方式で変換した run の所要。スライド番号で分けたグループごとにページ A / B を 1 ペアずつ持つ。
*/
export interface SinglePassGroupsTiming {
  /**
  判別子。1 パス方式で変換した run
  */
  readonly kind: 'converted'
  readonly groups: readonly SinglePassGroupTiming[]
  /**
  現行の worker に回したステップ（グループ単位の退避とステップ単位の失敗の両方。timing.perSlide と同じ表記）
  */
  readonly fallbackSteps: readonly string[]
}

/**
print ルートが build に無いと判定し、run 全体を現行方式（ステップ単位の並列）へ退避した run の所要。
全ステップは現行方式で変換され、perSlidePhases は現行方式の計測値になる。
*/
export interface SinglePassFallbackTiming {
  /**
  判別子。print ルートが無く run 全体を現行方式へ退避した run
  */
  readonly kind: 'printRouteMissing'
  /**
  退避の理由。グループは並列に判定し、最初に不在を返したグループの理由を載せる
  */
  readonly fallback: string
  /**
  1 パス方式を始めてから全グループの判定が終わる（各グループがページを開き・読み込み・判定し・
  閉じる）までの経過時間（ms）。グループは並列に動くため、グループごとの所要の合計ではない
  */
  readonly detectMs: number
}

/**
1 パス方式を試みた run の所要。変換した run はグループ別、run 全体を退避した run は理由と判定時間。
`kind` で判別する（`slide convert --json` の `timings.singlePass` にもそのまま載る）。
*/
export type SinglePassTiming = SinglePassGroupsTiming | SinglePassFallbackTiming

export interface PipelineTiming {
  readonly total: number
  readonly scan: number
  readonly phase1: number
  readonly phase2: number
  readonly perSlide: Readonly<Record<string, number>>
  /**
  変換したステップの工程別所要（キーは perSlide と同じ表記）。キャッシュ hit のステップは載らない
  */
  readonly perSlidePhases?: Readonly<Record<string, SlidePhases>>
  /**
  1 パス方式を試みた run だけ載る（print ルートが無く run 全体を退避した run を含む）
  */
  readonly singlePass?: SinglePassTiming
}

/**
既存キャッシュエントリの無効化の種別。新規スライドの miss は無効化に数えない
(末尾追加は `none`)。contracts/cache-interface.md §2 の `cache.invalidated` と同値。

`all:key` はキー算出失敗（slides.md が読めない等）による全変換フォールバック。
`enabled: false` と併記される。
#898 の `--no-cache` は同じく `enabled: false` だが `invalidated: 'none'` なので、JSON 上で区別できる。

`all:error` はキャッシュ層の予期しない例外（cache-store の I/O 失敗等）による全変換フォールバック。
同じく `enabled: false` と併記される。
`--no-cache` および `all:key`（想定内のキー算出失敗）とは、JSON 上で区別できる。
*/
export type CacheInvalidation = 'none' | 'all:env' | 'all:manifest' | 'all:key' | 'all:error' | 'partial'

export interface PipelineCacheStep {
  readonly stepIndex: number
  /**
  timing.perSlide と同じステップ表記 (`"5"` / `"5/2"`)。stepIndex からは復元できない
  */
  readonly key: string
  readonly cache: 'hit' | 'miss'
}

export interface PipelineCacheSummary {
  /**
  キャッシュを実際に使ったか。キー算出に失敗して全変換へ退避した run は false
  */
  readonly enabled: boolean
  readonly hits: number
  readonly misses: number
  readonly invalidated: CacheInvalidation
  readonly perStep: readonly PipelineCacheStep[]
}

export interface PipelineResult {
  readonly success: boolean
  readonly slideCount: number
  /**
  Phase 1 の単スライド PPTX 群が書き出された slides ディレクトリの絶対パス
  (`<outputDir>/slides/`)。merge 後の最終 PPTX path は cli 側
  (`commands/slidev-to-pptx/convert.ts`) の `--out` 値が真値であり、本フィールドではない。
  */
  readonly slidesDirectory: string
  readonly errors: readonly PipelineError[]
  readonly warnings: readonly string[]
  readonly timing: PipelineTiming
  /**
  pptx 差分キャッシュの判定結果。キャッシュを扱わなかった run
  (config.cache 未指定 / onlySlide / onlySteps の部分実行) では undefined。
  */
  readonly cache?: PipelineCacheSummary
}
