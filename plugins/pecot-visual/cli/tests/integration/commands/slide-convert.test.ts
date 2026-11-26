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
  convertErrorDiagnostics,
  executeSlideConvert,
  resolveDefaultOut,
  errorToReason,
  runSlideConvert,
  slideConvertDefaultDependencies,
  validateTheme,
  type SlideConvertDependencies,
  type SlideConvertOptions,
  type SlideConvertResultSummary,
} from '../../../src/commands/slidev-to-pptx/convert.js'
import type { TransitionType } from '../../../src/domain/pptx-ooxml/post-process.js'
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
import { readOutput } from '../../_helpers/attach.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { verifies } from '../../_helpers/verifies.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from '../../../src/commands/slidev-project/linked-theme.js'
import { makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'
import { explains } from '../../_helpers/explains.js'

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
  it('テーマ名に許容文字（英数字・@・/・_・.・-）だけを使った場合は、検証に成功する', async () => {
    await explains('`validateTheme` の許容文字のテストです。`default`・`@my-org/theme_v2.0`・`a/b.c-d_e` を渡した場合に、いずれも例外が発生しないことを確認します。')
    expect(callValidateTheme('default')).not.toThrow()
    expect(callValidateTheme('@my-org/theme_v2.0')).not.toThrow()
    expect(callValidateTheme('a/b.c-d_e')).not.toThrow()
  })

  it('テーマ名に禁止文字を含む場合は、invalid-theme の SlideConvertUsageError が発生する', async () => {
    await explains('`validateTheme` の禁止文字のテストです。`$(rm -rf /)`・空白を含む値・`;` を含む値・空文字を渡した場合に、いずれも `SlideConvertUsageError` が発生することを確認します。')
    expect(callValidateTheme('$(rm -rf /)')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('foo bar')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('foo;bar')).toThrow(SlideConvertUsageError)
    expect(callValidateTheme('')).toThrow(SlideConvertUsageError)
  })

  it('SlideConvertUsageError には、reason に invalid-theme が設定される', async () => {
    await explains('`validateTheme` の例外の `reason` のテストです。空白だけの値を渡した場合に、`reason` が `invalid-theme` の例外が発生することを確認します。')
    expect(callValidateTheme(' ')).toThrow(
      expect.objectContaining({ reason: 'invalid-theme' }),
    )
  })
})

describe('runSlideConvert (fake DI 経由 / 全分岐)', () => {
  it('成功した場合は、結合した PPTX を outputAbs に書き出し、runner と converter を 1 回ずつ呼び出す', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-02')
    await explains('`runSlideConvert` の成功時のテストです。2 枚のスライドを返す偽の変換器を使った場合に、出力先と入力元が絶対パスになり、runner と converter が 1 回ずつ呼び出され、PPTX が作成されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'sample.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(2)
    const infra = realInfra()

    const summary = await runSlideConvert(
      projectDirectory,
      { out },
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

  it('結合した後に、フォントの補正と CSS だけの書体の除去が適用される（#391 の回帰防止）', async () => {
    // dom-to-pptx が出力する次の内容が、`slide convert` 後の merged PPTX で補正されていることを XPath assertion する。
    // 内容は「日本語テキストに英文専用 ea (Test Display Extended) + CSS-only typeface (-apple-system) + 段落終端 endParaRPr」。
    // Phase 2 で `--skip-postprocess` を立てた際に slide convert からの font fix chain が
    // 抜け落ちて Phase 4 で顕在化したバグの回帰防止。
    await explains('結合後の後処理のテストです。日本語と `-apple-system` の書体を含む PPTX を結合した場合に、`a:ea` が `Noto Sans JP` になり、`-apple-system` が残らないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'fontfix.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithJapaneseSlide()
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out },
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

  it('宣言に pptx の値が存在しない場合は、東アジアのフォントを書き込まない', async () => {
    await explains('テーマの宣言に `pptx` の値が存在しない場合のテストです。`pptx` が空の宣言を使った場合に、`a:ea` の書体へ `Noto Sans JP` と `-apple-system` のどちらも含まれないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-policy.pptx')
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out },
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

  it('テーマの宣言の eastAsianFont を ea に書き込み、宣言の読み込み先は ensureThemeLinked が返したテーマの directory にする', async () => {
    await explains('テーマの宣言の読み込みのテストです。`eastAsianFont` が `Test Sans JP` の場合に、`a:ea` へその値が書き込まれ、`ensureThemeLinked` が返した `directory` から読み込まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'declared-font.pptx')
    const infra = realInfra()
    const ensured: string[] = []
    const read: string[] = []

    await runSlideConvert(
      projectDirectory,
      { out },
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

  it('テーマの名前が一致しない場合（SlideCreateRuntimeError）は、専用の reason の theme-name-mismatch を返す', async () => {
    await explains('`errorToReason` のテストです。`theme-name-mismatch` の `SlideCreateRuntimeError` を渡した場合に、`theme-name-mismatch` が返ることを確認します。')
    expect(errorToReason(new SlideCreateRuntimeError('名前が違う', 'theme-name-mismatch'))).toBe('theme-name-mismatch')
  })

  it('宣言の警告と、pptx の値を省略したことの警告を、標準エラーに warning: 付きで出力する', async () => {
    await explains('警告の出力のテストです。宣言の読み込みで警告が出て `pptx` が空の場合に、標準エラーへ宣言の警告と、`pptx.linkColor`・`pptx.eastAsianFont` の省略の警告が出力されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'warnings.pptx')
    const infra = realInfra()
    const stderr = makeStream('stderr')

    await runSlideConvert(
      projectDirectory,
      { out },
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
          warnings: ['theme /theme-root has no pecot-theme.json declaration; continuing with the defaults'],
        }),
      },
    )

    const written = stderr.chunks.join('')
    expect(written).toContain('warning: theme /theme-root has no pecot-theme.json declaration')
    expect(written).toContain('warning: pptx.linkColor is omitted, so links are not converted')
    expect(written).toContain('warning: pptx.eastAsianFont is omitted, so no East Asian font is written')
  })

  it('pptx の値が揃っている場合は、省略の警告を出力しない', async () => {
    await explains('省略の警告が出ない場合のテストです。`linkColor` と `eastAsianFont` を持つ宣言を使った場合に、標準エラーに `is omitted, so` が含まれないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-warnings.pptx')
    const infra = realInfra()
    const stderr = makeStream('stderr')

    await runSlideConvert(
      projectDirectory,
      { out },
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

    expect(stderr.chunks.join('')).not.toContain('is omitted, so')
  })

  it('取得の signal と警告の出力先を、ensureThemeLinked の引数の文脈として渡す', async () => {
    await explains('`ensureThemeLinked` へ渡す文脈のテストです。`AbortController` の `signal` を指定した場合に、同じ `signal` が文脈に含まれ、文脈の `warn` の出力が標準エラーに `warning:` 付きで出力されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'context.pptx')
    const infra = realInfra()
    const stderr = makeStream('stderr')
    const controller = new AbortController()

    await runSlideConvert(
      projectDirectory,
      { out },
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

    expect(stderr.chunks.join('')).toContain('warning: 取得中の警告')
  })

  it('テーマをリンクできない場合は、slidev build を始めず、theme-<reason> で止まる', async () => {
    await explains('テーマのリンクの失敗のテストです。`ensureThemeLinked` が `tag` の `ThemeFetchError` で失敗した場合に、同じ例外が発生し、`slidev build` が呼ばれず、PPTX が作成されないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'unlinked.pptx')
    const slidevRunner = createSuccessRunner()
    const infra = realInfra()
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    const rejected = await rejectionOf(runSlideConvert(
      projectDirectory,
      { out },
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

  it('移行前の talk-dir（theme が none でテーマの宣言も存在しない）は、slidev build を始めず theme-none で止まり、移行を案内する', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-09')
    await explains('移行前の `talk-dir` の変換のテストです。`theme: none` の `talk-dir` を指定した場合に、`reason` が `theme-none` になり、移行手順を示すメッセージが含まれ、build が呼ばれないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    writeFileSync(path.join(projectDirectory, 'slides.md'), '---\ntheme: none\ntitle: Legacy\n---\n# 表紙\n')
    const out = temporaryRoot('out', 'legacy.pptx')
    const slidevRunner = createSuccessRunner()
    const infra = realInfra()

    const rejected = await rejectionOf(runSlideConvert(
      projectDirectory,
      { out },
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
    expect(message).toContain('slide_sync with theme: <theme-spec>')
    expect(message).toContain('slide_sync')
    expect(slidevRunner.calls).toHaveLength(0)
    expect(existsSync(out)).toBe(false)
  })

  it('staging の letter-spacing.json と href-map.json を自動で検出し、変換の後処理へ渡す（ケース A）', async () => {
    // staging に書かれた json を CLI flag 無しでも自動検出して spc / hlinkClick が出力される
    // ことを pin。priority: `flag > staging > empty` の staging ルート。
    await explains('staging の JSON の自動検出のテストです。フラグなしで両方の JSON がある場合に、`spc` が 150 になり、`a:hlinkClick` が 1 件以上で、`Target` が `https://example.com` になることを確認します。')
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
      { out },
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

  it('フラグを指定した場合は、staging の JSON を使わず、フラグの指定を優先する（ケース B）', async () => {
    // staging には spacing/href json を書きつつ、CLI flag で別 path の JSON を渡す。
    // 出力 spc 値は flag 側 (5px → spc=375) と一致し、staging 値 (2px → 150) ではないことを assert。
    await explains('フラグと staging の優先順位のテストです。両方に JSON がある場合に、`spc` が 375 で `Target` が `https://flag.example.com` になり、staging の値が含まれないことを確認します。')
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

  it('staging に JSON が存在しない場合は、空の Map を使い、spc と hlinkClick を出力しない', async () => {
    // staging json を作らないルート。flag も無い。spc / hlinkClick は出力されない (= empty Map)。
    await explains('staging の JSON が存在しない場合のテストです。フラグも指定しなかった場合に、`a:rPr` の `spc` 属性が 0 件になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'no-staging.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out },
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

  it('--transition-type に morph、--morph-option に byChar、--transition-duration-ms に 800 を指定すると、PPTX に反映される', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-05')
    await explains('トランジションの指定のテストです。3 つのオプションを指定した場合に、`p159:morph` の `option` が `byChar` になり、`p14:dur` を持つ要素が 1 件以上になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out', 'morph.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      {
        out,
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

  it('staging の letter-spacing.json が JSON として不正な場合は、invalid-staging-json の SlideConvertRuntimeError が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`letter-spacing.json` の内容が JSON として不正な場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の letter-spacing.json が通常のオブジェクトでない場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`letter-spacing.json` の内容が配列の場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の letter-spacing.json の項目の型が不正な場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`letter-spacing.json` の項目がオブジェクトでなく文字列の場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の letter-spacing.json の項目で letterSpacing か fontSize が不足している場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`letter-spacing.json` の項目に `fontSize` が不足している場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の href-map.json が通常のオブジェクトでない場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`href-map.json` の内容が文字列の場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の href-map.json が JSON として不正な場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`href-map.json` の内容が JSON として不正な場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の href-map.json の項目の型が不正な場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('staging の JSON の検証のテストです。`href-map.json` の項目が文字列でなく数値の場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
      { out },
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

  it('フラグで指定した spacing の JSON のパスを読み込めない場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('フラグで指定した JSON の検証のテストです。存在しないパスを `spacingJson` へ指定した場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, spacingJson: temporaryRoot('no-such-spacing.json') },
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

  it('フラグで指定した href の JSON のパスを読み込めない場合は、invalid-staging-json の例外が発生する', async () => {
    await explains('フラグで指定した JSON の検証のテストです。存在しないパスを `hrefJson` へ指定した場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createConverterWithSpacingAndAnchor({})
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, hrefJson: temporaryRoot('no-such-href.json') },
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

  it('staging の JSON のパスがディレクトリの場合は、読み込まずに、空の Map で処理を続ける', async () => {
    // resolveJsonSource は stat で isFile() のみ true を返すため、ディレクトリは無視される
    await explains('staging の JSON がディレクトリの場合のテストです。`letter-spacing.json` という名前のディレクトリがある場合に、読み込みをせず、変換が例外なく完了することを確認します。')
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
      { out },
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

  it('--theme を指定した場合は、runner.build に theme の値を渡す', async () => {
    await explains('`--theme` の伝達のテストです。`theme` に `sample-theme` を指定した場合に、`slidevRunner.build` の呼び出しの `theme` が `sample-theme` になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out2.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()

    await runSlideConvert(
      projectDirectory,
      { out, theme: 'sample-theme' },
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

  it('--theme に不正な値を指定した場合は、invalid-theme の SlideConvertUsageError が発生する', async () => {
    await explains('`--theme` の検証のテストです。`$(rm -rf /)` を指定した場合に、`SlideConvertUsageError` が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out, theme: '$(rm -rf /)' },
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

  it('project-dir が存在しない場合は、project-not-found の SlideConvertRuntimeError が発生する', async () => {
    await explains('`project-dir` の検証のテストです。存在しないディレクトリを指定した場合に、`SlideConvertRuntimeError` が発生することを確認します。')
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      temporaryRoot('nonexistent'),
      { out },
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

  it('project-dir がファイルの場合（ディレクトリでない場合）は、project-not-found の SlideConvertRuntimeError が発生する', async () => {
    await explains('`project-dir` の検証のテストです。ディレクトリでなくファイルを指定した場合に、`not a directory` を含む例外が発生することを確認します。')
    const file = temporaryRoot('a-file')
    writeFileSync(file, 'not a directory')
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      file,
      { out },
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
    )).rejects.toThrow(/not a directory/)
  })

  it('slides.md が存在しない場合は、project-not-found の SlideConvertRuntimeError が発生する', async () => {
    await explains('`slides.md` の検証のテストです。`slides.md` が存在しないディレクトリを指定した場合に、`slides.md not found` を含む例外が発生することを確認します。')
    const directory = temporaryRoot('no-slides')
    mkdirSync(directory, { recursive: true })
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter = createSuccessConverter(1)
    const infra = realInfra()
    await expect(runSlideConvert(
      directory,
      { out },
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
    )).rejects.toThrow(/slides\.md not found/)
  })

  it('SlidevRunner が 0 以外の終了コードで失敗した場合は、slidev-build-failed の SlideConvertRuntimeError が発生する', async () => {
    await explains('`slidev build` の失敗のテストです。`SlidevRunner` が失敗の結果を返した場合に、`reason` が `slidev-build-failed` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner: SlidevRunner = {
      build: () => Promise.resolve(spawnFailure('slidev compile error')),
    }
    const pptxConverter: SlidevPptxPipeline = { convert: () => Promise.resolve(pipelineSuccess()) }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out },
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

  it('SlidevRunner が時間切れになった場合は、slidev-build-timeout の SlideConvertRuntimeError が発生する', async () => {
    await explains('`slidev build` の時間切れのテストです。`SlidevRunner` が時間切れの結果を返した場合に、`reason` が `slidev-build-timeout` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner: SlidevRunner = {
      build: () => Promise.resolve(spawnTimeout()),
    }
    const pptxConverter: SlidevPptxPipeline = { convert: () => Promise.resolve(pipelineSuccess()) }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out },
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

  it('Pipeline が success=false を返した場合は、pptx-convert-failed の SlideConvertRuntimeError が発生する', async () => {
    await explains('変換の失敗のテストです。Pipeline が `success` が偽の結果を返した場合に、`reason` が `pptx-convert-failed` の例外が発生することを確認します。')
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
      { out },
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

  it('Pipeline が PipelineRuntimeError を送出した場合は、pptx-convert-failed の SlideConvertRuntimeError が発生する', async () => {
    await explains('変換の例外の変換のテストです。Pipeline が `PipelineRuntimeError` で失敗した場合に、`reason` が `pptx-convert-failed` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: () => Promise.reject(new PipelineRuntimeError('chromium launch failed')),
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out },
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

  it('Pipeline が PipelineTimeoutError を送出した場合は、pptx-convert-timeout の SlideConvertRuntimeError が発生する', async () => {
    await explains('変換の時間切れのテストです。Pipeline が `PipelineTimeoutError` で失敗した場合に、`reason` が `pptx-convert-timeout` の例外が発生することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('out.pptx')
    const slidevRunner = createSuccessRunner()
    const pptxConverter: SlidevPptxPipeline = {
      convert: () => Promise.reject(new PipelineTimeoutError(100, { elapsedMs: 100 })),
    }
    const infra = realInfra()
    await expect(runSlideConvert(
      projectDirectory,
      { out },
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

  it('success が真でも staging に slide-<N>.pptx が存在しない場合は、pptx-convert-failed の SlideConvertRuntimeError が発生する', async () => {
    await explains('staging の成果物の確認のテストです。Pipeline が成功を返し、`slides` ディレクトリを作成しなかった場合に、`reason` が `pptx-convert-failed` の例外が発生することを確認します。')
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
      { out },
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

  it('staging の slides ディレクトリに slide-<N>.pptx が 0 件の場合（空のディレクトリなど）も、pptx-convert-failed の例外が発生する', async () => {
    await explains('staging の成果物の確認のテストです。`slides` ディレクトリに `README.txt` だけがある場合に、`reason` が `pptx-convert-failed` の例外が発生することを確認します。')
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
      { out },
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

  it('子の stdout/stderr を deps の stderr へ relay する', async () => {
    await explains('`runSlideConvert` の子プロセスの出力のテストです。`build` を実行した場合に、`slidevRunner` へ標準出力と標準エラー出力の出力先を渡すことを確認します。')
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
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    await runSlideConvert(
      projectDirectory,
      { out },
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

  it('build の失敗時の標準エラーが 1KB を超える場合は、末尾だけを detail に出力する', async () => {
    await explains('失敗時のメッセージの長さのテストです。2048 文字の標準エラーで失敗した場合に、`SlideConvertRuntimeError` のメッセージの長さが、元の長さに 200 を加えた値より短いことを確認します。')
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
        { out },
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

/**
MCP の slide_convert と同じ組み立てで実行し、結果か失敗の payload を JSON 1 行で stdout に書く。
*/
function createConvertRunner(
  createDependencies: () => SlideConvertDependencies,
): { parseAsync: (argv: readonly string[]) => Promise<void> } {
  return {
    async parseAsync(argv) {
      const dependencies = createDependencies()
      const [projectDirectory = '', ...rest] = argv
      const valueOf = (flag: string): string | undefined => {
        const index = rest.indexOf(flag)
        return index === -1 ? undefined : rest[index + 1]
      }
      const emit = (payload: unknown): void => {
        dependencies.stdout.write(`${JSON.stringify(payload)}\n`)
      }
      try {
        const out = valueOf('--out') ?? await resolveDefaultOut(path.resolve(projectDirectory), dependencies.stderr)
        const theme = valueOf('--theme')
        const spacingJson = valueOf('--spacing-json')
        const hrefJson = valueOf('--href-json')
        const transitionType = valueOf('--transition-type')
        const transitionDurationMs = valueOf('--transition-duration-ms')
        const morphOption = valueOf('--morph-option')
        const logLevel = valueOf('--log-level')
        const execution = await executeSlideConvert(projectDirectory, {
          out,
          cache: !rest.includes('--no-cache'),
          ...(rest.includes('--no-single-pass') && { singlePass: false }),
          ...(theme !== undefined && { theme }),
          ...(spacingJson !== undefined && { spacingJson }),
          ...(hrefJson !== undefined && { hrefJson }),
          // eslint-disable-next-line no-restricted-syntax -- argv の文字列を option の型へ渡すだけ
          ...(transitionType !== undefined && { transitionType: transitionType as TransitionType }),
          ...(transitionDurationMs !== undefined && { transitionDurationMs: Number(transitionDurationMs) }),
          // eslint-disable-next-line no-restricted-syntax -- 同上
          ...(morphOption !== undefined && { morphOption: morphOption as NonNullable<SlideConvertOptions['morphOption']> }),
          // eslint-disable-next-line no-restricted-syntax -- 同上
          ...(logLevel !== undefined && { logLevel: logLevel as 'verbose' | 'debug' }),
        }, dependencies)
        emit(execution.data)
      }
      catch (error: unknown) {
        emit({
          event: 'slide.convert.error',
          reason: errorToReason(error),
          detail: error instanceof Error ? error.message : String(error),
          ...convertErrorDiagnostics(error),
        })
      }
    },
  }
}

describe('slide convert の実行と結果 (execute 経由)', () => {
  it('成功すると slide.convert.done の data を返す', async () => {
    await explains('`slide convert` コマンドの `--json` のテストです。変換が成功した場合は、標準出力へ `slide.convert.done` のイベントだけを出力することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

    const events = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      .map((line): { event?: string } => {
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
        return JSON.parse(line) as { event?: string }
      })
    const eventNames = events.map(event => event.event)
    expect(eventNames).toEqual(['slide.convert.done'])
  })

  it('--json の done の timings は、perSlide の phases・outer・singlePass を含む（#1141）', async () => {
    await explains('`slide.convert.done` の `timings` のテストです。区間の時間を持つ変換の結果を返した場合に、`perSlide` の項目へ `phases` が含まれ、`singlePass` と `outer` がそのまま出力されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-phases.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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
    const command = createConvertRunner(() => dependencies)

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

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

  it('--no-single-pass を指定した場合は pipeline に singlePass が false の値を渡し、指定しない場合は singlePass のキーを渡さない（#1147）', async () => {
    await explains('`--no-single-pass` の伝達のテストです。指定して実行した場合は `singlePass` が `false`、指定せずに実行した場合は `singlePass` のキーが存在しないことを確認します。')
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

    await createConvertRunner(dependenciesCapturing).parseAsync(
      [projectDirectory, '--out', temporaryRoot('no-single-1.pptx'), '--no-single-pass'],
    )
    await createConvertRunner(dependenciesCapturing).parseAsync(
      [projectDirectory, '--out', temporaryRoot('no-single-2.pptx')],
    )

    expect(received).toStrictEqual([false, undefined])
    expect(keyPresent).toStrictEqual([true, false])
  })

  it('--json の done の timings は、現行のルートの実行では singlePass を含まず、outer は常に含まれる（#1141）', async () => {
    await explains('`slide.convert.done` の `timings` のテストです。1 パスの情報を持たない変換の場合に、`timings` に `perSlidePhases` と `singlePass` が含まれず、`outer` が含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-no-single.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

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

  it('--json を指定した場合は、pipeline の人間向けのログを、標準出力でなく標準エラーに出力する', async () => {
    await explains('`--json` のログの出力先のテストです。pipeline が警告を出した場合に、標準エラーへ `warning: pipeline-human-log` が出力され、標準出力が 2 件のイベントだけになることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-json-log.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const isProcessStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const dependencies = {
        ...buildFakeDependencies(stdout, stderr),
        // 実 InProcessSlidevPptxPipeline を通し、runner が logger.info で人間可読ログを書く
        pptxConverter: new InProcessSlidevPptxPipeline({
          convertToPptxRunner: async (config, pipelineDependencies) => {
            pipelineDependencies.logger?.warn('pipeline-human-log')
            mkdirSync(config.outputDir, { recursive: true })
            await placeFakeSlides(config.outputDir, 1)
            return pipelineSuccess()
          },
        }),
      }
      const command = createConvertRunner(() => dependencies)

      await command.parseAsync([projectDirectory, '--out', out, '--json'])

      const stdoutLines = stdout.chunks
        .flatMap(chunk => chunk.split('\n'))
        .filter(line => line.trim().length > 0)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      expect(stdoutLines.map(line => (JSON.parse(line) as { event?: string }).event))
        .toStrictEqual(['slide.convert.done'])
      expect(stderr.chunks.join('')).toContain('warning: pipeline-human-log\n')
      expect(isProcessStdoutWrite).not.toHaveBeenCalled()
    }
    finally {
      isProcessStdoutWrite.mockRestore()
    }
  })

  it('--log-level に verbose を指定した場合は、進捗の行を標準エラーに note: 付きで出力し、標準出力には出力しない', async () => {
    await explains('`--log-level` のテストです。`verbose` を指定した場合に、標準エラーに `note: pipeline-progress` が出力され、標準出力には含まれないことを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out-log-level.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = {
      ...buildFakeDependencies(stdout, stderr),
      pptxConverter: new InProcessSlidevPptxPipeline({
        convertToPptxRunner: async (config, pipelineDependencies) => {
          pipelineDependencies.logger?.info('pipeline-progress')
          mkdirSync(config.outputDir, { recursive: true })
          await placeFakeSlides(config.outputDir, 1)
          return pipelineSuccess()
        },
      }),
    }
    const command = createConvertRunner(() => dependencies)

    await command.parseAsync([projectDirectory, '--out', out, '--log-level', 'verbose'])

    expect(stderr.chunks.join('')).toContain('note: pipeline-progress\n')
    expect(stdout.chunks.join('')).not.toContain('pipeline-progress')
  })

  it('--json を指定して theme が不正な場合は、slide.convert.error を出力し、終了コード 2 で終わる', async () => {
    await explains('`--json` のエラーの出力のテストです。`$(rm -rf /)` を `--theme` へ指定した場合に、最後のイベントの `reason` が `invalid-theme` で、終了コードが 2 になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))
    await command.parseAsync([projectDirectory, '--out', out, '--theme', '$(rm -rf /)', '--json'])
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
  })

  it('--json を指定して project-dir が存在しない場合は、runtime error の reason を slide.convert.error へ引き継ぐ', async () => {
    await explains('`--json` のエラーの reason のテストです。存在しないディレクトリを指定した場合に、最後のイベントの `reason` が `project-not-found` で、終了コードが 1 になることを確認します。')
    const out = temporaryRoot('cmd-out.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))
    await command.parseAsync(
      [temporaryRoot('no-such-dir'), '--out', out, '--json'],
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
  })

  it('spacing・href・transition・morph の各オプションをすべて指定した場合は、変換に成功する', async () => {
    // commander で 5 flag が受理され、optional spread が全て分岐する正常系を pin。
    await explains('オプションの組み合わせのテストです。`--spacing-json` や `--href-json` など 5 つを同時に指定した場合に、`slide convert` が出力され、PPTX が作成されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cmd-all-flags.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const spacingPath = temporaryRoot('spacing.json')
    const hrefPath = temporaryRoot('href.json')
    writeFileSync(spacingPath, JSON.stringify({}))
    writeFileSync(hrefPath, JSON.stringify({}))
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))
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
    )
    expect(existsSync(out)).toBe(true)
  })

  it('--out を指定しない場合は、<project-dir>/pptx/<basename>.pptx に書き出す', async () => {
    await explains('出力先の既定値のテストです。`--out` を指定しない場合に、`pptx` ディレクトリ配下にディレクトリ名の PPTX が作成され、標準出力にそのパスが含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out を指定せず project-dir の末尾にスラッシュを付けた場合も、basename から既定のパスを決定する', async () => {
    await explains('末尾のスラッシュの扱いのテストです。末尾に `/` を付けた `project-dir` を指定した場合に、スラッシュのない場合と同じ既定のパスに PPTX が作成されることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    // 末尾スラッシュ付きで渡しても path.resolve が正規化するため basename は同じになる
    await command.parseAsync([`${projectDirectory}/`])

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out を指定せず slides.md に title がある場合は、title を元にした既定のパスに書き出す', async () => {
    await explains('`title` を使った既定のパスのテストです。`slides.md` に `title: 開発レポート` がある場合に、`開発レポート.pptx` が作成され、ディレクトリ名の PPTX が作成されないことを確認します。')
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: 開発レポート\n---\n\n# body')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', '開発レポート.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
    // title があるので basename 由来の旧既定パスは生成されない
    const legacyOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(legacyOut)).toBe(false)
  })

  it('--out を指定せず slides.md に title が存在しない場合は、basename を元にした既定のパスに書き出す', async () => {
    // readFile は成功するが parseSlidesTitle が undefined を返す接続 (title 不在 → basename fallback)。
    await explains('`title` が存在しない場合の既定のパスのテストです。`slides.md` に `title` がない場合に、ディレクトリ名の PPTX が作成され、標準エラーが空であることを確認します。')
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntheme: default\n---\n\n# body')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
    // 読取失敗ではないため stderr に診断は出ない
    expect(stderr.chunks.join('')).toBe('')
  })

  it('--out を指定せず slides.md の読み込みが ENOENT 以外で失敗した場合は、標準エラーに診断を出力し、basename を元にした既定のパスに書き出す', async () => {
    // slides.md をディレクトリにして readFile を EISDIR (非 ENOENT) で失敗させる。
    // ensureProjectDirectory の stat は成功し、後段は進行する。
    await explains('`slides.md` の読み込みの失敗のテストです。`slides.md` がディレクトリで `EISDIR` となる場合に、ディレクトリ名の PPTX が作成され、標準エラーへ `cannot read slides.md` が含まれることを確認します。')
    const projectDirectory = temporaryRoot('sample')
    mkdirSync(path.join(projectDirectory, 'slides.md'), { recursive: true })
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    // 読取失敗の診断が stderr に出る (stdout の JSON/人間向けメッセージは汚さない)
    expect(stderr.chunks.join('')).toContain('cannot read slides.md')
  })

  it('--out を指定せず title に禁止文字がある場合は、_ に置き換えた既定のパスに書き出す', async () => {
    await explains('`title` の禁止文字のテストです。`title` が `2026/Q1 レポート` の場合に、`/` が `_` に置き換わった `2026_Q1 レポート.pptx` が作成されることを確認します。')
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: 2026/Q1 レポート\n---\n')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', '2026_Q1 レポート.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out を指定せず title が引用符で囲まれている場合は、引用符を外した既定のパスに書き出す', async () => {
    await explains('引用符付きの `title` のテストです。`title` が `\'クォート付き\'` の場合に、引用符を除いた `クォート付き.pptx` が作成されることを確認します。')
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: \'クォート付き\'\n---\n')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory])

    const expectedOut = path.join(projectDirectory, 'pptx', 'クォート付き.pptx')
    expect(existsSync(expectedOut)).toBe(true)
    expect(stdout.chunks.join('')).toContain(expectedOut)
  })

  it('--out 省略時は done の output が title 由来パスになる', async () => {
    await explains('`slide convert` コマンドの出力先の決め方のテストです。`--out` を省略した場合に、`slide.convert.done` の `output` が `slides.md` の `title` から決まるパスになることを確認します。')
    const projectDirectory = makeProjectDirectoryWithSlides(temporaryRoot(), '---\ntitle: JSON タイトル\n---\n')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--json'])

    const expectedOut = path.join(projectDirectory, 'pptx', 'JSON タイトル.pptx')
    const events = stdout.chunks
      .flatMap(chunk => chunk.split('\n'))
      .filter(line => line.trim().length > 0)
      .map((line): { event?: string, output?: string } => {
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
        return JSON.parse(line) as { event?: string, output?: string }
      })
    const done = events.find(event => event.event === 'slide.convert.done')
    expect(done?.output).toBe(expectedOut)
  })
})

describe('slideConvertDefaultDependencies', () => {
  it('既定の依存は、infra の実装（in-process の pipeline）を組み立てて返す', async () => {
    await explains('`slideConvertDefaultDependencies` のテストです。既定の依存を作成した場合に、`slidevRunner`・`pptxConverter`・`archive`・`engine` が定義され、`now()` が数値を返すことを確認します。')
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

  it('座標とサイズが一致する場合は、1 段目の判定で、画像を高解像度版に差し替える（CUJ 1）', async () => {
    // invariant: 1 段目発火 (距離 ≤ 50 px, サイズ相対 ≤ 15%, includeImageRel=true で picMap 非空)
    await explains('高解像度の画像への差し替えの 1 段目のテストです。画像の位置の差が 50 px 以内で、サイズが一致する場合に、`image1-s1.png` の大きさが 1200 x 900 になることを確認します。')
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
      { out },
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

  it('prerender のファイルが存在しない場合は、何も差し替えず、画像の大きさが変わらない（CUJ 2）', async () => {
    await explains('高解像度の画像がない場合のテストです。prerender のファイルが存在しない場合に、`image1-s1.png` の大きさが入力の 400 x 300 のままであることを確認します。')
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
      { out },
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

  it('座標が離れていてサイズが一致する場合は、2 段目の判定で、画像を差し替える（CUJ 3）', async () => {
    // invariant: 2 段目発火 (距離 > 50 px で 1 段目却下、サイズ相対 ≤ 15%、picMap 非空で 3 段目には落ちない)
    await explains('高解像度の画像への差し替えの 2 段目のテストです。位置の差が 50 px を超え、サイズが一致する場合に、`image1-s1.png` の大きさが 1600 x 1200 になることを確認します。')
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
      { out },
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

  it('rels に画像の関係定義が存在せず対応表も空の場合は、3 段目の判定により、すべての PNG を走査して差し替える（CUJ 4）', async () => {
    // invariant: 3 段目発火 (includeImageRel=false で picMap 空、PNG 絶対差 ≤ 50 px)
    await explains('高解像度の画像への差し替えの 3 段目のテストです。画像の関係定義がなく、サイズの差が 50 px 以内の場合に、`image1-s1.png` の大きさが 2000 x 1500 になることを確認します。')
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
      { out },
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
  it('複数のスライドの slideNumber が 100 刻みの場合は、元のスライド番号から逆引きして、prerender の画像を差し替える（CUJ 5）', async () => {
    // invariant: 元 slideNumber (100, 200) と merged 連番 (1, 2) は一致しない。
    // そのため逆引きが破損していると、prerender ファイルが見つからず差し替え 0 件になる。
    await explains('スライド番号の逆引きのテストです。元の番号が 100 と 200 で、結合後の連番が 1 と 2 の場合に、どちらのスライドの画像も高解像度版に差し替わることを確認します。')
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
      { out },
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
  it('2 回続けて実行すると、2 回目はすべてキャッシュに一致し、変換が 1 件も動かない', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-03')
    await explains('差分キャッシュのテストです。同じデッキを 2 回続けて変換した場合に、1 回目は 2 件とも変換されて `misses` が 2、2 回目は変換が 0 件で `hits` が 2 になることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-1.pptx')
    const firstCalls: number[] = []
    const secondCalls: number[] = []
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    const first = await runSlideConvert(
      project.directory,
      { out },
      cacheDependencies(project, firstCalls, stdout, stderr),
    )
    const second = await runSlideConvert(
      project.directory,
      { out },
      cacheDependencies(project, secondCalls, stdout, stderr),
    )

    expect(firstCalls).toStrictEqual([100, 200])
    expect(first.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'none' })
    expect(secondCalls).toStrictEqual([])
    expect(second.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })
    expect(existsSync(out)).toBe(true)
  })

  it('1 枚だけ変更して再実行すると、そのステップだけがキャッシュに一致しない', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-03')
    await explains('差分キャッシュの部分的な無効化のテストです。2 枚目だけを変更して再実行した場合に、変換されるのが `200` だけで、`invalidated` が `partial`、`perStep` が `hit` と `miss` の順になることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    await runSlideConvert(project.directory, { out }, cacheDependencies(project, [], stdout, stderr))
    rewriteCacheDeck(project, ['# スライド1', '# スライド2 を修正'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out },
      cacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([200])
    expect(summary.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(summary.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
  })

  it('--json の done イベントに、cache と timings.perSlide[].cache を含める', async () => {
    await explains('`--json` のキャッシュの出力のテストです。2 枚目を変更して再実行した場合に、`cache` が `hits` 1 と `misses` 1 になり、`perSlide` が `hit` と `miss` になることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-3.pptx')
    const firstStdout = makeStream('firstStdout')
    const stderr = makeStream('stderr')
    const firstCommand = createConvertRunner(() => cacheDependencies(project, [], firstStdout, stderr))
    await firstCommand.parseAsync([project.directory, '--out', out, '--json'])

    rewriteCacheDeck(project, ['# スライド1', '# スライド2 を修正'])
    const stdout = makeStream('stdout')
    const command = createConvertRunner(() => cacheDependencies(project, [], stdout, stderr))
    await command.parseAsync([project.directory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: true, hits: 1, misses: 1, invalidated: 'partial' })
    const perSlide = done?.timings?.perSlide ?? []
    expect(perSlide.map(entry => ({ key: entry.key, cache: entry.cache }))).toStrictEqual([
      { key: '1', cache: 'hit' },
      { key: '2', cache: 'miss' },
    ])
  })

  it('すべてキャッシュに一致した実行の出力 PPTX は、初回の実行と同じ数のスライドの XML と ppt/media を持つ（F-02）', async () => {
    // existsSync(out) だけでは、materialize の復元抜け（通知なしのスライド欠落）を検知できない。
    // fake worker に prerender ファイルを書かせる。
    // キャッシュルートと prerender 差し替え（cache 由来 PNG が ppt/media に載るルート）を同時に踏む。
    // その上で初回 run と全ヒット run の出力を比べる（out は run ごとに別パス）。
    await explains('キャッシュからの復元のテストです。2 回目がすべて一致した場合に、2 回の出力でスライドの数と `ppt/media` の件数が同じ 2 件で、画像が高解像度版（1200 x 900）のままであることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const firstOut = temporaryRoot('cache-content-1.pptx')
    const secondOut = temporaryRoot('cache-content-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    const firstCalls: number[] = []
    await runSlideConvert(
      project.directory,
      { out: firstOut },
      cachePrerenderDependencies(project, firstCalls, stdout, stderr),
    )
    expect(firstCalls).toStrictEqual([100, 200])

    const secondCalls: number[] = []
    const second = await runSlideConvert(
      project.directory,
      { out: secondOut },
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

  it('同じ --theme で再実行するとすべてキャッシュに一致し、--theme を変更するとすべてのキャッシュが無効になる（F-01）', async () => {
    // --theme は slides.md の headmatter と共有クロージャのどちらにも現れない。
    // そのため envHash の材料に含めないと、テーマ切替後に旧テーマの描画が通知なしにヒットしてしまう。
    await explains('`--theme` とキャッシュのテストです。同じ `seriph` で再実行した場合は変換が 0 件で、`sample-theme` に変更した場合は `invalidated` が `all:env` で 2 件とも変換されることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-theme.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    await runSlideConvert(
      project.directory,
      { out, theme: 'seriph' },
      cacheDependencies(project, [], stdout, stderr),
    )

    const sameThemeCalls: number[] = []
    const sameTheme = await runSlideConvert(
      project.directory,
      { out, theme: 'seriph' },
      cacheDependencies(project, sameThemeCalls, stdout, stderr),
    )
    expect(sameThemeCalls).toStrictEqual([])
    expect(sameTheme.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })

    const differentThemeCalls: number[] = []
    const differentTheme = await runSlideConvert(
      project.directory,
      { out, theme: 'sample-theme' },
      cacheDependencies(project, differentThemeCalls, stdout, stderr),
    )
    expect(differentThemeCalls).toStrictEqual([100, 200])
    expect(differentTheme.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
  })

  it('clicks=N のクエリで展開されたステップは、stepIndex と key ごとに別々にキャッシュされ、2 回目に一致する（F-06）', async () => {
    await explains('クリックのステップのキャッシュのテストです。`2/1` を含む 3 ステップの場合に、1 回目は `miss`、2 回目は `hit` になり、`--json` の `perSlide` の `2/1` にも `hit` が付くことを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'cache-deck', ['# スライド1', '# スライド2'])
    const out = temporaryRoot('cache-clicks.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    const first = await runSlideConvert(
      project.directory,
      { out },
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
      { out },
      clicksCacheDependencies(project, secondCalls, stdout, stderr),
    )
    expect(secondCalls).toStrictEqual([])
    expect(second.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'hit' },
      { stepIndex: 201, key: '2/1', cache: 'hit' },
    ])

    // JSON の timings.perSlide でも key "2/1" に cache 注釈が付く（3 回目も引き続き全 hit）。
    const jsonStdout = makeStream('jsonStdout')
    const command = createConvertRunner(() => clicksCacheDependencies(project, [], jsonStdout, stderr))
    await command.parseAsync([project.directory, '--out', out, '--json'])
    const done = parseEvents(jsonStdout).find(event => event.event === 'slide.convert.done')
    const perSlide = done?.timings?.perSlide ?? []
    expect(perSlide.find(entry => entry.key === '2/1')).toMatchObject({ key: '2/1', cache: 'hit' })
  })

  it('pipeline が cache を返さない場合は、done イベントに cache のフィールドを含めない', async () => {
    await explains('キャッシュの情報がない場合のテストです。偽の pipeline が `cache` を返さない場合に、`slide.convert.done` の `cache` が `undefined` になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('cache-5.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done).toBeDefined()
    expect(done?.cache).toBeUndefined()
  })

  it('pipeline が記録した warnings を、done イベントに含める（#929）', async () => {
    await explains('`warnings` の出力のテストです。pipeline が警告を 1 件返した場合に、`slide.convert.done` の `warnings` がその 1 件だけの配列になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('warnings-1.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const warning = 'cannot read the cache manifest; cleaning existing artifacts and rebuilding'
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr, [warning]))

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.warnings).toStrictEqual([warning])
  })

  it('警告がない実行でも、done イベントに warnings として空の配列を出力する（#929）', async () => {
    // 条件付き掲載にすると「フィールドが無い＝警告なし」と「旧版で観測不能」が同型になる。
    await explains('警告がない場合の `warnings` のテストです。警告が 0 件の場合に、`slide.convert.done` の `warnings` が空の配列になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('warnings-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const command = createConvertRunner(() => buildFakeDependencies(stdout, stderr))

    await command.parseAsync([projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.warnings).toStrictEqual([])
  })
})

// --- 変換に失敗した run の warnings 掲載 (#931) ---
// 警告は「変換が成功した run」だけの情報ではない。失敗の原因診断にこそ要るため、
// slide.convert.error にも done と同型（常時掲載・不在＝旧版）で載せる。

const CACHE_WARNING = 'cannot read the cache manifest; cleaning existing artifacts and rebuilding'

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
  const command = createConvertRunner(() => dependencies)
  await command.parseAsync([...argv])
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
slide_convert を 1 回呼び、done イベントと呼び出しを返す。
*/
async function runSinglePassConvertJson(
  project: Readonly<CacheProject>,
  extraArguments: readonly string[] = [],
  options: Readonly<{ fallbackKeys?: readonly string[], outcome?: SinglePassOutcome }> = {},
): Promise<{ done: CacheDoneEvent | undefined, calls: SinglePassCalls }> {
  const calls: SinglePassCalls = { worker: [], singlePass: [] }
  const stdout = makeStream('stdout')
  const stderr = makeStream('stderr')
  const out = temporaryRoot('single-pass.pptx')
  const command = createConvertRunner(() => ({
    ...cacheDependencies(project, [], stdout, stderr),
    pptxConverter: createSinglePassPipeline(project, 2, calls, options),
  }))
  await command.parseAsync([project.directory, '--out', out, '--json', ...extraArguments])
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

  it('環境変数が未設定の場合は、1 パスのルートで変換し、done の timings.singlePass に記録する', async () => {
    await explains('1 パスのルートの既定のテストです。`PECOTV_SINGLE_PASS` が未設定の場合に、変換が 1 パスのルートで 2 件行われ、`timings.singlePass` に結果が含まれ、`warnings` が空であることを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])

    const { done, calls } = await runSinglePassConvertJson(project)

    expect(calls).toStrictEqual({ worker: [], singlePass: [100, 200] })
    expect(done?.timings?.singlePass).toStrictEqual(FAKE_SINGLE_PASS_TIMING)
    expect(done?.warnings).toStrictEqual([])
    expect(done?.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'none' })
  })

  it('1 パスのルートの成果物をキャッシュし、2 回目はすべて一致して、1 パスのルートも現行の worker も呼び出さない', async () => {
    await explains('1 パスのルートのキャッシュのテストです。同じデッキを 2 回変換した場合に、2 回目は変換が 0 件で、`hits` が 2 で、`timings` に `singlePass` が含まれないことを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])
    await runSinglePassConvertJson(project)

    const { done, calls } = await runSinglePassConvertJson(project)

    expect(calls).toStrictEqual({ worker: [], singlePass: [] })
    expect(done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(done?.timings).not.toHaveProperty('singlePass')
  })

  it('1 パスのルートから現行のルートに切り替えた場合は、warning に記録し、切り替えたステップを現行の worker で変換する', async () => {
    await explains('1 パスのルートの退避のテストです。2 枚目が退避した場合に、worker が `200`、1 パスのルートが `100` を変換し、警告に理由が含まれ、次の実行がすべて一致することを確認します。')
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])

    const { done, calls } = await runSinglePassConvertJson(project, [], { fallbackKeys: ['2'] })

    expect(calls).toStrictEqual({ worker: [200], singlePass: [100] })
    expect(done?.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: スライド #2: export failed'])
    // 退避したステップの成果物も同じ run のキャッシュに入る
    const second = await runSinglePassConvertJson(project)
    expect(second.done?.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
  })

  it('print のルートが存在しない build の場合は、warning を 1 件出力して全体を現行のルートに任せ、timings.singlePass に理由と判定時間を記録する', async () => {
    await explains('print のルートがない場合のテストです。`printRouteMissing` の結果の場合に、worker が 2 件を変換し、`timings.singlePass` が判定結果と一致し、`slide_sync` を案内する警告が出力されます。')
    const project = makeCacheProject(temporaryRoot(), 'single-pass-deck', ['# スライド1', '# スライド2'])
    const missing: SinglePassFallbackTiming = { kind: 'printRouteMissing', fallback: 'the deck build has no print route', detectMs: 40 }

    const { done, calls } = await runSinglePassConvertJson(project, [], { outcome: { kind: 'printRouteMissing', timing: missing } })

    expect(calls).toStrictEqual({ worker: [100, 200], singlePass: [] })
    expect(done?.timings?.singlePass).toStrictEqual(missing)
    expect(done?.warnings).toStrictEqual([
      'not using single-pass conversion; converting with the current method: the deck build has no print route; run `slide_sync` to add the print route to the deck',
    ])
  })

  it('ルートを切り替えた実行は envHash が変わり、all:env で全件を変換する（--no-single-pass と PECOTV_SINGLE_PASS=0 は同じルート）', async () => {
    await explains('ルートの切り替えとキャッシュのテストです。1 パスと現行のルートを切り替えた場合に、`invalidated` が `all:env` になり、同じルートの再実行は `hits` が 2 になることを確認します。')
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
  it('pipeline が success が偽の結果を返した実行でも、記録された警告を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `warnings` のテストです。pipeline が警告付きの失敗を返した場合に、`reason` が `pptx-convert-failed` で、`warnings` にその警告が含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-1.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, (arguments_) => {
      mkdirSync(arguments_.outputDirectory, { recursive: true })
      return Promise.resolve(pipelineFailure([CACHE_WARNING]))
    })

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('warnings 付きの PipelineRuntimeError が発生した実行では、その警告を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `warnings` のテストです。警告付きの `PipelineRuntimeError` が発生した場合に、`reason` が `pptx-convert-failed` で、`warnings` にその警告が含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineRuntimeError('aborted', { warnings: [CACHE_WARNING] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('warnings 付きの PipelineTimeoutError でも、その警告を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `warnings` のテストです。警告付きの `PipelineTimeoutError` が発生した場合に、`reason` が `pptx-convert-timeout` で、`warnings` にその警告が含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-3.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(100, { elapsedMs: 100, warnings: [CACHE_WARNING] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })

  it('pipeline の成功後に書き出しが失敗した場合も、reason は unknown にならず、警告を含める', async () => {
    // --out がディレクトリだと writer.finish が生の EISDIR Error を投げる。wrap しないと
    // errorToReason が unknown になり、pipeline の警告も添付されない（e2e 計測のルート）。
    await explains('書き出しの失敗のテストです。`--out` がディレクトリの場合に、`reason` が `merge-failed` で、pipeline の警告が `warnings` に含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-warnings-4-dir')
    mkdirSync(out, { recursive: true })
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildFakeDependencies(stdout, stderr, [CACHE_WARNING])

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('merge-failed')
    expect(error?.warnings).toStrictEqual([CACHE_WARNING])
  })
})

// --- 変換に失敗した run の errors 掲載 (#945) ---
// 蓄積済みの変換エラーは throw で終わる run でこそ原因診断に要る。detail は先頭 3 件に
// 丸めるため、機械可読な errors は warnings と同型（常時掲載・不在＝旧版）で全件載せる。

const SLIDE_ERROR = { level: 'slide', slideNumber: 2, message: 'worker-failed' }
const ELEMENT_ERROR = { level: 'element', slideNumber: 1, selector: '.chart', message: 'pr-fail' }

describe('slide.convert.error の errors 掲載 (#945)', () => {
  it('pipeline が success が偽の結果を返した実行では、その errors を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `errors` のテストです。pipeline が失敗を返した場合に、`reason` が `pptx-convert-failed` で、`errors` にスライド単位のエラーが含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-1.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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

  it('errors 付きの PipelineRuntimeError が発生した実行では、その errors を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `errors` のテストです。要素とスライドのエラーを持つ `PipelineRuntimeError` が発生した場合に、`errors` がその 2 件と一致することを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineRuntimeError('aborted', { errors: [ELEMENT_ERROR, SLIDE_ERROR] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-failed')
    expect(error?.errors).toStrictEqual([ELEMENT_ERROR, SLIDE_ERROR])
  })

  it('errors 付きの PipelineTimeoutError でも、その errors を error イベントに含める', async () => {
    await explains('`slide.convert.error` の `errors` のテストです。スライドのエラーを持つ `PipelineTimeoutError` が発生した場合に、`reason` が `pptx-convert-timeout` で、`errors` がその 1 件になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-3.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(100, { elapsedMs: 100, errors: [SLIDE_ERROR] }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.errors).toStrictEqual([SLIDE_ERROR])
  })

  it('pipeline の成功後に書き出しが失敗した場合も、pipeline が記録した要素のエラーを含める', async () => {
    // 要素エラーは success:true と両立する（スライド単位の失敗のみが success を落とす）。
    // --out がディレクトリだと writer.finish が生の EISDIR Error を投げ、merge-failed へ wrap される。
    await explains('書き出しの失敗時の `errors` のテストです。`--out` がディレクトリで、pipeline が要素のエラーを返した場合に、`reason` が `merge-failed` で、`errors` にその要素のエラーが含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-errors-4-dir')
    mkdirSync(out, { recursive: true })
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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
})

// --- idle timeout の文言 (#1097 F-05) ---
// PipelineTimeoutError.message は「進捗なし」と最終進捗ラベルを埋め込む (errors.ts)。
// convert.ts はこれを SlideConvertRuntimeError に包む。
// 包んだ文言は `pptx convert がタイムアウトしました: ${error.message}`。
// detail = formatError(error) で --json の error イベントへ、そのまま渡す。
// このルートを固定し、退行時の検知を可能にする。

describe('slide.convert.error の detail (idle timeout) (#1097 F-05)', () => {
  it('PipelineTimeoutError の elapsedMs と lastProgress が、detail に「進捗なし」の経過時間と最後の進捗として含まれる', async () => {
    await explains('時間切れのメッセージのテストです。`lastProgress` を持つ `PipelineTimeoutError` の場合に、`detail` へ `no progress for` と `last progress` の行が含まれます。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('error-timeout-detail.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const dependencies = buildPipelineDependencies(stdout, stderr, () => Promise.reject(
      new PipelineTimeoutError(600_000, { elapsedMs: 612_345, lastProgress: 'スライド #7 変換完了' }),
    ))

    await runCommandJson(dependencies, [projectDirectory, '--out', out, '--json'])

    const error = parseEvents(stdout).find(event => event.event === 'slide.convert.error')
    expect(error?.reason).toBe('pptx-convert-timeout')
    expect(error?.detail).toContain('no progress for')
    expect(error?.detail).toContain('last progress: スライド #7 変換完了')
  })
})

// --- キャンセル (#1228) ---
// MCP のキャンセル (signal の abort) で slidev build と pipeline を止め、PPTX を書き出さない。

describe('runSlideConvert のキャンセル (#1228)', () => {
  it('pipeline の実行中に abort すると、pipeline に渡した signal が中止され、PPTX を書き出さずに cancelled で失敗する', async () => {
    await explains('キャンセルのテストです。pipeline の実行中に `abort` した場合は、pipeline が受け取った `signal` が同一で、`reason` が `cancelled` の例外が発生し、PPTX は作成されません。')
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

  it('slidev build の実行中に abort すると、build に signal を渡し、pipeline を起動せずに cancelled で失敗する', async () => {
    await explains('`slidev build` のキャンセルのテストです。build の実行中に `abort` した場合は、`reason` が `cancelled` の例外が発生し、`convert` が呼び出されず、PPTX も作成されないことを確認します。')
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

  it('pipeline がキャンセルに間に合わず完了した場合も、PPTX を書き出さない', async () => {
    await explains('完了後のキャンセルのテストです。pipeline が完了した直後に `abort` した場合は、`reason` が `cancelled` の例外が発生し、PPTX が作成されないことを確認します。')
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

  it('abort 済みの signal で呼び出した場合は、前処理（dist と index.html の削除）も行わず、cancelled で失敗する', async () => {
    await explains('開始前のキャンセルのテストです。`abort` 済みの `signal` を渡した場合に、`reason` が `cancelled` で、`build` が呼ばれず、出力先は作成されません。')
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

  it('pipeline の完了後で結合の直前に abort した場合も、PPTX を書き出さない', async () => {
    await explains('結合の直前のキャンセルのテストです。pipeline の完了後に `abort` した場合は、`reason` が `cancelled` の例外が発生し、PPTX が作成されないことを確認します。')
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

  it('signal を渡さない場合は、従来どおり最後まで完了する', async () => {
    await explains('`signal` を渡さない場合のテストです。`signal` を指定せず実行した場合に、PPTX が作成されることを確認します。')
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
  it('要素のエラーだけで成功した実行でも、その errors を done イベントに含める', async () => {
    await explains('`slide.convert.done` の `errors` のテストです。pipeline が要素のエラーだけを返した場合に、`error` のイベントがなく、PPTX が作成され、`done` の `errors` にそのエラーが含まれることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-1.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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

  it('エラーがない実行でも、done イベントに errors として空の配列を出力する', async () => {
    // 条件付き掲載にすると「フィールドが無い＝エラーなし」と「旧版で観測不能」が同型になる。
    await explains('エラーがない場合の `errors` のテストです。エラーが 0 件の場合に、`slide.convert.done` の `errors` が空の配列になることを確認します。')
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-2.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    await runCommandJson(buildFakeDependencies(stdout, stderr), [projectDirectory, '--out', out, '--json'])

    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.errors).toStrictEqual([])
  })

  it('errors が複数件でも、done イベントにはすべてを含める', async () => {
    // detail 側（formatPipelineErrors）の先頭 3 件丸めを機械可読な errors へ波及させない。
    await explains('`slide.convert.done` の `errors` の件数のテストです。要素のエラーが 2 件ある場合に、`errors` に 2 件がすべて含まれ、先頭 3 件への丸めが行われないことを確認します。')
    const secondElementError = {
      level: 'element',
      slideNumber: 2,
      selector: '.table',
      message: 'pr-fail-2',
    }
    const projectDirectory = makeProjectDirectory(temporaryRoot())
    const out = temporaryRoot('done-errors-3.pptx')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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
  it('cacheDeckMarkdown で書いたデッキを、readCacheDeckBodies が同じ本文の並びに戻す', async () => {
    // 区切り書式（headmatter の終端と `---` の前後空行）を builder と reader が暗黙に
    // 共有している。片方だけ変えると fake worker が空本文で pptx を書き、内容依存性を
    // 失ったまま全テストが green になる。
    await explains('キャッシュの検証用のデッキの往復のテストです。3 枚のデッキを書いて読み込んだ場合と、1 枚に書き換えて読み込んだ場合に、書いた本文の並びと一致することを確認します。')
    const bodies = ['# 表紙', '# 本編\n\n本文が複数行のケース', '# まとめ']
    const project = makeCacheProject(temporaryRoot(), 'deck-roundtrip', bodies)
    expect(readCacheDeckBodies(project)).toStrictEqual(bodies)

    rewriteCacheDeck(project, ['# 1 枚だけ'])
    expect(readCacheDeckBodies(project)).toStrictEqual(['# 1 枚だけ'])
  })

  it('src で分離したデッキの slides.md を、readSourceSeparatedBodies が参照順の本文の並びに戻す', async () => {
    await explains('`src` で分離した検証用のデッキの往復のテストです。`a`・`b` の順と `b`・`a` の順へ書き換えた場合に、参照した順の本文の並びが返ることを確認します。')
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

  it('差分変換の出力は、同じ内容を全変換した出力と、XPath の抽出値の水準で一致する', async () => {
    await explains('出力の同一性のテストです。3 枚のうち 1 枚を変更して差分変換した場合に、変換が `200` の 1 件だけで、全変換の出力と一致することを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    // (B) S を変換 → 1 枚だけ変更して S' → 差分変換（hit + miss 混在）
    const diffProject = makeCacheProject(temporaryRoot(), 'identity-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('identity-warm.pptx')
    const diffOut = temporaryRoot('identity-diff.pptx')
    const warmCalls: number[] = []
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut },
      contentCacheDependencies(diffProject, warmCalls, stdout, stderr),
    )
    expect(warmCalls).toStrictEqual([100, 200, 300])

    rewriteCacheDeck(diffProject, BODIES_AFTER)
    const diffCalls: number[] = []
    const diffSummary = await runSlideConvert(
      diffProject.directory,
      { out: diffOut },
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
      { out: fullOut },
      contentCacheDependencies(fullProject, fullCalls, stdout, stderr),
    )
    expect(fullCalls).toStrictEqual([100, 200, 300])
    expect(fullSummary.cache).toMatchObject({ enabled: true, hits: 0, misses: 3 })

    await expectPptxOutputsEquivalent(fullOut, diffOut, { expectedSlideCount: 3 })
  })

  it('同じテキストの letterSpacing を後勝ちで集約した値は、差分変換でも全変換と同じ値になる', async () => {
    await explains('`letterSpacing` の集約のテストです。3 枚のデッキを差分変換した場合に、`spc` の値が 3 件とも同じで、全変換の値と一致することを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    const diffProject = makeCacheProject(temporaryRoot(), 'spacing-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('spacing-warm.pptx')
    const diffOut = temporaryRoot('spacing-diff.pptx')
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )
    rewriteCacheDeck(diffProject, BODIES_AFTER)
    await runSlideConvert(
      diffProject.directory,
      { out: diffOut },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )

    const fullProject = makeCacheProject(temporaryRoot(), 'spacing-full', BODIES_AFTER)
    const fullOut = temporaryRoot('spacing-full.pptx')
    await runSlideConvert(
      fullProject.directory,
      { out: fullOut },
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

  it('同じテキストの hrefMap を後勝ちで集約した値と、ハイパーリンクの復元も、差分変換で全変換と一致する', async () => {
    await explains('ハイパーリンクの復元のテストです。差分変換でキャッシュに一致したスライドも含めて、リンクが 3 件になり、リンク先が同じ URL で、全変換と一致することを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')

    const diffProject = makeCacheProject(temporaryRoot(), 'href-diff', BODIES_BEFORE)
    const warmOut = temporaryRoot('href-warm.pptx')
    const diffOut = temporaryRoot('href-diff.pptx')
    await runSlideConvert(
      diffProject.directory,
      { out: warmOut },
      contentCacheDependencies(diffProject, [], stdout, stderr),
    )
    rewriteCacheDeck(diffProject, BODIES_AFTER)
    const diffCalls: number[] = []
    await runSlideConvert(
      diffProject.directory,
      { out: diffOut },
      contentCacheDependencies(diffProject, diffCalls, stdout, stderr),
    )
    // hit したスライドの hrefMap は manifest から復元される。ここが 3 件全て miss だと
    // 「復元できている」ことの検証にならない。
    expect(diffCalls).toStrictEqual([200])

    const fullProject = makeCacheProject(temporaryRoot(), 'href-full', BODIES_AFTER)
    const fullOut = temporaryRoot('href-full.pptx')
    await runSlideConvert(
      fullProject.directory,
      { out: fullOut },
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

  it('画像だけのスライドを含むデッキは、スライドごとの退化の検証では失敗し、デッキ全体の退化の検証では成功する', async () => {
    // 実デッキには a:t と xfrm を持たないスライドがあり得る。
    // 外部 pptx モード（T013）で per-slide の退化検証のまま比較すると、出力が正しくても落ちる。
    await explains('退化の検証の強さのテストです。画像だけのスライドを含むデッキを比較した場合に、`degeneracyGate` を指定しない場合は例外が発生し、`deck` を指定した場合は成功することを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const bodies = ['# 表紙', `# ${IMAGE_ONLY_BODY_MARKER}`]
    const left = makeCacheProject(temporaryRoot(), 'gate-left', bodies)
    const right = makeCacheProject(temporaryRoot(), 'gate-right', bodies)
    const leftOut = temporaryRoot('gate-left.pptx')
    const rightOut = temporaryRoot('gate-right.pptx')
    await runSlideConvert(left.directory, { out: leftOut }, contentCacheDependencies(left, [], stdout, stderr))
    await runSlideConvert(right.directory, { out: rightOut }, contentCacheDependencies(right, [], stdout, stderr))

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

  it('比較ヘルパは、内容が異なる 2 つの出力を、不一致として報告する（負の対照）', async () => {
    await explains('比較ヘルパの検出力のテストです。1 枚だけ内容が異なる 2 つの出力を比較した場合に、`slide2.xml` と `image1-s2.png` の差分が報告され、`slide1.xml` の差分が含まれないことを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const left = makeCacheProject(temporaryRoot(), 'control-left', BODIES_AFTER)
    const right = makeCacheProject(temporaryRoot(), 'control-right', ['# 表紙', '# 別内容', '# まとめ'])
    const leftOut = temporaryRoot('control-left.pptx')
    const rightOut = temporaryRoot('control-right.pptx')
    await runSlideConvert(left.directory, { out: leftOut }, contentCacheDependencies(left, [], stdout, stderr))
    await runSlideConvert(right.directory, { out: rightOut }, contentCacheDependencies(right, [], stdout, stderr))

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
  it('末尾にスライドを追加した場合は、既存のスライドがすべてキャッシュに一致し、追加したスライドだけを変換する', async () => {
    await explains('スライドの末尾の追加のテストです。2 枚のデッキに 1 枚を追加した場合に、変換が `300` の 1 件だけで、`invalidated` が `none` になり、出力の並びが追加後の順になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'compose-append', ['# A', '# B'])
    const firstOut = temporaryRoot('append-1.pptx')
    const secondOut = temporaryRoot('append-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# B', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
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

  it('途中にスライドを挿入した場合は、挿入位置以降がキャッシュに一致せず、出力の並びが新しい構成に従う', async () => {
    await explains('スライドの途中への挿入のテストです。2 枚のデッキの間に 1 枚を挿入した場合に、変換が `200` と `300` で、`invalidated` が `partial` になり、出力の並びが挿入後の順になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'compose-insert', ['# A', '# B'])
    const firstOut = temporaryRoot('insert-1.pptx')
    const secondOut = temporaryRoot('insert-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# X', '# B'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
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

  it('スライドを削除した場合は、manifest と cache/ の両方から、削除したスライドの成果物が削除される', async () => {
    await explains('スライドの削除のテストです。3 枚のデッキから 1 枚を削除した場合に、`manifest` の項目が `100` と `200` だけになり、`slide-300.pptx` などのファイルが残らないことを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'compose-delete', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('delete-1.pptx')
    const secondOut = temporaryRoot('delete-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    expect(readdirSync(cacheDirectoryOfProject(project))).toContain('slide-300.pptx')

    rewriteCacheDeck(project, ['# A', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
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
      readOutput(path.join(cacheDirectory, 'manifest.json')),
    ) as { entries: Readonly<Record<string, unknown>> }
    expect(Object.keys(manifest.entries).toSorted(compareStrings)).toStrictEqual(['100', '200'])
    const names = readdirSync(cacheDirectory)
    expect(names).not.toContain('slide-300.pptx')
    expect(names.filter(name => name.startsWith('prerender-slide300-'))).toStrictEqual([])
  })

  it('スライドを並べ替えた場合は、位置の変わったスライドだけキャッシュに一致せず、出力の並びが入れ替わる', async () => {
    await explains('スライドの並べ替えのテストです。3 枚のうち 2 枚を入れ替えた場合に、変換が `200` と `300` で、出力の並びが新しい順になり、全変換の出力と一致することを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'compose-reorder', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('reorder-1.pptx')
    const secondOut = temporaryRoot('reorder-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    rewriteCacheDeck(project, ['# A', '# C', '# B'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
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
      { out: fullOut },
      contentCacheDependencies(fullProject, fullCalls, stdout, stderr),
    )
    expect(fullCalls).toStrictEqual([100, 200, 300])
    await expectPptxOutputsEquivalent(fullOut, secondOut, { expectedSlideCount: 3 })
  })

  it('src で分離したデッキを並べ替えた場合も、位置の変わったスライドだけキャッシュに一致せず、本文は新しい構成に従う', async () => {
    // 実デッキ（テーマを参照する talk-dir）は本文を pages/*.md へ分けた src 分離構成で、
    // slideHash の bodyRaw 側が動く。inline デッキだけでは このルートを通らない。
    await explains('`src` で分離したデッキの並べ替えのテストです。`pages` の参照順を `a`・`c`・`b` に変えた場合は、変換が `200` と `300` になり、出力の本文の並びが新しい順になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
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
      { out: firstOut },
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
      { out: secondOut },
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

  it('clicks 付きのスライドの前に 1 枚挿入した場合は、perStep のキーがずれて、すべてのステップがキャッシュに一致しない', async () => {
    await explains('clicks のステップのキーのテストです。クリックを持つスライドの前へ 1 枚挿入した場合は、キーが `3` と `3/1` へ移り、4 件のステップすべてが `miss` になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'compose-clicks', ['# A', '# B'])
    const firstOut = temporaryRoot('clicks-insert-1.pptx')
    const secondOut = temporaryRoot('clicks-insert-2.pptx')
    const first = await runSlideConvert(
      project.directory,
      { out: firstOut },
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
      { out: secondOut },
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
  it('残るステップの prerender の枚数が減った場合は、参照されなくなった古いファイルが cache/ から削除される', async () => {
    // prune の対象は、スキャン結果から消えた stepIndex だけ。
    // 同じ stepIndex が生き残ったまま枚数だけ減るケースは、removeUnreferencedArtifacts でしか掃除されない。
    // 掃除が無いと prerender の増減を繰り返すたびに cache/ が単調増加する。
    await explains('キャッシュの容量の制御のテストです。2 枚の prerender を持つステップを 1 枚へ変更した場合は、`200` のファイルが 1 枚分へ減り、`100` のファイルが残ることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'prerender-shrink', [
      '# A',
      `# B ${EXTRA_PRERENDER_BODY_MARKER}`,
    ])
    const firstOut = temporaryRoot('prerender-shrink-1.pptx')
    const secondOut = temporaryRoot('prerender-shrink-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
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
      { out: secondOut },
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
  const manifest = JSON.parse(readOutput(manifestPath)) as {
    entries: Readonly<Record<string, unknown>>
  }
  return Object.keys(manifest.entries).toSorted(compareStrings)
}

function manifestBytesOf(project: Readonly<CacheProject>): string {
  return readOutput(path.join(cacheDirectoryOfProject(project), 'manifest.json'))
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
  const text = readOutput(manifestPath)
  const downgraded = text.replace(
    `"schemaVersion": ${String(CACHE_SCHEMA_VERSION)}`,
    () => `"schemaVersion": ${String(OUTDATED_SCHEMA_VERSION)}`,
  )
  // 置換できていなければ manifest の書式が変わっている（テストが版差を再現できていない）。
  expect(downgraded).not.toBe(text)
  writeFileSync(manifestPath, downgraded)
}

describe('slide convert のキャッシュ無効化とフォールバック (T014 / T015)', () => {
  it('スライドの本文が同じでも共有の styles/ が変更された場合は、すべてのステップがキャッシュに一致しない（FR-005）', async () => {
    // 本文由来の slideHash は不変で envHash だけが動くケース。テーマ切替 (F-01) は --theme
    // 引数を材料に取るルートで、デッキ内のファイル内容を材料に取るルートはここでしか通らない。
    await explains('共有のスタイルとキャッシュのテストです。`styles` の内容を変更した場合に、変換が `100` と `200` で、`invalidated` が `all:env` になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'invalidate-shared', ['# A', '# B'])
    const firstOut = temporaryRoot('invalidate-shared-1.pptx')
    const secondOut = temporaryRoot('invalidate-shared-2.pptx')

    const firstCalls: number[] = []
    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, firstCalls, stdout, stderr),
    )
    expect(firstCalls).toStrictEqual([100, 200])

    writeFileSync(sharedStylesPathOf(project.directory), ':root { --cache-test: 2; }\n')
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
      contentCacheDependencies(project, calls, stdout, stderr),
    )

    expect(calls).toStrictEqual([100, 200])
    expect(summary.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'all:env' })
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])
  })

  it('manifest が破損していても、終了コード 0 で PPTX を出力し、警告のうえ manifest を再作成する（FR-006 / SC-004）', async () => {
    // pipeline 層の同ルートは pipeline.test.ts が見ている。ここは CLI 層まで通したときに
    // キャッシュ起因の異常が終了コードへ抜けないこと（contracts/cache-interface.md）を固定する。
    await explains('manifest の破損時の動作のテストです。破損した状態で実行した場合に、終了コードが変わらず、警告が標準エラーへ出力され、`invalidated` が `all:manifest` になることを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'fallback-manifest', ['# A', '# B'])
    const firstOut = temporaryRoot('fallback-manifest-1.pptx')
    const secondOut = temporaryRoot('fallback-manifest-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    corruptManifest(project)

    const calls: number[] = []
    const commandStdout = makeStream('commandStdout')
    const commandStderr = makeStream('commandStderr')
    const command = createConvertRunner(
      () => contentCacheDependencies(project, calls, commandStdout, commandStderr),
    )
    await command.parseAsync([project.directory, '--out', secondOut])

    expect(calls).toStrictEqual([100, 200])
    expect(existsSync(secondOut)).toBe(true)
    expect(commandStderr.chunks.join('')).toContain('cannot read the cache manifest; cleaning existing artifacts and rebuilding')
    expect(parseEvents(commandStdout).at(-1)?.cache).toStrictEqual({ enabled: true, hits: 0, misses: 2, invalidated: 'all:manifest' })
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
    expect(await readSlideMarkers(secondOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])
  })

  it('manifest のスキーマ版が現行と異なる場合は、破損と別の文言で警告し、全件を変換して作り直す', async () => {
    // プラグイン更新後の初回 run が必ず踏むルート。
    // 破損と同じ文言だと、利用者がキャッシュの破損と誤解する（#1070 F-17）。
    await explains('manifest の版の違いのテストです。古い版へ書き換えた場合は、版の違いを示す警告が出力され、`invalidated` が `all:manifest` になり、読み込み失敗の警告は含まれません。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'manifest-outdated', ['# A', '# B'])
    const firstOut = temporaryRoot('manifest-outdated-1.pptx')
    const secondOut = temporaryRoot('manifest-outdated-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    downgradeManifestSchema(project)

    const calls: number[] = []
    const secondStdout = makeStream('secondStdout')
    const secondStderr = makeStream('secondStderr')
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut },
      contentCacheDependencies(project, calls, secondStdout, secondStderr),
    )

    expect(calls).toStrictEqual([100, 200])
    expect(summary.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'all:manifest' })
    const stderrText = secondStderr.chunks.join('')
    expect(stderrText).toContain(
      `cache manifest schema version differs, so it is not used`
      + ` (manifest v${String(OUTDATED_SCHEMA_VERSION)}, current v${String(CACHE_SCHEMA_VERSION)}); cleaning existing artifacts and rebuilding`,
    )
    expect(stderrText).not.toContain('cannot read the cache manifest')
    // 掃除して作り直すため、次の run から再びヒットする状態に戻っている。
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
  })
})

describe('slide convert の --no-cache (T016 / T017)', () => {
  it('キャッシュがある状態でも --no-cache ですべてを変換し、完了時の再構築で、次の実行がすべてキャッシュに一致する', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-04')
    await explains('`--no-cache` のテストです。キャッシュがある状態で指定した場合に、`enabled` が偽で 2 件とも変換され、次の通常の実行は変換が 0 件で `hits` が 2 になることを確認します。')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'no-cache-rebuild', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-warm.pptx')
    const noCacheOut = temporaryRoot('no-cache-run.pptx')
    const afterOut = temporaryRoot('no-cache-after.pptx')

    const warmStdout = makeStream('warmStdout')
    await runSlideConvert(
      project.directory,
      { out: warmOut },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )

    const noCacheCalls: number[] = []
    const noCacheStdout = makeStream('noCacheStdout')
    const command = createConvertRunner(
      () => contentCacheDependencies(project, noCacheCalls, noCacheStdout, stderr),
    )
    await command.parseAsync(
      [project.directory, '--out', noCacheOut, '--no-cache', '--json'],
    )

    // 全ステップ変換される。enabled: false と invalidated: none の組で「無効化を検知したの
    // ではなく読まなかった」ことを表す（キー算出失敗の all:key と区別できる）。
    expect(noCacheCalls).toStrictEqual([100, 200])
    const done = parseEvents(noCacheStdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: false, hits: 0, misses: 2, invalidated: 'none' })
    expect(await readSlideMarkers(noCacheOut)).toStrictEqual([slideMarkerOf('# A'), slideMarkerOf('# B')])

    // 完了時のキャッシュ再構築（FR-007）。読まないだけで保存は動くため、次の通常 run は全ヒット。
    const afterCalls: number[] = []
    const afterStdout = makeStream('afterStdout')
    const after = await runSlideConvert(
      project.directory,
      { out: afterOut },
      contentCacheDependencies(project, afterCalls, afterStdout, stderr),
    )
    expect(afterCalls).toStrictEqual([])
    expect(after.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })
  })

  it('--no-cache で manifest が破損していても、不要になったファイルを掃除して、終了コード 0 で完了する', async () => {
    await explains('`--no-cache` と manifest の破損のテストです。不要な `slide-999.pptx` を残して破損させた場合に、警告が出力され、`999` を含むファイルが削除され、`manifest` が再作成されることを確認します。')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'no-cache-broken', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-broken-1.pptx')
    const noCacheOut = temporaryRoot('no-cache-broken-2.pptx')

    const warmStdout = makeStream('warmStdout')
    await runSlideConvert(
      project.directory,
      { out: warmOut },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )
    // 削除済みスライド相当の残骸。manifest が読めない run では prune の起点が無いため、
    // --no-cache でも孤児掃除が働かないと cache/ に永久残留する（FR-010）。
    const cacheDirectory = cacheDirectoryOfProject(project)
    writeFileSync(path.join(cacheDirectory, 'slide-999.pptx'), 'stale-pptx')
    writeFileSync(path.join(cacheDirectory, 'prerender-slide999-0.png'), 'stale-png')
    corruptManifest(project)

    const calls: number[] = []
    const stdout = makeStream('stdout')
    const commandStderr = makeStream('commandStderr')
    const command = createConvertRunner(
      () => contentCacheDependencies(project, calls, stdout, commandStderr),
    )
    await command.parseAsync([project.directory, '--out', noCacheOut, '--no-cache'])

    expect(calls).toStrictEqual([100, 200])
    expect(existsSync(noCacheOut)).toBe(true)
    // manifest 破損は all:manifest だが、判定していない run では種別を報告しない。
    expect(parseEvents(stdout).at(-1)?.cache).toMatchObject({ enabled: false, invalidated: 'none' })
    expect(commandStderr.chunks.join('')).toContain('cannot read the cache manifest; cleaning existing artifacts and rebuilding')
    expect(readdirSync(cacheDirectory).some(name => name.includes('999'))).toBe(false)
    expect(manifestEntryKeysOf(project)).toStrictEqual(['100', '200'])
  })

  it('キーの算出に失敗した場合は、all:key を報告し、manifest を更新しない', async () => {
    // --no-cache とキー算出失敗が重なると保存側も動かないため、完了時のキャッシュ再構築は
    // 成立しない（既知の限界）。manifest が warm run のまま据え置かれることで固定する。
    await explains('`--no-cache` とキーの算出の失敗のテストです。バンドルを読み込めない状態の場合に、`invalidated` が `all:key` で、`manifest` の内容が実行前と一致することを確認します。')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'no-cache-keyfail', ['# A', '# B'])
    const warmOut = temporaryRoot('no-cache-keyfail-1.pptx')
    const noCacheOut = temporaryRoot('no-cache-keyfail-2.pptx')

    const warmStdout = makeStream('warmStdout')
    await runSlideConvert(
      project.directory,
      { out: warmOut },
      contentCacheDependencies(project, [], warmStdout, stderr),
    )
    const manifestBefore = manifestBytesOf(project)

    // dom-to-pptx.bundle.js を読めなくするとキー算出が bundle-unreadable で失敗する。
    rmSync(project.bundlePath, { force: true })
    const calls: number[] = []
    const stdout = makeStream('stdout')
    const command = createConvertRunner(() => contentCacheDependencies(project, calls, stdout, stderr))
    await command.parseAsync(
      [project.directory, '--out', noCacheOut, '--no-cache', '--json'],
    )

    expect(calls).toStrictEqual([100, 200])
    const done = parseEvents(stdout).find(event => event.event === 'slide.convert.done')
    expect(done?.cache).toStrictEqual({ enabled: false, hits: 0, misses: 2, invalidated: 'all:key' })
    expect(manifestBytesOf(project)).toBe(manifestBefore)
  })

  it('スライドを削除して再変換すると、古いスライドの成果物と manifest の項目が残らない（FR-010）', async () => {
    // hit 判定を飛ばしても prune の起点として前回 manifest は読む、という設計をここで固定する。
    // previous を読まない実装にすると、このテストだけが落ちる。
    await explains('`--no-cache` でのスライドの削除のテストです。3 枚のデッキから 1 枚を削除して `cache: false` で実行した場合に、`manifest` の項目が `100` と `200` だけになり、`slide-300.pptx` が残らないことを確認します。')
    const stdout = makeStream('stdout')
    const stderr = makeStream('stderr')
    const project = makeCacheProject(temporaryRoot(), 'no-cache-delete', ['# A', '# B', '# C'])
    const firstOut = temporaryRoot('no-cache-delete-1.pptx')
    const secondOut = temporaryRoot('no-cache-delete-2.pptx')

    await runSlideConvert(
      project.directory,
      { out: firstOut },
      contentCacheDependencies(project, [], stdout, stderr),
    )
    expect(readdirSync(cacheDirectoryOfProject(project))).toContain('slide-300.pptx')

    rewriteCacheDeck(project, ['# A', '# C'])
    const calls: number[] = []
    const summary = await runSlideConvert(
      project.directory,
      { out: secondOut, cache: false },
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
    { out },
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

  it('animation-policy.json の keepTimingSteps に含まれる stepIndex だけ、p:timing を残す', async () => {
    await explains('アニメーションの方針のテストです。`keepTimingSteps` が `100` だけの場合に、`slide1.xml` の `p:timing` が 1 件、`slide2.xml` が 0 件になり、`bldLst` も除去されることを確認します。')
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

  it('animation-policy.json が存在しない場合は、すべてのスライドの p:timing を除去する', async () => {
    await explains('アニメーションの方針がない場合のテストです。`animation-policy.json` が存在しない場合に、`animationTimingRemovedSlides` が 2 で、2 枚とも `p:timing` が 0 件になることを確認します。')
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
  ])('animation-policy.json の内容（%s）が不正な場合は、invalid-staging-json の例外が発生する', async (_name, policyText) => {
    await explains('アニメーションの方針の検証のテストです。内容が不正な JSON などの場合に、`reason` が `invalid-staging-json` の例外が発生することを確認します。')
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
    { out },
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
  it('slide-<数字>.pptx の形式に合わない名前のファイルは、結合の入力に含めない', async () => {
    await explains('結合の入力のファイル名のテストです。`slide-1.pptx` と、形式に合わない 4 つの名前のファイルを置いた場合に、出力のスライドが 1 枚だけになることを確認します。')
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

  it('形式に合う名前のファイルが 1 つも存在しない場合は、結合の入力が 0 件として、pptx-convert-failed で失敗する', async () => {
    await explains('結合の入力が 0 件の場合のテストです。`slide-<数字>.pptx` の形式に合わないファイルだけがある場合に、`reason` が `pptx-convert-failed` の例外が発生することを確認します。')
    const out = temporaryRoot('decoy-names-only.pptx')
    await expect(runConvertWithSlideNames(out, ['slide-abc.pptx', 'other-1.pptx']))
      .rejects.toMatchObject({ reason: 'pptx-convert-failed' })
  })
})
