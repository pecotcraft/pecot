// #1062: 書体の自動埋め込みが実ライブラリまで届き、結合後も全スライド分が残ることの機械検証。
//
// unit / integration では `window.domToPptx` を fake に差し替えている。
// そのため、`autoEmbedFonts` が実ライブラリのオプションとして生きているかは確かめられない。
// 埋め込み結果が結合を通過するかも確かめられない。
// ここは実 slidev build + 実 Chromium + 実 dom-to-pptx を通した出力だけを見る。
//
// deck の並びが主張の中心。
//   スライド 1 = end（本文書体の Inter のみ）。
//   スライド 2 = cover（見出しの Noto Sans JP を追加で使う）。
//   スライド 3 = section。
// 結合はスライド 1 を base 構造に採る。
// そのためこの順序では、和集合を作らない実装だと Noto Sans JP が何の警告もなく消える。
// fixture テーマの既定順（cover が 1 枚目）ではスライド 1 が上位集合になり、この退行を捉えられない。
// 2 つの書体は、fixture テーマが public/fonts に同梱する OFL の書体（styles/index.css で @font-face を宣言）。
//
// transition の mc:AlternateContent が p:timing より前に出ることの検証は本ファイルの担当外。
// #1070 で装飾のみのスライドから p:timing を落としたため、section を実データにした主張は
// 恒久的に空振りする。順序の主張は slidev-to-pptx-animation-policy.test.ts が引き継ぐ。
//
// #1147: 既定（1 パス方式）と `--no-single-pass`（現行の方式）の両方で同じ主張を見る。現行の方式は
// 未同期 deck・`--only`・1 パス方式の退避先として残るため、既定 on の後も実ブラウザで通す。
//
// timeout の階層は golden-path-create-convert.test.ts と同じ。
// it 引数 = vitest.e2e.config.ts の testTimeout は 660_000 で、runPecotv spawnSync の 600_000 より大きい。
// spawnSync の 600_000 は cli 内部の SLIDEV_BUILD_TIMEOUT_MS と同じ値。
// wall clock ceiling は置かない（変換 1 回のみで、hang は spawnSync timeout が捕捉する）。

/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertCliBuilt, createPecotvRunner, isChromiumCached, lastEvent, createFixtureThemeSpec } from '../_helpers/pecotv-e2e-run.js'
import { parsePart } from '../_helpers/ooxml-parts.js'
import { expectConvertRouteFromEnvironment } from '../_helpers/single-pass-route.js'
import { readZipEntries } from '../_helpers/zip-entries.js'
import { compareStrings } from '../../src/domain/_shared/compare-strings.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

/**
presentationml / content-types 側の prefix。ooxml-parts の OOXML_NS は xlsx 用で p: を持たない。
*/
const PPTX_NS: Readonly<Record<string, string>> = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
}

/**
`p:embeddedFont` が持ちうる字形要素。1 字形 = `ppt/fonts/*.fntdata` 1 件に対応する。
*/
const FONT_STYLES: readonly string[] = ['regular', 'bold', 'italic', 'boldItalic']

const BODY_TYPEFACE = 'Inter'
const HEADING_TYPEFACE = 'Noto Sans JP'

const temporaryRoot = useTemporaryDirectory('pecotv-embedded-fonts-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'embedded-fonts',
  // 本ファイルは全ステップが exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

/**
`slide create` が置いた slides.md を、書体の少ないページが 1 枚目に来る順序へ組み直す。

headmatter（theme / title）はそのまま残し、`src:` の指す先と後続の include だけを差し替える。
*/
function reorderedDeck(original: string): string {
  const lines = original.split('\n')
  const closingIndex = lines.indexOf('---', 1)
  if (closingIndex === -1 || lines[0] !== '---') {
    throw new Error(`slides.md の headmatter を特定できません:\n${original.slice(0, 200)}`)
  }
  const headmatter = lines
    .slice(0, closingIndex + 1)
    .map(line => (line.startsWith('src:') ? 'src: ./pages/end.md' : line))
  return [
    ...headmatter,
    '',
    '---',
    'src: ./pages/cover.md',
    '---',
    '',
    '---',
    'src: ./pages/section.md',
    '---',
    '',
  ].join('\n')
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する（cold ダウンロードの所要が読めない。
// golden-path-create-convert.test.ts と同じ方針）。
const isChromiumReady = isChromiumCached()

/**
deck を作って変換し、出力の埋め込み書体を確かめる。
`name` は作業ディレクトリと出力の名前。
`routeArguments` は変換方式を決める追加引数。
`expectRoute` は done payload が示す変換方式の確認。
*/
async function convertAndAssertEmbeddedFonts(
  name: string,
  routeArguments: readonly string[],
  expectRoute: (done: ReturnType<typeof lastEvent>) => void,
): Promise<void> {
  const projectDirectory = temporaryRoot(`${name}-deck`)
  const pptxOut = temporaryRoot(`${name}.pptx`)
  // 追跡下の fixture を書き換えないよう、mkdtemp 配下へ `slide create` する。
  // create が plugin-root の node_modules への symlink を張るので、tmp でも build が通る。
  const themeSpec = createFixtureThemeSpec(temporaryRoot(`${name}-theme`))
  expect(runPecotv(`create-${name}`, ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)

  const slidesMdPath = path.join(projectDirectory, 'slides.md')
  writeFileSync(slidesMdPath, reorderedDeck(readFileSync(slidesMdPath, 'utf8')))

  const convert = runPecotv(`convert-${name}`, ['slide', 'convert', projectDirectory, '--out', pptxOut, '--json', ...routeArguments])
  expect(convert.status).toBe(0)
  // SIGTERM kill との区別。done event が出ていれば pipeline は最後まで実行されている。
  const convertDone = lastEvent(convert.stdout, 'slide.convert.done')
  expect(convertDone).toBeDefined()
  expectRoute(convertDone)

  const entries = await readZipEntries(pptxOut)
  const presentation = parsePart(entries, 'ppt/presentation.xml')

  // (a) 和集合: スライド 1 に無い見出し書体も embeddedFontLst に残る。
  const typefaces = presentation
    .selectNodes('/p:presentation/p:embeddedFontLst/p:embeddedFont/p:font', PPTX_NS)
    .map(node => node.getAttr('typeface') ?? '')
  expect(typefaces).toContain(BODY_TYPEFACE)
  expect(typefaces).toContain(HEADING_TYPEFACE)
  // 1 typeface = 1 p:embeddedFont（字形は子要素側）。重複した宣言が無いこと。
  expect(new Set(typefaces).size).toBe(typefaces.length)

  // (b) 字形の宣言数と font part の実数が一致する（採番のずれ・取りこぼしを弾く）。
  const glyphCount = FONT_STYLES
    .map(style => presentation
      .selectNodes(`/p:presentation/p:embeddedFontLst/p:embeddedFont/p:${style}`, PPTX_NS).length)
    .reduce((total, count) => total + count, 0)
  const fontParts = entries.keys().filter(part => part.startsWith('ppt/fonts/')).toArray()
  expect(glyphCount).toBeGreaterThan(0)
  expect(fontParts).toHaveLength(glyphCount)

  // (c) fntdata の Default 宣言は 1 件（base に既存があるときの二重追加を弾く）。
  const contentTypes = parsePart(entries, '[Content_Types].xml')
  const fontDataDefaults = contentTypes
    .selectNodes('//ct:Default', PPTX_NS)
    .filter(node => node.getAttr('Extension') === 'fntdata')
  expect(fontDataDefaults).toHaveLength(1)

  const slideParts = entries.keys()
    .filter(part => /^ppt\/slides\/slide\d+\.xml$/.test(part)).toArray()
    .toSorted(compareStrings)
  expect(slideParts.length).toBeGreaterThanOrEqual(3)

  // 何を見たかを一次情報として残す。
  console.info(
    `[embedded-fonts:${name}] typeface=${typefaces.join(' / ')}`
    + ` glyph=${String(glyphCount)} fontParts=${String(fontParts.length)}`
    + ` fntdataDefault=${String(fontDataDefaults.length)}`
    + ` / slides=${String(slideParts.length)}`,
  )

  // (d) 埋め込みを実際に使わせる宣言が p:presentation に載る（ECMA-376 の既定は false）。
  const presentationRoot = presentation.selectNodes('/p:presentation', PPTX_NS)[0]
  expect(presentationRoot?.getAttr('embedTrueTypeFonts')).toBe('true')
}

describe.skipIf(!isChromiumReady)('CUJ: 書体の少ないページを 1 枚目にした deck で埋め込み書体が残る', () => {
  it('embeddedFontLst に両書体が載り、fntdata の件数と宣言が整合する', async () => {
    expect.hasAssertions()
    // 変換方式の assert（#1147）: 既定は 1 パス方式、PECOTV_SINGLE_PASS=0 なら現行の方式で変換している
    await convertAndAssertEmbeddedFonts('embedded-fonts', [], expectConvertRouteFromEnvironment)
  }, 660_000)

  it('--no-single-pass（現行の方式）でも embeddedFontLst に両書体が載り、fntdata の件数と宣言が整合する (#1147)', async () => {
    expect.hasAssertions()
    await convertAndAssertEmbeddedFonts('embedded-fonts-per-step', ['--no-single-pass'], (done) => {
      expect(done?.timings).not.toHaveProperty('singlePass')
    })
  }, 660_000)
})
