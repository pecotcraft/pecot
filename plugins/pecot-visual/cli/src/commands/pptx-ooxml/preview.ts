// `pecotv pptx preview` 実装。
// dom-to-pptx 2.1.1 の `wrap="none"` + `<a:spAutoFit/>` を LibreOffice が中心基準 auto-size で描画する。
// この既知差異を補正したプレビュー PDF を生成する。
//
// 元 PPTX は一切変更しない。
// 全 entry を読み取り、slide part のみプレビュー正規化 (noAutofit + wrap=square) して mkdtemp に一時 PPTX を書き出す。
// soffice で PDF 化して --out へ copy する。一時 dir は finally で必ず削除する。
// 成果物生成ルート (slide convert) には組み込まない。

// 出力 path / report path / mkdtemp 先は CLI 引数由来で、リテラルではない。
// 本コマンド自身が出力先を生成する責務を持つため、本ファイル全体で security/detect-non-literal-fs-filename を disable する。
/* eslint-disable security/detect-non-literal-fs-filename */
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { Command } from 'commander'

import {
  applyPreviewNormalization,
  detectPreviewDivergence,
  type PreviewDivergenceFinding,
} from '../../domain/pptx-ooxml/preview-normalize.js'
import type { PdfConverter, PptxArchive, XmlEngine } from '../../domain/_shared/ports.js'
import { XmldomXmlEngine } from '../../infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../infra/pptx-ooxml/archive.js'
import {
  SofficePdfConverter,
  SofficeSpawnError,
  SofficeTimeoutError,
} from '../../infra/pptx-ooxml/soffice.js'

const SLIDE_PART_REGEX = /^ppt\/slides\/slide(\d+)\.xml$/
const SOFFICE_TIMEOUT_MS = 120_000

interface PreviewOptions {
  readonly out?: string
  readonly report?: string
  readonly detectOnly?: boolean
}

export interface PreviewDependencies {
  readonly archive: PptxArchive
  readonly engine: XmlEngine
  readonly pdfConverter: PdfConverter
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly now: () => number
}

/**
slide 番号付きの検知結果。レポート / イベントの 1 要素。
*/
export interface SlideFinding {
  readonly slide: number
  readonly rule: PreviewDivergenceFinding['rule']
  readonly shapeName?: string
}

export interface PreviewResultSummary {
  readonly inputAbs: string
  readonly outputAbs?: string
  readonly findings: readonly SlideFinding[]
  readonly normalized: number
  readonly detectOnly: boolean
  readonly durationMs: number
}

export class PreviewRuntimeError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'PreviewRuntimeError'
  }
}

function formatError(error: unknown): string {
  /* c8 ignore next -- 非 Error 例外は本実装範囲では未発生、防御網のみ */
  return error instanceof Error ? error.message : String(error)
}

function slideNumberOf(part: string): number {
  const match = SLIDE_PART_REGEX.exec(part)
  /* c8 ignore next 2 -- 呼び出し元が SLIDE_PART_REGEX.test 済の part のみ渡すため null / 捕捉群未定義は到達不能 */
  return match?.[1] === undefined ? 0 : Math.trunc(Number(match[1]))
}

/**
入力 PPTX の全 entry を読み取り、slide part をプレビュー正規化して一時 PPTX を書き出す。
findings（slide 番号付き）と書き出した一時 PPTX path を返す。入力は read-only。
*/
async function buildNormalizedPptx(
  inputAbs: string,
  temporaryPptxPath: string,
  // PptxArchive / XmlEngine の内部 method が mutable とみなされるため、interface readonly fields のみで担保。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: PreviewDependencies,
): Promise<{ readonly findings: readonly SlideFinding[], readonly normalized: number }> {
  const reader = await openInput(inputAbs, async inputPath => dependencies.archive.read(inputPath))

  const writer = dependencies.archive.write()
  const findings: SlideFinding[] = []
  let normalized = 0

  try {
    // slide part のみ正規化対象としてバッファ収集する。
    // それ以外 (rels / media / presentation.xml 等) は lazy passthrough で writer に積み直す。
    // 目的は media・presentation.xml の脱落防止。
    // 本コマンドは rels を mutate しないため、slide と非 slide の 2 分類で足りる。
    const slideBuffers = new Map<string, Buffer>()

    for await (const entry of reader.entries()) {
      if (SLIDE_PART_REGEX.test(entry.part)) {
        slideBuffers.set(entry.part, await entry.read())
      }
      else {
        // media (大型バイナリ) を全件メモリ展開しないよう、addReadStream で
        // finish 時に 1 件ずつ pull する lazy passthrough にする。read は
        // pull 時まで遅延する (finish は reader.close より前の try 内で呼ばれるため
        // pull 時に reader は open)。
        const entryReadThunk = entry.read.bind(entry)
        writer.addReadStream(
          entry.part,
          () => Readable.from((async function* (): AsyncGenerator<Buffer> {
            yield await entryReadThunk()
          })()),
        )
      }
    }

    for (const [slidePart, slideBuffer] of slideBuffers) {
      const slideDocument = dependencies.engine.parse(slideBuffer)
      const slide = slideNumberOf(slidePart)
      for (const finding of detectPreviewDivergence(slideDocument)) {
        findings.push(
          finding.shapeName === undefined
            ? { slide, rule: finding.rule }
            : { slide, rule: finding.rule, shapeName: finding.shapeName },
        )
      }
      const applied = applyPreviewNormalization(slideDocument)
      normalized += applied.normalized
      writer.addBuffer(slidePart, dependencies.engine.serialize(slideDocument))
    }

    await writer.finish(temporaryPptxPath)
  }
  finally {
    await reader.close()
  }

  // slide 番号昇順で安定化する (Map 反復順は挿入順 = archive 列挙順のため)。
  findings.sort((a, b) => a.slide - b.slide)
  return { findings, normalized }
}

/**
入力を一切変更せず、全 entry を読み取って findings のみ収集する（--detect-only ルート）。
*/
async function detectOnly(
  inputAbs: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 同上
  dependencies: PreviewDependencies,
): Promise<readonly SlideFinding[]> {
  const reader = await openInput(inputAbs, async inputPath => dependencies.archive.read(inputPath))
  const findings: SlideFinding[] = []
  try {
    for await (const entry of reader.entries()) {
      if (!SLIDE_PART_REGEX.test(entry.part)) continue
      const slideDocument = dependencies.engine.parse(await entry.read())
      const slide = slideNumberOf(entry.part)
      for (const finding of detectPreviewDivergence(slideDocument)) {
        findings.push(
          finding.shapeName === undefined
            ? { slide, rule: finding.rule }
            : { slide, rule: finding.rule, shapeName: finding.shapeName },
        )
      }
    }
  }
  finally {
    await reader.close()
  }
  findings.sort((a, b) => a.slide - b.slide)
  return findings
}

async function sha256Of(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  return createHash('sha256').update(buffer).digest('hex')
}

function inputOpenFailure(inputAbs: string, error: unknown): PreviewRuntimeError {
  return new PreviewRuntimeError(
    `input PPTX を開けません: ${inputAbs}: ${formatError(error)}`,
    'input-open-failed',
  )
}

/**
入力 PPTX の sha256。入力が無い・読めない場合は input-open-failed に倒す。
*/
async function inputSha256Of(inputAbs: string): Promise<string> {
  try {
    return await sha256Of(inputAbs)
  }
  catch (error: unknown) {
    throw inputOpenFailure(inputAbs, error)
  }
}

/**
入力 PPTX を開く。PDF ルート・detect-only ルートともに runPreview 冒頭の sha256Of が先に
input-open-failed を投げるため、ここでの失敗は到達不能な防御網。
*/
async function openInput(
  inputAbs: string,
  read: (inputPath: string) => ReturnType<PptxArchive['read']>,
): ReturnType<PptxArchive['read']> {
  try {
    return await read(inputAbs)
  }
  catch (error: unknown) {
    /* c8 ignore next 2 -- 上記のとおり到達不能。防御網 */
    throw inputOpenFailure(inputAbs, error)
  }
}

export async function runPreview(
  inputPath: string,
  options: Readonly<PreviewOptions>,
  // PptxArchive / XmlEngine / PdfConverter の内部 method は mutable とみなされる。
  // そのため interface の readonly fields のみで担保する。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: PreviewDependencies,
): Promise<PreviewResultSummary> {
  const inputAbs = path.resolve(inputPath)
  const start = dependencies.now()
  const isDetectOnlyMode = options.detectOnly === true

  if (isDetectOnlyMode) {
    // 入力不変を通常ルートと対称に sha256 で担保する (read-only 設計だが「入力不変」を売りにするため)。
    // 入力不在もここで input-open-failed に倒す (archive.read より前に読むため)。
    const detectInputSha = await inputSha256Of(inputAbs)
    const findings = await detectOnly(inputAbs, dependencies)
    const detectAfterSha = await sha256Of(inputAbs)
    /* c8 ignore next 6 -- detect-only は read-only 設計のため sha 変化ルートは到達不能。Acceptance 3 の防御網 */
    if (detectAfterSha !== detectInputSha) {
      throw new PreviewRuntimeError(
        `入力 PPTX が変更されました (sha256 mismatch): ${inputAbs}`,
        'input-mutated',
      )
    }
    const summary: PreviewResultSummary = {
      inputAbs,
      findings,
      normalized: 0,
      detectOnly: true,
      durationMs: dependencies.now() - start,
    }
    await writeReport(options.report, summary)
    return summary
  }

  // Acceptance 3 (入力不変) の二重担保: 実行前後の sha256 を比較する。
  // 入力不在もここで input-open-failed に倒す (archive.read より前に読むため)。
  const inputSha = await inputSha256Of(inputAbs)

  const stem = path.basename(inputAbs, path.extname(inputAbs))
  const outputAbs = options.out === undefined
    ? path.join(path.dirname(inputAbs), `${stem}.preview.pdf`)
    : path.resolve(options.out)

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pecotv-pptx-preview-'))
  try {
    // soffice の PDF 名が入力 stem 依存のため、一時 PPTX も同 stem で書き出す。
    const temporaryPptx = path.join(temporaryDirectory, `${stem}.pptx`)
    const { findings, normalized } = await buildNormalizedPptx(inputAbs, temporaryPptx, dependencies)

    const pdfOutputDirectory = path.join(temporaryDirectory, 'pdf')
    await mkdir(pdfOutputDirectory, { recursive: true })

    const pdfPath = await convertToPdf(temporaryPptx, pdfOutputDirectory, dependencies)

    await mkdir(path.dirname(outputAbs), { recursive: true })
    await copyFile(pdfPath, outputAbs)

    // 入力不変を最終確認する。
    const afterSha = await sha256Of(inputAbs)
    /* c8 ignore next 6 -- 入力は read-only 設計のため sha 変化ルートは到達不能。Acceptance 3 の防御網 */
    if (afterSha !== inputSha) {
      throw new PreviewRuntimeError(
        `入力 PPTX が変更されました (sha256 mismatch): ${inputAbs}`,
        'input-mutated',
      )
    }

    const summary: PreviewResultSummary = {
      inputAbs,
      outputAbs,
      findings,
      normalized,
      detectOnly: false,
      durationMs: dependencies.now() - start,
    }
    await writeReport(options.report, summary)
    return summary
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function convertToPdf(
  temporaryPptx: string,
  pdfOutputDirectory: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 同上
  dependencies: PreviewDependencies,
): Promise<string> {
  let result
  try {
    result = await dependencies.pdfConverter.convertToPdf({
      inputPath: temporaryPptx,
      outputDirectory: pdfOutputDirectory,
      timeoutMs: SOFFICE_TIMEOUT_MS,
    })
  }
  catch (error: unknown) {
    if (error instanceof SofficeTimeoutError) {
      throw new PreviewRuntimeError(
        `soffice の PDF 変換が ${String(error.timeoutMs)}ms でタイムアウトしました`,
        'soffice-timeout',
      )
    }
    if (error instanceof SofficeSpawnError) {
      throw new PreviewRuntimeError(
        `soffice (LibreOffice) が見つかりません。'sudo apt-get install -y libreoffice-impress'`
        + ` でインストールしてください: ${error.stderr}`,
        'soffice-not-found',
      )
    }
    /* c8 ignore next 5 -- PdfConverter は SofficeSpawnError / SofficeTimeoutError 以外を投げない契約。防御網 */
    throw new PreviewRuntimeError(
      `PDF 変換に失敗しました: ${formatError(error)}`,
      'soffice-conversion-failed',
    )
  }

  // soffice は変換失敗でも exit 0 を返すため、PDF の実在・非空を必須条件とする。
  // soffice 本体 (libreoffice-core) だけが入った環境では PPTX を load できず、
  // exit 0 + PDF 不在でこのルートに来る (#1072)。案内は soffice-not-found ではなく
  // ここに置かないと利用者に届かない。
  const pdfSize = await pdfFileSize(result.pdfPath)
  if (pdfSize === 0) {
    throw new PreviewRuntimeError(
      `soffice が PDF を生成できませんでした (出力 PDF が不在 or 空): ${result.pdfPath}`
      + `。PPTX の変換には libreoffice-impress が必要です`
      + ` ('sudo apt-get install -y libreoffice-impress')`,
      'soffice-conversion-failed',
    )
  }
  return result.pdfPath
}

/**
PDF の byte size を返す。不在なら 0（= 変換失敗扱い）。
*/
async function pdfFileSize(pdfPath: string): Promise<number> {
  try {
    const pdfStat = await stat(pdfPath)
    return pdfStat.size
  }
  catch {
    return 0
  }
}

async function writeReport(
  reportPath: string | undefined,
  summary: Readonly<PreviewResultSummary>,
): Promise<void> {
  if (reportPath === undefined) return
  const reportAbs = path.resolve(reportPath)
  const payload = JSON.stringify(
    {
      input: summary.inputAbs,
      output: summary.outputAbs,
      detectOnly: summary.detectOnly,
      normalized: summary.normalized,
      findings: summary.findings,
      durationMs: summary.durationMs,
    },
    undefined,
    2,
  )
  await mkdir(path.dirname(reportAbs), { recursive: true })
  await writeFile(reportAbs, payload, 'utf8')
}

export interface PptxPreviewOptions {
  readonly input: string
  /**
  省略時は `<input-dir>/<input-stem>.preview.pdf` を導出する (detect-only 時は出力しない)。
  */
  readonly out?: string
  readonly report?: string
  readonly detectOnly: boolean
}

/**
`--json` の成功イベント。detect-only では PDF を作らないため `output` キーごと落ちる。
*/
export interface PptxPreviewResultData {
  readonly event: 'pptx.preview.done'
  readonly input: string
  readonly output?: string
  readonly detectOnly: boolean
  readonly normalized: number
  readonly findings: readonly SlideFinding[]
  readonly durationMs: number
}

/**
プレビューを実行し、`--json` と同形の結果オブジェクトを返す。
CLI の action と MCP ツールはどちらもこの関数を呼ぶ (実行と結果組み立ての単一実装)。
*/
export async function executePptxPreview(
  options: Readonly<PptxPreviewOptions>,
  // PptxArchive / XmlEngine / PdfConverter の内部 method は mutable とみなされる。
  // そのため interface の readonly fields のみで担保する。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: PreviewDependencies,
): Promise<PptxPreviewResultData> {
  const summary = await runPreview(options.input, {
    detectOnly: options.detectOnly,
    ...(options.out !== undefined && { out: options.out }),
    ...(options.report !== undefined && { report: options.report }),
  }, dependencies)

  return {
    event: 'pptx.preview.done',
    input: summary.inputAbs,
    ...(summary.outputAbs !== undefined && { output: summary.outputAbs }),
    detectOnly: summary.detectOnly,
    normalized: summary.normalized,
    findings: summary.findings,
    durationMs: summary.durationMs,
  }
}

/**
実行失敗時の exit code。usage エラー (exit 2) は commander が cli.ts の main へ委譲するため、
本コマンド自身が設定するのは 1 のみ。
*/
export const PPTX_PREVIEW_FAILURE_EXIT_CODE = 1

export function errorToReason(error: unknown): string {
  /* c8 ignore next -- unknown フォールバックは防御網 */
  return error instanceof PreviewRuntimeError ? error.reason : 'unknown'
}

function formatFindingLine(finding: Readonly<SlideFinding>): string {
  const shape = finding.shapeName === undefined ? '(unnamed)' : `"${finding.shapeName}"`
  return `slide ${String(finding.slide)}: shape ${shape}`
    + ` — spAutoFit + wrap=none (LibreOffice で中央寄せ描画の既知差異)`
}

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

export function createPptxPreviewCommand(
  buildDependencies: () => PreviewDependencies,
): Command {
  const command = new Command('preview')
    .description(
      'PPTX のプレビュー PDF を生成する (LibreOffice 描画差異を補正)。元 PPTX は変更しない',
    )
    .argument('<input>', 'input .pptx path')
    .option('--out <path>', 'output .pdf path (省略時: <input-dir>/<input-stem>.preview.pdf)')
    .option('--json', 'emit machine-readable result on stdout', false)
    .option('--report <path>', 'write findings JSON to <path>')
    .option('--detect-only', 'soffice を呼ばず検知レポートのみ出力する', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          dependencies.stdout.write(JSON.stringify({
            event: 'pptx.preview.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:\s*/i, '').trim(),
          }) + '\n')
        }
        else {
          dependencies.stderr.write(string_)
        }
      },
    })
    .action(async (input: string, raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isJson = raw['json'] === true

      try {
        const data = await executePptxPreview({
          input,
          detectOnly: raw['detectOnly'] === true,
          ...((typeof raw['out'] === 'string') && { out: raw['out'] }),
          ...((typeof raw['report'] === 'string') && { report: raw['report'] }),
        }, dependencies)
        emitSuccess(dependencies, isJson, data)
      }
      catch (error: unknown) {
        const detail = formatError(error)
        if (isJson) {
          dependencies.stdout.write(JSON.stringify({
            event: 'pptx.preview.error',
            reason: errorToReason(error),
            detail,
          }) + '\n')
        }
        else {
          dependencies.stderr.write(`pecotv pptx preview: ${detail}\n`)
        }
        process.exitCode = PPTX_PREVIEW_FAILURE_EXIT_CODE
      }
    })
  return command
}

function emitSuccess(
  // WritableStream は内部 mutable。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: PreviewDependencies,
  isJson: boolean,
  data: Readonly<PptxPreviewResultData>,
): void {
  if (isJson) {
    dependencies.stdout.write(JSON.stringify(data) + '\n')
    return
  }

  for (const finding of data.findings) {
    dependencies.stdout.write(formatFindingLine(finding) + '\n')
  }
  if (data.detectOnly) {
    dependencies.stdout.write(
      `pptx preview (detect-only): ${data.input}`
      + ` (${String(data.findings.length)} findings)\n`,
    )
  }
  else {
    dependencies.stdout.write(
      `pptx preview: ${data.input} -> ${data.output ?? ''}`
      + ` (${String(data.findings.length)} findings,`
      + ` ${String(data.normalized)} normalized)\n`,
    )
  }
}

export function pptxPreviewDefaultDependencies(): PreviewDependencies {
  return {
    archive: new YauzlYazlPptxArchive(),
    engine: new XmldomXmlEngine(),
    pdfConverter: new SofficePdfConverter(),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => performance.now(),
  }
}
