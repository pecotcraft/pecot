// drawio_export の兄弟 PDF に関する応答形の単体テスト。
//
// 既存の drawio.test.ts は module を mock しない前提 (実 fixture・失敗注入 env で分岐を作る)。
// そのため、embed export を差し替える本テストはファイルを分ける。
// embed.diagrams.net への到達 (infra/drawio/screenshot.js) は、固定 SVG を返す mock に置き換える。
// PDF 印刷の Chromium (playwright) は、固定バイト列を返す mock に置き換える。
// PECOTV_FORCE_PDF_FAIL の判定は実装 (infra/drawio/pdf.ts) のまま通す。
// そのため、成功 / degrade の分岐は本物のルートで決まる。
// Chromium の取得済み判定だけは、引数確認との順序を観測するため差し替え可能にしてある（標準は取得済み）。

/* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリ配下のみ */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChromiumModule from '../../../infra/playwright/chromium.js'
import type { ToolCallContext } from '../../server.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { drawioExportTool } from '../drawio.js'

const EMBED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light dark;" width="201px" height="121px"><g/></svg>'
const PDF_BYTES = Buffer.from('%PDF-1.4 stub')

const chromiumState = vi.hoisted(() => ({ installed: true }))

vi.mock('../../../infra/drawio/screenshot.js', () => ({
  exportViaEmbed: () => Promise.resolve(Buffer.from(EMBED_SVG, 'utf8')),
}))

// executablePath を持たない mock なので、chromium の実行時ガードは「判定できない = 取得済み」で通る。
vi.mock('playwright', () => ({
  chromium: {
    launch: () => Promise.resolve({
      newPage: () => Promise.resolve({
        setContent: () => Promise.resolve(),
        pdf: () => Promise.resolve(PDF_BYTES),
      }),
      close: () => Promise.resolve(),
    }),
  },
}))

vi.mock('../../../infra/playwright/chromium.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ChromiumModule>()
  return { ...actual, isChromiumInstalled: () => Promise.resolve(chromiumState.installed) }
})

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const ICON_ROOT = path.join(PLUGIN_ROOT, 'assets', 'drawio-icons')
const ICON_RESOLVABLE = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'icon-resolvable.drawio')

const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-test-drawio-pdf-'))
  temporaryDirectories.push(directory)
  return directory
}

beforeEach(() => {
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
  // 未取得ケースで実ダウンロードへ進まないよう、自動取得の opt-in を落としておく。
  vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', '')
  chromiumState.installed = true
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('drawio_export の兄弟 PDF', () => {
  it('標準で SVG と兄弟 PDF を書き、artifacts と data.pdf に載せる', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-01')
    const directory = makeTemporaryDirectory()
    const svgPath = path.join(directory, 'diagram.drawio.svg')
    const pdfPath = path.join(directory, 'diagram.drawio.pdf')

    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: svgPath },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured).toMatchObject({
      ok: true,
      exitCode: 0,
      artifacts: [svgPath, pdfPath],
      data: { event: 'drawio.export.done', file: svgPath, pdf: pdfPath, pdfFailed: false, warnings: 0 },
      message: `wrote SVG to ${svgPath} (PDF: ${pdfPath})`,
    })
    expect(readFileSync(svgPath, 'utf8')).toContain('color-scheme: light;')
    expect(readFileSync(pdfPath)).toEqual(PDF_BYTES)
  })

  it('PECOTV_FORCE_PDF_FAIL=1 では SVG だけを残し、ok: true のまま exitCode 3 で警告を返す', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-04')
    vi.stubEnv('PECOTV_FORCE_PDF_FAIL', '1')
    const directory = makeTemporaryDirectory()
    const svgPath = path.join(directory, 'out.svg')
    const pdfPath = path.join(directory, 'out.pdf')
    // 前回の PDF は今回の失敗で消え、成果物と取り違えられない。
    writeFileSync(pdfPath, '%PDF-old')

    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: svgPath },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured).toMatchObject({
      ok: true,
      exitCode: 3,
      artifacts: [svgPath],
      // eslint-disable-next-line unicorn/no-null -- CLI の --json と同形性を保つため PDF 失敗時は null を pin する
      data: { event: 'drawio.export.done', file: svgPath, pdf: null, pdfFailed: true, warnings: 1 },
      message: `wrote SVG to ${svgPath} (1 warnings; details in stderr)`,
    })
    expect(String(structured['stderr'])).toContain('warning: PDF export failed: forced PDF failure')
    expect(existsSync(svgPath)).toBe(true)
    expect(existsSync(pdfPath)).toBe(false)
  })

  it('pdf: false では PDF を書かず、既存の PDF にも触れない', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-02')
    const directory = makeTemporaryDirectory()
    const svgPath = path.join(directory, 'out.svg')
    const pdfPath = path.join(directory, 'out.pdf')
    writeFileSync(pdfPath, '%PDF-old')

    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: svgPath, pdf: false },
      CALL,
    )

    expect(structuredOf(result)).toMatchObject({
      ok: true,
      exitCode: 0,
      artifacts: [svgPath],
      // eslint-disable-next-line unicorn/no-null -- PDF を出さないときの `pdf: null` を pin する
      data: { pdf: null, pdfFailed: false, warnings: 0 },
      message: `wrote SVG to ${svgPath}`,
    })
    expect(readFileSync(pdfPath, 'utf8')).toBe('%PDF-old')
  })

  it('out_path の拡張子が .pdf なら exit 2 の invalid-output-extension で何も書かない', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-06')
    const directory = makeTemporaryDirectory()
    const outPath = path.join(directory, 'diagram.pdf')

    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({
      ok: false,
      exitCode: 2,
      data: { event: 'drawio.export.error', reason: 'invalid-output-extension' },
    })
    expect(existsSync(outPath)).toBe(false)
  })

  it('pdf: false でも out_path の拡張子が .pdf なら exit 2 で拒否する', async () => {
    const outPath = path.join(makeTemporaryDirectory(), 'diagram.pdf')

    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath, pdf: false },
      CALL,
    )

    expect(structuredOf(result)).toMatchObject({
      ok: false,
      exitCode: 2,
      data: { event: 'drawio.export.error', reason: 'invalid-output-extension' },
    })
    expect(existsSync(outPath)).toBe(false)
  })

  it('Chromium 未取得でも out_path の拡張子の確認が先に行われ exit 2 を返す', async () => {
    chromiumState.installed = false
    const directory = makeTemporaryDirectory()

    const rejected = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: path.join(directory, 'diagram.pdf') },
      CALL,
    )
    // 対照: 拡張子が正しければ同じ環境で Chromium 未取得として返る（差し替えが働いている）。
    const unavailable = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: path.join(directory, 'diagram.svg') },
      CALL,
    )

    expect(structuredOf(rejected)).toMatchObject({
      ok: false,
      exitCode: 2,
      data: { event: 'drawio.export.error', reason: 'invalid-output-extension' },
    })
    expect(structuredOf(unavailable)).toMatchObject({
      ok: false,
      data: { reason: 'chromium-not-installed' },
    })
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
