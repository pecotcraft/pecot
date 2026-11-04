// commands/pptx-ooxml/preview.ts の unit test。
// 本物の XmldomXmlEngine + YauzlYazlPptxArchive (infra) を使う。
// yazl で in-test 生成した PPTX に対して、runPreview / createPptxPreviewCommand の各分岐を検証する。
// PdfConverter は FakePdfConverter で差し替え、soffice 非依存にする。

// tmpdir 配下に fixture を吐く都合で fs アクセスは全て non-literal path になる。
/* eslint-disable security/detect-non-literal-fs-filename */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { ZipFile as YazlZipFile } from 'yazl'

import {
  PreviewRuntimeError,
  createPptxPreviewCommand,
  pptxPreviewDefaultDependencies,
  runPreview,
} from '../../../src/commands/pptx-ooxml/preview.js'
import type { PreviewDependencies } from '../../../src/commands/pptx-ooxml/preview.js'
import type {
  PdfConvertArguments,
  PdfConvertResult,
  PdfConverter,
} from '../../../src/domain/_shared/ports.js'
import { XmldomXmlEngine } from '../../../src/infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../../src/infra/pptx-ooxml/archive.js'
import {
  SofficeSpawnError,
  SofficeTimeoutError,
  sofficePdfPath,
} from '../../../src/infra/pptx-ooxml/soffice.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const NS_PRESENTATIONML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const NS_DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main'

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

// write メソッドを持つ stub を直接渡す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream として narrowing
  return captured as unknown as NodeJS.WritableStream
}

function slideXml(options: {
  readonly divergent: boolean
  readonly shapeName?: string
}): string {
  const bodyPr = options.divergent
    ? `<a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr>`
    : `<a:bodyPr wrap="square"/>`
  const cNvPr = options.shapeName === undefined
    ? `<p:cNvPr id="2"/>`
    : `<p:cNvPr id="2" name="${options.shapeName}"/>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
    + `<p:cSld><p:spTree>`
    + `<p:sp><p:nvSpPr>${cNvPr}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:txBody>${bodyPr}<a:p><a:pPr algn="l"/><a:r><a:t>footer</a:t></a:r></a:p></p:txBody>`
    + `</p:sp>`
    + `</p:spTree></p:cSld></p:sld>`
}

/**
2 スライド構成 (slide1: divergent + name, slide2: 非対象) + media 1 件を含む
最小 PPTX を生成する。media と presentation.xml の passthrough 保全を検証するため。
*/
function buildPptx(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new YazlZipFile()
    const presentationXml
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
        + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/><p:sldId id="257" r:id="rId102"/></p:sldIdLst>`
        + `</p:presentation>`
    const presRels
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
        + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
        + `<Relationship Id="rId102" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>`
        + `</Relationships>`
    const slideRels
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}"/>`
    const contentTypes
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Types xmlns="${NS_CONTENT_TYPES}">`
        + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
        + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        + `<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        + `</Types>`
    zip.addBuffer(Buffer.from(presentationXml, 'utf8'), 'ppt/presentation.xml')
    zip.addBuffer(Buffer.from(presRels, 'utf8'), 'ppt/_rels/presentation.xml.rels')
    zip.addBuffer(Buffer.from(slideRels, 'utf8'), 'ppt/slides/_rels/slide1.xml.rels')
    zip.addBuffer(Buffer.from(slideRels, 'utf8'), 'ppt/slides/_rels/slide2.xml.rels')
    zip.addBuffer(Buffer.from(contentTypes, 'utf8'), '[Content_Types].xml')
    zip.addBuffer(Buffer.from(slideXml({ divergent: true, shapeName: 'footer-copyright' }), 'utf8'), 'ppt/slides/slide1.xml')
    zip.addBuffer(Buffer.from(slideXml({ divergent: false }), 'utf8'), 'ppt/slides/slide2.xml')
    // media バイナリ (passthrough 対象)
    zip.addBuffer(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'ppt/media/image1.png')
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (chunk: Readonly<Buffer | string>) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
    })
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    zip.outputStream.on('error', reject)
    zip.end()
  })
}

/**
convertToPdf 呼び出し時に渡された一時 PPTX を stash し、ダミー PDF を生成する FakePdfConverter。
behavior の値と動作を次に示す。
  - 'success' : 非空 PDF を sofficePdfPath に書き出す。
  - 'empty'   : 空 PDF を書き出す (soffice の偽陽性 exit 0 を模す)。
  - 'enoent'  : SofficeSpawnError を投げる (soffice 不在を模す)。
  - 'timeout' : SofficeTimeoutError を投げる (soffice 変換 timeout を模す)。
*/
class FakePdfConverter implements PdfConverter {
  public stashedInput?: string
  public stashedInputBuffer?: Buffer
  public callCount = 0

  constructor(private readonly behavior: 'success' | 'empty' | 'enoent' | 'timeout') {}

  // eslint-disable-next-line @typescript-eslint/require-await -- port は Promise を返す契約
  async convertToPdf(

    arguments_: Readonly<PdfConvertArguments>,
  ): Promise<PdfConvertResult> {
    this.callCount += 1
    this.stashedInput = arguments_.inputPath
    this.stashedInputBuffer = readFileSync(arguments_.inputPath)
    if (this.behavior === 'enoent') {
      throw new SofficeSpawnError('spawn soffice ENOENT')
    }
    if (this.behavior === 'timeout') {
      throw new SofficeTimeoutError(arguments_.timeoutMs)
    }
    const pdfPath = sofficePdfPath(arguments_.outputDirectory, arguments_.inputPath)
    writeFileSync(pdfPath, this.behavior === 'empty' ? Buffer.alloc(0) : Buffer.from('%PDF-1.4 fake'))
    return { pdfPath }
  }
}

const temporaryRoot = useTemporaryDirectory('pecotv-preview-test-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

function buildDependencies(converter: PdfConverter): PreviewDependencies {
  return {
    archive: new YauzlYazlPptxArchive(),
    engine: new XmldomXmlEngine(),
    pdfConverter: converter,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => 0,
  }
}

function dependenciesWith(behavior: ConstructorParameters<typeof FakePdfConverter>[0]): PreviewDependencies {
  return buildDependencies(new FakePdfConverter(behavior))
}

async function writeInputPptx(name = 'deck.pptx'): Promise<string> {
  const inputPath = temporaryRoot(name)
  writeFileSync(inputPath, await buildPptx())
  return inputPath
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function readPptxPart(pptxBuffer: Readonly<Buffer>, partName: string): Promise<string> {
  const archive = new YauzlYazlPptxArchive()
  const temporary = temporaryRoot(`read-${Math.random().toString(36).slice(2)}.pptx`)
  writeFileSync(temporary, Buffer.from(pptxBuffer))
  const reader = await archive.read(temporary)
  try {
    for await (const entry of reader.entries()) {
      if (entry.part === partName) {
        const buffer = await entry.read()
        return buffer.toString('utf8')
      }
    }
  }
  finally {
    await reader.close()
  }
  throw new Error(`${partName} が見つかりません`)
}

async function readPptxBinaryPart(pptxBuffer: Readonly<Buffer>, partName: string): Promise<Buffer> {
  const archive = new YauzlYazlPptxArchive()
  const temporary = temporaryRoot(`readbin-${Math.random().toString(36).slice(2)}.pptx`)
  writeFileSync(temporary, Buffer.from(pptxBuffer))
  const reader = await archive.read(temporary)
  try {
    for await (const entry of reader.entries()) {
      if (entry.part === partName) {
        return await entry.read()
      }
    }
  }
  finally {
    await reader.close()
  }
  throw new Error(`${partName} が見つかりません`)
}

async function listParts(pptxBuffer: Readonly<Buffer>): Promise<string[]> {
  const archive = new YauzlYazlPptxArchive()
  const temporary = temporaryRoot(`parts-${Math.random().toString(36).slice(2)}.pptx`)
  writeFileSync(temporary, Buffer.from(pptxBuffer))
  const reader = await archive.read(temporary)
  const parts: string[] = []
  try {
    for await (const entry of reader.entries()) {
      parts.push(entry.part)
    }
  }
  finally {
    await reader.close()
  }
  return parts
}

describe('runPreview (PDF 生成ルート)', () => {
  it('findings に slide 番号 + shape 名 + rule を付与し、--out へ PDF を出力する', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('deck.preview.pdf')
    const converter = new FakePdfConverter('success')

    const summary = await runPreview(inputPath, { out }, buildDependencies(converter))

    expect(summary.findings).toStrictEqual([
      { slide: 1, rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
    expect(summary.normalized).toBe(1)
    expect(summary.outputAbs).toBe(out)
    expect(existsSync(out)).toBe(true)
    expect(converter.callCount).toBe(1)
  })

  it('一時 PPTX の slide1 が正規化済み (wrap=square / noAutofit) で渡される', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    const converter = new FakePdfConverter('success')

    await runPreview(inputPath, { out }, buildDependencies(converter))

    expect(converter.stashedInputBuffer).toBeDefined()
    const buffer = converter.stashedInputBuffer
    if (buffer === undefined) return
    const slide1 = await readPptxPart(buffer, 'ppt/slides/slide1.xml')
    expect(slide1).toContain('wrap="square"')
    expect(slide1).toContain('noAutofit')
    expect(slide1).not.toContain('spAutoFit')
    expect(slide1).not.toContain('wrap="none"')
  })

  it('非対象 entry (media / presentation.xml / slide2) は passthrough 保全される', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    const converter = new FakePdfConverter('success')

    await runPreview(inputPath, { out }, buildDependencies(converter))

    const buffer = converter.stashedInputBuffer
    expect(buffer).toBeDefined()
    if (buffer === undefined) return
    const parts = await listParts(buffer)
    expect(parts).toContain('ppt/media/image1.png')
    expect(parts).toContain('ppt/presentation.xml')
    expect(parts).toContain('ppt/slides/slide2.xml')
    // media バイトが lazy passthrough (addReadStream) を通っても完全一致する。
    const media = await readPptxBinaryPart(buffer, 'ppt/media/image1.png')
    expect(media.equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe(true)
    // slide2 (非対象) は無変更
    const slide2 = await readPptxPart(buffer, 'ppt/slides/slide2.xml')
    expect(slide2).toContain('wrap="square"')
    expect(slide2).not.toContain('noAutofit')
  })

  it('入力 PPTX の sha256 が実行前後で不変 (Acceptance 3)', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    const before = sha256(inputPath)

    await runPreview(inputPath, { out }, dependenciesWith('success'))

    expect(sha256(inputPath)).toBe(before)
  })

  it('--out 省略時は <input-dir>/<stem>.preview.pdf に出力する', async () => {
    const inputPath = await writeInputPptx('talk.pptx')
    const summary = await runPreview(inputPath, {}, dependenciesWith('success'))
    const expected = temporaryRoot('talk.preview.pdf')
    expect(summary.outputAbs).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  it('実行後に一時 dir が残存しない', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    const converter = new FakePdfConverter('success')

    await runPreview(inputPath, { out }, buildDependencies(converter))

    expect(converter.stashedInput).toBeDefined()
    // stashedInput = <temporaryDir>/<stem>.pptx。temporaryDir 自体が削除される。
    const stashedDirectory = path.dirname(converter.stashedInput ?? '')
    expect(existsSync(stashedDirectory)).toBe(false)
  })

  it('PDF 未生成 (空 PDF) で soffice-conversion-failed を投げる', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    await expect(
      runPreview(inputPath, { out }, dependenciesWith('empty')),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'PreviewRuntimeError', reason: 'soffice-conversion-failed' }),
    )
  })

  // soffice 本体だけが入った環境 (libreoffice-impress 不在) が踏むのはこのルートであり、
  // reason だけでは利用者が次に何を入れればよいか分からない (#1072)。
  it('PDF 未生成の message に libreoffice-impress の導入案内が入る', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    await expect(
      runPreview(inputPath, { out }, dependenciesWith('empty')),
    ).rejects.toThrow(/libreoffice-impress/)
  })

  it('soffice 不在 (ENOENT) で soffice-not-found を投げる', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    await expect(
      runPreview(inputPath, { out }, dependenciesWith('enoent')),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'PreviewRuntimeError', reason: 'soffice-not-found' }),
    )
  })

  it('soffice 変換 timeout で soffice-timeout を投げる', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    await expect(
      runPreview(inputPath, { out }, dependenciesWith('timeout')),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'PreviewRuntimeError', reason: 'soffice-timeout' }),
    )
  })

  it('入力が存在しない場合 input-open-failed を投げる', async () => {
    const out = temporaryRoot('out.pdf')
    await expect(
      runPreview(temporaryRoot('missing.pptx'), { out }, dependenciesWith('success')),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'PreviewRuntimeError', reason: 'input-open-failed' }),
    )
  })

  it('--report 指定で findings JSON が出力される', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('out.pdf')
    const reportPath = temporaryRoot('report.json')

    await runPreview(inputPath, { out, report: reportPath }, dependenciesWith('success'))

    // eslint-disable-next-line no-restricted-syntax -- report JSON 戻りを既知構造へ narrowing
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      findings: { slide: number, rule: string, shapeName?: string }[]
      normalized: number
    }
    expect(parsed.findings).toStrictEqual([
      { slide: 1, rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
    expect(parsed.normalized).toBe(1)
  })
})

describe('runPreview (--detect-only)', () => {
  it('converter を呼ばず findings のみ返し PDF を生成しない', async () => {
    const inputPath = await writeInputPptx()
    const converter = new FakePdfConverter('success')

    const summary = await runPreview(inputPath, { detectOnly: true }, buildDependencies(converter))

    expect(converter.callCount).toBe(0)
    expect(summary.detectOnly).toBe(true)
    expect(summary.outputAbs).toBeUndefined()
    expect(summary.findings).toStrictEqual([
      { slide: 1, rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
  })

  it('--detect-only でも入力 sha256 が不変', async () => {
    const inputPath = await writeInputPptx()
    const before = sha256(inputPath)
    await runPreview(inputPath, { detectOnly: true }, dependenciesWith('success'))
    expect(sha256(inputPath)).toBe(before)
  })

  it('--detect-only で入力が存在しない場合 input-open-failed を投げる', async () => {
    await expect(
      runPreview(
        temporaryRoot('missing.pptx'),
        { detectOnly: true },
        dependenciesWith('success'),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'PreviewRuntimeError', reason: 'input-open-failed' }),
    )
  })

  it('--detect-only --report で findings JSON が出力される', async () => {
    const inputPath = await writeInputPptx()
    const reportPath = temporaryRoot('detect-report.json')
    await runPreview(inputPath, { detectOnly: true, report: reportPath }, dependenciesWith('success'))
    // eslint-disable-next-line no-restricted-syntax -- report JSON narrowing
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      detectOnly: boolean
      output?: string
      normalized: number
      findings: readonly { slide: number, rule: string, shapeName?: string }[]
    }
    expect(parsed.detectOnly).toBe(true)
    expect(parsed.output).toBeUndefined()
    expect(parsed.normalized).toBe(0)
    expect(parsed.findings).toStrictEqual([
      { slide: 1, rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
  })
})

describe('createPptxPreviewCommand', () => {
  it('--json 成功時 stdout に pptx.preview.done を出す (findings 配列含む)', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('cmd-out.pdf')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('success'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))

    await command.parseAsync([inputPath, '--out', out, '--json'], { from: 'user' })

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(stdout.chunks[0] ?? '') as {
      event: string
      findings: { slide: number, rule: string }[]
    }
    expect(parsed.event).toBe('pptx.preview.done')
    expect(parsed.findings).toStrictEqual([
      { slide: 1, rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
  })

  it('--json なし成功時 stdout に finding 行 + サマリを出す (findings ありでも exit 0)', async () => {
    const inputPath = await writeInputPptx()
    const out = temporaryRoot('cmd-out-text.pdf')
    const stdout = makeStream()
    const stderr = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createPptxPreviewCommand(() => ({
        ...dependenciesWith('success'),
        stdout: asStream(stdout),
        stderr: asStream(stderr),
      }))
      await command.parseAsync([inputPath, '--out', out], { from: 'user' })
      const text = stdout.chunks.join('')
      expect(text).toContain('slide 1: shape "footer-copyright"')
      expect(text).toContain('pptx preview:')
      expect(process.exitCode ?? 0).toBe(0)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--detect-only --json で converter 未呼出 + pptx.preview.done', async () => {
    const inputPath = await writeInputPptx()
    const converter = new FakePdfConverter('success')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...buildDependencies(converter),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))

    await command.parseAsync([inputPath, '--detect-only', '--json'], { from: 'user' })

    expect(converter.callCount).toBe(0)
    // eslint-disable-next-line no-restricted-syntax -- JSON narrowing
    const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, detectOnly: boolean }
    expect(parsed.event).toBe('pptx.preview.done')
    expect(parsed.detectOnly).toBe(true)
  })

  it('--detect-only --json なしでサマリ行を出す', async () => {
    const inputPath = await writeInputPptx()
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('success'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))

    await command.parseAsync([inputPath, '--detect-only'], { from: 'user' })

    expect(stdout.chunks.join('')).toContain('pptx preview (detect-only):')
  })

  it('--json エラー時 stdout に pptx.preview.error + exit 1', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('success'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [temporaryRoot('missing.pptx'), '--out', temporaryRoot('x.pdf'), '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('pptx.preview.error')
      expect(parsed.reason).toBe('input-open-failed')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json なしエラー時 stderr にメッセージを出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('success'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [temporaryRoot('missing.pptx'), '--out', temporaryRoot('x.pdf')],
        { from: 'user' },
      )
      expect(stderr.chunks.join('')).toContain('pecotv pptx preview:')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('ENOENT エラー時 soffice-not-found を --json で出す', async () => {
    const inputPath = await writeInputPptx()
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('enoent'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync([inputPath, '--out', temporaryRoot('x.pdf'), '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('pptx.preview.error')
      expect(parsed.reason).toBe('soffice-not-found')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })
})

describe('createPptxPreviewCommand: invalid option', () => {
  it('未知オプションを --json で渡すと pptx.preview.error (invalid-option) を出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createPptxPreviewCommand(() => ({
      ...dependenciesWith('success'),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    // configureOutput の writeErr は process.argv を見るため --json を argv に積む
    const previousArgv = process.argv
    process.argv = [...previousArgv, '--json']
    try {
      await command.parseAsync(['some.pptx', '--unknown-flag'], { from: 'user' })
    }
    catch {
      // commander は exitOverride で throw する。stdout の event を検証する。
    }
    finally {
      process.argv = previousArgv
    }
    const errorLine = stdout.chunks.find(c => c.includes('pptx.preview.error'))
    expect(errorLine).toBeDefined()
  })
})

describe('pptxPreviewDefaultDependencies', () => {
  it('infra の本物実装を返す', () => {
    const dependencies = pptxPreviewDefaultDependencies()
    expect(dependencies.archive).toBeInstanceOf(YauzlYazlPptxArchive)
    expect(dependencies.engine).toBeInstanceOf(XmldomXmlEngine)
    expect(typeof dependencies.now()).toBe('number')
  })
})

// PreviewRuntimeError export の参照を保つ (型のみ import になると knip が誤検知するため、
// 値としての参照を 1 箇所残す)。
describe('PreviewRuntimeError', () => {
  it('reason を保持する', () => {
    const error = new PreviewRuntimeError('msg', 'soffice-not-found')
    expect(error.reason).toBe('soffice-not-found')
    expect(error.name).toBe('PreviewRuntimeError')
  })
})
