// drawio_export ツールの実装。commands/drawio/url.ts と同形の DI / 二段例外を採用する。
//
// 公開ビルドの draw.io 図を CDN 非依存にするため、パイプライン（公開フック）が
// 呼ぶ自動化の一部。生 XML をそのまま export すると `icon://` 参照が全滅する。
// そのため icon 解決 → export → color-scheme 固定 → 合成ハッシュ埋め込み の順で処理する。
//
// 標準で SVG の兄弟ファイル（拡張子を .pdf に置換）として PDF も書き出す。PDF の失敗は
// SVG を書いたうえで warning に落とす。`pdf: false` で抑止する。出力パスに `.pdf` は
// `pdf` の有無に関係なく指定できない（中身が SVG の `.pdf` を書かないため）。
//
// `printHash` は export を伴わず合成ハッシュだけを出す。公開フックが「既存 SVG が
// 現在の入力と対応しているか」を判定するためのルート。
// ハッシュの組み立て規則をフック側の bash に複製しないよう、ツール側へ寄せている。

// input/output はツールの引数として受理する想定で、信頼境界外ではあるが open API 仕様。
/* eslint-disable security/detect-non-literal-fs-filename */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { collectIconReferences, computeSourceHash, embedSourceHash, forceLightColorScheme, resolveIconsForExport, siblingPath } from '../../domain/drawio/export.js'
import { createDiagnostics } from '../../diagnostics.js'
import { createIconResolver } from '../../infra/drawio/icons.js'
import { exportPdf } from '../../infra/drawio/pdf.js'
import { exportViaEmbed } from '../../infra/drawio/screenshot.js'

/**
`output` 省略時に付与する拡張子。`<xmlSrc>.svg` という公開物の命名規約と揃える。
*/
const OUTPUT_SUFFIX = '.svg'
/**
兄弟 PDF の拡張子。
*/
const PDF_EXTENSION = '.pdf'

export class DrawioExportUsageError extends Error {
  constructor(message: string, readonly reason: FailureReason) {
    super(message)
    this.name = 'DrawioExportUsageError'
  }
}

export class DrawioExportRuntimeError extends Error {
  constructor(message: string, readonly reason: FailureReason) {
    super(message)
    this.name = 'DrawioExportRuntimeError'
  }
}

export interface DrawioExportOptions {
  readonly icons: string
  readonly output: string | undefined
  readonly printHash: boolean
  /**
  SVG の兄弟ファイルとして PDF も書き出すか。
  */
  readonly pdf: boolean
}

export interface DrawioExportDependencies {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly readFile: (filePath: string) => Promise<string>
  readonly writeFile: (filePath: string, content: string) => Promise<void>
  readonly exportSvg: (xmlString: string) => Promise<string>
  readonly exportPdf: (svg: string, outputPath: string) => Promise<void>
  /**
  存在しないファイルの削除は成功扱いにする。
  */
  readonly removeFile: (filePath: string) => Promise<void>
}

export interface DrawioExportResultSummary {
  readonly inputFile: string
  readonly outputFile: string
  readonly sourceSha256: string
  readonly iconCount: number
  /**
  `printHash` はハッシュ算出だけを行い、export と書き出しは行わないため false。
  */
  readonly written: boolean
  /**
  書き出した PDF の絶対パス。PDF を要求しなかった・失敗したときは undefined。
  */
  readonly pdfFile: string | undefined
  /**
  PDF を要求して生成に失敗したら true。
  */
  readonly pdfFailed: boolean
  readonly warningCount: number
}

/**
出力パスの拡張子を確認する。`.pdf` は `pdf` の有無に関係なく拒否する。
PDF 同時出力時は兄弟 PDF が SVG 自身を上書きし、`pdf: false` 時は中身が SVG の `.pdf` が書かれるため。
`printHash` は何も書かないため確認しない。

入力の読み込みや Chromium の確認より先に呼べるよう、IO を伴わない純粋関数にしてある
（MCP の drawio_export も Chromium 確認の前にこれを呼ぶ）。
*/
export function assertOutputExtension(
  output: string | undefined,
  options: Readonly<Pick<DrawioExportOptions, 'printHash'>>,
): void {
  if (output === undefined || output === '' || options.printHash || (path.extname(output).toLowerCase() !== PDF_EXTENSION)) return
  throw new DrawioExportUsageError(
    `output cannot use the ${PDF_EXTENSION} extension: ${path.resolve(output)} (fix: the output is SVG, so use an extension such as ${OUTPUT_SUFFIX})`,
    'invalid-output-extension',
  )
}

export async function runDrawioExport(
  inputFile: string,
  options: Readonly<DrawioExportOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: DrawioExportDependencies,
): Promise<DrawioExportResultSummary> {
  const absoluteInput = path.resolve(inputFile)
  const absoluteOutput = options.output === undefined || options.output === ''
    ? `${absoluteInput}${OUTPUT_SUFFIX}`
    : path.resolve(options.output)

  // 入力の読み込みより先に確認して、UsageError のルートでは成果物を残さない。
  assertOutputExtension(options.output, options)
  // 兄弟 PDF は SVG の拡張子を `.pdf` に置換して置く。出力パスが `.svg` のように拡張子だけの
  // ファイル名では置換でなく付加となり、`.svg.pdf` ができる（規則は siblingPath に集約）。
  const pdfPath = siblingPath(absoluteOutput, PDF_EXTENSION)

  let xml: string
  try {
    xml = await dependencies.readFile(absoluteInput)
  }
  catch (error: unknown) {
    throw new DrawioExportRuntimeError(
      `cannot read input file: ${absoluteInput}: ${formatError(error)}`,
      'input-not-found',
    )
  }

  const iconRoot = path.resolve(options.icons)
  const resolveIcon = createIconResolver(iconRoot)

  // 陳腐化検知の基準は「生 XML + 参照 icon の内容」。XML 単体だと icon カタログの
  // 差し替えを検知できず、古い図をそのまま流用し続ける。
  const sourceSha256 = computeSourceHash(xml, resolveIcon)
  const iconCount = collectIconReferences(xml).length

  if (options.printHash) {
    return {
      inputFile: absoluteInput,
      outputFile: absoluteOutput,
      sourceSha256,
      iconCount,
      written: false,
      pdfFile: undefined,
      pdfFailed: false,
      warningCount: 0,
    }
  }

  const resolved = resolveIconsForExport(xml, resolveIcon)
  if (resolved.unresolved.length > 0) {
    throw new DrawioExportRuntimeError(
      `cannot resolve icon:// references (icons root: ${iconRoot}): ${resolved.unresolved.join(', ')}`,
      'icon-unresolved',
    )
  }
  let svg: string
  try {
    svg = await dependencies.exportSvg(resolved.xml)
  }
  catch (error: unknown) {
    throw new DrawioExportRuntimeError(
      `SVG export failed: ${formatError(error)}`,
      'export-failed',
    )
  }

  const baked = embedSourceHash(forceLightColorScheme(svg), sourceSha256)

  try {
    await dependencies.writeFile(absoluteOutput, baked)
  }
  catch (error: unknown) {
    throw new DrawioExportRuntimeError(
      `cannot write output file: ${absoluteOutput}: ${formatError(error)}`,
      'output-write-failed',
    )
  }

  const pdfResult = options.pdf
    ? await writeSiblingPdf(baked, pdfPath, dependencies)
    : { pdfFile: undefined, pdfFailed: false }

  return {
    inputFile: absoluteInput,
    outputFile: absoluteOutput,
    sourceSha256,
    iconCount,
    written: true,
    ...pdfResult,
    warningCount: pdfResult.pdfFailed ? 1 : 0,
  }
}

/**
公開物と同じ baked SVG（color-scheme 固定・ハッシュ埋め込み済）から兄弟 PDF を作る。
失敗は warning に落とし、前回の PDF が残っていれば消す（`pdf: null` の隣に古い PDF が
残ると、今回の出力と区別できない）。
*/
async function writeSiblingPdf(
  baked: string,
  pdfPath: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: DrawioExportDependencies,
): Promise<{ readonly pdfFile: string | undefined, readonly pdfFailed: boolean }> {
  try {
    await dependencies.exportPdf(baked, pdfPath)
    return { pdfFile: pdfPath, pdfFailed: false }
  }
  catch (error: unknown) {
    createDiagnostics(dependencies.stderr).warning(`PDF export failed: ${formatError(error)}`)
    // 古い PDF の削除失敗は独立した警告として数えない。今回の PDF 失敗 1 件（pdfFailed /
    // warnings: 1）に集約し、結果の data には出さず stderr の行だけで知らせる。
    // 呼び出し側は `pdf: null` を見て隣の PDF を今回の出力として扱わない前提にする。
    try {
      await dependencies.removeFile(pdfPath)
    }
    catch (removeError: unknown) {
      createDiagnostics(dependencies.stderr).warning(`cannot remove the previous PDF: ${pdfPath}: ${formatError(removeError)}`)
    }
    return { pdfFile: undefined, pdfFailed: true }
  }
}

/**
executeDrawioExport の結果。MCP ツールの ToolResult 組み立てはこれだけを見る。
*/
export interface DrawioExportExecution {
  /**
  ツールの structuredContent に載せる値。
  */
  readonly data: Readonly<Record<string, unknown>>
  /**
  書き出したファイルの絶対パス。`printHash` では空。
  */
  readonly artifacts: readonly string[]
  /**
  入力と参照 icon から算出した合成ハッシュ。
  */
  readonly sourceSha256: string
  /**
  書き出した SVG の絶対パス。`printHash` では undefined。
  */
  readonly outputFile: string | undefined
  /**
  書き出した PDF の絶対パス。PDF を出していなければ undefined。
  */
  readonly pdfFile: string | undefined
  readonly warningCount: number
}

/**
export（または `printHash` のハッシュ算出）を実行し、ツールの結果に載せる data を組み立てる。
*/
export async function executeDrawioExport(
  inputFile: string,
  options: Readonly<DrawioExportOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: DrawioExportDependencies,
): Promise<DrawioExportExecution> {
  const summary = await runDrawioExport(inputFile, options, dependencies)

  if (!summary.written) {
    return {
      data: {
        event: 'drawio.export.hash',
        file: summary.inputFile,
        sourceSha256: summary.sourceSha256,
        icons: summary.iconCount,
      },
      artifacts: [],
      sourceSha256: summary.sourceSha256,
      outputFile: undefined,
      pdfFile: undefined,
      warningCount: 0,
    }
  }

  return {
    data: {
      event: 'drawio.export.done',
      file: summary.outputFile,
      sourceSha256: summary.sourceSha256,
      icons: summary.iconCount,
      // eslint-disable-next-line unicorn/no-null -- PDF を出していないときに `pdf: null` を返すことが結果の契約
      pdf: summary.pdfFile ?? null,
      pdfFailed: summary.pdfFailed,
      warnings: summary.warningCount,
    },
    artifacts: summary.pdfFile === undefined ? [summary.outputFile] : [summary.outputFile, summary.pdfFile],
    sourceSha256: summary.sourceSha256,
    outputFile: summary.outputFile,
    pdfFile: summary.pdfFile,
    warningCount: summary.warningCount,
  }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

/* c8 ignore start -- 上記 2 種以外の throw は実装内に存在しない、防御網のみ */
export function errorToReason(error: unknown): FailureReason {
  if (error instanceof DrawioExportUsageError) return error.reason
  if (error instanceof DrawioExportRuntimeError) return error.reason
  return 'unknown'
}
/* c8 ignore stop */

export function drawioExportDefaultDependencies(): DrawioExportDependencies {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    readFile: (filePath: string) => readFile(filePath, 'utf8'),
    writeFile: async (filePath: string, content: string) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
    },
    exportSvg: async (xmlString: string) => {
      const buffer = await exportViaEmbed(xmlString, { format: 'svg' })
      return buffer.toString('utf8')
    },
    exportPdf,
    removeFile: (filePath: string) => rm(filePath, { force: true }),
  }
}
/* eslint-enable security/detect-non-literal-fs-filename */
