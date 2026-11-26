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
    const directory = makeTemporaryDirectory()
    const first = path.join(directory, 'a.svg')
    const second = path.join(directory, 'b.svg')

    await runDrawioExport(RESOLVABLE_FIXTURE, { icons: ICON_ROOT, output: first, printHash: false, pdf: true }, buildDependencies())
    await runDrawioExport(RESOLVABLE_FIXTURE, { icons: ICON_ROOT, output: second, printHash: false, pdf: true }, buildDependencies())

    expect(readFileSync(first)).toEqual(readFileSync(second))
  })

  it('--output 省略時は <input>.svg に書き出す', async () => {
    const directory = makeTemporaryDirectory()
    const inputPath = path.join(directory, 'diagram.drawio')
    await fsWriteFile(inputPath, readFileSync(MINIMAL_FIXTURE, 'utf8'), 'utf8')

    const summary = await runDrawioExport(inputPath, { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true }, buildDependencies())

    expect(summary.outputFile).toBe(`${inputPath}.svg`)
    expect(readOutput(summary.outputFile)).toContain(SOURCE_HASH_ATTRIBUTE)
  })

  it('解決できない icon:// があれば export へ進まず fail する', async () => {
    const exportSvg = vi.fn<(xmlString: string) => Promise<string>>(() => Promise.resolve(EXPORTED_SVG))
    const outputPath = path.join(makeTemporaryDirectory(), 'out.svg')

    await expect(runDrawioExport(
      ICON_INCLUDED_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ exportSvg }),
    )).rejects.toMatchObject({ reason: 'icon-unresolved' })

    expect(exportSvg).not.toHaveBeenCalled()
  })

  it('--print-hash は export と書き出しのどちらも行わずハッシュだけを返す', async () => {
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

  it('--print-hash は icon が解決できなくても値を返す（判定は export 時に行う）', async () => {
    const summary = await runDrawioExport(
      ICON_INCLUDED_FIXTURE,
      { icons: ICON_ROOT, output: undefined, printHash: true, pdf: true },
      buildDependencies(),
    )

    expect(summary.sourceSha256).toMatch(/^[\da-f]{64}$/)
  })

  it('入力ファイルが読めなければ input-not-found で fail する', async () => {
    const missingInput = path.join(makeTemporaryDirectory(), 'missing.drawio')
    await expect(runDrawioExport(
      missingInput,
      { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true },
      buildDependencies(),
    )).rejects.toBeInstanceOf(DrawioExportRuntimeError)
  })

  it('export 失敗（オフライン・Chromium 不在）は export-failed で fail する', async () => {
    const output = path.join(makeTemporaryDirectory(), 'out.svg')
    await expect(runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output, printHash: false, pdf: true },
      buildDependencies({ exportSvg: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) }),
    )).rejects.toMatchObject({ reason: 'export-failed' })
  })

  it('書き込み失敗は output-write-failed で fail する', async () => {
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
  it('標準で SVG の兄弟 .pdf へ、書き出した SVG と同じ baked SVG を渡す', async () => {
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

  it('pdf: false では exportPdf を呼ばず、既存の兄弟 PDF にも触れない', async () => {
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

  it('PDF 生成に失敗したら前回の兄弟 PDF を削除する', async () => {
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

  it('前回の PDF を削除できなくても PDF 失敗 1 件に集約し、stderr だけで知らせる', async () => {
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

  it('多重拡張子は末尾だけを置換する (diagram.drawio.svg → diagram.drawio.pdf)', async () => {
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

  it('拡張子だけのファイル名 (-o .svg) は置換せず付加して .svg.pdf に書き出す', async () => {
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

  it('--output 省略時は <input>.svg の兄弟 <input>.pdf に書き出す', async () => {
    const exportPdf = pdfStub()
    const directory = makeTemporaryDirectory()
    const inputPath = path.join(directory, 'diagram.drawio')
    await fsWriteFile(inputPath, readFileSync(MINIMAL_FIXTURE, 'utf8'), 'utf8')

    const summary = await runDrawioExport(inputPath, { icons: ICON_ROOT, output: undefined, printHash: false, pdf: true }, buildDependencies({ exportPdf }))

    expect(summary.pdfFile).toBe(path.join(directory, 'diagram.drawio.pdf'))
  })

  it('-o の拡張子が .pdf なら入力を読む前に invalid-output-extension で止まる', async () => {
    const readFile = vi.fn<(filePath: string) => Promise<string>>(() => Promise.resolve(''))
    const outputPath = path.join(makeTemporaryDirectory(), 'diagram.PDF')

    await expect(runDrawioExport(
      RESOLVABLE_FIXTURE,
      { icons: ICON_ROOT, output: outputPath, printHash: false, pdf: true },
      buildDependencies({ readFile }),
    )).rejects.toMatchObject({ name: 'DrawioExportUsageError', reason: 'invalid-output-extension' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('pdf: false でも -o に .pdf を指定すると拒否し、.svg の指定を案内する', async () => {
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

  it('--print-hash は exportPdf を呼ばず、hash イベントのキー集合は従来のまま', async () => {
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
  it('writeFile は親ディレクトリを補完してから書き込む', async () => {
    const dependencies = drawioExportDefaultDependencies()
    const nested = path.join(makeTemporaryDirectory(), 'a', 'b', 'out.svg')

    await dependencies.writeFile(nested, '<svg/>')

    expect(readFileSync(nested, 'utf8')).toBe('<svg/>')
  })

  it('removeFile は存在しないファイルでも成功する', async () => {
    const dependencies = drawioExportDefaultDependencies()

    const missingPdf = path.join(makeTemporaryDirectory(), 'missing.pdf')
    await expect(dependencies.removeFile(missingPdf)).resolves.toBeUndefined()
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
