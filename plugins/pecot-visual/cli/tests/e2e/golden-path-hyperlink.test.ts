// Phase 2 受け入れ条件 (d): --force 再生成 + hyperlink 包括ケース。
// xpath-cases.yml の 4 case を、create → convert を通した最終出力へ当てる XPath 定義として流用する。
// 期待値は project 依存で固定できないため、閾値だけここで与える。
//
// 同じ受け入れ条件の他 CUJ は別ファイルで並列に動く。
// 別ファイルは golden-path-create-convert.test.ts / golden-path-default-out.test.ts。
// もう 1 本は golden-path-errors.test.ts。
//
// duration ceiling / timeout 階層 (#506)。
//   - it(..., 660_000) ≥ vitest.testTimeout 660_000 > runPecotv spawnSync 600_000。
//   - runPecotv spawnSync 600_000 ≥ cli 内部 SLIDEV_BUILD_TIMEOUT_MS (600_000)。
//   - Chromium cache 不在時は describe ごと skip する。install は golden-path-create-convert が担う。

/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import {
  assertCliBuilt,
  createPecotvRunner,
  isChromiumCached,
  lastEvent,
  createFixtureThemeSpec,
} from '../_helpers/pecotv-e2e-run.js'
import { aggregateCount, extractFromPptx } from '../_helpers/xpath-extract.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { FIXTURE_THEMES } from '../_helpers/theme-fixtures.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const XPATH_CASES = path.join(CLI_TS_ROOT, 'tests', 'e2e', 'xpath-cases.yml')

// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、本 CUJ 最悪は 10.0s。
// これにマージン倍率 4.4 倍（44.0s）を取り、45s へ切り上げる。
// hang regression を SIGTERM kill (600s) より手前で落とす目的。
const DURATION_CEILING_MS = 45_000

interface XPathCase {
  readonly id: string
  readonly description: string
  readonly parts: readonly string[]
  readonly xpath: string
  readonly extract: string
}

interface CaseFile {
  readonly namespaces: Readonly<Record<string, string>>
  readonly cases: readonly XPathCase[]
}

const temporaryRoot = useTemporaryDirectory('pecotv-e2e-hyperlink-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'golden-path/hyperlink',
  isUnexpectedExit: status => status !== 0,
})

/**
fixture テーマの宣言（pecot-theme.json）の pptx.eastAsianFont。期待値は宣言から取る。
*/
function declaredEastAsianFont(): string {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  const declaration = JSON.parse(readFileSync(path.join(FIXTURE_THEMES, 'with-declaration', 'pecot-theme.json'), 'utf8')) as { pptx?: { eastAsianFont?: string } }
  const font = declaration.pptx?.eastAsianFont
  if (font === undefined) throw new Error('fixture テーマの宣言に pptx.eastAsianFont が無い')
  return font
}

function loadCases(): CaseFile {
  // eslint-disable-next-line no-restricted-syntax -- YAML parse 結果を既知の構造へ narrowing
  return parseYaml(readFileSync(XPATH_CASES, 'utf8')) as CaseFile
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ 2: --force 再生成 + hyperlink 包括', () => {
  it('link layout に hyperlink を追加し、--force で再生成 → convert', async () => {
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj2')
    const pptxOut = temporaryRoot('cuj2.pptx')

    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme-cuj2'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)

    // fixture テーマの link layout を直接書き込んで slides.md に include する。
    // cover layout は frontmatter slot のみで、markdown 末尾の `[Spec](url)` を render しない。
    // そのため hyperlink が生成されない (#506 で発覚)。
    // link layout は `cards[].url` を <a href> として render するため、確実に hyperlink を含む PPTX を得られる。
    //
    // YAML literal は文字列配列 .join('\n') で組み立てる (fixture として読みやすさ優先)。
    // 値に YAML 特殊文字 (`:` `#` `'`) を入れる場合は yaml.stringify を使うこと。
    // 現状の `cards[].url` は `'` を含まない前提 (含む場合は `''` で escape が必要)。
    const linkPagePath = path.join(projectDirectory, 'pages', 'link.md')
    const slidesMdPath = path.join(projectDirectory, 'slides.md')
    const linkFrontmatter = [
      '---',
      'layout: link',
      'heading: \'関連リソース\'',
      'cards:',
      '  - title: \'Spec\'',
      '    description: \'spec link\'',
      '    url: \'https://example.com\'',
      '  - title: \'Repo\'',
      '    description: \'repository link\'',
      '    url: \'https://example.org\'',
      '---',
      '',
    ].join('\n')
    const linkIncludeBlock = '\n---\nsrc: ./pages/link.md\n---\n'
    const writeLinkFixture = (): void => {
      // `--force` で `slide create` が動くと、project 全体がテーマから再生成される。
      // そのため CUJ 2 fixture (link.md / slides.md include) を再投入する必要がある。
      writeFileSync(linkPagePath, linkFrontmatter)
      writeFileSync(slidesMdPath, readFileSync(slidesMdPath, 'utf8') + linkIncludeBlock)
    }

    // --force 再生成。`writeLinkFixture()` は再生成後に呼び、テーマからの再生成を通り抜けさせる。
    // 再生成前に書いても --force で消されるため、fixture は再生成後 1 回だけ書く。
    expect(runPecotv('create-force', ['slide', 'create', projectDirectory, '--theme', themeSpec, '--force']).status).toBe(0)
    writeLinkFixture()

    // convert (--json で slide.convert.done event を確認するため)
    const convert = runPecotv('convert', ['slide', 'convert', projectDirectory, '--out', pptxOut, '--json'])
    expect(convert.status).toBe(0)
    expect(lastEvent(convert.stdout, 'slide.convert.done')).toBeDefined()

    // fixture テーマ + link layout で hyperlink / font-fix / transition の痕跡を assert する。
    // 期待値は動的に組み立てた project 依存で固定できないため、xpath-cases.yml からは
    // part glob / xpath / extract のみを取り、閾値はここで与える。
    //
    // 以降 4 件はいずれも create → convert を通した最終出力に対する assert。
    // font-fix / hyperlink / transition は convert が内部で適用する。
    const cases = loadCases()

    // font-fix: 日本語テキストの East Asian フォントが、テーマの宣言（pptx.eastAsianFont）に置換されていること
    const fontCase = cases.cases.find(c => c.id === 'east-asian-declared-font')
    if (fontCase === undefined) throw new Error('xpath-cases.yml に east-asian-declared-font が無い')
    const fontValues = await extractFromPptx(
      pptxOut,
      fontCase.parts,
      fontCase.xpath.replace('{{eastAsianFont}}', () => declaredEastAsianFont()),
      fontCase.extract,
      cases.namespaces,
    )
    expect(aggregateCount(fontValues)).toBeGreaterThanOrEqual(1)

    // hyperlink (rels): link layout の url が、パイプライン出力に格納される。
    // 格納先は ppt/slides/_rels/slide*.xml.rels で、hyperlink Relationship として入る。
    // named-hyperlink-rel-target-named ケースの定義で、rels の part を走査する。
    const relationshipTargetCase = cases.cases.find(c => c.id === 'named-hyperlink-rel-target-named')
    if (relationshipTargetCase === undefined) throw new Error('xpath-cases.yml に named-hyperlink-rel-target-named が無い')
    const relationshipTargets = await extractFromPptx(
      pptxOut,
      relationshipTargetCase.parts,
      relationshipTargetCase.xpath,
      relationshipTargetCase.extract,
      cases.namespaces,
    )
    // extractFromPptx は ExtractedValue[] を返し、attr:Target なら value は string[]
    const flatUrls: string[] = []
    for (const v of relationshipTargets) {
      if (Array.isArray(v.value)) {
        for (const s of v.value) flatUrls.push(String(s))
      }
    }
    expect(flatUrls.some(u => u.startsWith('https://example.'))).toBe(true)

    // hyperlink (click count): slide XML 側にも a:hlinkClick 要素が存在することを確認する。
    // パイプラインの hyperlink の流れを rels Target + click count の 2 軸で守る。
    const hlinkClickCountCase = cases.cases.find(c => c.id === 'named-hyperlink-hlink-click-count')
    if (hlinkClickCountCase === undefined) throw new Error('xpath-cases.yml に named-hyperlink-hlink-click-count が無い')
    const hlinkClickValues = await extractFromPptx(
      pptxOut,
      hlinkClickCountCase.parts,
      hlinkClickCountCase.xpath,
      hlinkClickCountCase.extract,
      cases.namespaces,
    )
    expect(aggregateCount(hlinkClickValues)).toBeGreaterThanOrEqual(1)

    // transition: fade default のため transition-type-morph-presence (p159:morph count) は 0 件。
    // morph option 利用時は >0 になるが、本 CUJ は fade default で convert している。
    const transitionCase = cases.cases.find(c => c.id === 'transition-type-morph-presence')
    if (transitionCase === undefined) throw new Error('xpath-cases.yml に transition-type-morph-presence が無い')
    const transitionValues = await extractFromPptx(
      pptxOut,
      transitionCase.parts,
      transitionCase.xpath,
      transitionCase.extract,
      cases.namespaces,
    )
    expect(aggregateCount(transitionValues)).toBe(0)

    expect(performance.now() - itT0).toBeLessThan(DURATION_CEILING_MS)
  }, 660_000)
})
