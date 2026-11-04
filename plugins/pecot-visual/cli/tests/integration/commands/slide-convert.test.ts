// commands/slidev-to-pptx/convert.ts の分岐網羅テスト。
// SlidevRunner / SlidevPptxPipeline / PptxArchive / XmlEngine は fake / 実装を DI して、全 reason code を観測する。
// 実 spawn ルートは tests/integration/infra/ で別途検証する。

// SpawnResult 契約上 exitCode / signal は null を取り得るため、本ファイル全体で no-null を許可する。
// fs path も全て temp 由来でリテラルではないため non-literal-fs-filename も全体で許可する。
/* eslint-disable unicorn/no-null, security/detect-non-literal-fs-filename */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'

import type { Browser } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZipFile as YazlZipFile } from 'yazl'

import {
  SlideConvertRuntimeError,
  SlideConvertUsageError,
  createSlideConvertCommand,
  errorToReason,
  runSlideConvert,
  slideConvertDefaultDependencies,
  validateTheme,
  type SlideConvertDependencies,
  type SlideConvertResultSummary,
} from '../../../src/commands/slidev-to-pptx/convert.js'
import type {
  PptxArchive,
  SlidevPptxPipeline,
  SlidevRunner,
  XmlEngine,
} from '../../../src/domain/_shared/ports.js'
import type { SpawnResult } from '../../../src/domain/_shared/spawn-result.js'
import {
  PipelineRuntimeError,
  PipelineTimeoutError,
} from '../../../src/domain/slidev-to-pptx/errors.js'
import type { ResolvedThemeDeclaration } from '../../../src/domain/slidev-theme/declaration.js'
import { SlideCreateRuntimeError } from '../../../src/domain/slidev-project/errors.js'
import { ThemeFetchError } from '../../../src/domain/slidev-theme/store-layout.js'
import { DEFAULT_THEME_DECLARATION } from '../../../src/domain/slidev-theme/defaults.js'
import { CACHE_SCHEMA_VERSION } from '../../../src/domain/slidev-to-pptx/cache-manifest.js'
import { ANIMATION_POLICY_SCHEMA_VERSION } from '../../../src/domain/slidev-to-pptx/config.js'
import { stepIndexOf } from '../../../src/domain/slidev-to-pptx/step-index.js'
import type { PipelineResult, SinglePassFallbackTiming, SinglePassGroupsTiming } from '../../../src/domain/slidev-to-pptx/types.js'
import { XmldomXmlEngine } from '../../../src/infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../../src/infra/pptx-ooxml/archive.js'
import { InProcessSlidevPptxPipeline } from '../../../src/infra/slidev-to-pptx/index.js'
import { convertToPptx } from '../../../src/infra/slidev-to-pptx/pipeline.js'
import type { SinglePassOutcome, SinglePassRunner } from '../../../src/infra/slidev-to-pptx/single-pass-worker.js'
import type { SlideConvertResult, SlideWorkerRunner } from '../../../src/infra/slidev-to-pptx/slide-worker.js'
import {
  diffPptxSnapshots,
  expectPptxOutputsEquivalent,
  slidesInOrder,
  snapshotPptx,
  valuesOf,
  type PptxSnapshot,
} from '../../_helpers/pptx-compare.js'
import { extractFromPptx } from '../../_helpers/xpath-extract.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from '../../../src/commands/slidev-project/linked-theme.js'

// テーマの宣言（pecot-theme.json）の pptx を、テスト内の値で与える。テーマの固有値は本体に持たない。
const TEST_LINK_COLOR = '4F46E5'
const TEST_PPTX = { eastAsianFont: 'Noto Sans JP', linkColor: TEST_LINK_COLOR }

function themePorts(pptx: ResolvedThemeDeclaration['pptx']): Pick<SlideConvertDependencies, 'ensureThemeLinked' | 'readThemeDeclaration'> {
  return {
    ensureThemeLinked: () => Promise.resolve({ theme: { directory: '/theme-root' } }),
    readThemeDeclaration: () => Promise.resolve({ declaration: { ...DEFAULT_THEME_DECLARATION, pptx }, warnings: [] }),
  }
}

const THEME_PORTS = themePorts(TEST_PPTX)

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

function realInfra(): { archive: PptxArchive, engine: XmlEngine } {
  return { archive: new YauzlYazlPptxArchive(), engine: new XmldomXmlEngine() }
}

interface FakeSlidevRunner extends SlidevRunner {
  readonly calls: { projectDirectory: string, theme?: string }[]
}

interface FakePptxConverter extends SlidevPptxPipeline {
  readonly calls: {
    presDirectory: string
    targetDirectory: string
    outputDirectory: string
    skipPostprocess?: boolean
  }[]
}

const NS_PRESENTATIONML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'

/**
yazl で part 群を 1 つの PPTX バッファにまとめる（各 builder 共通の定型）。
*/
function zipBufferOf(
  // yazl の addBuffer は Buffer 実体を要求する。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  entries: readonly { readonly name: string, readonly buffer: Buffer }[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new YazlZipFile()
    for (const entry of entries) zip.addBuffer(entry.buffer, entry.name)
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

function buildSinglePagePptx(slideLabel: string): Promise<Buffer> {
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}"><p:cSld><p:spTree/></p:cSld><!-- ${slideLabel} --></p:sld>`
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
  ])
}

async function placeFakeSlides(stagingDirectory: string, count: number): Promise<void> {
  const slidesDirectory = path.join(stagingDirectory, 'slides')
  mkdirSync(slidesDirectory, { recursive: true })
  for (let n = 1; n <= count; n += 1) {
    const buffer = await buildSinglePagePptx(`slide-${String(n)}`)
    writeFileSync(path.join(slidesDirectory, `slide-${String(n)}.pptx`), buffer)
  }
}

const NS_DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/**
dom-to-pptx が出すような単スライド PPTX を生成する。
含めるのは「CSS-only typeface (-apple-system) + 日本語テキストに英文 ea + 段落終端 endParaRPr」。
merge 後に `slide convert` ルートの post-process が動いたかを assertion する用。
*/
function buildPptxWithJapaneseAndCssTypeface(): Promise<Buffer> {
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
      + `<p:cSld><p:spTree>`
      + `<p:sp><p:txBody><a:p>`
      + `<a:r><a:rPr lang="ja-JP">`
      + `<a:latin typeface="Test Display Extended"/>`
      + `<a:ea typeface="Test Display Extended"/>`
      + `</a:rPr><a:t>日本語テキスト</a:t></a:r>`
      + `<a:endParaRPr lang="ja-JP">`
      + `<a:latin typeface="Test Display Extended"/>`
      + `</a:endParaRPr>`
      + `</a:p></p:txBody></p:sp>`
      + `<p:sp><p:txBody><a:p>`
      + `<a:r><a:rPr lang="en-US">`
      + `<a:latin typeface="-apple-system"/>`
      + `<a:ea typeface="-apple-system"/>`
      + `<a:cs typeface="-apple-system"/>`
      + `</a:rPr><a:t>English</a:t></a:r>`
      + `</a:p></p:txBody></p:sp>`
      + `</p:spTree></p:cSld></p:sld>`
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
  ])
}

/**
`extractFromPptx` が返す ExtractedValue 配列から、`attr:typeface` 抽出 (= readonly string[]) の値だけを平坦化する。
返り値は string[]。型ガードで narrow するため、`as` キャストを使わない。
*/
function flattenAttributeValues(
  values: readonly { readonly value: number | string | readonly string[] }[],
): readonly string[] {
  const flattened: string[] = []
  for (const v of values) {
    if (Array.isArray(v.value)) {
      for (const s of v.value) {
        if (typeof s === 'string') flattened.push(s)
      }
    }
  }
  return flattened
}

/**
letter-spacing 対象 (`テスト`) と テーマの linkColor (#4F46E5) 同色 anchor (`公式サイト`) を含む
単スライド PPTX を生成する。
staging に letter-spacing.json / href-map.json を書き出した状態を模擬する。
そのため convert fake が staging dir に json も併せて投入するルート (auto-detect 検証) と、
flag 優先ルートの両方で参照する。
*/
function buildPptxWithSpacingAndAnchor(): Promise<Buffer> {
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  // run-1: letter-spacing 対象 (key=テスト)
  // run-2: テーマの linkColor (4F46E5) 同色 anchor text (key=公式サイト)
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
      + `<p:cSld><p:spTree>`
      + `<p:sp><p:txBody><a:p>`
      + `<a:r><a:rPr lang="ja-JP">`
      + `<a:latin typeface="Test Display Extended"/>`
      + `</a:rPr><a:t>テスト</a:t></a:r>`
      + `</a:p></p:txBody></p:sp>`
      + `<p:sp><p:txBody><a:p>`
      + `<a:r><a:rPr lang="ja-JP">`
      + `<a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>`
      + `</a:rPr><a:t>公式サイト</a:t></a:r>`
      + `</a:p></p:txBody></p:sp>`
      + `</p:spTree></p:cSld></p:sld>`
  // 単スライド PPTX には slide rels も含める (空 Relationships)
  const slideRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}"/>`
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', buffer: Buffer.from(slideRels, 'utf8') },
  ])
}

interface StagingJsonContents {
  readonly letterSpacing?: Record<string, { letterSpacing: string, fontSize: string }>
  readonly href?: Record<string, string>
}

/**
staging/slides/ に slide-1.pptx と (任意で) letter-spacing.json / href-map.json を書き出す
fake converter。`json` を渡さないルートでは json を作らない (= empty Map で chain される) ことを
確認できる。
*/
// Record<string, ...> は本 fake converter の入力 only な test fixture でしか使われない。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function createConverterWithSpacingAndAnchor(json: StagingJsonContents): FakePptxConverter {
  const calls: FakePptxConverter['calls'] = []
  return {
    calls,
    async convert(arguments_) {
      const entry: FakePptxConverter['calls'][number] = {
        presDirectory: arguments_.presDirectory,
        targetDirectory: arguments_.targetDirectory,
        outputDirectory: arguments_.outputDirectory,
      }
      if (arguments_.skipPostprocess !== undefined) {
        entry.skipPostprocess = arguments_.skipPostprocess
      }
      calls.push(entry)
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      const buffer = await buildPptxWithSpacingAndAnchor()
      writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
      if (json.letterSpacing !== undefined) {
        writeFileSync(
          path.join(slidesDirectory, 'letter-spacing.json'),
          JSON.stringify(json.letterSpacing),
        )
      }
      if (json.href !== undefined) {
        writeFileSync(
          path.join(slidesDirectory, 'href-map.json'),
          JSON.stringify(json.href),
        )
      }
      return pipelineSuccess()
    },
  }
}

function createConverterWithJapaneseSlide(): FakePptxConverter {
  const calls: FakePptxConverter['calls'] = []
  return {
    calls,
    async convert(arguments_) {
      const entry: FakePptxConverter['calls'][number] = {
        presDirectory: arguments_.presDirectory,
        targetDirectory: arguments_.targetDirectory,
        outputDirectory: arguments_.outputDirectory,
      }
      if (arguments_.skipPostprocess !== undefined) {
        entry.skipPostprocess = arguments_.skipPostprocess
      }
      calls.push(entry)
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      const buffer = await buildPptxWithJapaneseAndCssTypeface()
      writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
      return pipelineSuccess()
    },
  }
}

function createSuccessRunner(): FakeSlidevRunner {
  const calls: { projectDirectory: string, theme?: string }[] = []
  return {
    calls,
    build(projectDirectory, options) {
      const entry: { projectDirectory: string, theme?: string } = { projectDirectory }
      if (options.theme !== undefined) entry.theme = options.theme
      calls.push(entry)
      // dist/ ディレクトリが必要な後段のために空 dir を作る
      mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
      return Promise.resolve(spawnSuccess())
    },
  }
}

/**
成功 fake converter。outputDirectory/slides/ に slide-1.pptx ... slide-<count>.pptx を生成する。
`warnings` は pipeline が積んだ警告の再現用（既定は警告なしの空配列）。
*/
function createSuccessConverter(slideCount: number, warnings: readonly string[] = []): FakePptxConverter {
  const calls: FakePptxConverter['calls'] = []
  return {
    calls,
    async convert(arguments_) {
      const entry: FakePptxConverter['calls'][number] = {
        presDirectory: arguments_.presDirectory,
        targetDirectory: arguments_.targetDirectory,
        outputDirectory: arguments_.outputDirectory,
      }
      if (arguments_.skipPostprocess !== undefined) {
        entry.skipPostprocess = arguments_.skipPostprocess
      }
      calls.push(entry)
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      await placeFakeSlides(arguments_.outputDirectory, slideCount)
      return { ...pipelineSuccess(), warnings }
    },
  }
}

// SlidevRunner (spawn 戻り) 用 helper
function spawnSuccess(): SpawnResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
}

function spawnFailure(stderr = 'boom'): SpawnResult {
  return { exitCode: 1, signal: null, stdout: '', stderr, timedOut: false }
}

function spawnTimeout(): SpawnResult {
  return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: 'killed', timedOut: true }
}

// SlidevPptxPipeline (in-process) 用 helper
function pipelineSuccess(slideCount = 1): PipelineResult {
  return {
    success: true,
    slideCount,
    slidesDirectory: '',
    errors: [],
    warnings: [],
    timing: { total: 0, scan: 0, phase1: 0, phase2: 0, perSlide: {} },
  }
}

/**
`warnings` は pipeline が失敗する前に積んだ警告の再現用（既定は警告なしの空配列）。
*/
function pipelineFailure(warnings: readonly string[] = []): PipelineResult {
  return {
    success: false,
    slideCount: 0,
    slidesDirectory: '',
    // level は PipelineError の実値 (`slide` / `element`) を使う。pipeline が積むのはこの
    // 2 値のみで、`--json` の errors はこの値をそのまま出す (#945)。
    errors: [{ level: 'slide', slideNumber: 1, message: 'dom-to-pptx inject failed' }],
    warnings,
    timing: { total: 0, scan: 0, phase1: 0, phase2: 0, perSlide: {} },
  }
}

function makeProjectDirectory(root: string): string {
  const directory = path.join(root, 'sample')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'slides.md'), '# slides\n')
  return directory
}

// title 由来の既定出力名を検証するため、frontmatter 付き slides.md を持つ project を作る。
function makeProjectDirectoryWithSlides(root: string, slidesContent: string): string {
  const directory = path.join(root, 'sample')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'slides.md'), slidesContent)
  return directory
}

const temporaryRoot = useTemporaryDirectory('pecotv-slide-convert-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

function callValidateTheme(value: string): () => void {
  return () => {
    validateTheme(value)
  }
}

describe('validateTheme', () => {
  it('許容文字 [a-zA-Z0-9@/_.-] のみで成功する', () => {
    expect(callValidateTheme('default')).not.toThrow()
    expect(callValidateTheme('@my-org/theme_v2.0')).not.toThrow()
    expect(callValidateTheme('a/b.c-d_e')).not.toThrow()
  })

  it('禁止文字を含む値は SlideConvertUsageError(invalid-theme) を投げる', () => {
    expect(callValidateTheme('$(rm -rf /)')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('foo bar')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('foo;bar')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('')).toThrow(SlideConvertUsageError)
  })

  it('SlideConvertUsageError には reason=invalid-theme が入る', () => {
    expect(callValidateTheme(' ')).toThrow(
      expect.objectContaining({ reason: 'invalid-theme' }),
    )
  })
})

describe('runSlideConvert (fake DI 経由 / 全分岐)', () => {
  it('成功時: outputAbs に merge 済 PPTX を書き出し、runner / converter が 1 回ずつ呼ばれる', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'sample.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(2)
    const infra = realInfra()

    const summary = await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    expect(summary.outputAbs).toBe(path.resolve(out))
    expect(summary.inputAbs).toBe(path.resolve(projectDirectory))
    expect(slidevRunner.calls).toHaveLength(1)
    expect(pptxConverter.calls).toHaveLength(1)
    expect(pptxConverter.calls[0]?.skipPostprocess).toBe(true)
    expect(existsSync(out)).toBe(true)
  })

  it('merge 後に font fix + CSS-only typeface sanitize が適用される (#391 回帰防止)', async () => {
    // dom-to-pptx が出力する次の内容が、`slide convert` 後の merged PPTX で補正されていることを XPath assertion する。
    // 内容は「日本語テキストに英文専用 ea (Test Display Extended) + CSS-only typeface (-apple-system) + 段落終端 endParaRPr」。
    // Phase 2 で `--skip-postprocess` を立てた際に slide convert からの font fix chain が
    // 抜け落ちて Phase 4 で顕在化したバグの回帰防止。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'fontfix.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithJapaneseSlide()
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    // XPath ベースで assert (regex より serialize 形式変動に強い)。
    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const slideParts = ['ppt/slides/slide1.xml']

    // method='attr:typeface' は readonly string[] を返す。flattenAttrValues で narrow する。

    // (a) 日本語ランの a:ea typeface が Noto Sans JP に補正されている
    const eaTypefaces = await extractFromPptx(
      out, slideParts, '//a:r//a:ea', 'attr:typeface', namespaces,
    )
    const eaValues = flattenAttributeValues(eaTypefaces)
    expect(eaValues).toContain('Noto Sans JP')
    expect(eaValues).not.toContain('-apple-system')

    // (b) CSS-only typeface (-apple-system) を含む latin/ea/cs が完全除去
    const allTypefaces = await extractFromPptx(
      out, slideParts, '//a:latin | //a:ea | //a:cs', 'attr:typeface', namespaces,
    )
    const allValues = flattenAttributeValues(allTypefaces)
    expect(allValues.filter(v => v === '-apple-system')).toHaveLength(0)

    // (c) endParaRPr の段落テキストが日本語を含むため ea typeface が Noto Sans JP に補正
    const endParaEa = await extractFromPptx(
      out, slideParts, '//a:endParaRPr/a:ea', 'attr:typeface', namespaces,
    )
    const endParaEaValues = flattenAttributeValues(endParaEa)
    expect(endParaEaValues).toContain('Noto Sans JP')
  })

  it('宣言に pptx の値が無ければ、東アジア書体を書き込まない', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-policy.pptx')
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner: createSuccessRunner(),
        pptxConverter: createConverterWithJapaneseSlide(),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...themePorts({}),
      },
    )

    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const eaTypefaces = await extractFromPptx(
      out, ['ppt/slides/slide1.xml'], '//a:ea', 'attr:typeface', namespaces,
    )
    const eaValues = flattenAttributeValues(eaTypefaces)
    expect(eaValues).not.toContain('Noto Sans JP')
    expect(eaValues).not.toContain('-apple-system')
  })

  it('テーマの宣言の eastAsianFont を ea に書き、読み先は ensureThemeLinked が返したテーマの directory にする', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'declared-font.pptx')
    const infra = realInfra()
    const ensured: string[] = []
    const read: string[] = []

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner: createSuccessRunner(),
        pptxConverter: createConverterWithJapaneseSlide(),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ensureThemeLinked: (directory) => {
          ensured.push(directory)
          return Promise.resolve({ theme: { directory: '/store/theme/package' } })
        },
        readThemeDeclaration: (directory) => {
          read.push(directory)
          return Promise.resolve({
            declaration: { ...DEFAULT_THEME_DECLARATION, pptx: { eastAsianFont: 'Test Sans JP' } },
            warnings: [],
          })
        },
      },
    )

    expect(ensured).toStrictEqual([path.resolve(projectDirectory)])
    expect(read).toStrictEqual(['/store/theme/package'])
    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const eaValues = flattenAttributeValues(await extractFromPptx(
      out, ['ppt/slides/slide1.xml'], '//a:r//a:ea', 'attr:typeface', namespaces,
    ))
    expect(eaValues).toContain('Test Sans JP')
    expect(eaValues).not.toContain('Noto Sans JP')
  })

  it('テーマの名前の不一致 (SlideCreateRuntimeError) は専用の reason を返す', () => {
    expect(errorToReason(new SlideCreateRuntimeError('名前が違う', 'theme-name-mismatch'))).toBe('theme-name-mismatch')
  })

  it('宣言の警告と、pptx の値を省いたことの警告を stderr に [warn] で流す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'warnings.pptx')
    const infra = realInfra()
    const stderr = makeStream()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner: createSuccessRunner(),
        pptxConverter: createConverterWithJapaneseSlide(),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: asStream(stderr),
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ensureThemeLinked: () => Promise.resolve({ theme: { directory: '/theme-root' } }),
        readThemeDeclaration: () => Promise.resolve({
          declaration: { ...DEFAULT_THEME_DECLARATION, pptx: {} },
          warnings: ['テーマ /theme-root に pecot-theme.json の宣言が無いため、本体の既定値で続けます'],
        }),
      },
    )

    const written = stderr.chunks.join('')
    expect(written).toContain('[warn] テーマ /theme-root に pecot-theme.json の宣言が無いため')
    expect(written).toContain('[warn] pptx.linkColor を省いたため')
    expect(written).toContain('[warn] pptx.eastAsianFont を省いたため')
  })

  it('pptx の値が揃っていれば、省略の警告は出さない', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-warnings.pptx')
    const infra = realInfra()
    const stderr = makeStream()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner: createSuccessRunner(),
        pptxConverter: createSuccessConverter(1),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: asStream(stderr),
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    expect(stderr.chunks.join('')).not.toContain('を省いたため')
  })

  it('取得の signal と警告の出力先を、ensureThemeLinked の文脈として渡す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'context.pptx')
    const infra = realInfra()
    const stderr = makeStream()
    const controller = new AbortController()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner: createSuccessRunner(),
        pptxConverter: createSuccessConverter(1),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: asStream(stderr),
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        signal: controller.signal,
        ...THEME_PORTS,
        ensureThemeLinked: (_directory, context) => {
          expect(context.signal).toBe(controller.signal)
          context.warn?.('取得中の警告')
          return Promise.resolve({ theme: { directory: '/theme-root' } })
        },
      },
    )

    expect(stderr.chunks.join('')).toContain('[warn] 取得中の警告')
  })

  it('テーマを張れなければ、slidev build に入らず、theme-<reason> で止まる', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'unlinked.pptx')
    const slidevRunner = createSuccessRunner()
    const infra = realInfra()
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    const rejected = await rejectionOf(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter: createSuccessConverter(1),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
        ensureThemeLinked: () => Promise.reject(failure),
      },
    ))

    expect(rejected).toBe(failure)
    expect(errorToReason(rejected)).toBe('theme-tag')
    expect(slidevRunner.calls).toHaveLength(0)
    expect(existsSync(out)).toBe(false)
  })

  it('移行前の talk-dir (theme: none でテーマの宣言も無い) は、slidev build に入らず theme-none で止まり、移行を案内する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    writeFileSync(path.join(projectDirectory, 'slides.md'), '---\ntheme: none\ntitle: Legacy\n---\n# 表紙\n')
    const out = temporaryRoot('out', 'legacy.pptx')
    const slidevRunner = createSuccessRunner()
    const infra = realInfra()

    const rejected = await rejectionOf(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter: createSuccessConverter(1),
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
        // 本番の既定と同じく、テーマを参照しない talk-dir を止める。
        ensureThemeLinked: (directory, context) => ensureTalkThemeLinked(
          directory,
          linkedThemeDefaultDependencies(temporaryRoot(), context),
          { requireTheme: true },
        ),
      },
    ))

    expect(errorToReason(rejected)).toBe('theme-none')
    expect(rejected).toBeInstanceOf(Error)
    const message = rejected instanceof Error ? rejected.message : ''
    expect(message).toContain('slide sync --theme <theme-spec>')
    expect(message).toContain('slide_sync')
    expect(slidevRunner.calls).toHaveLength(0)
    expect(existsSync(out)).toBe(false)
  })

  it('staging の letter-spacing.json / href-map.json を auto-detect して chain に流す (ケース A)', async () => {
    // staging に書かれた json を CLI flag 無しでも自動検出して spc / hlinkClick が出力される
    // ことを pin。priority: `flag > staging > empty` の staging ルート。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'staging-auto.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({
      letterSpacing: { テスト: { letterSpacing: '2px', fontSize: '32px' } },
      href: { 公式サイト: 'https://example.com' },
    })
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const slideParts = ['ppt/slides/slide1.xml']

    // (a) letter-spacing が rPr@spc に反映されている
    const spcValues = await extractFromPptx(
      out, slideParts, '//a:rPr[@spc]', 'attr:spc', namespaces,
    )
    const spc = flattenAttributeValues(spcValues)
    // calculateSpcValue('2px') = round(2 * 0.75 * 100) = 150
    expect(spc).toContain('150')

    // (b) hlinkClick が anchor run に追加されている
    const hlinkValues = await extractFromPptx(
      out, slideParts, '//a:hlinkClick', 'count', namespaces,
    )
    const hitCount = hlinkValues.reduce(
      (sum, v) => sum + (typeof v.value === 'number' ? v.value : 0),
      0,
    )
    expect(hitCount).toBeGreaterThanOrEqual(1)

    // (c) slide rels に hyperlink Relationship が追加されている (Target=https://example.com)
    const relsTargets = await extractFromPptx(
      out,
      ['ppt/slides/_rels/slide1.xml.rels'],
      '//rel:Relationship[@Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"]',
      'attr:Target',
      { rel: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    )
    const targets = flattenAttributeValues(relsTargets)
    expect(targets).toContain('https://example.com')
  })

  it('flag 指定時は staging json を無視して flag 側を優先する (ケース B / priority pin)', async () => {
    // staging には spacing/href json を書きつつ、CLI flag で別 path の JSON を渡す。
    // 出力 spc 値は flag 側 (5px → spc=375) と一致し、staging 値 (2px → 150) ではないことを assert。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'flag-priority.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({
      letterSpacing: { テスト: { letterSpacing: '2px', fontSize: '32px' } },
      href: { 公式サイト: 'https://staging.example.com' },
    })
    const infra = realInfra()

    const flagSpacingPath = temporaryRoot('flag-spacing.json')
    writeFileSync(
      flagSpacingPath,
      JSON.stringify({ テスト: { letterSpacing: '5px', fontSize: '32px' } }),
    )
    const flagHrefPath = temporaryRoot('flag-href.json')
    writeFileSync(
      flagHrefPath,
      JSON.stringify({ 公式サイト: 'https://flag.example.com' }),
    )

    await runSlideConvert(
      projectDirectory,
      {
        out,
        json: false,
        spacingJson: flagSpacingPath,
        hrefJson: flagHrefPath,
      },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const slideParts = ['ppt/slides/slide1.xml']

    // (a) spc 値が flag 側 (5px → 375) になっており、staging 値 (150) ではない
    const spcValues = await extractFromPptx(
      out, slideParts, '//a:rPr[@spc]', 'attr:spc', namespaces,
    )
    const spc = flattenAttributeValues(spcValues)
    expect(spc).toContain('375')
    expect(spc).not.toContain('150')

    // (b) Relationship の Target が flag 側 URL になっており、staging 側ではない
    const relsTargets = await extractFromPptx(
      out,
      ['ppt/slides/_rels/slide1.xml.rels'],
      '//rel:Relationship[@Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"]',
      'attr:Target',
      { rel: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    )
    const targets = flattenAttributeValues(relsTargets)
    expect(targets).toContain('https://flag.example.com')
    expect(targets).not.toContain('https://staging.example.com')
  })

  it('staging に json が無いルートでは空 Map で chain される (priority: staging > empty)', async () => {
    // staging json を作らないルート。flag も無い。spc / hlinkClick は出力されない (= empty Map)。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-staging.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const namespaces = { a: NS_DRAWINGML, p: NS_PRESENTATIONML }
    const slideParts = ['ppt/slides/slide1.xml']

    // spc 属性は付いていない
    const spcValues = await extractFromPptx(
      out, slideParts, '//a:rPr[@spc]', 'count', namespaces,
    )
    const spcCount = spcValues.reduce(
      (sum, v) => sum + (typeof v.value === 'number' ? v.value : 0),
      0,
    )
    expect(spcCount).toBe(0)
  })

  it('--transition-type=morph + --morph-option=byChar + --transition-duration-ms=800 が反映される', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'morph.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      {
        out,
        json: false,
        transitionType: 'morph',
        transitionDurationMs: 800,
        morphOption: 'byChar',
      },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const namespaces = {
      p159: 'http://schemas.microsoft.com/office/powerpoint/2015/09/main',
      p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
    }
    const slideParts = ['ppt/slides/slide1.xml']

    const morphOption = await extractFromPptx(
      out, slideParts, '//p159:morph', 'attr:option', namespaces,
    )
    expect(flattenAttributeValues(morphOption)).toContain('byChar')

    // ここでは count で単純に検出するに留める
    const durValues = await extractFromPptx(
      out, slideParts, '//*[@p14:dur]', 'count', namespaces,
    )
    const durCount = durValues.reduce(
      (sum, v) => sum + (typeof v.value === 'number' ? v.value : 0),
      0,
    )
    expect(durCount).toBeGreaterThanOrEqual(1)
  })

  it('staging letter-spacing.json が破損している場合 SlideConvertRuntimeError(invalid-staging-json)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    // 不正 JSON を staging に投入する converter
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(path.join(slidesDirectory, 'letter-spacing.json'), 'not-a-json')
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging letter-spacing.json が plain object でない場合 invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(path.join(slidesDirectory, 'letter-spacing.json'), '[1,2]')
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging letter-spacing.json の entry 型不正で invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(
          path.join(slidesDirectory, 'letter-spacing.json'),
          JSON.stringify({ テスト: 'not-an-object' }),
        )
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging letter-spacing.json の entry が { letterSpacing, fontSize } 不揃いで invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(
          path.join(slidesDirectory, 'letter-spacing.json'),
          JSON.stringify({ テスト: { letterSpacing: '2px' } }),
        )
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging href-map.json が plain object でない場合 invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(path.join(slidesDirectory, 'href-map.json'), '"plain-string"')
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging href-map.json が parse 不能な場合 invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(path.join(slidesDirectory, 'href-map.json'), 'not-json')
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging href-map.json の entry 型不正で invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        writeFileSync(
          path.join(slidesDirectory, 'href-map.json'),
          JSON.stringify({ 公式: 123 }),
        )
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('flag 指定の path が読めない場合 invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false, spacingJson: temporaryRoot('no-such-spacing.json') },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('flag href の path が読めない場合 invalid-staging-json', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false, hrefJson: temporaryRoot('no-such-href.json') },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })

  it('staging json path がディレクトリの場合は読み込まずスキップ (空 Map で進行)', async () => {
    // resolveJsonSource は stat で isFile() のみ true を返すため、ディレクトリは無視される
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: async (arguments_) => {
        const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
        mkdirSync(slidesDirectory, { recursive: true })
        const buffer = await buildPptxWithSpacingAndAnchor()
        writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
        // letter-spacing.json をディレクトリ名として作る (file ではない)
        mkdirSync(path.join(slidesDirectory, 'letter-spacing.json'), { recursive: true })
        return pipelineSuccess()
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).resolves.toBeDefined()
  })

  it('--theme 指定時: runner.build に theme が伝搬する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out2.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, theme: 'sample-theme', json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    expect(slidevRunner.calls[0]?.theme).toBe('sample-theme')
  })

  it('--theme 不正値で SlideConvertUsageError(invalid-theme)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, theme: '$(rm -rf /)', json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toThrow(SlideConvertUsageError)
  })

  it('project-dir 不存在で SlideConvertRuntimeError(project-not-found)', async () => {
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      temporaryRoot('nonexistent'),
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toThrow(SlideConvertRuntimeError)
  })

  it('project-dir がファイル (= isDirectory()===false) で SlideConvertRuntimeError(project-not-found)', async () => {
    const file = temporaryRoot('a-file')
    writeFileSync(file, 'not a directory')
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      file,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toThrow(/ディレクトリではありません/)
  })

  it('slides.md 不在で SlideConvertRuntimeError(project-not-found)', async () => {
    const directory = temporaryRoot('no-slides')
    mkdirSync(directory, { recursive: true })
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      directory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toThrow(/slides\.md が見つかりません/)
  })

  it('SlidevRunner が exit≠0 で SlideConvertRuntimeError(slidev-build-failed)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner: SlidevRunner = {
      build: () => Promise.resolve(spawnFailure('slidev compile error')),
    }
    const pptxConverter: SlidevPptxPipeline = { convert: () => Promise.resolve(pipelineSuccess()) }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'slidev-build-failed' })
  })

  it('SlidevRunner timeout で SlideConvertRuntimeError(slidev-build-timeout)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner: SlidevRunner = {
      build: () => Promise.resolve(spawnTimeout()),
    }
    const pptxConverter: SlidevPptxPipeline = { convert: () => Promise.resolve(pipelineSuccess()) }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'slidev-build-timeout' })
  })

  it('Pipeline が success=false を返した時 SlideConvertRuntimeError(pptx-convert-failed)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: (arguments_) => {
        mkdirSync(arguments_.outputDirectory, { recursive: true })
        return Promise.resolve(pipelineFailure())
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })

  it('Pipeline が PipelineRuntimeError を throw した時 SlideConvertRuntimeError(pptx-convert-failed)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: () => Promise.reject(new PipelineRuntimeError('chromium launch failed')),
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })

  it('Pipeline が PipelineTimeoutError を throw した時 SlideConvertRuntimeError(pptx-convert-timeout)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: () => Promise.reject(new PipelineTimeoutError(100, { elapsedMs: 100 })),
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'pptx-convert-timeout' })
  })

  it('success=true でも staging に slide-<N>.pptx が無ければ SlideConvertRuntimeError(pptx-convert-failed)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      // staging slides/ を作らないまま success を返す破損した実装をシミュレート
      convert: () => Promise.resolve(pipelineSuccess()),
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })

  it('staging/slides/ 内に slide-<N>.pptx が 0 件でも (例: 空ディレクトリ) pptx-convert-failed', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: (arguments_) => {
        // staging/slides は作るが、slide-N.pptx は置かない (no match)
        mkdirSync(path.join(arguments_.outputDirectory, 'slides'), { recursive: true })
        // 関係ないファイルだけ置く (regex に match しないので無視される)
        writeFileSync(path.join(arguments_.outputDirectory, 'slides', 'README.txt'), 'noise')
        return Promise.resolve(pipelineSuccess())
      },
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )).rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })

  it('--json 未指定時は子の stdout/stderr を deps stream に relay 設定する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    let buildOptions: Parameters<SlidevRunner['build']>[1] | undefined
    const slidevRunner: SlidevRunner = {
      build: (projectDirectoryIn, options) => {
        buildOptions = options
        mkdirSync(path.join(projectDirectoryIn, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    }
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    const stdout = makeStream()
    const stderr = makeStream()
    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: asStream(stdout),
        stderr: asStream(stderr),
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )
    expect(buildOptions?.stdout).toBeDefined()
    expect(buildOptions?.stderr).toBeDefined()
  })

  it('--json 指定時は子の stdout/stderr を relay しない (capture のみ)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    let buildOptions: Parameters<SlidevRunner['build']>[1] | undefined
    const slidevRunner: SlidevRunner = {
      build: (projectDirectoryIn, options) => {
        buildOptions = options
        mkdirSync(path.join(projectDirectoryIn, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    }
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await runSlideConvert(
      projectDirectory,
      { out, json: true },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )
    expect(buildOptions?.stdout).toBeUndefined()
    expect(buildOptions?.stderr).toBeUndefined()
  })

  it('build 失敗時の stderr 末尾 1KB を超える場合は tail のみ detail に出る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const longStderr = 'X'.repeat(2048)
    const slidevRunner: SlidevRunner = {
      build: () => Promise.resolve(spawnFailure(longStderr)),
    }
    const pptxConverter: SlidevPptxPipeline = { convert: () => Promise.resolve(pipelineSuccess()) }
    const infra = realInfra()
    let captured: SlideConvertRuntimeError | undefined
    try {
      await runSlideConvert(
        projectDirectory,
        { out, json: false },
        {
          slidevRunner,
          pptxConverter,
          archive: infra.archive,
          engine: infra.engine,
          stdout: process.stdout,
          stderr: process.stderr,
          now: () => 0,
          pluginVersion: () => 'test-plugin',
          ...THEME_PORTS,
        },
      )
    }
    catch (error: unknown) {
      // eslint-disable-next-line no-restricted-syntax -- test narrowing
      captured = error as SlideConvertRuntimeError
    }
    expect(captured).toBeInstanceOf(SlideConvertRuntimeError)
    // detail 末尾 1024 字に丸まっている
    expect(captured?.message.length).toBeLessThan(longStderr.length + 200)
  })
})

interface BuildFakeDependenciesResult {
  slidevRunner: SlidevRunner
  pptxConverter: SlidevPptxPipeline
  archive: PptxArchive
  engine: XmlEngine
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  now: () => number
  pluginVersion: () => string
  ensureThemeLinked: SlideConvertDependencies['ensureThemeLinked']
  readThemeDeclaration: SlideConvertDependencies['readThemeDeclaration']
}

function buildFakeDependencies(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
  warnings: readonly string[] = []): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: createSuccessConverter(1, warnings),
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    pluginVersion: () => 'test-plugin',
    ...THEME_PORTS,
  }
}

/**
`slide.convert.error` payload の検証で使う形。`warnings` / `errors` は「フィールド不在＝
旧版」と「診断なしの run」を区別するため optional で受ける (#929/#931/#945)。
*/
interface ConvertErrorEvent {
  readonly event?: string
  readonly reason?: string
  readonly warnings?: readonly string[]
  readonly errors?: readonly {
    readonly level: string
    readonly slideNumber?: number
    readonly selector?: string
    readonly message: string
  }[]
}

describe('createSlideConvertCommand (commander 経由)', () => {
  it('--json 成功で slide.convert.start → slide.convert.done が stdout に出る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const events = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      .map((line): { event?: string } => {
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
        return JSON.parse(line) as { event?: string }
      })
    const eventNames = events.map(event => event.event)
    expect(eventNames).toEqual(['slide.convert.start', 'slide.convert.done'])
  })

  it('--json の done の timings は perSlide[].phases / outer / singlePass を持つ (#1141)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-phases.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const phases = { newPage: 0, goto: 0, visible: 0, cssSettle: 0, iframeLoad: 0, inject: 0, prerender: 3, convert: 5, restore: 1 }
    const singlePass: SinglePassGroupsTiming = {
      kind: 'converted',
      groups: [{
        slides: [1],
        steps: 1,
        pageA: { goto: 10, visible: 2, cssSettle: 1, iframeLoad: 0, inject: 4 },
        pageB: { goto: 9, wait: 7, scrollWarmup: 6 },
      }],
      fallbackSteps: [],
    }
    // now() は呼ばれるたびに 10 ずつ進む。区間はいずれも 1 回の呼び出し差なので 10 になる
    let clock = 0
    const base = buildFakeDependencies(stdout, stderr)
    const dependencies = {
      ...base,
      now: () => (clock += 10),
      pptxConverter: {
        // WritableStream を含む test 内 stub。
        // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
        async convert(arguments_: Readonly<Parameters<SlidevPptxPipeline['convert']>[0]>): Promise<PipelineResult> {
          mkdirSync(arguments_.outputDirectory, { recursive: true })
          await placeFakeSlides(arguments_.outputDirectory, 1)
          return {
            ...pipelineSuccess(),
            timing: { total: 0, scan: 0, phase1: 0, phase2: 0, perSlide: { 1: 8, 2: 4 }, perSlidePhases: { 1: phases }, singlePass },
          }
        },
      },
    }
    const command = createSlideConvertCommand(() => dependencies)

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const done = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      .map(line => JSON.parse(line) as { event?: string, timings?: Record<string, unknown> })
      .find(event => event.event === 'slide.convert.done')
    // phases は perSlide の同じ key の要素に載る。phases の無いステップ（キャッシュ hit 等）は phases キーを持たない
    expect(done?.timings?.['perSlide']).toStrictEqual([
      { key: '1', elapsedMs: 8, phases },
      { key: '2', elapsedMs: 4 },
    ])
    expect(done?.timings).not.toHaveProperty('perSlidePhases')
    expect(done?.timings?.['singlePass']).toStrictEqual(singlePass)
    expect(done?.timings?.['outer']).toStrictEqual({ cleanBuild: 10, slidevBuild: 10, pipeline: 10, mergeAndPostprocess: 10 })
  })

  it('--no-single-pass は pipeline に singlePass: false を渡し、未指定ならキーを置かない (#1147)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const received: (false | undefined)[] = []
    const keyPresent: boolean[] = []
    function dependenciesCapturing(): ReturnType<typeof buildFakeDependencies> {
      const base = buildFakeDependencies(makeStream(), makeStream())
      return {
        ...base,
        pptxConverter: {
          // WritableStream を含む test 内 stub。
          // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
          async convert(arguments_: Readonly<Parameters<SlidevPptxPipeline['convert']>[0]>): Promise<PipelineResult> {
            received.push(arguments_.singlePass)
            keyPresent.push('singlePass' in arguments_)
            return base.pptxConverter.convert(arguments_)
          },
        },
      }
    }

    await createSlideConvertCommand(dependenciesCapturing).parseAsync(
      [projectDirectory, '--out', temporaryRoot('no-single-1.pptx'), '--no-single-pass'],
      { from: 'user' },
    )
    await createSlideConvertCommand(dependenciesCapturing).parseAsync(
      [projectDirectory, '--out', temporaryRoot('no-single-2.pptx')],
      { from: 'user' },
    )

    expect(received).toStrictEqual([false, undefined])
    expect(keyPresent).toStrictEqual([true, false])
  })

  it('--json の done の timings は現行ルートの run では singlePass を持たず outer は常に載る (#1141)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-no-single.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const done = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      .map(line => JSON.parse(line) as { event?: string, timings?: Record<string, unknown> })
      .find(event => event.event === 'slide.convert.done')
    expect(done?.timings).not.toHaveProperty('perSlidePhases')
    expect(done?.timings).not.toHaveProperty('singlePass')
    expect(done?.timings).toHaveProperty('outer')
  })

  it('--json のとき pipeline の人間可読ログは stdout ではなく stderr へ出す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-json-log.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const isProcessStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const dependencies = {
        ...buildFakeDependencies(stdout, stderr),
        // 実 InProcessSlidevPptxPipeline を通し、runner が logger.info で人間可読ログを書く
        pptxConverter: new InProcessSlidevPptxPipeline({
          convertToPptxRunner: async (config, pipelineDependencies) => {
            pipelineDependencies.logger?.info('pipeline-human-log')
            mkdirSync(config.outputDir, { recursive: true })
            await placeFakeSlides(config.outputDir, 1)
            return pipelineSuccess()
          },
        }),
      }
      const command = createSlideConvertCommand(() => dependencies)

      await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

      const stdoutLines = stdout.chunks
        .flatMap(chunk => chunk.split('\n'))
        .filter(line => line.trim().length > 0)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      expect(stdoutLines.map(line => (JSON.parse(line) as { event?: string }).event))
        .toStrictEqual(['slide.convert.start', 'slide.convert.done'])
      expect(stderr.chunks.join('')).toContain('pipeline-human-log\n')
      expect(isProcessStdoutWrite).not.toHaveBeenCalled()
    }
    finally {
      isProcessStdoutWrite.mockRestore()
    }
  })

  it('--json なし成功で stdout にテキスト 1 行を出す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-text.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out], { from: 'user' })

    expect(stdout.chunks.join('')).toContain('slide convert')
    expect(stdout.chunks.join('')).toContain(out)
  })

  it('--json + invalid-theme で slide.convert.error / exit 2', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync([projectDirectory, '--out', out, '--theme', '$(rm -rf /)', '--json'], { from: 'user' })
      // start → error の系列。最後の event を error として検証する
      const events = stdout.chunks
        .flatMap(chunk => chunk.split('\n'))
        .filter(line => line.trim().length > 0)
        .map((line): ConvertErrorEvent => {
          // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
          return JSON.parse(line) as ConvertErrorEvent
        })
      const lastEvent = events.at(-1)
      expect(lastEvent?.event).toBe('slide.convert.error')
      expect(lastEvent?.reason).toBe('invalid-theme')
      // SlideConvertUsageError は SlideConvertRuntimeError と別の型。
      // warningsOf / pipelineErrorsOf の非 SlideConvertRuntimeError 分岐を通り、空配列になる (#931/#945)。
      expect(lastEvent?.warnings).toStrictEqual([])
      expect(lastEvent?.errors).toStrictEqual([])
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json + 未知フラグで slide.convert.error reason=invalid-option / warnings・errors は空配列', async () => {
    // commander の option 解析で落ちるルートは action を通らず configureOutput.writeErr が
    // JSON を書く。error payload 3 箇所のうちここだけ検証が無く、warnings の抜けを
    // 検知できなかった (#931)。writeErr は parse 引数ではなく process.argv を見るため、
    // --json 判定の材料をここで揃える。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousArgv = process.argv
    process.argv = [...previousArgv, '--json']
    try {
      await expect(
        command.parseAsync([projectDirectory, '--bogus', '--json'], { from: 'user' }),
      ).rejects.toThrow()

      const events = stdout.chunks
        .flatMap(chunk => chunk.split('\n'))
        .filter(line => line.trim().length > 0)
        .map((line): ConvertErrorEvent => {
          // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
          return JSON.parse(line) as ConvertErrorEvent
        })
      const lastEvent = events.at(-1)
      expect(lastEvent?.event).toBe('slide.convert.error')
      expect(lastEvent?.reason).toBe('invalid-option')
      expect(lastEvent?.warnings).toStrictEqual([])
      expect(lastEvent?.errors).toStrictEqual([])
    }
    finally {
      process.argv = previousArgv
    }
  })

  it('--json + project-not-found で slide.convert.error reason が runtime error から伝搬', async () => {
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [temporaryRoot('no-such-dir'), '--out', out, '--json'],
        { from: 'user' },
      )
      const events = stdout.chunks
        .flatMap(chunk => chunk.split('\n'))
        .filter(line => line.trim().length > 0)
        .map((line): ConvertErrorEvent => {
          // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
          return JSON.parse(line) as ConvertErrorEvent
        })
      const lastEvent = events.at(-1)
      expect(lastEvent?.event).toBe('slide.convert.error')
      expect(lastEvent?.reason).toBe('project-not-found')
      // pipeline 未到達でも warnings / errors は載せる。フィールド不在は「旧版」の意味に
      // 予約する (#931/#945)
      expect(lastEvent?.warnings).toStrictEqual([])
      expect(lastEvent?.errors).toStrictEqual([])
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json なし + project-not-found で stderr に詳細', async () => {
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync([temporaryRoot('nonexistent'), '--out', out], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('pecotv slide convert')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json なし + --transition-type 不正値で stderr に英文を出す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--transition-type', 'spin'],
        { from: 'user' },
      )
      expect(stderr.chunks.join('')).toContain('pecotv slide convert')
      expect(stderr.chunks.join('')).toContain('--transition-type')
      expect(stdout.chunks.length).toBe(0)
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--transition-type 不正値で slide.convert.error reason=invalid-transition-type', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--transition-type', 'spin', '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.convert.error')
      expect(parsed.reason).toBe('invalid-transition-type')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--morph-option 不正値で slide.convert.error reason=invalid-morph-option', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--morph-option', 'bogus', '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.convert.error')
      expect(parsed.reason).toBe('invalid-morph-option')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--transition-duration-ms に非整数を渡すと invalid-transition-duration-ms', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--transition-duration-ms', 'abc', '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.convert.error')
      expect(parsed.reason).toBe('invalid-transition-duration-ms')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--transition-duration-ms に小数を渡すと invalid-transition-duration-ms (trim 比較分岐)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--transition-duration-ms', '12.5', '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.convert.error')
      expect(parsed.reason).toBe('invalid-transition-duration-ms')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--transition-duration-ms に 0 を渡すと invalid-transition-duration-ms', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(
        [projectDirectory, '--out', out, '--transition-duration-ms', '0', '--json'],
        { from: 'user' },
      )
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(stdout.chunks[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.convert.error')
      expect(parsed.reason).toBe('invalid-transition-duration-ms')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('spacing / href / transition / morph の各オプションを全指定して成功する', async () => {
    // commander で 5 flag が受理され、optional spread が全て分岐する正常系を pin。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-all-flags.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const spacingPath = temporaryRoot('spacing.json')
    const hrefPath = temporaryRoot('href.json')
    writeFileSync(spacingPath, JSON.stringify({}))
    writeFileSync(hrefPath, JSON.stringify({}))
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))
    await command.parseAsync(
      [
        projectDirectory,
        '--out', out,
        '--spacing-json', spacingPath,
        '--href-json', hrefPath,
        '--transition-type', 'fade',
        '--transition-duration-ms', '500',
        '--morph-option', 'byObject',
      ],
      { from: 'user' },
    )
    expect(stdout.chunks.join('')).toContain('slide convert')
    expect(existsSync(out)).toBe(true)
  })

  it('--out 省略時は <project-dir>/pptx/<basename>.pptx に書き出す', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out 省略 + 末尾スラッシュ付き project-dir でも basename から既定パスが導出される', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    // 末尾スラッシュ付きで渡しても path.resolve が正規化するため basename は同じになる
    await command.parseAsync([`${projectDirectory}/`], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out 省略 + slides.md に title があれば title 由来の既定パスに書き出す', async () => {
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: 開発レポート\n---\n\n# body')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', '開発レポート.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
    // title があるので basename 由来の旧既定パスは生成されない
    const legacyOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(legacyOut)).toBe(false)
  })

  it('--out 省略 + slides.md はあるが title キーが無ければ basename 由来にフォールバックする', async () => {
    // readFile は成功するが parseSlidesTitle が undefined を返す接続 (title 不在 → basename fallback)。
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntheme: default\n---\n\n# body')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
    // 読取失敗ではないため stderr に診断は出ない
    expect(stderr.chunks.join('')).toBe('')
  })

  it('--out 省略 + slides.md 読取が ENOENT 以外で失敗したら stderr に診断を出し basename にフォールバック', async () => {
    // slides.md をディレクトリにして readFile を EISDIR (非 ENOENT) で失敗させる。
    // ensureProjectDirectory の stat は成功し、後段は進行する。
    const projectDirectory = temporaryRoot('sample')
    mkdirSync(path.join(projectDirectory, 'slides.md'), { recursive: true })
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    // 読取失敗の診断が stderr に出る (stdout の JSON/人間向けメッセージは汚さない)
    expect(stderr.chunks.join('')).toContain('slides.md を読み取れないため')
  })

  it('--out 省略 + title の禁止文字は _ に正規化される', async () => {
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: 2026/Q1 レポート\n---\n')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', '2026_Q1 レポート.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out 省略 + quoted title はクォートを外して既定パスにする', async () => {
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: \'クォート付き\'\n---\n')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', 'クォート付き.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out 省略 + --json 時 start / done 双方の output が title 由来パスになる', async () => {
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: JSON タイトル\n---\n')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--json'], { from: 'user' })

    const expectedOut = path.join(projectDirectory, 'pptx', 'JSON タイトル.pptx')
    const events = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      .map((line): { event?: string, output?: string } => {
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
        return JSON.parse(line) as { event?: string, output?: string }
      })
    const start = events.find(event => event.event === 'slide.convert.start')
    const done = events.find(event => event.event === 'slide.convert.done')
    expect(start?.output).toBe(expectedOut)
    expect(done?.output).toBe(expectedOut)
  })
})

describe('slideConvertDefaultDependencies', () => {
  it('infra 実装を組み立てて返す (in-process pipeline ルート)', () => {
    const dependencies = slideConvertDefaultDependencies()
    expect(dependencies.slidevRunner).toBeDefined()
    expect(dependencies.pptxConverter).toBeDefined()
    expect(dependencies.archive).toBeDefined()
    expect(dependencies.engine).toBeDefined()
    expect(typeof dependencies.now()).toBe('number')
  })
})

// 最小 PNG (8 byte signature + 16 byte IHDR チャンク領域)。
// CRC は省略しても、getPngDimensions は magic と IHDR marker、W/H 4 byte ずつのみ参照する。
function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  buffer.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function readPngDimensions(buffer: Readonly<Buffer>): { readonly width: number, readonly height: number } {
  // IHDR の W/H を直読み (test util)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

interface PicSpec {
  readonly xEmu: number
  readonly yEmu: number
  readonly cxEmu: number
  readonly cyEmu: number
}

/**
単一 image を含む単スライド PPTX を生成する。
`includeImageRel` を false にすると、`_rels/slide1.xml.rels` から image Relationship を除外する。
これで buildPicMediaMap が空になる状態 (3 段目フォールバック発火条件) を作る。
*/
function buildSinglePagePptxWithImage(options: {
  readonly pic: PicSpec
  readonly imageWidth: number
  readonly imageHeight: number
  readonly includeImageRel: boolean
}): Promise<Buffer> {
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Default Extension="png" ContentType="image/png"/>`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  const { pic } = options
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
      + `<p:cSld><p:spTree>`
      + `<p:pic>`
      + `<p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`
      + `<p:blipFill><a:blip r:embed="rId7"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
      + `<p:spPr><a:xfrm>`
      + `<a:off x="${String(pic.xEmu)}" y="${String(pic.yEmu)}"/>`
      + `<a:ext cx="${String(pic.cxEmu)}" cy="${String(pic.cyEmu)}"/>`
      + `</a:xfrm></p:spPr>`
      + `</p:pic>`
      + `</p:spTree></p:cSld></p:sld>`
  const slideRels = options.includeImageRel
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
    + `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
    + `</Relationships>`
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}"/>`
  const imageBuffer = makePng(options.imageWidth, options.imageHeight)
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', buffer: Buffer.from(slideRels, 'utf8') },
    { name: 'ppt/media/image1.png', buffer: imageBuffer },
  ])
}

interface PrerenderFixture {
  readonly pic: PicSpec
  readonly inputImageWidth: number
  readonly inputImageHeight: number
  readonly includeImageRel: boolean
  readonly prerender?: {
    readonly width: number
    readonly height: number
    readonly meta: Readonly<Record<string, unknown>>
  }
}

function createPrerenderConverter(fixture: Readonly<PrerenderFixture>): FakePptxConverter {
  const calls: FakePptxConverter['calls'] = []
  return {
    calls,
    async convert(arguments_) {
      const entry: FakePptxConverter['calls'][number] = {
        presDirectory: arguments_.presDirectory,
        targetDirectory: arguments_.targetDirectory,
        outputDirectory: arguments_.outputDirectory,
      }
      if (arguments_.skipPostprocess !== undefined) {
        entry.skipPostprocess = arguments_.skipPostprocess
      }
      calls.push(entry)
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      const buffer = await buildSinglePagePptxWithImage({
        pic: fixture.pic,
        imageWidth: fixture.inputImageWidth,
        imageHeight: fixture.inputImageHeight,
        includeImageRel: fixture.includeImageRel,
      })
      writeFileSync(path.join(slidesDirectory, 'slide-1.pptx'), buffer)
      if (fixture.prerender !== undefined) {
        writeFileSync(
          path.join(slidesDirectory, 'prerender-slide1-0.png'),
          makePng(fixture.prerender.width, fixture.prerender.height),
        )
        writeFileSync(
          path.join(slidesDirectory, 'prerender-slide1-0.meta.json'),
          JSON.stringify(fixture.prerender.meta),
        )
      }
      return pipelineSuccess()
    },
  }
}

interface MultiSlidePrerenderEntry {
  readonly originalSlideNumber: number
  readonly pic: PicSpec
  readonly inputImageWidth: number
  readonly inputImageHeight: number
  readonly prerender?: {
    readonly width: number
    readonly height: number
    readonly meta: Readonly<Record<string, unknown>>
  }
}

/**
複数スライド対応の prerender converter。dom-to-pptx の 100 刻みなど
元 slideNumber が連番でないケースを再現するために `originalSlideNumber` を
個別指定できる。
staging に `slide-<originalSlideNumber>.pptx` を書き出す。
同じく `prerender-slide<originalSlideNumber>-0.png` / `.meta.json` も書き出す。
*/
function createMultiSlidePrerenderConverter(
  entries: readonly Readonly<MultiSlidePrerenderEntry>[],
): FakePptxConverter {
  const calls: FakePptxConverter['calls'] = []
  return {
    calls,
    async convert(arguments_) {
      const callEntry: FakePptxConverter['calls'][number] = {
        presDirectory: arguments_.presDirectory,
        targetDirectory: arguments_.targetDirectory,
        outputDirectory: arguments_.outputDirectory,
      }
      if (arguments_.skipPostprocess !== undefined) {
        callEntry.skipPostprocess = arguments_.skipPostprocess
      }
      calls.push(callEntry)
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      for (const entry of entries) {
        const buffer = await buildSinglePagePptxWithImage({
          pic: entry.pic,
          imageWidth: entry.inputImageWidth,
          imageHeight: entry.inputImageHeight,
          includeImageRel: true,
        })
        writeFileSync(
          path.join(slidesDirectory, `slide-${String(entry.originalSlideNumber)}.pptx`),
          buffer,
        )
        if (entry.prerender === undefined) {
          continue
        }

        writeFileSync(
          path.join(slidesDirectory, `prerender-slide${String(entry.originalSlideNumber)}-0.png`),
          makePng(entry.prerender.width, entry.prerender.height),
        )
        writeFileSync(
          path.join(slidesDirectory, `prerender-slide${String(entry.originalSlideNumber)}-0.meta.json`),
          JSON.stringify(entry.prerender.meta),
        )
      }
      return pipelineSuccess()
    },
  }
}

async function readMediaImage(pptxPath: string, part: string): Promise<Buffer> {
  const archive = new YauzlYazlPptxArchive()
  const reader = await archive.read(pptxPath)
  try {
    return await reader.read(part)
  }
  finally {
    await reader.close()
  }
}

describe('prerender replace (CUJ 1-5)', () => {
  // EMU per CSS px (96 dpi): 1 CSS px = 9525 EMU
  const EMU = 9525

  it('CUJ 1: 1 段目発火 — 座標 + サイズ一致で高解像度版に差し替わる', async () => {
    // invariant: 1 段目発火 (距離 ≤ 50 px, サイズ相対 ≤ 15%, includeImageRel=true で picMap 非空)
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'stage1.pptx')
    const slidevRunner = createSuccessRunner()
    // 前提は pic 位置 (100 px, 200 px)、pic サイズ (400 px, 300 px)、PPTX 内 PNG 400 x 300。
    // prerender meta は left/top が ±10 px 以内、W/H が PNG と一致 (相対 0%)。
    const pptxConverter = createPrerenderConverter({
      pic: { xEmu: 100 * EMU, yEmu: 200 * EMU, cxEmu: 400 * EMU, cyEmu: 300 * EMU },
      inputImageWidth: 400,
      inputImageHeight: 300,
      includeImageRel: true,
      prerender: {
        width: 1200,
        height: 900,
        meta: { width: 400, height: 300, left: 105, top: 198, selector: '#mermaid' },
      },
    })
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const mediaBuffer = await readMediaImage(out, 'ppt/media/image1-s1.png')
    const dims = readPngDimensions(mediaBuffer)
    // 高解像度版 (1200 x 900) に差し替わっている
    expect(dims).toStrictEqual({ width: 1200, height: 900 })
  })

  it('CUJ 2: prerender ファイル不在で no-op (image dimensions 不変)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'noop.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createPrerenderConverter({
      pic: { xEmu: 100 * EMU, yEmu: 200 * EMU, cxEmu: 400 * EMU, cyEmu: 300 * EMU },
      inputImageWidth: 400,
      inputImageHeight: 300,
      includeImageRel: true,
      // prerender なし (entries が空 → applyPrerenderImageReplace が早期 return)
    })
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const mediaBuffer = await readMediaImage(out, 'ppt/media/image1-s1.png')
    const dims = readPngDimensions(mediaBuffer)
    // 入力 PNG (400 x 300) のまま
    expect(dims).toStrictEqual({ width: 400, height: 300 })
  })

  it('CUJ 3: 2 段目発火 — 座標外 + サイズ一致でフォールバック差し替え', async () => {
    // invariant: 2 段目発火 (距離 > 50 px で 1 段目却下、サイズ相対 ≤ 15%、picMap 非空で 3 段目には落ちない)
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'stage2.pptx')
    const slidevRunner = createSuccessRunner()
    // pic 位置 (100, 200) に対し meta.left/top を (400, 600) にする。距離は約 360 px で 50 px を超え、1 段目は却下される。
    // サイズは PNG と一致 (相対 0%) するため、2 段目が発火する。
    const pptxConverter = createPrerenderConverter({
      pic: { xEmu: 100 * EMU, yEmu: 200 * EMU, cxEmu: 400 * EMU, cyEmu: 300 * EMU },
      inputImageWidth: 400,
      inputImageHeight: 300,
      includeImageRel: true,
      prerender: {
        width: 1600,
        height: 1200,
        meta: { width: 400, height: 300, left: 400, top: 600 },
      },
    })
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const mediaBuffer = await readMediaImage(out, 'ppt/media/image1-s1.png')
    const dims = readPngDimensions(mediaBuffer)
    expect(dims).toStrictEqual({ width: 1600, height: 1200 })
  })

  it('CUJ 4: 3 段目発火 — rels に image rel が無く pic_media_map が空でも全 PNG 走査で差し替わる', async () => {
    // invariant: 3 段目発火 (includeImageRel=false で picMap 空、PNG 絶対差 ≤ 50 px)
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'stage3.pptx')
    const slidevRunner = createSuccessRunner()
    // includeImageRel=false で pic_media_map が空。
    // 3 段目は PPTX 内 PNG dimensions と meta.width/height の絶対差 ≤ 50 px で発火する。
    const pptxConverter = createPrerenderConverter({
      pic: { xEmu: 100 * EMU, yEmu: 200 * EMU, cxEmu: 400 * EMU, cyEmu: 300 * EMU },
      inputImageWidth: 400,
      inputImageHeight: 300,
      includeImageRel: false,
      prerender: {
        width: 2000,
        height: 1500,
        meta: { width: 410, height: 295 },
      },
    })
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    const mediaBuffer = await readMediaImage(out, 'ppt/media/image1-s1.png')
    const dims = readPngDimensions(mediaBuffer)
    expect(dims).toStrictEqual({ width: 2000, height: 1500 })
  })

  // CUJ 5: dom-to-pptx の 100 刻み slideNumber を再現する。
  // merged 連番 (1, 2) と元 slideNumber (100, 200) の逆引きが正しく機能することを担保する。
  // 既存 CUJ 1 は merged_index === original_slideNumber === 1 の幸運ケースで
  // バグを検出できなかった (commit 08bf130 を参照)。本テストは逆引きが必須の
  // ルートのみで合格する設計で、再発検出のための regression test。
  it('CUJ 5: 複数スライド × 100 刻み slideNumber でも prerender 逆引きで正しく解決される', async () => {
    // invariant: 元 slideNumber (100, 200) と merged 連番 (1, 2) は一致しない。
    // そのため逆引きが破損していると、prerender ファイルが見つからず差し替え 0 件になる。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'stage5.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createMultiSlidePrerenderConverter([
      {
        originalSlideNumber: 100,
        pic: { xEmu: 100 * EMU, yEmu: 200 * EMU, cxEmu: 320 * EMU, cyEmu: 40 * EMU },
        inputImageWidth: 320,
        inputImageHeight: 40,
        prerender: {
          width: 1280, // 高解像度版 (320 * 4)
          height: 160, // (40 * 4)
          meta: { width: 320, height: 40, left: 100, top: 200 },
        },
      },
      {
        originalSlideNumber: 200,
        pic: { xEmu: 50 * EMU, yEmu: 150 * EMU, cxEmu: 480 * EMU, cyEmu: 60 * EMU },
        inputImageWidth: 480,
        inputImageHeight: 60,
        prerender: {
          width: 1920, // (480 * 4)
          height: 240, // (60 * 4)
          meta: { width: 480, height: 60, left: 50, top: 150 },
        },
      },
    ])
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, json: false },
      {
        slidevRunner,
        pptxConverter,
        archive: infra.archive,
        engine: infra.engine,
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => 0,
        pluginVersion: () => 'test-plugin',
        ...THEME_PORTS,
      },
    )

    // mergePptxFiles で slide-100.pptx → slide1.xml (image1-s1.png) になる。
    // 同様に slide-200.pptx → slide2.xml (image1-s2.png) になる。
    const slide1MediaBuffer = await readMediaImage(out, 'ppt/media/image1-s1.png')
    expect(readPngDimensions(slide1MediaBuffer)).toStrictEqual({ width: 1280, height: 160 })

    const slide2MediaBuffer = await readMediaImage(out, 'ppt/media/image1-s2.png')
    expect(readPngDimensions(slide2MediaBuffer)).toStrictEqual({ width: 1920, height: 240 })
  })
})

// --- 差分キャッシュ (#896 US1) ---
// fake pipeline ではキャッシュ判定を通らない。
// そのため実 convertToPptx に fake playwright を注入した pipeline を組み立てる。
// convert コマンドの接続と可視化 (JSON / 人間向け) を検証する。

function cacheDeckMarkdown(bodies: readonly string[]): string {
  return ['---', 'theme: none', 'title: Cache Deck', '---', '', bodies.join('\n\n---\n\n'), ''].join('\n')
}

interface CacheProject {
  readonly directory: string
  readonly bundlePath: string
}

/**
デッキ 1 つ分の作業ディレクトリを作る。`name` は 1 つのテストで 2 プロジェクト
（全変換用と差分変換用）を併存させるために必要で、固定名にすると同一ディレクトリを
共有してキャッシュ状態が混在する。
*/
function makeCacheProject(root: string, name: string, bodies: readonly string[]): CacheProject {
  const directory = path.join(root, name)
  mkdirSync(path.join(directory, 'lib'), { recursive: true })
  mkdirSync(path.join(directory, 'styles'), { recursive: true })
  writeFileSync(path.join(directory, 'slides.md'), cacheDeckMarkdown(bodies))
  // 共有クロージャ（envHash の材料）を持つデッキにする。スライド本文と無関係な入力を
  // 動かせないと、FR-005 の「本文以外の変化での全無効化」を統合レベルで踏めない。
  writeFileSync(sharedStylesPathOf(directory), SHARED_STYLES_INITIAL)
  const bundlePath = path.join(directory, 'lib', 'dom-to-pptx.bundle.js')
  writeFileSync(bundlePath, 'globalThis.domToPptx = () => undefined\n')
  return { directory, bundlePath }
}

const SHARED_STYLES_INITIAL = ':root { --cache-test: 1; }\n'

function sharedStylesPathOf(directory: string): string {
  return path.join(directory, 'styles', 'base.css')
}

function rewriteCacheDeck(project: Readonly<CacheProject>, bodies: readonly string[]): void {
  writeFileSync(path.join(project.directory, 'slides.md'), cacheDeckMarkdown(bodies))
}

/**
scan ルートだけを満たす Playwright ページ / ブラウザの stub。ArrowRight で queue の URL を
順に送り、queue が尽きたら waitForURL を失敗させて scanSlideSteps を打ち切る
(FakePage と同じ流儀)。queue には 2 ステップ目以降の URL を渡す。
*/
function createQueueScanBrowser(urls: readonly string[]): Browser {
  const queue = [...urls]
  let currentUrl = `${FAKE_SERVER_ORIGIN}/`
  let isNavigable = true
  const page = {
    url: () => currentUrl,
    setViewportSize: () => Promise.resolve(),
    goto: (target: string) => {
      currentUrl = target
      return Promise.resolve()
    },
    waitForFunction: () => Promise.resolve(),
    waitForURL: () => (isNavigable ? Promise.resolve() : Promise.reject(new Error('no navigation'))),
    keyboard: {
      press: () => {
        const next = queue.shift()
        if (next === undefined) isNavigable = false
        else currentUrl = next
        return Promise.resolve()
      },
    },
    close: () => Promise.resolve(),
  }
  const browser = {
    version: () => '141.0.7390.37',
    newPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
  }
  // eslint-disable-next-line no-restricted-syntax -- Playwright の API 表面のうち scan ルートが呼ぶ分だけを実装した stub
  return browser as unknown as Browser
}

/**
連番スライド（clicks 無し）のデッキを走査する scan browser。
*/
function createScanBrowser(stepCount: number): Browser {
  return createQueueScanBrowser(
    Array.from({ length: stepCount - 1 }, (_v, index) => `${FAKE_SERVER_ORIGIN}/${String(index + 2)}`),
  )
}

/**
fake dist 配信サーバが bind したことにするポート。
実サーバは標準の port=0 で ephemeral bind し、`address()` の実ポートで baseUrl が組まれる。
fake も同じ形で答え、scan stub の URL もこの値から組む。
そうして pipeline が渡す baseUrl と食い違わせない。
*/
const FAKE_SERVER_PORT = 45_678
const FAKE_SERVER_ORIGIN = `http://localhost:${String(FAKE_SERVER_PORT)}`

function fakeHttpServer(): Server {
  // eslint-disable-next-line no-restricted-syntax -- close() と address() のみ呼ばれる stub
  return {
    close: () => { /* noop */ },
    address: () => ({ port: FAKE_SERVER_PORT, address: '127.0.0.1', family: 'IPv4' }),
  } as unknown as Server
}

/**
実 convertToPptx を fake playwright で動かす pipeline。slideWorkerRunner は
merge を通せる有効な単ページ PPTX を `slide-<stepIndex>.pptx` で書く。
*/
function createCachePipeline(
  project: Readonly<CacheProject>,
  stepCount: number,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
): SlidevPptxPipeline {
  return new InProcessSlidevPptxPipeline({
    // fake browser は evaluate を持たず print ページを描けない。そのため現行ルート（ステップ単位）に固定する。
    // 1 パスのルートは「1 パスのルートの run」の describe で、deps.singlePassRunner を差し替えて検証する。
    convertToPptxRunner: async (config, dependencies) => convertToPptx({ ...config, singlePass: false }, {
      ...dependencies,
      createBrowser: () => Promise.resolve(createScanBrowser(stepCount)),
      createServer: () => Promise.resolve(fakeHttpServer()),
      resolveDomToPptx: () => project.bundlePath,
      slideWorkerRunner: async (_browser, step, workerConfig, slidesDirectory) => {
        const stepIndex = stepIndexOf(step)
        calls.push(stepIndex)
        const buffer = await buildSinglePagePptx(`slide-${String(stepIndex)}`)
        writeFileSync(path.join(slidesDirectory, `${workerConfig.slidePrefix}${String(stepIndex)}.pptx`), buffer)
        return {
          step,
          letterSpacingMap: { [`s${String(step.slideNumber)}`]: { letterSpacing: '1.0px', fontSize: '14px' } },
          hrefMap: {},
          hasExplicitAnimation: false,
          prerenderResults: [],
          elapsed: 1,
        }
      },
    }),
  })
}

function cacheDependencies(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: createCachePipeline(project, 2, calls),
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    // plugin.json の版数に依存させず、run 間で envHash を安定させる
    pluginVersion: () => 'test-plugin-1.0.0',
    ...THEME_PORTS,
  }
}

/**
F-06: clicks クエリ付き URL を含む scan browser stub。
スライド 1 (click null) → スライド 2 (click null) → スライド 2 の click 1 の 3 ステップに展開される。
*/
function createClicksScanBrowser(): Browser {
  return createQueueScanBrowser(['http://localhost:3002/2', 'http://localhost:3002/2?clicks=1'])
}

function createClicksCachePipeline(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
): SlidevPptxPipeline {
  return new InProcessSlidevPptxPipeline({
    // fake browser は evaluate を持たず print ページを描けない。そのため現行ルート（ステップ単位）に固定する。
    // 1 パスのルートは「1 パスのルートの run」の describe で、deps.singlePassRunner を差し替えて検証する。
    convertToPptxRunner: async (config, dependencies) => convertToPptx({ ...config, singlePass: false }, {
      ...dependencies,
      createBrowser: () => Promise.resolve(createClicksScanBrowser()),
      createServer: () => Promise.resolve(fakeHttpServer()),
      resolveDomToPptx: () => project.bundlePath,
      slideWorkerRunner: async (_browser, step, workerConfig, slidesDirectory) => {
        const stepIndex = stepIndexOf(step)
        calls.push(stepIndex)
        const buffer = await buildSinglePagePptx(`slide-${String(stepIndex)}`)
        writeFileSync(path.join(slidesDirectory, `${workerConfig.slidePrefix}${String(stepIndex)}.pptx`), buffer)
        return {
          step,
          letterSpacingMap: { [`s${String(step.slideNumber)}`]: { letterSpacing: '1.0px', fontSize: '14px' } },
          hrefMap: {},
          hasExplicitAnimation: false,
          prerenderResults: [],
          elapsed: 1,
        }
      },
    }),
  })
}

function clicksCacheDependencies(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: createClicksCachePipeline(project, calls),
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    pluginVersion: () => 'test-plugin-1.0.0',
    ...THEME_PORTS,
  }
}

/**
F-02: prerender 差し替え（cache 由来 PNG が ppt/media に載るルート）を実際に踏む cache worker。
`buildSinglePagePptxWithImage` で pic + image relationship を持つ単スライド PPTX を書く。
対応する prerender PNG/meta も staging に置く。
キャッシュの保存・復元・merge 後の prerender 差し替えを一気通貫で通す。
*/
function createCachePrerenderPipeline(
  project: Readonly<CacheProject>,
  stepCount: number,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
): SlidevPptxPipeline {
  const PIC_EMU_PER_PX = 9525
  return new InProcessSlidevPptxPipeline({
    // fake browser は evaluate を持たず print ページを描けない。そのため現行ルート（ステップ単位）に固定する。
    // 1 パスのルートは「1 パスのルートの run」の describe で、deps.singlePassRunner を差し替えて検証する。
    convertToPptxRunner: async (config, dependencies) => convertToPptx({ ...config, singlePass: false }, {
      ...dependencies,
      createBrowser: () => Promise.resolve(createScanBrowser(stepCount)),
      createServer: () => Promise.resolve(fakeHttpServer()),
      resolveDomToPptx: () => project.bundlePath,
      slideWorkerRunner: async (_browser, step, workerConfig, slidesDirectory) => {
        const stepIndex = stepIndexOf(step)
        calls.push(stepIndex)
        const buffer = await buildSinglePagePptxWithImage({
          pic: {
            xEmu: 100 * PIC_EMU_PER_PX,
            yEmu: 200 * PIC_EMU_PER_PX,
            cxEmu: 400 * PIC_EMU_PER_PX,
            cyEmu: 300 * PIC_EMU_PER_PX,
          },
          imageWidth: 400,
          imageHeight: 300,
          includeImageRel: true,
        })
        writeFileSync(path.join(slidesDirectory, `${workerConfig.slidePrefix}${String(stepIndex)}.pptx`), buffer)
        writeFileSync(
          path.join(slidesDirectory, `prerender-slide${String(stepIndex)}-0.png`),
          makePng(1200, 900),
        )
        writeFileSync(
          path.join(slidesDirectory, `prerender-slide${String(stepIndex)}-0.meta.json`),
          JSON.stringify({ width: 400, height: 300, left: 100, top: 200 }),
        )
        return {
          step,
          letterSpacingMap: { [`s${String(step.slideNumber)}`]: { letterSpacing: '1.0px', fontSize: '14px' } },
          hrefMap: {},
          hasExplicitAnimation: false,
          prerenderResults: [],
          elapsed: 1,
        }
      },
    }),
  })
}

function cachePrerenderDependencies(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: createCachePrerenderPipeline(project, 2, calls),
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    pluginVersion: () => 'test-plugin-1.0.0',
    ...THEME_PORTS,
  }
}

/**
part 名が glob（`ppt/media/*` 等）に一致するエントリ数を数える（XML parse を伴わない）。
*/
async function countPptxParts(pptxPath: string, partPrefix: string): Promise<number> {
  const archive = new YauzlYazlPptxArchive()
  const reader = await archive.read(pptxPath)
  let count = 0
  try {
    for await (const entry of reader.entries()) {
      if (entry.part.startsWith(partPrefix)) count++
    }
  }
  finally {
    await reader.close()
  }
  return count
}

function parseEvents(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
): CacheDoneEvent[] {
  return stdout.chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.trim().length > 0)
    .map((line): CacheDoneEvent => {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      return JSON.parse(line) as CacheDoneEvent
    })
}

interface CacheDoneEvent {
  readonly event?: string
  /**
  slide.convert.error でのみ入る。done / start では undefined。
  */
  readonly reason?: string
  /**
  slide.convert.error でのみ入る。formatError(error) の結果 (#1097 F-05)。
  */
  readonly detail?: string
  readonly cache?: {
    readonly enabled: boolean
    readonly hits: number
    readonly misses: number
    readonly invalidated: string
  }
  readonly timings?: {
    readonly perSlide?: readonly { readonly key: string, readonly elapsedMs: number, readonly cache?: string }[]
    readonly singlePass?: unknown
  }
  /**
  #929。フィールド自体が無い（旧版）ことと、警告なしの run とを区別するため optional で受ける。
  */
  readonly warnings?: readonly string[]
  /**
  #945 / #949。warnings と同型（常時掲載・不在＝旧版）で slide.convert.error と
  slide.convert.done の双方に載る。
  */
  readonly errors?: readonly {
    readonly level: string
    readonly slideNumber?: number
    readonly selector?: string
    readonly message: string
  }[]
}

describe('slide convert の差分キャッシュ', () => {
  it('2 回連続で実行すると 2 回目は全ヒットし、変換が 1 件も動かない', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-1.pptx')
    const firstCalls: number[] = []
    const secondCalls: number[] = []
    const stdout = makeStream()
    const stderr = makeStream()

    const first = await runSlideConvert(
      project.directory,
      { out, json: false },
      cacheDependencies(project, firstCalls, stdout, stderr),
    )
    const second = await runSlideConvert(
      project.directory,
      { out, json: false },
      cacheDependencies(project, secondCalls, stdout, stderr),
    )

    expect(firstCalls).toStrictEqual([100, 200])
    expect(first.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'none' })
    expect(secondCalls).toStrictEqual([])
    expect(second.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })
    expect(existsSync(out)).toBe(true)
  })

  it('1 枚だけ変更した再実行では該当ステップのみ miss になる', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    await runSlideConvert(project.directory, { out, json: false }, cacheDependencies(project, [], stdout, stderr))
    rewriteCacheDeck(project, ['# スライド1', '# スライド2 を修正'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out, json: false },
      cacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
  })

  it('--json の done イベントに cache と timings.perSlide[].cache が乗る', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-3.pptx')
    const firstStdout = makeStream()
    const stderr = makeStream()
    const firstCommand = createSlideConvertCommand(() => cacheDependencies(project, [], firstStdout, stderr))
    await firstCommand.parseAsync([project.directory, '--out', out, '--json'], { from: 'user' })

    rewriteCacheDeck(project, ['# スライド1', '# スライド2 を修正'])
    const stdout = makeStream()
    const command = createSlideConvertCommand(() => cacheDependencies(project, [], stdout, stderr))
    await command.parseAsync([project.directory, '--out', out, '--json'], { from: 'user' })

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: true, hits: 1, misses: 1, invalidated: 'partial' })
    const perSlide = done?.timings?.perSlide ?? []
    expect(perSlide.map(entry => ({ key: entry.key, cache: entry.cache }))).toStrictEqual([
      { key: '1', cache: 'hit' },
      { key: '2', cache: 'miss' },
    ])
  })

  it('--json なしの出力に cache サマリと miss ステップの列挙 + hit 件数集約が出る (F-14)', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-4.pptx')
    const stderr = makeStream()
    const firstStdout = makeStream()
    const firstCommand = createSlideConvertCommand(() => cacheDependencies(project, [], firstStdout, stderr))
    await firstCommand.parseAsync([project.directory, '--out', out], { from: 'user' })

    rewriteCacheDeck(project, ['# スライド1', '# スライド2 を修正'])
    const stdout = makeStream()
    const command = createSlideConvertCommand(() => cacheDependencies(project, [], stdout, stderr))
    await command.parseAsync([project.directory, '--out', out], { from: 'user' })

    const text = stdout.chunks.join('')
    expect(text).toContain('cache: 1 hits / 1 misses')
    // miss（今回変換したステップ）のみを列挙し、hit は件数集約する（全ステップ列挙だと
    // 多スライドデッキで 500 文字を超えるため）。
    expect(text).toContain('cache steps: miss #2 (他 1 件 hit)')
  })

  it('全ヒットなら miss 列挙なしで件数のみ出す (F-14)', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-4b.pptx')
    const stderr = makeStream()
    const stdout = makeStream()
    const firstCommand = createSlideConvertCommand(() => cacheDependencies(project, [], stdout, stderr))
    await firstCommand.parseAsync([project.directory, '--out', out], { from: 'user' })

    const secondStdout = makeStream()
    const secondCommand = createSlideConvertCommand(() => cacheDependencies(project, [], secondStdout, stderr))
    await secondCommand.parseAsync([project.directory, '--out', out], { from: 'user' })

    const text = secondStdout.chunks.join('')
    expect(text).toContain('cache: 2 hits / 0 misses')
    expect(text).toContain('cache steps: 2 件 hit\n')
  })

  it('全ミスなら hit 件数の付記なしで miss を列挙する (F-14)', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-4c.pptx')
    const stderr = makeStream()
    const stdout = makeStream()
    const command = createSlideConvertCommand(() => cacheDependencies(project, [], stdout, stderr))
    await command.parseAsync([project.directory, '--out', out], { from: 'user' })

    const text = stdout.chunks.join('')
    expect(text).toContain('cache: 0 hits / 2 misses')
    expect(text).toContain('cache steps: miss #1, #2')
    expect(text).not.toContain('件 hit')
  })

  it('全ヒット run の出力 pptx は初回 run と同じ slide xml / ppt/media 件数を持つ (F-02)', async () => {
    // existsSync(out) だけでは、materialize の復元抜け（通知なしのスライド欠落）を検知できない。
    // fake worker に prerender ファイルを書かせる。
    // キャッシュルートと prerender 差し替え（cache 由来 PNG が ppt/media に載るルート）を同時に踏む。
    // その上で初回 run と全ヒット run の出力を比べる（out は run ごとに別パス）。
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const firstOut = temporaryRoot('cache-content-1.pptx')
    const secondOut = temporaryRoot('cache-content-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    const firstCalls: number[] = []
    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      cachePrerenderDependencies(project, firstCalls, stdout, stderr),
    )
    expect(firstCalls).toStrictEqual([100, 200])

    const secondCalls: number[] = []
    const second = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      cachePrerenderDependencies(project, secondCalls, stdout, stderr),
    )
    expect(secondCalls).toStrictEqual([])
    expect(second.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })

    const namespaces = { p: NS_PRESENTATIONML }
    const firstSlides = await extractFromPptx(firstOut, ['ppt/slides/slide*.xml'], '/*', 'count', namespaces)
    const secondSlides = await extractFromPptx(secondOut, ['ppt/slides/slide*.xml'], '/*', 'count', namespaces)
    expect(secondSlides).toHaveLength(firstSlides.length)
    expect(firstSlides).toHaveLength(2)

    const firstMediaCount = await countPptxParts(firstOut, 'ppt/media/')
    const secondMediaCount = await countPptxParts(secondOut, 'ppt/media/')
    expect(secondMediaCount).toBe(firstMediaCount)
    expect(firstMediaCount).toBe(2)

    // prerender 差し替え自体も、全ヒット run で通知なしに外れていないこと（高解像度版のまま）。
    const secondMedia1 = await readMediaImage(secondOut, 'ppt/media/image1-s1.png')
    expect(readPngDimensions(secondMedia1)).toStrictEqual({ width: 1200, height: 900 })
    const secondMedia2 = await readMediaImage(secondOut, 'ppt/media/image1-s2.png')
    expect(readPngDimensions(secondMedia2)).toStrictEqual({ width: 1200, height: 900 })
  })

  it('同じ --theme の再実行は全ヒットし、--theme を変えると全キャッシュが無効化される (F-01)', async () => {
    // --theme は slides.md の headmatter と共有クロージャのどちらにも現れない。
    // そのため envHash の材料に含めないと、テーマ切替後に旧テーマの描画が通知なしにヒットしてしまう。
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-theme.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    await runSlideConvert(
      project.directory,
      { out, json: false, theme: 'seriph' },
      cacheDependencies(project, [], stdout, stderr),
    )

    const sameThemeCalls: number[] = []
    const sameTheme = await runSlideConvert(
      project.directory,
      { out, json: false, theme: 'seriph' },
      cacheDependencies(project, sameThemeCalls, stdout, stderr),
    )
    expect(sameThemeCalls).toStrictEqual([])
    expect(sameTheme.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })

    const differentThemeCalls: number[] = []
    const differentTheme = await runSlideConvert(
      project.directory,
      { out, json: false, theme: 'sample-theme' },
      cacheDependencies(project, differentThemeCalls, stdout, stderr),
    )
    expect(differentThemeCalls).toStrictEqual([100, 200])
    expect(differentTheme.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
  })

  it('clicks=N クエリで展開されたステップは stepIndex/key で個別にキャッシュされ、2 回目で hit する (F-06)', async () => {
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-clicks.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    const first = await runSlideConvert(
      project.directory,
      { out, json: false },
      clicksCacheDependencies(project, [], stdout, stderr),
    )
    expect(first.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'miss' },
      { stepIndex: 200, key: '2', cache: 'miss' },
      { stepIndex: 201, key: '2/1', cache: 'miss' },
    ])

    const secondCalls: number[] = []
    const second = await runSlideConvert(
      project.directory,
      { out, json: false },
      clicksCacheDependencies(project, secondCalls, stdout, stderr),
    )
    expect(secondCalls).toStrictEqual([])
    expect(second.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'hit' },
      { stepIndex: 201, key: '2/1', cache: 'hit' },
    ])

    // JSON の timings.perSlide でも key "2/1" に cache 注釈が付く（3 回目も引き続き全 hit）。
    const jsonStdout = makeStream()
    const command = createSlideConvertCommand(() => clicksCacheDependencies(project, [], jsonStdout, stderr))
    await command.parseAsync([project.directory, '--out', out, '--json'], { from: 'user' })
    const done = parseEvents(jsonStdout).find(event => event.event === 'slide.convert.done')
    const perSlide = done?.timings?.perSlide ?? []
    expect(perSlide.find(entry => entry.key === '2/1')).toMatchObject({ key: '2/1', cache: 'hit' })
  })

  it('pipeline が cache を返さないルートでは done イベントに cache フィールドが出ない', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cache-5.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done).toBeDefined()
    expect(done?.cache).toBeUndefined()
  })

  it('pipeline が積んだ warnings が done イベントに載る (#929)', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('warnings-1.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const warning = 'キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）'
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr, [warning]))

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.warnings).toStrictEqual([warning])
  })

  it('警告なしの run でも done イベントに warnings: [] を出す (#929)', async () => {
    // 条件付き掲載にすると「フィールドが無い＝警告なし」と「旧版で観測不能」が同型になる。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('warnings-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideConvertCommand(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'], { from: 'user' })

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.warnings).toStrictEqual([])
  })
})

// --- 変換に失敗した run の warnings 掲載 (#931) ---
// 警告は「変換が成功した run」だけの情報ではない。失敗の原因診断にこそ要るため、
// slide.convert.error にも done と同型（常時掲載・不在＝旧版）で載せる。

const CACHE_WARNING = 'キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）'

/**
pipeline が指定の結果を返す（または throw する）deps を組む。
*/
function buildPipelineDependencies(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
  convert: SlidevPptxPipeline['convert'],
): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: { convert },
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    pluginVersion: () => 'test-plugin',
    ...THEME_PORTS,
  }
}

async function runCommandJson(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  dependencies: BuildFakeDependenciesResult,
  argv: readonly string[],
): Promise<void> {
  const previousExitCode = process.exitCode
  try {
    const command = createSlideConvertCommand(() => dependencies)
    await command.parseAsync([...argv], { from: 'user' })
  }
  finally {
    process.exitCode = previousExitCode
  }
}

/**
1 パスのルートの fake が返す timing（グループ 1 つ・退避なし）。
*/
const FAKE_SINGLE_PASS_TIMING: SinglePassGroupsTiming = {
  kind: 'converted',
  groups: [{ slides: [1, 2], steps: 2, pageA: { goto: 1, visible: 1, cssSettle: 1, iframeLoad: 1, inject: 1 } }],
  fallbackSteps: [],
}

/**
単スライド PPTX を staging に書き、変換結果を返す（現行 worker と 1 パスのルートの fake で共用）。
*/
async function writeFakeSlide(
  step: Readonly<SlideConvertResult['step']>,
  slidePrefix: string,
  slidesDirectory: string,
): Promise<SlideConvertResult> {
  const stepIndex = stepIndexOf(step)
  const buffer = await buildSinglePagePptx(`slide-${String(stepIndex)}`)
  writeFileSync(path.join(slidesDirectory, `${slidePrefix}${String(stepIndex)}.pptx`), buffer)
  return { step, letterSpacingMap: {}, hrefMap: {}, hasExplicitAnimation: false, prerenderResults: [], elapsed: 1 }
}

interface SinglePassCalls {
  /**
  現行 worker で変換した stepIndex
  */
  readonly worker: number[]
  /**
  1 パスのルートの fake で変換した stepIndex
  */
  readonly singlePass: number[]
}

/**
実 convertToPptx を fake playwright で動かし、1 パスのルートを `singlePassRunner` に差し替える pipeline。
config は index.ts が組み立てたまま渡す（既定 on・env・`--no-single-pass` の解釈を通す）。
`outcome` を省略した fake は、各ステップを 1 パスで変換する。
`fallbackKeys` のステップだけを request の現行 worker（fallbackRunner）へ回し、退避理由を返す。
*/
function createSinglePassPipeline(
  project: Readonly<CacheProject>,
  stepCount: number,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: SinglePassCalls,
  options: Readonly<{ fallbackKeys?: readonly string[], outcome?: SinglePassOutcome }> = {},
): SlidevPptxPipeline {
  const slideWorkerRunner: SlideWorkerRunner = async (_browser, step, workerConfig, slidesDirectory) => {
    calls.worker.push(stepIndexOf(step))
    return writeFakeSlide(step, workerConfig.slidePrefix, slidesDirectory)
  }
  const singlePassRunner: SinglePassRunner = async (request) => {
    if (options.outcome !== undefined) return options.outcome
    const fallbackKeys = new Set(options.fallbackKeys)
    const results: PromiseSettledResult<SlideConvertResult>[] = []
    const fallbacks: string[] = []
    for (const step of request.steps) {
      const key = String(step.slideNumber)
      if (fallbackKeys.has(key)) {
        fallbacks.push(`スライド #${key}: export failed`)
        results.push({ status: 'fulfilled', value: await request.fallbackRunner(request.browser, step, request.workerConfig, request.slidesDir, request.logger) })
        continue
      }
      calls.singlePass.push(stepIndexOf(step))
      results.push({ status: 'fulfilled', value: await writeFakeSlide(step, request.workerConfig.slidePrefix, request.slidesDir) })
    }
    return { kind: 'converted', results, timing: FAKE_SINGLE_PASS_TIMING, fallbacks }
  }
  return new InProcessSlidevPptxPipeline({
    convertToPptxRunner: async (config, dependencies) => convertToPptx(config, {
      ...dependencies,
      createBrowser: () => Promise.resolve(createScanBrowser(stepCount)),
      createServer: () => Promise.resolve(fakeHttpServer()),
      resolveDomToPptx: () => project.bundlePath,
      slideWorkerRunner,
      singlePassRunner,
    }),
  })
}

/**
`slide convert --json` を 1 回実行し、done イベントと呼び出しを返す。
*/
async function runSinglePassConvertJson(
  project: Readonly<CacheProject>,
  extraArguments: readonly string[] = [],
  options: Readonly<{ fallbackKeys?: readonly string[], outcome?: SinglePassOutcome }> = {},
): Promise<{ done: CacheDoneEvent | undefined, calls: SinglePassCalls }> {
  const calls: SinglePassCalls = { worker: [], singlePass: [] }
  const stdout = makeStream()
  const stderr = makeStream()
  const out = temporaryRoot('single-pass.pptx')
  const command = createSlideConvertCommand(() => ({
    ...cacheDependencies(project, [], stdout, stderr),
    pptxConverter: createSinglePassPipeline(project, 2, calls, options),
  }))
  await command.parseAsync([project.directory, '--out', out, '--json', ...extraArguments], { from: 'user' })
  return { done: parseEvents(stdout).find(event => event.event === 'slide.convert.done'), calls }
}

describe('slide convert の 1 パスのルート (#1147)', () => {
  beforeEach(() => {
    // 既定（env 未設定）の挙動を固定する。実行環境の PECOTV_SINGLE_PASS に左右されない

    vi.stubEnv('PECOTV_SINGLE_PASS', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('env 未設定では 1 パスのルートで変換し、done の timings.singlePass に載せる', async () => {
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])

    const { done, calls } = await runSinglePassConvertJson(project)

    expect(calls).toStrictEqual({ worker: [], singlePass: [100, 200] })
    expect(done?.timings?.singlePass).toStrictEqual(FAKE_SINGLE_PASS_TIMING)
    expect(done?.warnings).toStrictEqual([])
    expect(done?.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'none' })
  })

  it('1 パスのルートの成果物をキャッシュし、2 回目は全 hit で 1 パスのルートと現行 worker を呼ばない', async () => {
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])
    await runSinglePassConvertJson(project)

    const { done, calls } = await runSinglePassConvertJson(project)

    expect(calls).toStrictEqual({ worker: [], singlePass: [] })
    expect(done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(done?.timings).not.toHaveProperty('singlePass')
  })

  it('1 パスのルートの退避は warning に載り、退避したステップは現行 worker で変換される', async () => {
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])

    const { done, calls } = await runSinglePassConvertJson(project, [], { fallbackKeys: ['2'] })

    expect(calls).toStrictEqual({ worker: [200], singlePass: [100] })
    expect(done?.warnings).toStrictEqual(['1 パス変換を使わず現行方式で変換します: スライド #2: export failed'])
    // 退避したステップの成果物も同じ run のキャッシュに入る
    const second = await runSinglePassConvertJson(project)
    expect(second.done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
  })

  it('print ルートの無い build は warning 1 件で run 全体を現行ルートに任せ、timings.singlePass に理由と判定時間を載せる', async () => {
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])
    const missing: SinglePassFallbackTiming = { kind: 'printRouteMissing', fallback: 'デッキの build に print ルートがありません', detectMs: 40 }

    const { done, calls } = await runSinglePassConvertJson(project, [], { outcome: { kind: 'printRouteMissing', timing: missing } })

    expect(calls).toStrictEqual({ worker: [100, 200], singlePass: [] })
    expect(done?.timings?.singlePass).toStrictEqual(missing)
    expect(done?.warnings).toStrictEqual([
      '1 パス変換を使わず現行方式で変換します: デッキの build に print ルートがありません。`slide_sync` で deck を同期すると print ルートが入ります',
    ])
  })

  it('ルートを切り替えた run は envHash が変わり all:env で全変換になる（--no-single-pass と PECOTV_SINGLE_PASS=0 は同じルート）', async () => {
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])

    const singlePass = await runSinglePassConvertJson(project)
    const perStep = await runSinglePassConvertJson(project, ['--no-single-pass'])
    vi.stubEnv('PECOTV_SINGLE_PASS', '0')
    const perStepByEnvironment = await runSinglePassConvertJson(project)
    vi.stubEnv('PECOTV_SINGLE_PASS', '1')
    const optionOverEnvironment = await runSinglePassConvertJson(project, ['--no-single-pass'])

    vi.stubEnv('PECOTV_SINGLE_PASS', undefined)
    const backToSinglePass = await runSinglePassConvertJson(project)

    expect(singlePass.done?.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'none' })
    expect(perStep.done?.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
    expect(perStep.calls).toStrictEqual({ worker: [100, 200], singlePass: [] })
    expect(perStep.done?.timings).not.toHaveProperty('singlePass')
    expect(perStepByEnvironment.done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(optionOverEnvironment.done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(backToSinglePass.done?.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
    expect(backToSinglePass.calls).toStrictEqual({ worker: [], singlePass: [100, 200] })
  })
})

describe('slide.convert.error の warnings 掲載 (#931)', () => {
  it('pipeline が success:false を返した run でも、積まれた警告が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-1.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      return Promise.resolve(pipelineFailure([CACHE_WARNING]))
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('warnings 付きの PipelineRuntimeError を throw した run では、その警告が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineRuntimeError('aborted', { warnings: [CACHE_WARNING] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('warnings 付きの PipelineTimeoutError でも警告が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-3.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(100, { elapsedMs: 100, warnings: [CACHE_WARNING] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('pipeline 成功後の書き出し失敗でも reason は unknown にならず、警告が載る', async () => {
    // --out がディレクトリだと writer.finish が生の EISDIR Error を投げる。wrap しないと
    // errorToReason が unknown になり、pipeline の警告も添付されない（e2e 計測のルート）。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-4-dir')
    mkdirSync(out, { recursive: true })
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildFakeDependencies(stdout, stderr, [CACHE_WARNING])

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('merge-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('option 解析で落ちた run では warnings: [] を載せる', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-5.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    await runCommandJson(
      buildFakeDependencies(stdout, stderr),
      [projectDirectory, '--out', out, '--transition-type', 'spin', '--json'],
    )

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('invalid-transition-type')
    expect(error?.warnings).toStrictEqual([])
  })
})

// --- 変換に失敗した run の errors 掲載 (#945) ---
// 蓄積済みの変換エラーは throw で終わる run でこそ原因診断に要る。detail は先頭 3 件に
// 丸めるため、機械可読な errors は warnings と同型（常時掲載・不在＝旧版）で全件載せる。

const SLIDE_ERROR = { level: 'slide', slideNumber: 2, message: 'worker-failed' }
const ELEMENT_ERROR = { level: 'element', slideNumber: 1, selector: '.chart', message: 'pr-fail' }

describe('slide.convert.error の errors 掲載 (#945)', () => {
  it('pipeline が success:false を返した run では、その errors が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-1.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      return Promise.resolve(pipelineFailure())
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.errors).toStrictEqual([
      { level: 'slide', slideNumber: 1, message: 'dom-to-pptx inject failed' },
    ])
  })

  it('errors 付きの PipelineRuntimeError を throw した run では、その errors が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineRuntimeError('aborted', { errors: [ELEMENT_ERROR, SLIDE_ERROR] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.errors).toStrictEqual([ELEMENT_ERROR, SLIDE_ERROR])
  })

  it('errors 付きの PipelineTimeoutError でも errors が error イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-3.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(100, { elapsedMs: 100, errors: [SLIDE_ERROR] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.errors).toStrictEqual([SLIDE_ERROR])
  })

  it('pipeline 成功後の書き出し失敗でも、pipeline の積んだ要素エラーが載る', async () => {
    // 要素エラーは success:true と両立する（スライド単位の失敗のみが success を落とす）。
    // --out がディレクトリだと writer.finish が生の EISDIR Error を投げ、merge-failed へ wrap される。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-4-dir')
    mkdirSync(out, { recursive: true })
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, async (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      await placeFakeSlides(arguments_.outputDirectory, 1)
      return { ...pipelineSuccess(), errors: [ELEMENT_ERROR] }
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('merge-failed')
    expect(error?.errors).toStrictEqual([ELEMENT_ERROR])
  })

  it('option 解析で落ちた run では errors: [] を載せる', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-5.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    await runCommandJson(
      buildFakeDependencies(stdout, stderr),
      [projectDirectory, '--out', out, '--transition-type', 'spin', '--json'],
    )

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('invalid-transition-type')
    expect(error?.errors).toStrictEqual([])
    expect(error?.warnings).toStrictEqual([])
  })
})

// --- idle timeout の文言 (#1097 F-05) ---
// PipelineTimeoutError.message は「進捗なし」と最終進捗ラベルを埋め込む (errors.ts)。
// convert.ts はこれを SlideConvertRuntimeError に包む。
// 包んだ文言は `pptx convert がタイムアウトしました: ${error.message}`。
// detail = formatError(error) で --json の error イベントへ、そのまま渡す。
// このルートを固定し、退行時の検知を可能にする。

describe('slide.convert.error の detail (idle timeout) (#1097 F-05)', () => {
  it('PipelineTimeoutError の elapsedMs / lastProgress が detail に「進捗なし」と最終進捗ラベルとして載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-timeout-detail.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(600_000, { elapsedMs: 612_345, lastProgress: 'スライド #7 変換完了' }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.detail).toContain('進捗なし')
    expect(error?.detail).toContain('最終進捗: スライド #7 変換完了')
  })
})

// --- キャンセル (#1228) ---
// MCP のキャンセル (signal の abort) で slidev build と pipeline を止め、PPTX を書き出さない。

describe('runSlideConvert のキャンセル (#1228)', () => {
  it('pipeline の実行中に abort すると、pipeline へ渡した signal が abort され、PPTX を書かずに cancelled で失敗する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'cancel-pipeline.pptx')
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const dependencies: BuildFakeDependenciesResult = {
      ...buildFakeDependencies(makeStream(), makeStream()),
      pptxConverter: {
        convert: (arguments_) => {
          received = arguments_.signal
          return new Promise((_resolve, reject) => {
            arguments_.signal?.addEventListener('abort', () => {
              reject(new PipelineRuntimeError('aborted'))
            })
            controller.abort()
          })
        },
      },
    }

    const error = await rejectionOf(runSlideConvert(projectDirectory, { out }, { ...dependencies, signal: controller.signal }))

    expect(received).toBe(controller.signal)
    expect(error).toBeInstanceOf(SlideConvertRuntimeError)
    expect(error).toMatchObject({ reason: 'cancelled' })
    expect(existsSync(out)).toBe(false)
  })

  it('slidev build の実行中に abort すると、build へ signal が渡り、pipeline を起動せず cancelled で失敗する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'cancel-build.pptx')
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const convert = vi.fn<SlidevPptxPipeline['convert']>()
    const dependencies: BuildFakeDependenciesResult = {
      ...buildFakeDependencies(makeStream(), makeStream()),
      slidevRunner: {
        build: (_directory, options) => {
          received = options.signal
          controller.abort()
          return Promise.resolve(spawnFailure('killed'))
        },
      },
      pptxConverter: { convert },
    }

    const error = await rejectionOf(runSlideConvert(projectDirectory, { out }, { ...dependencies, signal: controller.signal }))

    expect(received).toBe(controller.signal)
    expect(error).toMatchObject({ reason: 'cancelled' })
    expect(convert).not.toHaveBeenCalled()
    expect(existsSync(out)).toBe(false)
  })

  it('pipeline がキャンセルに間に合わず完走しても、PPTX は書き出さない', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'cancel-late.pptx')
    const controller = new AbortController()
    const completing = createSuccessConverter(1)
    const dependencies: BuildFakeDependenciesResult = {
      ...buildFakeDependencies(makeStream(), makeStream()),
      pptxConverter: {
        convert: async (arguments_) => {
          const result = await completing.convert(arguments_)
          controller.abort()
          return result
        },
      },
    }

    const error = await rejectionOf(runSlideConvert(projectDirectory, { out }, { ...dependencies, signal: controller.signal }))

    expect(error).toMatchObject({ reason: 'cancelled' })
    expect(existsSync(out)).toBe(false)
  })

  it('abort 済みで呼ぶと、前処理 (dist / index.html の削除) にも入らず cancelled で失敗する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const staleDistribution = path.join(projectDirectory, 'dist')
    const staleIndex = path.join(projectDirectory, 'index.html')
    mkdirSync(staleDistribution)
    writeFileSync(staleIndex, '<html></html>')
    const out = temporaryRoot('out', 'cancel-before-start.pptx')
    const controller = new AbortController()
    controller.abort()
    const build = vi.fn<SlidevRunner['build']>()
    const dependencies: BuildFakeDependenciesResult = {
      ...buildFakeDependencies(makeStream(), makeStream()),
      slidevRunner: { build },
    }

    const error = await rejectionOf(runSlideConvert(projectDirectory, { out }, { ...dependencies, signal: controller.signal }))

    expect(error).toMatchObject({ reason: 'cancelled' })
    expect(build).not.toHaveBeenCalled()
    expect(existsSync(staleDistribution)).toBe(true)
    expect(existsSync(staleIndex)).toBe(true)
    expect(existsSync(path.dirname(out))).toBe(false)
  })

  it('pipeline 完了後、結合の直前に abort されても、PPTX は書き出さない', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'cancel-before-merge.pptx')
    const controller = new AbortController()
    const completing = createSuccessConverter(1)
    let isPipelineDone = false
    const base = buildFakeDependencies(makeStream(), makeStream())
    const dependencies: BuildFakeDependenciesResult = {
      ...base,
      pptxConverter: {
        convert: async (arguments_) => {
          const result = await completing.convert(arguments_)
          isPipelineDone = true
          return result
        },
      },
      // pipeline 直後の経過時間計測 (mergeStart) を、キャンセル確認のあとで abort する観測点に使う。
      now: () => {
        if (isPipelineDone) controller.abort()
        return 0
      },
    }

    const error = await rejectionOf(runSlideConvert(projectDirectory, { out }, { ...dependencies, signal: controller.signal }))

    expect(error).toMatchObject({ reason: 'cancelled' })
    expect(existsSync(out)).toBe(false)
  })

  it('signal を渡さない実行は従来どおり完走する', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-signal.pptx')

    await runSlideConvert(projectDirectory, { out }, buildFakeDependencies(makeStream(), makeStream()))

    expect(existsSync(out)).toBe(true)
  })
})

// --- 成功完走した run の errors 掲載 (#949) ---
// level=element のエラーは success を落とさないため、run は done で完走する。集約出力は
// `--json` でも stderr に出るが人間可読テキストなので、done payload が唯一の機械可読な
// 観測ルートになる。

describe('slide.convert.done の errors 掲載 (#949)', () => {
  it('element エラーのみで成功完走した run でも、その errors が done イベントに載る', async () => {
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-1.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, async (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      await placeFakeSlides(arguments_.outputDirectory, 1)
      return { ...pipelineSuccess(), errors: [ELEMENT_ERROR] }
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const events = parseEvents(stdout)
    // 成功完走であることを固定する（error イベント無し + 出力 pptx 生成済み）。
    expect(events.find(event => event.event === 'slide.convert.error')).toBeUndefined()
    expect(existsSync(out)).toBe(true)
    const done = events.find(event => event.event === 'slide.convert.done')
    expect(done?.errors).toStrictEqual([ELEMENT_ERROR])
  })

  it('エラーなしの run でも done イベントに errors: [] を出す', async () => {
    // 条件付き掲載にすると「フィールドが無い＝エラーなし」と「旧版で観測不能」が同型になる。
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-2.pptx')
    const stdout = makeStream()
    const stderr = makeStream()

    await runCommandJson(buildFakeDependencies(stdout, stderr), [projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.errors).toStrictEqual([])
  })

  it('errors が複数件でも done イベントには全件が載る', async () => {
    // detail 側（formatPipelineErrors）の先頭 3 件丸めを機械可読な errors へ波及させない。
    const secondElementError = {
      level: 'element',
      slideNumber: 2,
      selector: '.table',
      message: 'pr-fail-2',
    }
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-3.pptx')
    const stdout = makeStream()
    const stderr = makeStream()
    const dependencies = buildPipelineDependencies(stdout, stderr, async (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      await placeFakeSlides(arguments_.outputDirectory, 1)
      return { ...pipelineSuccess(), errors: [ELEMENT_ERROR, secondElementError] }
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.errors).toStrictEqual([ELEMENT_ERROR, secondElementError])
  })
})

// --- 出力同一性 / 構成変更 (#897 US2: T011-a / T012) ---
// 同一ソースを「全変換」と「差分変換」の 2 ルートで変換する。
// 出力どうしを XPath 抽出値レベルで相互比較する（正解源を持たない自己相対方式。SC-003 / FR-008 の定義そのもの）。
//
// 上の差分キャッシュ節の fake worker は stepIndex だけを見て pptx を書くため、どのスライドを
// 復元しても出力が同じになり、同一性比較が恒真になる。
// 以下の pipeline はデッキ本文を読んで、テキスト・座標へ埋め込む。
// これでキャッシュが誤ったスライドを復元した場合に、比較が実際に落ちる。
// 既存 F-02 が依存する createCachePrerenderPipeline は変更しない。

/**
全スライドに同一内容で置くテキスト。letterSpacingMap / hrefMap はどちらもテキスト内容が
キーなので、この 1 本で両方の後勝ち集約を踏ませる。
*/
const SHARED_SLIDE_TEXT = '共通テキスト'
/**
この文字列を含む本文のスライドは、fake worker がテキスト図形を書かない。
*/
const IMAGE_ONLY_BODY_MARKER = '画像のみ'
/**
この文字列を含む本文のスライドは、fake worker が prerender を 2 枚書く。
*/
const EXTRA_PRERENDER_BODY_MARKER = 'プレビュー2枚'

/**
本文から prerender の出力枚数を決める。枚数が減る編集を作れるようにするための口。
*/
function prerenderCountOf(body: string): number {
  return body.includes(EXTRA_PRERENDER_BODY_MARKER) ? 2 : 1
}
const CONTENT_PIC_WIDTH_PX = 400
const CONTENT_PIC_HEIGHT_PX = 300
const EMU_PER_PX = 9525

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
デッキ本文からスライド固有の内容マーカーを作る（出力の位置と内容の対応を検証するため）。
*/
function slideMarkerOf(body: string): string {
  return `マーカー ${body.replaceAll('\n', ' ').trim()}`
}

/**
本文から決定論的に座標を作る。内容が変われば座標も変わるので取り違えが座標にも出る。
*/
function contentOffsetPxOf(body: string): number {
  let sum = 0
  for (const character of body) sum += character.codePointAt(0) ?? 0
  return 100 + (sum % 500)
}

/**
post-process（sanitize → 日本語フォント → spc → hyperlink）が実際に動く text run 1 件分。
`a:solidFill` は applyHyperlinkFix の linkColor と同色にする。色が違う run は hyperlink
変換の対象外になり、hrefMap の復元検証が空振りする。
*/
function contentRunXml(text: string): string {
  return `<a:r><a:rPr lang="ja-JP">`
    + `<a:solidFill><a:srgbClr val="${TEST_LINK_COLOR}"/></a:solidFill>`
    + `<a:latin typeface="Noto Sans"/>`
    + `<a:ea typeface="Noto Sans"/>`
    + `</a:rPr><a:t>${escapeXmlText(text)}</a:t></a:r>`
}

/**
内容依存の単スライド PPTX。
`buildSinglePagePptxWithImage`（png Default / slide rels 整合済み）と同じ骨格を使う。
それに `p:txBody`（a:t 2 件・a:rPr/a:latin/a:ea）を足したもの。
post-process（sanitize → 日本語フォント → spc）を実際に通すため typeface は
CSS 専用キーワードではない実名を書く。
*/
function buildContentDependentPptx(options: Readonly<{
  markerText: string
  sharedText: string
  offsetPx: number
  /**
  false にするとテキスト図形を持たない「画像のみのスライド」になる
  */
  includeText: boolean
}>): Promise<Buffer> {
  const offsetEmu = options.offsetPx * EMU_PER_PX
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Default Extension="png" ContentType="image/png"/>`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
      + `<p:cSld><p:spTree>`
      + `<p:pic>`
      + `<p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`
      + `<p:blipFill><a:blip r:embed="rId7"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
      + `<p:spPr><a:xfrm>`
      + `<a:off x="${String(offsetEmu)}" y="${String(offsetEmu)}"/>`
      + `<a:ext cx="${String(CONTENT_PIC_WIDTH_PX * EMU_PER_PX)}" cy="${String(CONTENT_PIC_HEIGHT_PX * EMU_PER_PX)}"/>`
      + `</a:xfrm></p:spPr>`
      + `</p:pic>`
      + (options.includeText
        ? `<p:sp>`
        + `<p:nvSpPr><p:cNvPr id="3" name="TextBox"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
        + `<p:spPr><a:xfrm>`
        + `<a:off x="${String(offsetEmu + EMU_PER_PX)}" y="${String(offsetEmu + 2 * EMU_PER_PX)}"/>`
        + `<a:ext cx="${String(500 * EMU_PER_PX)}" cy="${String(120 * EMU_PER_PX)}"/>`
        + `</a:xfrm></p:spPr>`
        + `<p:txBody><a:bodyPr/><a:lstStyle/>`
        + `<a:p>${contentRunXml(options.markerText)}</a:p>`
        + `<a:p>${contentRunXml(options.sharedText)}</a:p>`
        + `</p:txBody>`
        + `</p:sp>`
        : '')
      + `</p:spTree></p:cSld></p:sld>`
  const slideRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
      + `</Relationships>`
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', buffer: Buffer.from(slideRels, 'utf8') },
    { name: 'ppt/media/image1.png', buffer: makePng(CONTENT_PIC_WIDTH_PX, CONTENT_PIC_HEIGHT_PX) },
  ])
}

/**
slides.md を読んでスライド本文の配列に戻す（headmatter を落として `---` で分割）。
*/
function readCacheDeckBodies(project: Readonly<CacheProject>): readonly string[] {
  const lines = readFileSync(path.join(project.directory, 'slides.md'), 'utf8').split('\n')
  const headmatterEnd = lines.indexOf('---', 1)
  return lines.slice(headmatterEnd + 1).join('\n').split('\n---\n').map(block => block.trim())
}

/**
clicks 付きスライド（2 枚目）を持つデッキの scan URL 列。
*/
function clicksScanUrlsBeforeInsert(): readonly string[] {
  return [`${FAKE_SERVER_ORIGIN}/2`, `${FAKE_SERVER_ORIGIN}/2?clicks=1`]
}

/**
上のデッキの先頭に 1 枚挿入した後の scan URL 列（clicks 付きは 3 枚目へ移る）。
*/
function clicksScanUrlsAfterInsert(): readonly string[] {
  return [`${FAKE_SERVER_ORIGIN}/2`, `${FAKE_SERVER_ORIGIN}/3`, `${FAKE_SERVER_ORIGIN}/3?clicks=1`]
}

/**
clicks 展開の無いデッキの scan URL 列（2 ステップ目以降）。
*/
function sequentialScanUrls(bodies: readonly string[]): readonly string[] {
  return bodies.slice(1).map((_body, index) => `${FAKE_SERVER_ORIGIN}/${String(index + 2)}`)
}

/**
デッキから各スライドの本文を取り出す関数（inline デッキと src 分離デッキで実装が違う）。
*/
type DeckBodiesReader = (project: Readonly<CacheProject>) => readonly string[]

/**
内容依存の fake worker を持つ pipeline。scan するステップ数もデッキ本文から導出するため、
テスト側でデッキを書き換えたとき、件数の更新抜けで通知なしの全 miss になることがない。
*/
function createContentCachePipeline(
  project: Readonly<CacheProject>,
  bodiesOf: DeckBodiesReader,
  scanUrlsOf: (bodies: readonly string[]) => readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
): SlidevPptxPipeline {
  const scanUrls = scanUrlsOf(bodiesOf(project))
  return new InProcessSlidevPptxPipeline({
    // fake browser は evaluate を持たず print ページを描けない。そのため現行ルート（ステップ単位）に固定する。
    // 1 パスのルートは「1 パスのルートの run」の describe で、deps.singlePassRunner を差し替えて検証する。
    convertToPptxRunner: async (config, dependencies) => convertToPptx({ ...config, singlePass: false }, {
      ...dependencies,
      createBrowser: () => Promise.resolve(createQueueScanBrowser(scanUrls)),
      createServer: () => Promise.resolve(fakeHttpServer()),
      resolveDomToPptx: () => project.bundlePath,
      slideWorkerRunner: async (_browser, step, workerConfig, slidesDirectory) => {
        const stepIndex = stepIndexOf(step)
        calls.push(stepIndex)
        const bodies = bodiesOf(project)
        const body = bodies[step.slideNumber - 1] ?? ''
        const offsetPx = contentOffsetPxOf(body)
        const buffer = await buildContentDependentPptx({
          markerText: slideMarkerOf(body),
          sharedText: SHARED_SLIDE_TEXT,
          offsetPx,
          // 本文に IMAGE_ONLY_BODY_MARKER を含むスライドはテキスト図形を持たない。
          // 実デッキ（画像 1 枚だけのレイアウト）を統合レベルで再現するため。
          includeText: !body.includes(IMAGE_ONLY_BODY_MARKER),
        })
        writeFileSync(path.join(slidesDirectory, `${workerConfig.slidePrefix}${String(stepIndex)}.pptx`), buffer)
        for (let index = 0; index < prerenderCountOf(body); index++) {
          const stem = `prerender-slide${String(stepIndex)}-${String(index)}`
          writeFileSync(
            path.join(slidesDirectory, `${stem}.png`),
            // 寸法を本文依存にする。全ステップ同一バイトだと ppt/media の比較で
            // 取り違えを検出できない（差分キャッシュの主成果物は prerender PNG）。
            makePng(1200 + offsetPx + index, 900 + offsetPx + index),
          )
          writeFileSync(
            path.join(slidesDirectory, `${stem}.meta.json`),
            JSON.stringify({
              width: CONTENT_PIC_WIDTH_PX,
              height: CONTENT_PIC_HEIGHT_PX,
              left: offsetPx,
              top: offsetPx,
            }),
          )
        }
        return {
          step,
          // 同一テキストへ、スライドごとに違う letterSpacing を付ける。
          // post-process はテキスト内容をキーに後勝ちで集約する。そのため全スライドが最後の値で揃う。
          // 差分変換でも集約順（ステップ順）が変わらないことを、ここで検証する。
          letterSpacingMap: {
            [SHARED_SLIDE_TEXT]: { letterSpacing: `${String(step.slideNumber)}.5px`, fontSize: '14px' },
          },
          // hrefMap も letterSpacingMap と同じ集約ルートを通る。hit 時に materialize が
          // 復元し損ねると、この URL が出力から落ちる。
          hrefMap: { [SHARED_SLIDE_TEXT]: `https://example.com/slide-${String(step.slideNumber)}` },
          hasExplicitAnimation: false,
          prerenderResults: [],
          elapsed: 1,
        }
      },
    }),
  })
}

function contentCacheDependenciesWithScanUrls(
  project: Readonly<CacheProject>,
  bodiesOf: DeckBodiesReader,
  scanUrlsOf: (bodies: readonly string[]) => readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
): BuildFakeDependenciesResult {
  const infra = realInfra()
  return {
    slidevRunner: {
      build: (projectDirectory) => {
        mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
        return Promise.resolve(spawnSuccess())
      },
    },
    pptxConverter: createContentCachePipeline(project, bodiesOf, scanUrlsOf, calls),
    archive: infra.archive,
    engine: infra.engine,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    pluginVersion: () => 'test-plugin-1.0.0',
    ...THEME_PORTS,
  }
}

function contentCacheDependencies(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
): BuildFakeDependenciesResult {
  return contentCacheDependenciesWithScanUrls(project, readCacheDeckBodies, sequentialScanUrls, calls, stdout, stderr)
}

/**
`src: ./pages/<name>.md` でスライド本文を外部ファイルへ分けたデッキを作る
（テーマを参照する talk-dir と同じ構成）。slideHash の bodyRaw 側を動かす検証に使う。
*/
function makeSourceSeparatedCacheProject(
  root: string,
  name: string,
  pages: readonly Readonly<{ file: string, body: string }>[],
): CacheProject {
  const directory = path.join(root, name)
  mkdirSync(path.join(directory, 'lib'), { recursive: true })
  mkdirSync(path.join(directory, 'pages'), { recursive: true })
  for (const page of pages) {
    writeFileSync(path.join(directory, 'pages', `${page.file}.md`), `${page.body}\n`)
  }
  writeSourceSeparatedSlides(directory, pages.map(page => page.file))
  const bundlePath = path.join(directory, 'lib', 'dom-to-pptx.bundle.js')
  writeFileSync(bundlePath, 'globalThis.domToPptx = () => undefined\n')
  return { directory, bundlePath }
}

/**
src 分離デッキの slides.md を（再）生成する。並べ替えは files の順序で表現する。
*/
function writeSourceSeparatedSlides(directory: string, files: readonly string[]): void {
  const [first, ...rest] = files
  const lines = [
    '---',
    'theme: none',
    'title: Cache Deck',
    `src: ./pages/${String(first)}.md`,
    '---',
    '',
    ...rest.flatMap(file => ['---', `src: ./pages/${file}.md`, '---', '']),
  ]
  writeFileSync(path.join(directory, 'slides.md'), lines.join('\n'))
}

/**
src 分離デッキの本文を slides.md の `src:` 参照順に読み出す。
*/
function readSourceSeparatedBodies(project: Readonly<CacheProject>): readonly string[] {
  const text = readFileSync(path.join(project.directory, 'slides.md'), 'utf8')
  return text.matchAll(/^src: \.\/pages\/(.+)\.md$/gm)
    .map(match => readFileSync(path.join(project.directory, 'pages', `${String(match[1])}.md`), 'utf8').trim()).toArray()
}

function sourceSeparatedCacheDependencies(
  project: Readonly<CacheProject>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 呼び出しを記録する accumulator
  calls: number[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  stderr: CapturedStream,
): BuildFakeDependenciesResult {
  return contentCacheDependenciesWithScanUrls(project, readSourceSeparatedBodies, sequentialScanUrls, calls, stdout, stderr)
}

/**
slide rels から hyperlink Relationship の Target だけを取り出す。
*/
function hyperlinkTargetsOf(snapshot: Readonly<PptxSnapshot>): readonly string[] {
  return Object.values(snapshot.slideRels)
    .flat()
    .filter(entry => entry.includes('/hyperlink|'))
    .map(entry => entry.split('|', 3)[2] ?? '')
}

/**
出力 PPTX から part 番号順に各スライドの先頭 `a:t`（内容マーカー）を取り出す。
*/
async function readSlideMarkers(pptxPath: string): Promise<readonly string[]> {
  const snapshot = await snapshotPptx(pptxPath)
  return slidesInOrder(snapshot).map(slide => valuesOf(slide, 'text')[0] ?? '')
}

function cacheDirectoryOfProject(project: Readonly<CacheProject>): string {
  return path.join(project.directory, 'pptx', 'cache')
}

describe('キャッシュ検証デッキの fixture', () => {
  it('cacheDeckMarkdown で書いたデッキを readCacheDeckBodies が同じ本文列に戻す', () => {
    // 区切り書式（headmatter の終端と `---` の前後空行）を builder と reader が暗黙に
    // 共有している。片方だけ変えると fake worker が空本文で pptx を書き、内容依存性を
    // 失ったまま全テストが green になる。
    const bodies = ['# 表紙', '# 本編\n\n本文が複数行のケース', '# まとめ']
    const project = makeCacheProject(temporaryRoot(), 'deck-roundtrip', bodies)
    expect(readCacheDeckBodies(project)).toStrictEqual(bodies)

    rewriteCacheDeck(project, ['# 1 枚だけ'])
    expect(readCacheDeckBodies(project)).toStrictEqual(['# 1 枚だけ'])
  })

  it('src 分離デッキの slides.md を readSourceSeparatedBodies が参照順の本文列に戻す', () => {
    const project = makeSourceSeparatedCacheProject(temporaryRoot(), 'src-roundtrip', [
      { file: 'a', body: '# ページ A' },
      { file: 'b', body: '# ページ B' },
    ])
    expect(readSourceSeparatedBodies(project)).toStrictEqual(['# ページ A', '# ページ B'])

    writeSourceSeparatedSlides(project.directory, ['b', 'a'])
    expect(readSourceSeparatedBodies(project)).toStrictEqual(['# ページ B', '# ページ A'])
  })
})

describe('slide convert の出力同一性 (T011-a)', () => {
  const BODIES_BEFORE = ['# 表紙', '# 本編', '# まとめ']
  const BODIES_AFTER = ['# 表紙', '# 本編 改訂', '# まとめ']

  it('差分変換の出力は同一ソースの全変換の出力と XPath 抽出値レベルで一致する', async () => {
    const stdout = makeStream()
    const stderr = makeStream()

    // (B) S を変換 → 1 枚だけ変更して S' → 差分変換（hit + miss 混在）
    const diffProject = makeCacheProject(temporaryRoot(), 'identity-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('identity-warm.pptx')
    const diffOut = temporaryRoot('identity-diff.pptx')
    const warmCalls: number[] = []
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(diffProject, warmCalls, stdout, stderr),
    )
    expect(warmCalls).toStrictEqual([100, 200, 300])

    rewriteCacheDeck(diffProject, BODIES_AFTER)
    const diffCalls: number[] = []
    const diffSummary = await runSlideConvert(
      diffProject.directory,
      { out: diffOut, json: false },
      contentCacheDependencies(diffProject, diffCalls, stdout, stderr),
    )

    // ルートモード assert: 差分ルートであること。
    // 通知なしに全 miss へ降格すると A と同モードになる。
    // その場合は、比較が通っても SC-003 を検証したことにならない。
    expect(diffCalls).toStrictEqual([200])
    expect(diffSummary.cache).toMatchObject({ enabled: true, hits: 2, misses: 1, invalidated: 'partial' })

    // (A) キャッシュを一度も作っていないプロジェクトでの全変換（--no-cache は #898 で未実装）
    const fullProject = makeCacheProject(temporaryRoot(), 'identity-full', BODIES_AFTER)
    const fullOut = temporaryRoot('identity-full.pptx')
    const fullCalls: number[] = []
    const fullSummary = await runSlideConvert(
      fullProject.directory,
      { out: fullOut, json: false },
      contentCacheDependencies(fullProject, fullCalls, stdout, stderr),
    )
    expect(fullCalls).toStrictEqual([100, 200, 300])
    expect(fullSummary.cache).toMatchObject({ enabled: true, hits: 0, misses: 3 })

    await expectPptxOutputsEquivalent(fullOut, diffOut, { expectedSlideCount: 3 })
  })

  it('同一テキストの letterSpacing 後勝ち集約は差分変換でも全変換と同じ値に落ち着く', async () => {
    const stdout = makeStream()
    const stderr = makeStream()

    const diffProject = makeCacheProject(temporaryRoot(), 'spacing-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('spacing-warm.pptx')
    const diffOut = temporaryRoot('spacing-diff.pptx')
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )
    rewriteCacheDeck(diffProject, BODIES_AFTER)
    await runSlideConvert(
      diffProject.directory,
      { out: diffOut, json: false },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )

    const fullProject = makeCacheProject(temporaryRoot(), 'spacing-full', BODIES_AFTER)
    const fullOut = temporaryRoot('spacing-full.pptx')
    await runSlideConvert(
      fullProject.directory,
      { out: fullOut, json: false },
      contentCacheDependencies(fullProject, [], stdout, stderr),
    )

    // 抽出値が空のまま「一致」になるのを防ぐため、spc が実際に書かれていることを先に固定する。
    // 値の絶対値は post-process の計算結果なので assert しない（2 ルートの相対比較にのみ使う）。
    const diffSnapshot = await snapshotPptx(diffOut)
    const fullSnapshot = await snapshotPptx(fullOut)
    const diffSpacing = slidesInOrder(diffSnapshot)
      .flatMap(slide => valuesOf(slide, 'spc'))
      .filter(value => value !== '')
    const fullSpacing = slidesInOrder(fullSnapshot)
      .flatMap(slide => valuesOf(slide, 'spc'))
      .filter(value => value !== '')
    expect(diffSpacing).toHaveLength(3)
    // テキストキーの後勝ち集約により、3 枚とも同じ spc に揃う（枚数分の値が散らばらない）
    expect(new Set(diffSpacing).size).toBe(1)
    expect(diffSpacing).toStrictEqual(fullSpacing)
  })

  it('同一テキストの hrefMap 後勝ち集約とハイパーリンク復元も差分変換で全変換と一致する', async () => {
    const stdout = makeStream()
    const stderr = makeStream()

    const diffProject = makeCacheProject(temporaryRoot(), 'href-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('href-warm.pptx')
    const diffOut = temporaryRoot('href-diff.pptx')
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )
    rewriteCacheDeck(diffProject, BODIES_AFTER)
    const diffCalls: number[] = []
    await runSlideConvert(
      diffProject.directory,
      { out: diffOut, json: false },
      contentCacheDependencies(diffProject, diffCalls, stdout, stderr),
    )
    // hit したスライドの hrefMap は manifest から復元される。ここが 3 件全て miss だと
    // 「復元できている」ことの検証にならない。
    expect(diffCalls).toStrictEqual([200])

    const fullProject = makeCacheProject(temporaryRoot(), 'href-full', BODIES_AFTER)
    const fullOut = temporaryRoot('href-full.pptx')
    await runSlideConvert(
      fullProject.directory,
      { out: fullOut, json: false },
      contentCacheDependencies(fullProject, [], stdout, stderr),
    )

    const diffSnapshot = await snapshotPptx(diffOut)
    // ハイパーリンクが実際に張られていること（空のまま「一致」になる恒真を防ぐ）
    const diffRids = slidesInOrder(diffSnapshot).flatMap(slide => valuesOf(slide, 'hlinkRid'))
    expect(diffRids).toHaveLength(3)
    expect(diffRids.every(rid => rid.startsWith('rId'))).toBe(true)

    const diffTargets = hyperlinkTargetsOf(diffSnapshot)
    expect(diffTargets).toHaveLength(3)
    // letterSpacing と同じくテキストキーの後勝ち集約なので、3 枚とも同じ URL に揃う
    expect(new Set(diffTargets).size).toBe(1)
    expect(diffTargets).toStrictEqual(hyperlinkTargetsOf(await snapshotPptx(fullOut)))
  })

  it('画像のみのスライドを含むデッキは per-slide の退化検証で落ち、deck の退化検証では通る', async () => {
    // 実デッキには a:t と xfrm を持たないスライドがあり得る。
    // 外部 pptx モード（T013）で per-slide の退化検証のまま比較すると、出力が正しくても落ちる。
    const stdout = makeStream()
    const stderr = makeStream()
    const bodies = ['# 表紙', `# ${IMAGE_ONLY_BODY_MARKER}`]
    const left = makeCacheProject(temporaryRoot(), 'gate-left', bodies)
    const right = makeCacheProject(temporaryRoot(), 'gate-right', bodies)
    const leftOut = temporaryRoot('gate-left.pptx')
    const rightOut = temporaryRoot('gate-right.pptx')
    await runSlideConvert(left.directory, { out: leftOut, json: false }, contentCacheDependencies(left, [], stdout, stderr))
    await runSlideConvert(right.directory, { out: rightOut, json: false }, contentCacheDependencies(right, [], stdout, stderr))

    // 内容は同一なので、落ちる理由は退化検証の強さだけ
    expect(diffPptxSnapshots(await snapshotPptx(leftOut), await snapshotPptx(rightOut))).toStrictEqual([])
    await expect(
      expectPptxOutputsEquivalent(leftOut, rightOut, { expectedSlideCount: 2 }),
    ).rejects.toThrow()
    await expectPptxOutputsEquivalent(leftOut, rightOut, {
      expectedSlideCount: 2,
      degeneracyGate: 'deck',
    })
  })

  it('比較ヘルパは内容の違う 2 出力を不一致として報告する (負のコントロール)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const left = makeCacheProject(temporaryRoot(), 'control-left', BODIES_AFTER)
    const right = makeCacheProject(temporaryRoot(), 'control-right', ['# 表紙', '# 別内容', '# まとめ'])
    const leftOut = temporaryRoot('control-left.pptx')
    const rightOut = temporaryRoot('control-right.pptx')
    await runSlideConvert(left.directory, { out: leftOut, json: false }, contentCacheDependencies(left, [], stdout, stderr))
    await runSlideConvert(right.directory, { out: rightOut, json: false }, contentCacheDependencies(right, [], stdout, stderr))

    const differences = diffPptxSnapshots(await snapshotPptx(leftOut), await snapshotPptx(rightOut))
    expect(differences.length).toBeGreaterThan(0)
    expect(differences.join('\n')).toContain('ppt/slides/slide2.xml')
    // prerender 由来の PNG（差分キャッシュの主成果物）も比較対象に入っていること
    expect(differences.join('\n')).toContain('ppt/media/image1-s2.png')
    // 1 枚だけ違う構成なので、他のスライドは差分として挙がらない
    expect(differences.join('\n')).not.toContain('ppt/slides/slide1.xml')
    expect(differences.join('\n')).not.toContain('ppt/media/image1-s1.png')

    // 各テストが実際に使うのは expectPptxOutputsEquivalent なので、その失敗ルートも固定する。
    // diffPptxSnapshots だけを検証しても、本番ルートの判別能力の証明にならない。
    await expect(
      expectPptxOutputsEquivalent(leftOut, rightOut, { expectedSlideCount: 3 }),
    ).rejects.toThrow()
  })
})

describe('slide convert のスライド構成変更 (T012)', () => {
  it('末尾追加では既存スライドが全ヒットし、追加分のみ変換される', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'compose-append', ['# A', '# B'])
    const firstOut = temporaryRoot('append-1.pptx')
    const secondOut = temporaryRoot('append-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# B', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([300])
    // 新規ステップの miss では invalidated を partial へ昇格させない（既存分は全て有効）
    expect(summary.cache).toMatchObject({ hits: 2, misses: 1, invalidated: 'none' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'hit' },
      { stepIndex: 300, key: '3', cache: 'miss' },
    ])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([
      slideMarkerOf('# A'),
      slideMarkerOf('# B'),
      slideMarkerOf('# C'),
    ])
  })

  it('中間挿入では挿入位置以降がミスになり、出力の並びが新構成に追従する', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'compose-insert', ['# A', '# B'])
    const firstOut = temporaryRoot('insert-1.pptx')
    const secondOut = temporaryRoot('insert-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# X', '# B'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200, 300])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 2, invalidated: 'partial' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
      { stepIndex: 300, key: '3', cache: 'miss' },
    ])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([
      slideMarkerOf('# A'),
      slideMarkerOf('# X'),
      slideMarkerOf('# B'),
    ])
  })

  it('削除では manifest と cache/ の双方から削除スライドの成果物が消える', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'compose-delete', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('delete-1.pptx')
    const secondOut = temporaryRoot('delete-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    expect(readdirSync(cacheDirectoryOfProject(project))).toContain('slide-300.pptx')

    rewriteCacheDeck(project, ['# A', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# C')])

    // 残骸なしは manifest だけでなく実ファイルでも確認する（entries から落ちても
    // ファイルが残れば cache/ が肥大し続ける — FR-010）
    const cacheDirectory = cacheDirectoryOfProject(project)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const manifest = JSON.parse(
      readFileSync(path.join(cacheDirectory, 'manifest.json'), 'utf8'),
    ) as { entries: Readonly<Record<string, unknown>> }
    expect(Object.keys(manifest.entries).toSorted(compareStrings)).toStrictEqual(['100', '200'])
    const names = readdirSync(cacheDirectory)
    expect(names).not.toContain('slide-300.pptx')
    expect(names.filter(name => name.startsWith('prerender-slide300-'))).toStrictEqual([])
  })

  it('並べ替えでは位置のずれたスライドをミスとして扱い、出力の並びが入れ替わる', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'compose-reorder', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('reorder-1.pptx')
    const secondOut = temporaryRoot('reorder-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# C', '# B'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200, 300])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 2, invalidated: 'partial' })
    expect(await readSlideMarkers(secondOut)).toStrictEqual([
      slideMarkerOf('# A'),
      slideMarkerOf('# C'),
      slideMarkerOf('# B'),
    ])

    // FR-004（構成変更の反映）と FR-008（出力同一性）の交差。マーカーの並びだけでは
    // 座標・typeface・spc・media が新構成に追従しているかを見ていない。
    const fullProject = makeCacheProject(temporaryRoot(), 'compose-reorder-full', ['# A', '# C', '# B'])
    const fullOut = temporaryRoot('reorder-full.pptx')
    const fullCalls: number[] = []
    await runSlideConvert(
      fullProject.directory,
      { out: fullOut, json: false },
      contentCacheDependencies(fullProject, fullCalls, stdout, stderr),
    )
    expect(fullCalls).toStrictEqual([100, 200, 300])
    await expectPptxOutputsEquivalent(fullOut, secondOut, { expectedSlideCount: 3 })
  })

  it('src 分離デッキの並べ替えでも位置のずれたスライドをミスとして扱い、本文が新構成に追従する', async () => {
    // 実デッキ（テーマを参照する talk-dir）は本文を pages/*.md へ分けた src 分離構成で、
    // slideHash の bodyRaw 側が動く。inline デッキだけでは このルートを通らない。
    const stdout = makeStream()
    const stderr = makeStream()
    const pages = [
      { file: 'a', body: '# ページ A' },
      { file: 'b', body: '# ページ B' },
      { file: 'c', body: '# ページ C' },
    ]
    const project = makeSourceSeparatedCacheProject(temporaryRoot(), 'compose-src-reorder', pages)
    const firstOut = temporaryRoot('src-reorder-1.pptx')
    const secondOut = temporaryRoot('src-reorder-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      sourceSeparatedCacheDependencies(project, [], stdout, stderr),
    )
    expect(await readSlideMarkers(firstOut)).toStrictEqual([
      slideMarkerOf('# ページ A'),
      slideMarkerOf('# ページ B'),
      slideMarkerOf('# ページ C'),
    ])

    writeSourceSeparatedSlides(project.directory, ['a', 'c', 'b'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      sourceSeparatedCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200, 300])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 2, invalidated: 'partial' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
      { stepIndex: 300, key: '3', cache: 'miss' },
    ])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([
      slideMarkerOf('# ページ A'),
      slideMarkerOf('# ページ C'),
      slideMarkerOf('# ページ B'),
    ])
  })

  it('clicks 付きスライドの前に 1 枚挿入すると perStep キーがずれて全ステップがミスになる', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'compose-clicks', ['# A', '# B'])
    const firstOut = temporaryRoot('clicks-insert-1.pptx')
    const secondOut = temporaryRoot('clicks-insert-2.pptx')
    const first = await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependenciesWithScanUrls(project, readCacheDeckBodies, clicksScanUrlsBeforeInsert, [], stdout, stderr),
    )
    expect(first.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'miss' },
      { stepIndex: 200, key: '2', cache: 'miss' },
      { stepIndex: 201, key: '2/1', cache: 'miss' },
    ])

    rewriteCacheDeck(project, ['# X', '# A', '# B'])
    const calls: number[] = []
    const second = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependenciesWithScanUrls(project, readCacheDeckBodies, clicksScanUrlsAfterInsert, calls, stdout, stderr),
    )

    // 展開ステップのキーが '2','2/1' から '3','3/1' へ移り、旧キーのエントリは再利用されない
    expect(calls).toStrictEqual([100, 200, 300, 301])
    expect(second.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'miss' },
      { stepIndex: 200, key: '2', cache: 'miss' },
      { stepIndex: 300, key: '3', cache: 'miss' },
      { stepIndex: 301, key: '3/1', cache: 'miss' },
    ])
    expect(second.cache).toMatchObject({ hits: 0, misses: 4 })
  })
})

describe('slide convert のキャッシュ容量制御 (FR-010)', () => {
  it('生存ステップの prerender 枚数が減ると参照されなくなった旧ファイルが cache/ から消える', async () => {
    // prune の対象は、スキャン結果から消えた stepIndex だけ。
    // 同じ stepIndex が生き残ったまま枚数だけ減るケースは、removeUnreferencedArtifacts でしか掃除されない。
    // 掃除が無いと prerender の増減を繰り返すたびに cache/ が単調増加する。
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'prerender-shrink', [
      '# A',
      `# B ${EXTRA_PRERENDER_BODY_MARKER}`,
    ])
    const firstOut = temporaryRoot('prerender-shrink-1.pptx')
    const secondOut = temporaryRoot('prerender-shrink-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    const cacheDirectory = cacheDirectoryOfProject(project)
    expect(prerenderNamesOf(cacheDirectory, 200)).toStrictEqual([
      'prerender-slide200-0.meta.json',
      'prerender-slide200-0.png',
      'prerender-slide200-1.meta.json',
      'prerender-slide200-1.png',
    ])

    // 本文編集で stepIndex 200 は miss になり、prerender は 1 枚だけ書き直される。
    rewriteCacheDeck(project, ['# A', '# B'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(prerenderNamesOf(cacheDirectory, 200)).toStrictEqual([
      'prerender-slide200-0.meta.json',
      'prerender-slide200-0.png',
    ])
    // hit した側の成果物まで巻き添えで消していないこと。
    expect(prerenderNamesOf(cacheDirectory, 100)).toStrictEqual([
      'prerender-slide100-0.meta.json',
      'prerender-slide100-0.png',
    ])
  })
})

/**
cache/ 配下の当該ステップの prerender ファイル名を名前順で取り出す。
*/
function prerenderNamesOf(cacheDirectory: string, stepIndex: number): readonly string[] {
  const prefix = `prerender-slide${String(stepIndex)}-`
  return readdirSync(cacheDirectory).filter(name => name.startsWith(prefix)).toSorted(compareStrings)
}

// --- 無効化・フォールバック・--no-cache (#898 US3: T014 / T015 / T016 / T017) ---

/**
cache/manifest.json の entries キーを昇順で取り出す。manifest が無ければ undefined。
*/
function manifestEntryKeysOf(project: Readonly<CacheProject>): readonly string[] | undefined {
  const manifestPath = path.join(cacheDirectoryOfProject(project), 'manifest.json')
  if (!existsSync(manifestPath)) return undefined
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    entries: Readonly<Record<string, unknown>>
  }
  return Object.keys(manifest.entries).toSorted(compareStrings)
}

function manifestBytesOf(project: Readonly<CacheProject>): string {
  return readFileSync(path.join(cacheDirectoryOfProject(project), 'manifest.json'), 'utf8')
}

/**
manifest.json を parse 不能な内容に壊す（pipeline 側の invalid 判定を踏ませる）。
*/
function corruptManifest(project: Readonly<CacheProject>): void {
  writeFileSync(
    path.join(cacheDirectoryOfProject(project), 'manifest.json'),
    '{"schemaVersion":1,"envHash":',
  )
}

/**
版差判定で使う「現行より 1 つ古い」版。実装の版を上げてもテストが追従する。
*/
const OUTDATED_SCHEMA_VERSION = CACHE_SCHEMA_VERSION - 1

/**
manifest.json の schemaVersion だけを旧版に落とす（JSON としては壊さない）。
プラグイン更新後の初回 run が踏むルートを、破損と分けて再現するために使う。
*/
function downgradeManifestSchema(project: Readonly<CacheProject>): void {
  const manifestPath = path.join(cacheDirectoryOfProject(project), 'manifest.json')
  const text = readFileSync(manifestPath, 'utf8')
  const downgraded = text.replace(
    `"schemaVersion": ${String(CACHE_SCHEMA_VERSION)}`,
    () => `"schemaVersion": ${String(OUTDATED_SCHEMA_VERSION)}`,
  )
  // 置換できていなければ manifest の書式が変わっている（テストが版差を再現できていない）。
  expect(downgraded).not.toBe(text)
  writeFileSync(manifestPath, downgraded)
}

describe('slide convert のキャッシュ無効化とフォールバック (T014 / T015)', () => {
  it('スライド本文が同じでも共有クロージャ（styles/）が変われば全ステップが miss になる (FR-005)', async () => {
    // 本文由来の slideHash は不変で envHash だけが動くケース。テーマ切替 (F-01) は --theme
    // 引数を材料に取るルートで、デッキ内のファイル内容を材料に取るルートはここでしか通らない。
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'invalidate-shared', ['# A', '# B'])
    const firstOut = temporaryRoot('invalidate-shared-1.pptx')
    const secondOut = temporaryRoot('invalidate-shared-2.pptx')

    const firstCalls: number[] = []
    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, firstCalls, stdout, stderr),
    )
    expect(firstCalls).toStrictEqual([100, 200])

    writeFileSync(sharedStylesPathOf(project.directory), ':root { --cache-test: 2; }\n')
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([100, 200])
    expect(summary.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'all:env' })
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])
  })

  it('manifest が破損していても exit 0 で pptx を出し、警告のうえ manifest を再生成する (FR-006 / SC-004)', async () => {
    // pipeline 層の同ルートは pipeline.test.ts が見ている。ここは CLI 層まで通したときに
    // キャッシュ起因の異常が終了コードへ抜けないこと（contracts/cache-interface.md）を固定する。
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'fallback-manifest', ['# A', '# B'])
    const firstOut = temporaryRoot('fallback-manifest-1.pptx')
    const secondOut = temporaryRoot('fallback-manifest-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    corruptManifest(project)

    const calls: number[] = []
    const commandStdout = makeStream()
    const commandStderr = makeStream()
    const command = createSlideConvertCommand(
      () => contentCacheDependencies(project, calls, commandStdout, commandStderr),
    )
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync([project.directory, '--out', secondOut], { from: 'user' })
      expect(process.exitCode).toBeUndefined()
    }
    finally {
      process.exitCode = previousExitCode
    }

    expect(calls).toStrictEqual([100, 200])
    expect(existsSync(secondOut)).toBe(true)
    expect(commandStderr.chunks.join('')).toContain('キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）')
    expect(commandStdout.chunks.join('')).toContain('cache: 0 hits / 2 misses (enabled: true, invalidated: all:manifest)')
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])
  })

  it('manifest のスキーマ版が現行と違うときは破損と別の文言で報告し、全変換で作り直す', async () => {
    // プラグイン更新後の初回 run が必ず踏むルート。
    // 破損と同じ文言だと、利用者がキャッシュの破損と誤解する（#1070 F-17）。
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'manifest-outdated', ['# A', '# B'])
    const firstOut = temporaryRoot('manifest-outdated-1.pptx')
    const secondOut = temporaryRoot('manifest-outdated-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    downgradeManifestSchema(project)

    const calls: number[] = []
    const secondStdout = makeStream()
    const secondStderr = makeStream()
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false },
      contentCacheDependencies(project, calls, secondStdout, secondStderr),
    )

    expect(calls).toStrictEqual([100, 200])
    expect(summary.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'all:manifest' })
    const stderrText = secondStderr.chunks.join('')
    expect(stderrText).toContain(
      `キャッシュ manifest のスキーマ版が異なるため使いません`
      + `（manifest v${String(OUTDATED_SCHEMA_VERSION)} / 現行 v${String(CACHE_SCHEMA_VERSION)}）。既存の成果物を掃除して作り直します`,
    )
    expect(stderrText).not.toContain('キャッシュ manifest が読めません')
    // 掃除して作り直すため、次の run から再びヒットする状態に戻っている。
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
  })
})

describe('slide convert の --no-cache (T016 / T017)', () => {
  it('warm cache でも全変換し、完了時の再構築で次の run が全ヒットする', async () => {
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'no-cache-rebuild', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-warm.pptx')
    const noCacheOut = temporaryRoot('no-cache-run.pptx')
    const afterOut = temporaryRoot('no-cache-after.pptx')

    const warmStdout = makeStream()
    await runSlideConvert(
      project.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )

    const noCacheCalls: number[] = []
    const noCacheStdout = makeStream()
    const command = createSlideConvertCommand(
      () => contentCacheDependencies(project, noCacheCalls, noCacheStdout, stderr),
    )
    await command.parseAsync(
      [project.directory, '--out', noCacheOut, '--no-cache', '--json'],
      { from: 'user' },
    )

    // 全ステップ変換される。enabled: false と invalidated: none の組で「無効化を検知したの
    // ではなく読まなかった」ことを表す（キー算出失敗の all:key と区別できる）。
    expect(noCacheCalls).toStrictEqual([100, 200])
    const done = parseEvents(noCacheStdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: false, hits: 0, misses: 2, invalidated: 'none' })
    expect(await readSlideMarkers(noCacheOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])

    // 完了時のキャッシュ再構築（FR-007）。読まないだけで保存は動くため、次の通常 run は全ヒット。
    const afterCalls: number[] = []
    const afterStdout = makeStream()
    const after = await runSlideConvert(
      project.directory,
      { out: afterOut, json: false },
      contentCacheDependencies(project, afterCalls, afterStdout, stderr),
    )
    expect(afterCalls).toStrictEqual([])
    expect(after.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })
  })

  it('人間向け出力は enabled: false / invalidated: none で miss を全件列挙する', async () => {
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'no-cache-text', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-text-1.pptx')
    const noCacheOut = temporaryRoot('no-cache-text-2.pptx')

    const warmStdout = makeStream()
    await runSlideConvert(
      project.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )

    const stdout = makeStream()
    const command = createSlideConvertCommand(() => contentCacheDependencies(project, [], stdout, stderr))
    await command.parseAsync([project.directory, '--out', noCacheOut, '--no-cache'], { from: 'user' })

    const text = stdout.chunks.join('')
    expect(text).toContain('cache: 0 hits / 2 misses (enabled: false, invalidated: none)')
    // 全 miss になるため hit 件数の付記は出ず、変換したステップが全件並ぶ。
    expect(text).toContain('cache steps: miss #1, #2')
    expect(text).not.toContain('件 hit')
  })

  it('manifest が破損していても孤児を掃除して exit 0 で完走する', async () => {
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'no-cache-broken', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-broken-1.pptx')
    const noCacheOut = temporaryRoot('no-cache-broken-2.pptx')

    const warmStdout = makeStream()
    await runSlideConvert(
      project.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )
    // 削除済みスライド相当の残骸。manifest が読めない run では prune の起点が無いため、
    // --no-cache でも孤児掃除が働かないと cache/ に永久残留する（FR-010）。
    const cacheDirectory = cacheDirectoryOfProject(project)
    writeFileSync(path.join(cacheDirectory, 'slide-999.pptx'), 'stale-pptx')
    writeFileSync(path.join(cacheDirectory, 'prerender-slide999-0.png'), 'stale-png')
    corruptManifest(project)

    const calls: number[] = []
    const stdout = makeStream()
    const commandStderr = makeStream()
    const command = createSlideConvertCommand(
      () => contentCacheDependencies(project, calls, stdout, commandStderr),
    )
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync([project.directory, '--out', noCacheOut, '--no-cache'], { from: 'user' })
      expect(process.exitCode).toBeUndefined()
    }
    finally {
      process.exitCode = previousExitCode
    }

    expect(calls).toStrictEqual([100, 200])
    expect(existsSync(noCacheOut)).toBe(true)
    // manifest 破損は all:manifest だが、判定していない run では種別を報告しない。
    expect(stdout.chunks.join('')).toContain('(enabled: false, invalidated: none)')
    expect(commandStderr.chunks.join('')).toContain('キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）')
    expect(readdirSync(cacheDirectory).some(name => name.includes('999'))).toBe(false)
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
  })

  it('キー算出に失敗した場合は all:key を報告し manifest を更新しない', async () => {
    // --no-cache とキー算出失敗が重なると保存側も動かないため、完了時のキャッシュ再構築は
    // 成立しない（既知の限界）。manifest が warm run のまま据え置かれることで固定する。
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'no-cache-keyfail', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-keyfail-1.pptx')
    const noCacheOut = temporaryRoot('no-cache-keyfail-2.pptx')

    const warmStdout = makeStream()
    await runSlideConvert(
      project.directory,
      { out: warmOut, json: false },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )
    const manifestBefore = manifestBytesOf(project)

    // dom-to-pptx.bundle.js を読めなくするとキー算出が bundle-unreadable で失敗する。
    rmSync(project.bundlePath, { force: true })
    const calls: number[] = []
    const stdout = makeStream()
    const command = createSlideConvertCommand(() => contentCacheDependencies(project, calls, stdout, stderr))
    await command.parseAsync(
      [project.directory, '--out', noCacheOut, '--no-cache', '--json'],
      { from: 'user' },
    )

    expect(calls).toStrictEqual([100, 200])
    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: false, hits: 0, misses: 2, invalidated: 'all:key' })
    expect(manifestBytesOf(project)).toBe(manifestBefore)
  })

  it('スライドを削除して再変換すると旧スライドの成果物と manifest エントリが残らない (FR-010)', async () => {
    // hit 判定を飛ばしても prune の起点として前回 manifest は読む、という設計をここで固定する。
    // previous を読まない実装にすると、このテストだけが落ちる。
    const stdout = makeStream()
    const stderr = makeStream()
    const project = makeCacheProject(temporaryRoot(), 'no-cache-delete', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('no-cache-delete-1.pptx')
    const secondOut = temporaryRoot('no-cache-delete-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut, json: false },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    expect(readdirSync(cacheDirectoryOfProject(project))).toContain('slide-300.pptx')

    rewriteCacheDeck(project, ['# A', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, json: false, cache: false },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([100, 200])
    expect(summary.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'none' })
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# C')])

    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
    const names = readdirSync(cacheDirectoryOfProject(project))
    expect(names).not.toContain('slide-300.pptx')
    expect(names.filter(name => name.startsWith('prerender-slide300-'))).toStrictEqual([])
  })
})

/**
`p:timing`（出現アニメーション）を持つ単スライド PPTX を作る。#1070 の除去判定の被験体。
中身は dom-to-pptx が明示指定ルートで出す形の最小化。
*/
function buildSinglePagePptxWithTiming(slideLabel: string): Promise<Buffer> {
  const presentationXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
      + `</p:presentation>`
  const presRels
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
      + `</Relationships>`
  const contentTypes
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      + `</Types>`
  const slideXml
    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
      + `<p:cSld><p:spTree/></p:cSld>`
      + `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">`
      + `<p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">`
      + `<p:childTnLst><p:par><p:cTn id="5" presetID="10" presetClass="entr" grpId="0" nodeType="clickEffect">`
      + `<p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="600"/>`
      + `<p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst>`
      + `</p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst>`
      + `</p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="5" grpId="0"/></p:bldLst></p:timing>`
      + `<!-- ${slideLabel} --></p:sld>`
  return zipBufferOf([
    { name: 'ppt/presentation.xml', buffer: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', buffer: Buffer.from(presRels, 'utf8') },
    { name: '[Content_Types].xml', buffer: Buffer.from(contentTypes, 'utf8') },
    { name: 'ppt/slides/slide1.xml', buffer: Buffer.from(slideXml, 'utf8') },
  ])
}

/**
staging に `p:timing` 付きの 2 スライドと animation-policy.json を置く converter を作る。
`policyText` を undefined にすると animation-policy.json を書かない（不在時の既定を見る）。
*/
function timingStagingConverter(policyText: string | undefined): SlidevPptxPipeline {
  return {
    convert: async (arguments_) => {
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      for (const stepIndex of [100, 200]) {
        const buffer = await buildSinglePagePptxWithTiming(`slide-${String(stepIndex)}`)
        writeFileSync(path.join(slidesDirectory, `slide-${String(stepIndex)}.pptx`), buffer)
      }
      if (policyText !== undefined) {
        writeFileSync(path.join(slidesDirectory, 'animation-policy.json'), policyText)
      }
      return pipelineSuccess(2)
    },
  }
}

/**
pipeline (infra/slidev-to-pptx/pipeline.ts) が書く animation-policy.json と同形の JSON。
*/
function policyJson(keepTimingSteps: readonly number[]): string {
  return JSON.stringify({ schemaVersion: ANIMATION_POLICY_SCHEMA_VERSION, keepTimingSteps })
}

async function runConvertWithPolicy(
  out: string,
  policyText?: string,
): Promise<SlideConvertResultSummary> {
  const infra = realInfra()
  return runSlideConvert(
    makeProjectDirectory(temporaryRoot()),
    { out, json: false },
    {
      slidevRunner: createSuccessRunner(),
      pptxConverter: timingStagingConverter(policyText),
      archive: infra.archive,
      engine: infra.engine,
      stdout: process.stdout,
      stderr: process.stderr,
      now: () => 0,
      pluginVersion: () => 'test-plugin',
      ...THEME_PORTS,
    },
  )
}

describe('slide convert のアニメーション方針 (#1070)', () => {
  const namespaces: Readonly<Record<string, string>> = { p: NS_PRESENTATIONML }

  it('animation-policy.json の keepTimingSteps に載る stepIndex だけ p:timing が残る', async () => {
    const out = temporaryRoot('animation-policy.pptx')
    // stepIndex 100 のみ明示指定あり。merge 後は 100 → slide1、200 → slide2。
    const summary = await runConvertWithPolicy(out, policyJson([100]))
    // 除去が働いたのは明示指定の無い 1 枚だけ（観測値としてサマリに載る）。
    expect(summary.animationTimingRemovedSlides).toBe(1)

    const kept = await extractFromPptx(out, ['ppt/slides/slide1.xml'], '//p:timing', 'count', namespaces)
    const removed = await extractFromPptx(out, ['ppt/slides/slide2.xml'], '//p:timing', 'count', namespaces)
    expect(kept[0]?.value).toBe(1)
    expect(removed[0]?.value).toBe(0)
    // timing の内側にあった bldLst / animEffect も一緒に消える。
    const bldLst = await extractFromPptx(out, ['ppt/slides/slide2.xml'], '//p:bldLst', 'count', namespaces)
    expect(bldLst[0]?.value).toBe(0)
  })

  it('animation-policy.json が無ければ全スライドの p:timing を落とす', async () => {
    const out = temporaryRoot('animation-policy-absent.pptx')
    const summary = await runConvertWithPolicy(out)
    expect(summary.animationTimingRemovedSlides).toBe(2)

    const counts = await extractFromPptx(
      out, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'], '//p:timing', 'count', namespaces,
    )
    expect(counts.map(entry => entry.value)).toStrictEqual([0, 0])
  })

  it.each([
    ['parse 不能', 'not-json'],
    ['plain object でない', '["100"]'],
    ['schemaVersion 不在', '{"keepTimingSteps":[100]}'],
    ['schemaVersion 不一致', '{"schemaVersion":999,"keepTimingSteps":[100]}'],
    ['keepTimingSteps が配列でない', '{"schemaVersion":1,"keepTimingSteps":100}'],
    ['keepTimingSteps の要素が整数でない', '{"schemaVersion":1,"keepTimingSteps":["100"]}'],
  ])('animation-policy.json が %s なら invalid-staging-json', async (_name, policyText) => {
    const out = temporaryRoot('animation-policy-invalid.pptx')
    await expect(runConvertWithPolicy(out, policyText))
      .rejects.toMatchObject({ reason: 'invalid-staging-json' })
  })
})
/**
staging/slides/ に merge 入力の名前規約 `slide-<N>.pptx` に合う / 合わないファイルを混ぜる。
中身はすべて同じ 1 枚 PPTX なので、拾われたかどうかは出力スライド枚数で判別できる。
*/
function decoyNameConverter(names: readonly string[]): SlidevPptxPipeline {
  return {
    convert: async (arguments_) => {
      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      for (const name of names) {
        writeFileSync(path.join(slidesDirectory, name), await buildSinglePagePptx(name))
      }
      return pipelineSuccess(names.length)
    },
  }
}

async function runConvertWithSlideNames(out: string, names: readonly string[]): Promise<void> {
  const infra = realInfra()
  await runSlideConvert(
    makeProjectDirectory(temporaryRoot()),
    { out, json: false },
    {
      slidevRunner: createSuccessRunner(),
      pptxConverter: decoyNameConverter(names),
      archive: infra.archive,
      engine: infra.engine,
      stdout: process.stdout,
      stderr: process.stderr,
      now: () => 0,
      pluginVersion: () => 'test-plugin',
      ...THEME_PORTS,
    },
  )
}

describe('merge 入力に拾うファイル名', () => {
  it('`slide-<数字>.pptx` に合わない名前は merge 入力に入らない', async () => {
    const out = temporaryRoot('decoy-names.pptx')
    // 数字以外 / prefix 違い / 数字なし / suffix 違いを混ぜても、拾うのは slide-1.pptx だけ。
    await runConvertWithSlideNames(out, [
      'slide-1.pptx',
      'slide-abc.pptx',
      'other-1.pptx',
      'slide-.pptx',
      'slide-2.pptx.bak',
    ])

    // `ppt/slides/_rels/...` は接頭辞が `ppt/slides/_` なのでこの数え方には入らない。
    expect(await countPptxParts(out, 'ppt/slides/slide')).toBe(1)
  })

  it('名前が 1 つも合わなければ merge 入力 0 件として失敗する', async () => {
    const out = temporaryRoot('decoy-names-only.pptx')
    await expect(runConvertWithSlideNames(out, ['slide-abc.pptx', 'other-1.pptx']))
      .rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })
})
