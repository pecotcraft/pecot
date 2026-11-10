// exportPdf (SVG → 1 ページ PDF) の単体テスト。
// 実 Playwright 起動は重いため playwright の launch を mock し、印刷に渡す引数と
// 書き出しの順序だけを検証する。実 Chromium での PDF の中身は tests/e2e 側が持つ。

/* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリ配下のみ */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200.5px" height="120px"><text>日本語</text></svg>'
const PDF_BYTES = Buffer.from('%PDF-1.4 stub')

interface PdfOptions {
  readonly width?: string
  readonly height?: string
  readonly printBackground?: boolean
  readonly pageRanges?: string
}

function mockPlaywright(pdfImpl: () => Promise<Buffer> = () => Promise.resolve(PDF_BYTES)) {
  const setContent = vi.fn<(html: string, options: Readonly<{ timeout?: number }>) => Promise<void>>(() => Promise.resolve())
  const pdf = vi.fn<(options: Readonly<PdfOptions>) => Promise<Buffer>>(pdfImpl)
  const newPage = vi.fn(() => Promise.resolve({ setContent, pdf }))
  const close = vi.fn(() => Promise.resolve())
  const launch = vi.fn(() => Promise.resolve({ newPage, close }))
  vi.doMock('playwright', () => ({ chromium: { launch } }))
  return { launch, setContent, pdf, close }
}

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-pdf-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('exportPdf', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.doUnmock('playwright')
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('SVG の px 寸法 (切り上げ) と pageRanges: 1 / printBackground で印刷し、結果を書き出す', async () => {
    const { pdf, setContent, close } = mockPlaywright()
    const { exportPdf } = await import('../../../../src/infra/drawio/pdf.js')
    const outputPath = path.join(makeTemporaryDirectory(), 'nested', 'out.pdf')

    await exportPdf(SVG, outputPath)

    expect(pdf).toHaveBeenCalledWith({
      width: '201px',
      height: '120px',
      printBackground: true,
      pageRanges: '1',
    })
    const [html, options] = setContent.mock.calls[0] ?? ['', {}]
    expect(html).toContain(SVG)
    expect(html).toContain('@page{margin:0}')
    expect(html).toContain('overflow:hidden')
    expect(html).toContain('svg{display:block}')
    expect(options.timeout).toBe(60_000)
    expect(close).toHaveBeenCalledTimes(1)
    expect(readFileSync(outputPath)).toEqual(PDF_BYTES)
  })

  it('PECOTV_FORCE_PDF_FAIL=1 なら Playwright を起動する前に reject し、何も書かない', async () => {
    vi.stubEnv('PECOTV_FORCE_PDF_FAIL', '1')
    const { launch } = mockPlaywright()
    const { exportPdf } = await import('../../../../src/infra/drawio/pdf.js')
    const directory = path.join(makeTemporaryDirectory(), 'out')

    await expect(exportPdf(SVG, path.join(directory, 'out.pdf'))).rejects.toThrow(/forced PDF failure \(PECOTV_FORCE_PDF_FAIL=1\)/)

    expect(launch).not.toHaveBeenCalled()
    expect(existsSync(directory)).toBe(false)
  })

  it('SVG の寸法が読めなければ Playwright を起動せずに reject する', async () => {
    const { launch } = mockPlaywright()
    const { exportPdf } = await import('../../../../src/infra/drawio/pdf.js')

    const outputPath = path.join(makeTemporaryDirectory(), 'out.pdf')
    await expect(exportPdf('<svg width="100%" height="10px"/>', outputPath))
      .rejects.toThrow(/is not a positive px value/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('印刷に失敗したら出力ディレクトリを作らず、ブラウザは閉じる', async () => {
    const { close } = mockPlaywright(() => Promise.reject(new Error('print failed')))
    const { exportPdf } = await import('../../../../src/infra/drawio/pdf.js')
    const directory = path.join(makeTemporaryDirectory(), 'out')

    await expect(exportPdf(SVG, path.join(directory, 'out.pdf'))).rejects.toThrow('print failed')

    expect(close).toHaveBeenCalledTimes(1)
    expect(existsSync(directory)).toBe(false)
  })

  it('印刷が上限時間内に終わらなければ reject する', async () => {
    vi.useFakeTimers()
    const { close } = mockPlaywright(() => new Promise<Buffer>(() => { /* 返らない印刷 */ }))
    const { exportPdf } = await import('../../../../src/infra/drawio/pdf.js')
    const outputPath = path.join(makeTemporaryDirectory(), 'out.pdf')

    const settled = (async () => {
      try {
        await exportPdf(SVG, outputPath)
        return 'resolved'
      }
      catch (error: unknown) {
        return error instanceof Error ? error.message : 'non-error'
      }
    })()
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(settled).resolves.toMatch(/did not finish within 60s/)

    expect(close).toHaveBeenCalledTimes(1)
    expect(existsSync(outputPath)).toBe(false)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
