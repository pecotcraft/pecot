// Phase 1 のポート契約。infra 実装 (xmldom / yauzl / yazl) はここを参照する。
// Phase 1 では FontResolver は導入しない。
// Python 版 fix_japanese_fonts.py は CJK 正規表現判定のみで glyph 存在チェックを行わず、fontkit は過剰設計になるため。

import type { PipelineResult } from '../slidev-to-pptx/types.js'
import type { SpawnResult } from './spawn-result.js'

export interface XmlEngine {
  parse(buffer: Readonly<Buffer>): XmlDocument
  serialize(document: XmlDocument): Buffer
}

export interface XmlDocument {
  selectNodes(
    xpath: string,
    nsMap?: Readonly<Record<string, string>>,
  ): readonly XmlNode[]
  /**
  Document のルート要素を子として末尾に XML 文字列の要素を追加する。
  Python 版 _add_transition_to_tree は `tree.append(ac)` で、morph/fade の
  AlternateContent を root に挿入する。この操作を表す。
  */
  appendChildXml(xml: string): void
}

export interface XmlNode {
  /**
  自ノードを起点にした xpath 検索（`./` 起点で評価）。
  Python 版 lxml の `Element.xpath()` / `Element.find()` 相当。
  */
  selectNodes(
    xpath: string,
    nsMap?: Readonly<Record<string, string>>,
  ): readonly XmlNode[]
  /**
  要素名の prefix を除いた部分（`p:sldIdLst` なら `sldIdLst`）。
  */
  localName(): string
  /**
  属性値取得（未設定時 undefined）。
  */
  getAttr(name: string): string | undefined
  setAttr(name: string, value: string): void
  /**
  要素直下の text content を返す（lxml の `Element.text` 相当）。
  */
  text(): string
  setText(value: string): void
  /**
  自ノードを親要素から削除する。
  */
  remove(): void
  /**
  自ノードを XML 文字列で表現された新ノードに置き換える。
  */
  replaceWithXml(xml: string): void
  /**
  XML 文字列で表現される新要素を自ノードの子として末尾に追加する。
  */
  appendChildXml(xml: string): void
  /**
  `appendChildXml` と対称、sibling 挿入 API。Python 旧版
  `rpr.insert(latin_index + 1, ea_elem)` の sibling 順序を保つために使う。
  */
  addNextSiblingXml(xml: string): void
  /**
  自ノードを同じ親の末尾へ移動する（子の並べ替え用）。
  `p:presentation` の子を CT_Presentation の sequence 順に直すために使う。
  */
  moveToEnd(): void
}

export interface PptxArchive {
  read(path: string): Promise<PptxReader>
  write(): PptxWriter
}

export interface PptxEntry {
  readonly part: string
  read(): Promise<Buffer>
}

export interface PptxReader {
  read(part: string): Promise<Buffer>
  entries(): AsyncIterable<PptxEntry>
  close(): Promise<void>
}

export interface PptxWriter {
  addBuffer(part: string, buffer: Readonly<Buffer>): void
  addReadStream(part: string, getStream: () => NodeJS.ReadableStream): void
  finish(outputPath: string): Promise<void>
}

/**
PPTX を soffice (LibreOffice headless) 経由で PDF 化する port。
`pecotv pptx preview` が、プレビュー正規化済みの一時 PPTX を PDF へレンダリングするときに
利用する。fake 差し替えで command テストを soffice 非依存にする（SlidevRunner と同流儀）。

実装は soffice の出力 PDF を outputDirectory/<inputStem>.pdf に書き出す。soffice が変換失敗でも
exit 0 を返す既知挙動があるため、成否判定（PDF 実在・非空）は呼び出し元の責務とする。
*/
export interface PdfConverter {

  convertToPdf(arguments_: Readonly<PdfConvertArguments>): Promise<PdfConvertResult>
}

export interface PdfConvertArguments {
  /**
  PDF 化する入力 PPTX の絶対 path。
  */
  readonly inputPath: string
  /**
  生成 PDF を書き出す出力ディレクトリの絶対 path。
  */
  readonly outputDirectory: string
  readonly timeoutMs: number
}

export interface PdfConvertResult {
  /**
  生成された PDF の絶対 path（outDir/<inputStem>.pdf）。
  */
  readonly pdfPath: string
}

/**
Slidev build (`npx slidev build`) を起動する port。
Phase 2 では `npx slidev build [--theme <name>]` を `projectDirectory` を cwd で実行する。
*/
export interface SlidevRunner {
  build(
    projectDirectory: string,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
    options: Readonly<{
      theme?: string
      timeoutMs: number
      stdout?: NodeJS.WritableStream
      stderr?: NodeJS.WritableStream
      /**
      abort すると子プロセスを止める（MCP のキャンセル）。
      */
      signal?: AbortSignal
    }>,
  ): Promise<SpawnResult>
}

/**
Slidev 出力ディレクトリ (`dist/`) から PPTX を生成する port。
#491 Step 3 で in-process 同一プロセス pipeline (`infra/slidev-to-pptx/`) に統合された。
旧 subprocess 起動 (`node convert-slidev-to-pptx.js ...`) は廃止された。

`skipPostprocess: true` を渡すと、Phase 2+3 (旧 Python pptx-postprocess 相当の merge) を skip する。
その場合は単スライド PPTX (slides/<prefix><N>.pptx) のみが生成される。
pecotv slide convert はこちらを利用し、merge は cli 側 `domain/pptx-ooxml/merge.ts` で実施する。
*/
export interface SlidevPptxPipeline {
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
  convert(arguments_: Readonly<SlidevPptxConvertArguments>): Promise<PipelineResult>
}

export interface SlidevPptxConvertArguments {
  readonly presDirectory: string
  readonly targetDirectory: string
  readonly outputDirectory: string
  /**
  進捗が無い時間の上限 (ms)。合計時間の上限ではない。pipeline はスキャンで 1 ステップ
  検出するごと、スライド 1 ステップの変換が終わるごとに進捗を報告し、そのたびに
  計時をやり直す。上限内に次の進捗が無ければ `PipelineTimeoutError` で打ち切る。
  */
  readonly idleTimeoutMs: number
  /**
  abort すると pipeline を中断する（MCP のキャンセル）。無進捗タイムアウトの打ち切りとは別に働く。
  */
  readonly signal?: AbortSignal
  readonly skipPostprocess?: boolean
  readonly stdout?: NodeJS.WritableStream
  readonly stderr?: NodeJS.WritableStream
  /**
  既定 0 (ephemeral)。dist/ を serve する HTTP server の port。0 のときは OS が空き
  ポートを採番し、bind された実ポートで配信・スクレイプする。
  */
  readonly port?: number
  /**
  既定 4。slide 並列変換数。
  */
  readonly concurrency?: number
  /**
  既定 'normal'。`'normal'|'verbose'|'debug'`。Logger の verbosity。
  */
  readonly logLevel?: string
  /**
  指定するとステップ単位の差分キャッシュが有効になり、値は envHash の材料になる
  （プラグイン版数が変われば全キャッシュが無効化される）。未指定は全変換。
  */
  readonly cachePluginVersion?: string
  /**
  `slidev build --theme` に渡した値。差分キャッシュ有効時は envHash の材料になる
  （テーマ切替後も旧描画のキャッシュがヒットしないようにするため）。未指定は null 扱い。
  */
  readonly theme?: string
  /**
  true にすると差分キャッシュの hit 判定をせず、全スライドを変換する（`--no-cache`）。
  保存側は通常どおり動くため、完了時にキャッシュは今回の変換結果で再構築される。
  */
  readonly cacheSkipRead?: boolean
  /**
  `false` のとき 1 パス方式を使わず現行方式（ステップごとにページを開く）で変換する
  （`--no-single-pass`）。env `PECOTV_SINGLE_PASS` より優先する。未指定は env に従う（既定 on）。
  */
  readonly singlePass?: false
  /**
  ステップ単位の進み具合の報告先。スキャンで総数が決まった時点で completed=0、以降は
  ステップが 1 つ終わるごとに呼ぶ（キャッシュ hit を含む。方式の退避でやり直しても二重に数えない）。
  */
  readonly onStepProgress?: (completed: number, total: number) => void
}
