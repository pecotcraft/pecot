// Issue #731 — `pecotv pptx preview` を実 soffice で動かす e2e。
// `pnpm test:e2e` 経由でのみ起動する。
// soffice / pdftotext が最小 PPTX を実際に PDF 化できるかを、変換可能性スモークで確かめ、できなければ skip する。
// command -v soffice だけでは、soffice はあるが変換できない環境で fail するため。
//
// CUJ: 実 soffice で正規化済み PPTX を PDF 化し、findings にスライド番号が付くことを確認する。
// CUJ (#1072): fixture テーマを slide create してから slide convert した実 pptx を、soffice で PDF 化する。
// スライド数と同じページ数になることと、全ページに本文テキストが出ることを確認する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import type { TestContext } from 'vitest'
import { afterAll, describe, expect, it } from 'vitest'
import { ZipFile as YazlZipFile } from 'yazl'

import {
  runPreview,
  type PreviewDependencies,
} from '../../src/commands/pptx-ooxml/preview.js'
import { XmldomXmlEngine } from '../../src/infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import { SofficePdfConverter } from '../../src/infra/pptx-ooxml/soffice.js'
import {
  assertCliBuilt,
  createPecotvRunner,
  isChromiumCached,
  lastEvent,
  createFixtureThemeSpec,
} from '../_helpers/pecotv-e2e-run.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const NS_PRESENTATIONML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const NS_DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main'

// footer fixture の配置。PDF 上の期待 x 位置を導出するため、fixture のリテラルと
// assertion で同じ定数を使う（1pt = 12700 EMU）。lIns は fixture が明示しないので
// a:bodyPr の既定値 91440 EMU (0.1 inch) が適用される。
const EMU_PER_POINT = 12_700
const FOOTER_OFFSET_X_EMU = 457_200
const DEFAULT_LEFT_INSET_EMU = 91_440
const FOOTER_TEXT_LEFT_PT = (FOOTER_OFFSET_X_EMU + DEFAULT_LEFT_INSET_EMU) / EMU_PER_POINT

// 実変換ケース (#1072) の wall clock 上限。
// 計測では、本ファイル単独の 2 run が 8.1s / 8.1s、`pnpm test:e2e` の並列 2 run が 9.0s / 9.4s だった。
// 最悪の 9.4s に、golden-path と同じ考え方のマージン倍率 4 倍強を掛けて、40s とする。
// 性能目標ではなく、hang regression を spawnSync の SIGTERM kill (600s) より手前で落とすための上限。
const DURATION_CEILING_MS = 40_000

/**
実変換ケースの deck。slide create が置く初期ページ（cover・section・end）の順で、見出しを書き直す。
[ファイル名, layout, 見出し]。見出しは ASCII のみ（日本語は埋め込みフォントの ToUnicode 依存で pdftotext 上崩れうる）。
*/
const DECK_PAGES: readonly (readonly [string, string, string])[] = [
  ['cover.md', 'cover', 'PREVIEW COVER'],
  ['section.md', 'section', 'PREVIEW SECTION'],
  ['end.md', 'end', 'PREVIEW END'],
]

const temporaryRoot = useTemporaryDirectory('pecotv-731-preview-', { hook: 'all' })
/**
Chromium cache 不在では、slide convert が cold ダウンロードになり、所要が読めない。
そのため実変換ケースは skip する。
モジュール読み込み時に固定する（本ファイルは install しない）。
*/
const isChromiumReady = isChromiumCached()

const runPecotv = createPecotvRunner({
  logPrefix: 'pptx-preview-soffice/real',
  isUnexpectedExit: status => status !== 0,
})

function isCommandAvailable(command: string): boolean {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  return result.status === 0
}

/**
フッター相当の divergent shape (wrap=none + spAutoFit) を持つ最小 PPTX を生成する。
soffice が render できるよう sldSz / 必須 part を最小限揃える。
*/
function buildMinimalPptx(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new YazlZipFile()
    const presentationXml
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
        + `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>`
        + `<p:sldSz cx="12192000" cy="6858000"/>`
        + `<p:notesSz cx="6858000" cy="9144000"/>`
        + `</p:presentation>`
    const presRels
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
        + `</Relationships>`
    const slideRels
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}"/>`
    const contentTypes
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Types xmlns="${NS_CONTENT_TYPES}">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
        + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        + `</Types>`
    const slideXml
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:a="${NS_DRAWINGML}">`
        + `<p:cSld><p:spTree>`
        + `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
        + `<p:grpSpPr/>`
        + `<p:sp>`
        + `<p:nvSpPr><p:cNvPr id="2" name="footer-copyright"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
        + `<p:spPr><a:xfrm><a:off x="${String(FOOTER_OFFSET_X_EMU)}" y="6000000"/><a:ext cx="6000000" cy="400000"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
        + `<p:txBody><a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr><a:lstStyle/>`
        + `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US"/><a:t>(c) Sample Footer Preview</a:t></a:r></a:p>`
        + `</p:txBody></p:sp>`
        + `</p:spTree></p:cSld></p:sld>`
    const relsContentType
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
        + `<Relationship Id="rIdPres" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>`
        + `</Relationships>`
    zip.addBuffer(Buffer.from(contentTypes, 'utf8'), '[Content_Types].xml')
    zip.addBuffer(Buffer.from(relsContentType, 'utf8'), '_rels/.rels')
    zip.addBuffer(Buffer.from(presentationXml, 'utf8'), 'ppt/presentation.xml')
    zip.addBuffer(Buffer.from(presRels, 'utf8'), 'ppt/_rels/presentation.xml.rels')
    zip.addBuffer(Buffer.from(slideRels, 'utf8'), 'ppt/slides/_rels/slide1.xml.rels')
    zip.addBuffer(Buffer.from(slideXml, 'utf8'), 'ppt/slides/slide1.xml')
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
archive.read は成功する (valid zip) が、soffice が PDF render できない最小 PPTX。
Content_Types は presentation override を宣言する。
しかし presentation.xml が不正な XML のため、soffice は "could not be loaded" と出し、exit 0 で outdir が空になる。
zip として妥当でも、プレゼン本体を読めない PPTX は render されない。
*/
function buildUnrenderablePptx(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new YazlZipFile()
    const contentTypes
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Types xmlns="${NS_CONTENT_TYPES}">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
        + `</Types>`
    const rootRels
      = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
        + `<Relationship Id="rIdPres" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>`
        + `</Relationships>`
    zip.addBuffer(Buffer.from(contentTypes, 'utf8'), '[Content_Types].xml')
    zip.addBuffer(Buffer.from(rootRels, 'utf8'), '_rels/.rels')
    // presentation.xml が破損 XML (タグ未閉じ) → soffice が presentation として load 不可。
    // slide part は無いので preview の正規化対象は 0 件、passthrough のみ。
    zip.addBuffer(Buffer.from('<p:presentation NOT CLOSED', 'utf8'), 'ppt/presentation.xml')
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

function buildDependencies(): PreviewDependencies {
  return {
    archive: new YauzlYazlPptxArchive(),
    engine: new XmldomXmlEngine(),
    pdfConverter: new SofficePdfConverter(),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => Date.now(),
  }
}

/**
soffice が実際に最小 PPTX を PDF 化できるか確認する変換可能性スモーク。
*/
async function canConvertWithSoffice(): Promise<boolean> {
  if (!isCommandAvailable('soffice') || !isCommandAvailable('pdftotext')) return false
  const probeDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-preview-probe-'))
  try {
    const probePptx = path.join(probeDirectory, 'probe.pptx')
    writeFileSync(probePptx, await buildMinimalPptx())
    const outputDirectory = path.join(probeDirectory, 'pdf')
    const result = await new SofficePdfConverter().convertToPdf({
      inputPath: probePptx,
      outputDirectory,
      timeoutMs: 120_000,
    })
    return existsSync(result.pdfPath) && statSync(result.pdfPath).size > 0
  }
  catch {
    return false
  }
  finally {
    rmSync(probeDirectory, { recursive: true, force: true })
  }
}

/**
pdftotext -bbox で対象テキストを含む word の最小 xMin を返す。見つからなければ null。
-bbox は `<word xMin=".." yMin=".." xMax=".." yMax="..">token</word>` を出力する。
*/
function footerXMin(pdfPath: string, needle: string): number | undefined {
  const result = spawnSync('pdftotext', ['-bbox', pdfPath, '-'], { encoding: 'utf8' })
  /* c8 ignore next -- pdftotext 失敗時の防御。probe で usability 確認済のため通常到達しない */
  if (result.status !== 0) return undefined
  const wordRegex
    = /<word xMin="([\d.]+)" yMin="[\d.]+" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g
  let match: RegExpExecArray | null
  let minX: number | undefined
  while ((match = wordRegex.exec(result.stdout)) !== null) {
    const token = match[2] ?? ''
    if (!token.includes(needle)) continue
    const x = Number(match[1] ?? '')
    if (minX === undefined || x < minX) minX = x
  }
  return minX
}

/**
pdftotext 出力を改ページ (\f) で分割してページ本文を返す。probe の gate が
`isCommandAvailable('pdftotext')` なので、ページ数も同じバイナリで数えて gate と使用系を一致させる。
*/
function pdfPages(pdfPath: string): readonly string[] {
  const result = spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' })
  /* c8 ignore next -- pdftotext 失敗時の防御。probe で usability 確認済のため通常到達しない */
  if (result.status !== 0) return []
  const pages = result.stdout.split('\f')
  // pdftotext は最終ページの後にも改ページを置くため、末尾の空要素を落とす。
  while (pages.length > 0 && pages.at(-1) === '') pages.pop()
  return pages
}

/**
字送り由来の空白を畳む（pdftotext は字間の広い run を語ごとに割って出力する）。
*/
function compactWhitespace(text: string): string {
  return text.replaceAll(/\s+/gu, '')
}

/**
pptx の全 part 名を列挙する。
*/
async function listPptxParts(pptxPath: string): Promise<readonly string[]> {
  const reader = await new YauzlYazlPptxArchive().read(pptxPath)
  try {
    const parts: string[] = []
    for await (const entry of reader.entries()) parts.push(entry.part)
    return parts
  }
  finally {
    await reader.close()
  }
}

/**
`ppt/media/` のようなディレクトリ接頭辞に属するファイル part を数える。
*/
function countPartsUnder(parts: readonly string[], prefix: string): number {
  return parts.filter(part => part.startsWith(prefix) && part !== prefix).length
}

/**
soffice が Impress 文書を PDF 化できない環境では、以降を skip する。
console.warn と return で済ませると、pass として計上される。
すると、変換を一度も行っていないことが、集計から読み取れない。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- vitest 側の可変型
function skipWithoutImpressConversion(context: TestContext): void {
  context.skip(
    !isSofficeUsable,
    'soffice が Impress 文書を PDF 化できる環境ではないため skip。'
    + ' `sudo apt-get install -y libreoffice-impress poppler-utils` を実行してから再試行してください。',
  )
}

/**
実変換ケース用。impress と Chromium を 2 段で見て、skip 理由をどちらか読み分けられるようにする。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 同上
function skipWithoutRealConvert(context: TestContext): void {
  skipWithoutImpressConversion(context)
  context.skip(
    !isChromiumReady,
    'Chromium cache 不在のため実変換 pptx を用意できず skip。'
    + ' `npx playwright install chromium` 後に再試行してください。',
  )
}

/**
render 不可 fixture が、環境差で PDF になってしまった場合の mid-test escape。
その環境では soffice-conversion-failed を踏めず、続けても検証にならない。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 同上
function skipWhenFixtureRenders(context: TestContext, probePdfPath: string): void {
  context.skip(
    existsSync(probePdfPath) && statSync(probePdfPath).size > 0,
    'この環境では fixture が PDF render 可能なため soffice-conversion-failed を踏めない',
  )
}

// 判定に soffice を実際に起動するため時間がかかる。ファイルの読み込み時に 1 度だけ行う。
const isSofficeUsable = await canConvertWithSoffice()

afterAll(() => {
  if (temporaryRoot() && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
})

describe('Issue #731 — pecotv pptx preview を実 soffice で動かす', () => {
  it('実 soffice で PDF 生成成功・非空・findings にスライド番号', { timeout: 180_000 }, async (context) => {
    skipWithoutImpressConversion(context)

    const inputPath = temporaryRoot('deck.pptx')
    writeFileSync(inputPath, await buildMinimalPptx())
    const out = temporaryRoot('deck.preview.pdf')

    const summary = await runPreview(inputPath, { out }, buildDependencies())

    expect(summary.findings).toHaveLength(1)
    expect(summary.findings[0]?.slide).toBe(1)
    expect(summary.findings[0]?.rule).toBe('spautofit-wrap-none')
    expect(summary.normalized).toBe(1)
    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(0)
  })

  // 当初は、「補正なし PDF より有意に左へ寄る」差分比較だった。
  // しかし LibreOffice 26.2.5.2 では、補正なしでも footer が箱の左端に描かれるため成立しない。
  // 判別実験では、同 fixture の raw と preview がどちらも xMin 43.087 で一致した。
  // 実デッキの pptx でも、全 82 語の差は最大 0.028pt だった。
  // #731 実装時の前提だった中心基準 auto-size の描画は、LibreOffice の版依存だった。
  // そこで、版に依らず成立する絶対位置（補正後は箱の左端に左揃え）で意図を固定する。
  // 補正なし PDF は assertion に使わないので生成しない。
  it('補正後 footer が箱の左端に左揃えで描画される (退行検知)', { timeout: 180_000 }, async (context) => {
    skipWithoutImpressConversion(context)

    const inputPath = temporaryRoot('shift.pptx')
    writeFileSync(inputPath, await buildMinimalPptx())

    const correctedOut = temporaryRoot('shift.preview.pdf')
    const summary = await runPreview(inputPath, { out: correctedOut }, buildDependencies())
    expect(summary.normalized).toBe(1)
    expect(existsSync(correctedOut)).toBe(true)

    // footer の leftmost token "(c)" の xMin が、shape の左端 + lIns に載ること。
    // 中央寄せ化が復活すれば xMin は箱の中心側へ数十 pt ずれてここで落ちる。
    const correctedXMin = footerXMin(correctedOut, '(c)')
    expect(correctedXMin).toBeDefined()
    /* c8 ignore next -- undefined は上の assertion で fail 済。型 narrowing のための防御 */
    if (correctedXMin === undefined) return

    // 許容 1pt は glyph の左サイドベアリング分の揺れを吸収するための幅。
    expect(Math.abs(correctedXMin - FOOTER_TEXT_LEFT_PT)).toBeLessThan(1)
  })

  it('render 不可な PPTX で soffice-conversion-failed・PDF 未生成 (exit 1 相当)', { timeout: 180_000 }, async (context) => {
    skipWithoutImpressConversion(context)

    const inputPath = temporaryRoot('unrenderable.pptx')
    writeFileSync(inputPath, await buildUnrenderablePptx())

    // 環境差で soffice が PDF を生成できてしまう場合の false fail を避ける。
    // そのため、同 fixture を直接変換して render 可否を確認し、render できる環境なら skip する。
    const probeDirectory = temporaryRoot('unrenderable-probe')
    const probeResult = await new SofficePdfConverter().convertToPdf({
      inputPath,
      outputDirectory: probeDirectory,
      timeoutMs: 120_000,
    })
    skipWhenFixtureRenders(context, probeResult.pdfPath)

    const out = temporaryRoot('unrenderable.preview.pdf')
    let caught: unknown
    try {
      await runPreview(inputPath, { out }, buildDependencies())
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({
      name: 'PreviewRuntimeError',
      reason: 'soffice-conversion-failed',
    })
    expect(existsSync(out)).toBe(false)
  })
})

describe('Issue #1072 — fixture テーマの実変換 pptx の実 soffice 変換', () => {
  it('slide create → convert した pptx が soffice でスライド数と同じページ数の PDF になる', async (context) => {
    skipWithoutRealConvert(context)
    // gating 後にのみ呼ぶ（dist 未ビルドで既存 3 件まで巻き込んで落とさない）。
    assertCliBuilt()
    const itT0 = performance.now()

    const projectDirectory = temporaryRoot('real-deck')
    const pptxOut = temporaryRoot('real-deck.pptx')

    const create = runPecotv('create', ['slide', 'create', projectDirectory, '--theme', createFixtureThemeSpec(temporaryRoot('real-theme')), '--json'])
    expect(create.status).toBe(0)
    // ページごとの ASCII の見出しを deck に書き、PDF の各ページでそれが現れることを見る。
    for (const [file, layout, heading] of DECK_PAGES) {
      writeFileSync(path.join(projectDirectory, 'pages', file), `---\nlayout: ${layout}\nheading: ${heading}\n---\n`)
    }

    const convert = runPecotv('convert', ['slide', 'convert', projectDirectory, '--out', pptxOut, '--json'])
    expect(convert.status).toBe(0)
    expect(lastEvent(convert.stdout, 'slide.convert.done')).toBeDefined()

    // 合成 fixture (buildMinimalPptx: slide 1 / media 0 / fonts 0) と取り違えていないことを
    // 兼ねて見る。スライド枚数は slide create が置く初期ページ（cover・section・end）の数。
    const parts = await listPptxParts(pptxOut)
    const slideCount = parts.filter(part => /^ppt\/slides\/slide\d+\.xml$/.test(part)).length
    expect(slideCount).toBe(DECK_PAGES.length)
    expect(countPartsUnder(parts, 'ppt/media/')).toBeGreaterThanOrEqual(1)
    expect(countPartsUnder(parts, 'ppt/fonts/')).toBeGreaterThanOrEqual(1)

    const pdfOutputDirectory = temporaryRoot('real-pdf')
    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: pptxOut,
      outputDirectory: pdfOutputDirectory,
      timeoutMs: 120_000,
    })
    expect(existsSync(converted.pdfPath)).toBe(true)
    expect(statSync(converted.pdfPath).size).toBeGreaterThan(0)

    // impress 不在だと soffice は exit 0 のまま PDF を出さない。ページ数一致まで見て
    // 「読めているが白紙」「先頭 1 枚だけ」の退行も落とす。
    const pages = pdfPages(converted.pdfPath)
    expect(pages).toHaveLength(slideCount)
    // needle は ASCII のみ（日本語は埋め込みフォントの ToUnicode 依存で pdftotext 上崩れうる）。
    // 実テーマによっては字送りを適用し、pdftotext が字間に空白を挟む。空白を畳んで比べる。
    for (const [index, page] of DECK_PAGES.entries()) {
      const heading = page[2]
      expect(
        compactWhitespace(pages.at(index) ?? ''),
        `PDF ${String(index + 1)} ページ目に見出し ${heading} が現れない`,
      ).toContain(compactWhitespace(heading))
    }

    // skip されると出ない pass マーカー（集計行だけでは実行有無が読めない）。
    console.info(`[pptx-preview-soffice/real] slides=${String(slideCount)} pdfPages=${String(pages.length)}`)
    expect(performance.now() - itT0).toBeLessThan(DURATION_CEILING_MS)
  }, 660_000)
})
