// commands/drawio/export.ts の integration test。
// embed API への実アクセスは DI の exportSvg スタブで置き換える。
// icon 解決 → export → color-scheme 固定 → SHA-256 埋め込み → 書き出しの系列を検証する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DrawioExportRuntimeError,
  drawioExportDefaultDependencies,
  errorToReason,
  executeDrawioExport,
  runDrawioExport,
} from '../../../src/commands/drawio/export.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { SOURCE_HASH_ATTRIBUTE, collectIconReferences, computeSourceHash, readSourceHash } from '../../../src/domain/drawio/export.js'
import { createIconResolver } from '../../../src/infra/drawio/icons.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { readOutput } from '../../_helpers/attach.js'
import { makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'
import { explains } from '../../_helpers/explains.js'

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const ICON_ROOT = path.join(PLUGIN_ROOT, 'assets', 'drawio-icons')
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures', 'drawio')
const RESOLVABLE_FIXTURE = path.join(FIXTURES, 'icon-resolvable.drawio')
const ICON_INCLUDED_FIXTURE = path.join(FIXTURES, 'icon-included.drawio')
const MINIMAL_FIXTURE = path.join(FIXTURES, 'minimal.drawio')

// editor が返す SVG を模した最小応答。ルートに color-scheme: light dark を持つ。
const EXPORTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; color-scheme: light dark;" width="840px"><g/></svg>'

// write メソッドを持つ stub を直接渡す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream として narrowing
  return captured as unknown as NodeJS.WritableStream
}

function buildDependencies(overrides: Partial<{
  readonly readFile: (filePath: string) => Promise<string>
  readonly writeFile: (filePath: string, content: string) => Promise<void>
  readonly exportSvg: (xmlString: string) => Promise<string>
  readonly exportPdf: (svg: string, outputPath: string) => Promise<void>
  readonly removeFile: (filePath: string) => Promise<void>
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}> = {}): ReturnType<typeof drawioExportDefaultDependencies> {
  return {
    stdout: overrides.stdout ?? asStream(makeStream()),
    stderr: overrides.stderr ?? asStream(makeStream()),
    readFile: overrides.readFile ?? ((filePath: string) => Promise.resolve(readFileSync(filePath, 'utf8'))),
    writeFile: overrides.writeFile ?? ((filePath: string, content: string) => fsWriteFile(filePath, content, 'utf8')),
    exportSvg: overrides.exportSvg ?? (() => Promise.resolve(EXPORTED_SVG)),
    exportPdf: overrides.exportPdf ?? (() => Promise.resolve()),
    removeFile: overrides.removeFile ?? ((filePath: string) => fsRm(filePath, { force: true })),
  }
}

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-drawio-export-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('runDrawioExport', () => {
  it('icon:// を全件 data URI に解決してから export へ渡す', async () => {
    await explains('`runDrawioExport` の `icon://` の解決のテストです。2 件の `icon://` を含む図を書き出す場合に、すべて data URI に置き換えた XML を export へ渡すことを確認します。')
    const exportSvg = vi.fn<(xmlString: string) => Promise<string>>(() => Promise.resolve(EXPORTED_SVG))
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ exportSvg }),
    )

    const sourceXml = readFileSync(RESOLVABLE_FIXTURE, 'utf8')
    const iconCount = collectIconReferences(sourceXml).length
    expect(iconCount).toBe(2)
    expect(summary.iconCount).toBe(iconCount)

    const passedXml = exportSvg.mock.calls[0]?.[0] ?? ''
    expect(passedXml).not.toContain('icon://')
    expect(passedXml.match(/data:image\/svg\+xml,/g)).toHaveLength(iconCount)
  })

  it('書き出す SVG は color-scheme が light 固定で、入力の合成ハッシュを持つ', async () => {
    await explains('`runDrawioExport` が書き出す SVG のテストです。書き出した SVG が `color-scheme: light;` を持ち、入力と画像から計算した合成ハッシュを持つことを確認します。')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies(),
    )

    const written = readOutput(outputPath)
    const expectedSha = computeSourceHash(
      readFileSync(RESOLVABLE_FIXTURE, 'utf8'),
      createIconResolver(ICON_ROOT),
    )

    expect(written).toContain('color-scheme: light;')
    expect(written).not.toContain('light dark')
    expect(readSourceHash(written)).toBe(expectedSha)
    expect(summary.sourceSha256).toBe(expectedSha)
    expect(summary.outputFile).toBe(outputPath)
  })

  it('同一入力・同一 export 応答なら 2 回の出力がバイト一致する', async () => {
    await explains('`runDrawioExport` の再現性のテストです。同じ入力と同じ export の応答で 2 回書き出した場合に、2 つの SVG がバイト単位で一致することを確認します。')
    const directory = makeTemporaryDirectory()
    const first = path.join(directory, 'a.svg')
    const second = path.join(directory, 'b.svg')

    await runDrawioExport(RESOLVABLE_FIXTURE, { icons: ICON_ROOT, output: first, printHash: false, pdf: true }, buildDependencies())
    await runDrawioExport(RESOLVABLE_FIXTURE, { icons: ICON_ROOT, output: second, printHash: false, pdf: true }, buildDependencies())

    expect(readFileSync(first)).toEqual(readFileSync(second))
  })

  it('--output 省略時は <input>.svg に書き出す', async () => {
    await explains('`runDrawioExport` の出力先の既定値のテストです。出力先を省略した場合に、入力のファイル名に `.svg` を付けたパスへ書き出し、合成ハッシュを含むことを確認します。')
    const directory = makeTemporaryDirectory()
    const inputPath = path.join(directory, 'diagram.drawio')
    await fsWriteFile(inputPath, readFileSync(MINIMAL_FIXTURE, 'utf8'), 'utf8')

    const summary = await runDrawioExport(inputPath, { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true }, buildDependencies())

    expect(summary.outputFile).toBe(`${inputPath}.svg`)
    expect(readOutput(summary.outputFile)).toContain(SOURCE_HASH_ATTRIBUTE)
  })

  it('解決できない `icon://` があれば、export へ進まず `icon-unresolved` で失敗する', async () => {
    await explains('`runDrawioExport` の `icon://` の検証のテストです。解決できない `icon://` を含む図の場合に、export を呼ばず、`icon-unresolved` で失敗することを確認します。')
    const exportSvg = vi.fn<(xmlString: string) => Promise<string>>(() => Promise.resolve(EXPORTED_SVG))
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    await expect(runDrawioExport(
      ICON_INCLUDED_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ exportSvg }),
    )).rejects.toMatchObject({ reason: 'icon-unresolved' })

    expect(exportSvg).not.toHaveBeenCalled()
  })

  it('`--print-hash` は export と書き出しを行わず、ハッシュだけを返す', async () => {
    await explains('`runDrawioExport` のハッシュだけを返す指定のテストです。`printHash` を指定した場合に、export を呼ばず、ファイルも書き出さず、入力から計算したハッシュを返すことを確認します。')
    const exportSvg = vi.fn<(xmlString: string) => Promise<string>>(() => Promise.resolve(EXPORTED_SVG))
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: true, pdf: true },
      buildDependencies({ exportSvg }),
    )

    expect(summary.written).toBe(false)
    expect(exportSvg).not.toHaveBeenCalled()
    expect(existsSync(outputPath)).toBe(false)
    expect(summary.sourceSha256).toBe(
      computeSourceHash(readFileSync(RESOLVABLE_FIXTURE, 'utf8'), createIconResolver(ICON_ROOT)),
    )
  })

  it('`--print-hash` は、`icon://` が解決できなくてもハッシュを返す', async () => {
    await explains('`runDrawioExport` のハッシュだけを返す指定のテストです。解決できない `icon://` を含む図でも、解決の判定は export のときに行うため、64 桁の 16 進数のハッシュを返すことを確認します。')
    const summary = await runDrawioExport(
      ICON_INCLUDED_FIXTURE,
      { icons: ICON_ROOT, output: undefined, printHash: true, pdf: true },
      buildDependencies(),
    )

    expect(summary.sourceSha256).toMatch(/^[\da-f]{64}$/)
  })

  it('入力ファイルを読めなければ、`input-not-found` で失敗する', async () => {
    await explains('`runDrawioExport` の入力の検証のテストです。存在しない入力ファイルを指定した場合に、`DrawioExportRuntimeError` の例外が発生することを確認します。')
    const missingInput = path.join(makeTemporaryDirectory(), 'missing.drawio')
    await expect(runDrawioExport(
      missingInput,
      { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true },
      buildDependencies(),
    )).rejects.toBeInstanceOf(DrawioExportRuntimeError)
  })

  it('オフラインや Chromium の不在で export に失敗すると、`export-failed` で失敗する', async () => {
    await explains('`runDrawioExport` の export の失敗のテストです。export がネットワークの切断で失敗した場合に、`export-failed` の理由で失敗することを確認します。')
    const output = path.join(makeTemporaryDirectory(), 'out.svg')
    await expect(runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output, printHash: false, pdf: true },
      buildDependencies({ exportSvg: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) }),
    )).rejects.toMatchObject({ reason: 'export-failed' })
  })

  it('書き込みに失敗すると、`output-write-failed` で失敗する', async () => {
    await explains('`runDrawioExport` の書き込みの失敗のテストです。書き込みが権限のエラーで失敗した場合に、`output-write-failed` の理由で失敗することを確認します。')
    const output = path.join(makeTemporaryDirectory(), 'out.svg')
    await expect(runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output, printHash: false, pdf: true },
      buildDependencies({ writeFile: () => Promise.reject(new Error('EACCES')) }),
    )).rejects.toMatchObject({ reason: 'output-write-failed' })
  })
})

describe('executeDrawioExport の結果', () => {
  it('成功時は done の data に file と icons 数を載せる', async () => {
    await explains('`executeDrawioExport` の成功時の結果のテストです。図の書き出しが成功した場合は、`drawio.export.done` のイベントへ出力先と解決したアイコンの数が含まれ、警告が 0 件であることを確認します。')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: false },
      buildDependencies(),
    )

    expect(execution.data).toMatchObject({ event: 'drawio.export.done', file: outputPath, icons: 2 })
    expect(execution.warningCount).toBe(0)
  })

  it('printHash は export を行わず hash の data とハッシュ値だけを返す', async () => {
    await explains('`executeDrawioExport` の `printHash` のテストです。`printHash` を指定した場合に、書き出しを行わず、`drawio.export.hash` のイベントとハッシュ値だけを返し、成果物が空であることを確認します。')
    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: undefined, printHash: true, pdf: false },
      buildDependencies(),
    )

    const expected = computeSourceHash(readFileSync(RESOLVABLE_FIXTURE, 'utf8'), createIconResolver(ICON_ROOT))
    expect(execution.sourceSha256).toBe(expected)
    expect(execution.data).toMatchObject({ event: 'drawio.export.hash', icons: 2, sourceSha256: expected })
    expect(execution.artifacts).toEqual([])
  })

  it('解決できない icon は icon-unresolved の runtime error になる', async () => {
    await explains('`executeDrawioExport` の `icon://` の解決のテストです。解決できない `icon://` を含む図を書き出す場合に、`DrawioExportRuntimeError` が発生し、理由が `icon-unresolved` になることを確認します。')
    const error = await rejectionOf(executeDrawioExport(
      ICON_INCLUDED_FIXTURE,
      { icons: ICON_ROOT, output: undefined, printHash: false, pdf: false },
      buildDependencies(),
    ))

    expect(error).toBeInstanceOf(DrawioExportRuntimeError)
    expect(errorToReason(error)).toBe('icon-unresolved')
  })
})

function pdfStub(): ReturnType<typeof vi.fn<(svg: string, outputPath: string) => Promise<void>>> {
  return vi.fn<(svg: string, outputPath: string) => Promise<void>>(() => Promise.resolve())
}

describe('兄弟 PDF', () => {
  it('標準では、SVG の兄弟の `.pdf` へ、書き出した SVG と同じ内容の SVG を渡す', async () => {
    await explains('兄弟の PDF の書き出しのテストです。PDF の指定を変えない場合に、SVG と同じ場所の `.pdf` を出力先として、書き出した SVG と同じ内容を PDF の生成へ渡すことを確認します。')
    const exportPdf = pdfStub()
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ exportPdf }),
    )

    const pdfPath = path.join(path.dirname(outputPath), 'out.pdf')
    expect(exportPdf).toHaveBeenCalledTimes(1)
    expect(exportPdf.mock.calls[0]?.[1]).toBe(pdfPath)
    const passedSvg = exportPdf.mock.calls[0]?.[0] ?? ''
    expect(passedSvg).toBe(readOutput(outputPath))
    expect(passedSvg).toContain(SOURCE_HASH_ATTRIBUTE)
    expect(passedSvg).toContain('color-scheme: light;')
    expect(summary).toMatchObject({ pdfFile: pdfPath, pdfFailed: false, warningCount: 0 })
  })

  it('`pdf: false` では PDF を生成せず、既存の兄弟の PDF にも触れない', async () => {
    await explains('兄弟の PDF の書き出しのテストです。`pdf: false` を指定した場合に、PDF の生成と削除を呼ばず、既存の PDF が変わらず、終了コードが 0 であることを確認します。')
    const exportPdf = pdfStub()
    const removeFile = vi.fn<(filePath: string) => Promise<void>>(() => Promise.resolve())
    const directory = makeTemporaryDirectory()
    const outputPath = path.join(directory, 'out.svg')
    const stalePdf = path.join(directory, 'out.pdf')
    await fsWriteFile(stalePdf, '%PDF-old', 'utf8')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: false },
      buildDependencies({ exportPdf, removeFile }),
    )

    expect(exportPdf).not.toHaveBeenCalled()
    expect(removeFile).not.toHaveBeenCalled()
    expect(readFileSync(stalePdf, 'utf8')).toBe('%PDF-old')
    expect(execution.artifacts).toEqual([outputPath])
    // eslint-disable-next-line unicorn/no-null -- PDF を出さないときの `pdf: null` を pin する
    expect(execution.data).toMatchObject({ pdf: null, pdfFailed: false, warnings: 0 })
  })

  it('PDF 生成に失敗しても SVG は残り、pdf: null / pdfFailed / warnings 1 になる', async () => {
    await explains('`executeDrawioExport` の PDF の生成に失敗した場合のテストです。PDF の生成が失敗した場合に、SVG を残し、結果が `pdf: null`・`pdfFailed: true`・警告 1 件になり、標準エラー出力へ警告を表示することを確認します。')
    const stderr = makeStream('stderr')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ stderr: asStream(stderr), exportPdf: () => Promise.reject(new Error('chromium crashed')) }),
    )

    expect(existsSync(outputPath)).toBe(true)
    expect(execution.data).toMatchObject({
      event: 'drawio.export.done',
      file: outputPath,
      // eslint-disable-next-line unicorn/no-null -- CLI の --json で PDF 失敗時に `pdf: null` を pin する
      pdf: null,
      pdfFailed: true,
      warnings: 1,
    })
    expect(execution.artifacts).toEqual([outputPath])
    expect(execution.pdfFile).toBeUndefined()
    expect(execution.warningCount).toBe(1)
    expect(execution.warningCount).toBe(1)
    expect(stderr.chunks.join('')).toContain('warning: PDF export failed: chromium crashed')
  })

  it('PDF の生成に失敗したら、前回の兄弟の PDF を削除する', async () => {
    await explains('兄弟の PDF の生成に失敗した場合のテストです。前回の PDF があるときに PDF の生成が失敗した場合に、古い PDF を削除し、SVG は残ることを確認します。')
    const directory = makeTemporaryDirectory()
    const outputPath = path.join(directory, 'out.svg')
    const stalePdf = path.join(directory, 'out.pdf')
    await fsWriteFile(stalePdf, '%PDF-old', 'utf8')

    await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ exportPdf: () => Promise.reject(new Error('boom')) }),
    )

    expect(existsSync(stalePdf)).toBe(false)
    expect(existsSync(outputPath)).toBe(true)
  })

  it('前回の PDF を削除できなくても、PDF の失敗 1 件にまとめ、標準エラー出力だけで知らせる', async () => {
    await explains('兄弟の PDF の削除に失敗した場合のテストです。PDF の生成と削除が失敗した場合に、警告を 1 件にまとめ、終了コード 3 で、削除できなかったことを標準エラー出力へ表示することを確認します。')
    const stderr = makeStream('stderr')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({
        stderr: asStream(stderr),
        exportPdf: () => Promise.reject(new Error('boom')),
        removeFile: () => Promise.reject(new Error('EACCES')),
      }),
    )

    // 削除失敗は独立した警告に数えない（JSON のキーも増やさない）。
    // eslint-disable-next-line unicorn/no-null -- PDF 失敗時の `pdf: null` を pin する
    expect(execution.data).toEqual(expect.objectContaining({ pdf: null, pdfFailed: true, warnings: 1 }))
    expect(Object.keys(execution.data).toSorted(compareStrings)).toEqual(['event', 'file', 'icons', 'pdf', 'pdfFailed', 'sourceSha256', 'warnings'])
    expect(execution.warningCount).toBe(1)
    expect(execution.warningCount).toBe(1)
    expect(stderr.chunks.join('')).toContain('cannot remove the previous PDF')
  })

  it('多重拡張子は末尾だけを置き換える（`diagram.drawio.svg` は `diagram.drawio.pdf` になる）', async () => {
    await explains('兄弟の PDF のパスの決め方のテストです。出力先が `diagram.drawio.svg` の場合に、末尾の拡張子だけを置き換え、`diagram.drawio.pdf` に書き出すことを確認します。')
    const exportPdf = pdfStub()
    const directory = makeTemporaryDirectory()

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: path.join(directory, 'diagram.drawio.svg'), printHash: false, pdf: true },
      buildDependencies({ exportPdf }),
    )

    expect(summary.pdfFile).toBe(path.join(directory, 'diagram.drawio.pdf'))
    expect(exportPdf.mock.calls[0]?.[1]).toBe(path.join(directory, 'diagram.drawio.pdf'))
  })

  it('拡張子だけのファイル名（`-o .svg`）は置き換えず、`.svg.pdf` として書き出す', async () => {
    await explains('兄弟の PDF のパスの決め方のテストです。出力先が `.svg` の場合に、拡張子を置き換えず、`.svg.pdf` に書き出すことを確認します。')
    const exportPdf = pdfStub()
    const directory = makeTemporaryDirectory()

    const summary = await runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: path.join(directory, '.svg'), printHash: false, pdf: true },
      buildDependencies({ exportPdf }),
    )

    expect(summary.outputFile).toBe(path.join(directory, '.svg'))
    expect(summary.pdfFile).toBe(path.join(directory, '.svg.pdf'))
  })

  it('出力先を省略すると、`<input>.svg` の兄弟の `<input>.pdf` に書き出す', async () => {
    await explains('兄弟の PDF のパスの決め方のテストです。出力先を省略した場合に、入力のファイル名に `.pdf` を付けたパスへ PDF を書き出すことを確認します。')
    const exportPdf = pdfStub()
    const directory = makeTemporaryDirectory()
    const inputPath = path.join(directory, 'diagram.drawio')
    await fsWriteFile(inputPath, readFileSync(MINIMAL_FIXTURE, 'utf8'), 'utf8')

    const summary = await runDrawioExport(inputPath, { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true }, buildDependencies({ exportPdf }))

    expect(summary.pdfFile).toBe(path.join(directory, 'diagram.drawio.pdf'))
  })

  it('`-o` の拡張子が `.pdf` なら、入力を読む前に `invalid-output-extension` で止まる', async () => {
    await explains('`runDrawioExport` の出力先の拡張子の検証のテストです。`-o` に `.PDF` の拡張子を指定した場合に、入力を読まず、`invalid-output-extension` の使い方の誤りで失敗することを確認します。')
    const readFile = vi.fn<(filePath: string) => Promise<string>>(() => Promise.resolve(''))
    const outputPath = path.join(makeTemporaryDirectory(), 'diagram.PDF')

    await expect(runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ readFile }),
    )).rejects.toMatchObject({ name: 'DrawioExportUsageError', reason: 'invalid-output-extension' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('`pdf: false` でも `-o` に `.pdf` を指定すると拒否し、`.svg` の指定を案内する', async () => {
    await explains('`runDrawioExport` の出力先の拡張子の検証のテストです。`pdf: false` でも `-o` に `.pdf` を指定した場合に、拒否してファイルを作らず、`.svg` など別の拡張子を案内することを確認します。')
    const outputPath = path.join(makeTemporaryDirectory(), 'diagram.pdf')

    const rejected = runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: false },
      buildDependencies(),
    )

    await expect(rejected).rejects.toMatchObject({ name: 'DrawioExportUsageError', reason: 'invalid-output-extension' })
    await expect(rejected).rejects.toThrow('so use an extension such as .svg')
    await expect(rejected).rejects.not.toThrow('--no-pdf')
    expect(existsSync(outputPath)).toBe(false)
  })

  it('`--print-hash` は PDF を生成せず、hash のイベントのキーは従来のままにする', async () => {
    await explains('`executeDrawioExport` の `--print-hash` のテストです。`--print-hash` を指定した場合に、PDF の生成を呼ばず、結果のキーが `event`・`file`・`icons`・`sourceSha256` だけで、終了コード 0 であることを確認します。')
    const exportPdf = pdfStub()

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: undefined, printHash: true, pdf: true },
      buildDependencies({ exportPdf }),
    )

    expect(exportPdf).not.toHaveBeenCalled()
    expect(Object.keys(execution.data).toSorted(compareStrings)).toEqual(['event', 'file', 'icons', 'sourceSha256'])
    expect(execution.artifacts).toEqual([])
  })
})

describe('executeDrawioExport の PDF', () => {
  it('done の data に pdf / pdfFailed / warnings が載り、PDF のパスが返る', async () => {
    await explains('`executeDrawioExport` の PDF の結果のテストです。PDF の生成が成功した場合は、`drawio.export.done` のイベントへ PDF のパスと `pdfFailed: false`、警告 0 件が含まれることを確認します。')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies(),
    )

    expect(execution.data).toMatchObject({
      event: 'drawio.export.done',
      file: outputPath,
      pdf: path.join(path.dirname(outputPath), 'out.pdf'),
      pdfFailed: false,
      warnings: 0,
    })
  })

  it('pdf: false は exportPdf を呼ばない', async () => {
    await explains('`executeDrawioExport` の `pdf: false` のテストです。`pdf: false` を指定した場合に、PDF の生成を呼び出さないことを確認します。')
    const stderr = makeStream('stderr')
    const exportPdf = pdfStub()
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: false },
      buildDependencies({ stderr: asStream(stderr), exportPdf }),
    )

    expect(exportPdf).not.toHaveBeenCalled()
  })

  it('PDF 失敗は stderr に warning を出す', async () => {
    await explains('`executeDrawioExport` の PDF の警告のテストです。PDF の生成が失敗した場合は、標準エラー出力へ失敗の理由つきの警告を表示し、PDF のパスは表示せず、警告が 1 件になることを確認します。')
    const stderr = makeStream('stderr')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    const execution = await executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ stderr: asStream(stderr), exportPdf: () => Promise.reject(new Error('forced PDF failure')) }),
    )

    const written = stderr.chunks.join('')
    expect(written).toContain('warning: PDF export failed: forced PDF failure')
    expect(written).not.toContain('.pdf')
    expect(execution.warningCount).toBe(1)
  })

  it('出力が .pdf なら invalid-output-extension で成果物を残さない', async () => {
    await explains('`executeDrawioExport` の出力先の拡張子の検証のテストです。出力先に `.pdf` を指定した場合に、理由が `invalid-output-extension` のエラーになり、ファイルを作成しないことを確認します。')
    const outputPath = path.join(makeTemporaryDirectory(), 'diagram.pdf')

    const error = await rejectionOf(executeDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies(),
    ))

    expect(errorToReason(error)).toBe('invalid-output-extension')
    expect(existsSync(outputPath)).toBe(false)
  })
})

describe('drawioExportDefaultDependencies', () => {
  it('既定の `writeFile` は、親ディレクトリを作ってから書き込む', async () => {
    await explains('`drawioExportDefaultDependencies` の `writeFile` のテストです。存在しない親ディレクトリを含むパスを渡した場合に、親ディレクトリを作ってから、渡した内容を書き込むことを確認します。')
    const dependencies = drawioExportDefaultDependencies()
    const nested = path.join(makeTemporaryDirectory(), 'a', 'b', 'out.svg')

    await dependencies.writeFile(nested, '<svg/>')

    expect(readFileSync(nested, 'utf8')).toBe('<svg/>')
  })

  it('既定の `removeFile` は、存在しないファイルでも成功する', async () => {
    await explains('`drawioExportDefaultDependencies` の `removeFile` のテストです。存在しないファイルのパスを渡した場合に、エラーにならず、`undefined` で成功することを確認します。')
    const dependencies = drawioExportDefaultDependencies()

    const missingPdf = path.join(makeTemporaryDirectory(), 'missing.pdf')
    await expect(dependencies.removeFile(missingPdf)).resolves.toBeUndefined()
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
