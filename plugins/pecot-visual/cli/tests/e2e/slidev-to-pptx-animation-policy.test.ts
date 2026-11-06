// #1070: 「明示指定のアニメーションだけ通し、装飾は p:timing ごと落とす」方針の機械検証。
//
// unit では `window.domToPptx` を fake に差し替えているため、明示指定が実ライブラリの
// アニメーションとして出るか・装飾が確かに p:timing を生むかは通らない。ここは実 slidev
// build + 実 Chromium + 実 dom-to-pptx を通した出力だけを見る。
//
// deck の並びが主張の中心。
//   スライド 1 = cover（アニメーション無し）。
//   スライド 2 = section（fixture テーマの装飾 CSS animation のみ。明示指定は無い）。
//   スライド 3 = 混在ページ（明示指定 3 要素 + 装飾 1 要素）。
//   スライド 4 = end。
// スライド 2 では装飾が除去されること、スライド 3 では明示指定の効果が残ることを、
// 同じ 1 回の変換から確かめる。粒度はスライド単位なので、スライド 3 では装飾分の効果も残る。
//
// 末尾で `--no-cache` を外した 2 回目の変換を回し、キャッシュ経由でも判定が復元されることを
// 見る（2 回目は phase 1 が全ヒットで Chromium を起動しない）。
//
// #1147: 既定（1 パス方式）と `--no-single-pass`（現行の方式）の両方で同じ主張を見る。現行の方式は
// 未同期 deck・`--only`・1 パス方式の退避先として残るため、既定 on の後も実ブラウザで通す。
// キャッシュの envHash は変換方式ごとに分かれるため、2 回目の変換も 1 回目と同じ方式の引数で実行する。
//
// timeout の階層は golden-path-create-convert.test.ts と同じ。
// it 引数 = vitest.e2e.config.ts の testTimeout は 660_000 で、runPecotv spawnSync の 600_000 より大きい。
// spawnSync の 600_000 は cli 内部の SLIDEV_BUILD_TIMEOUT_MS と同じ値。
// it の末尾で wall clock < TWO_CONVERT_CEILING_MS を assert する。
// 2 回変換する cache-warning-cleanup-failure.test.ts と同じ作法。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { XmlDocument } from '../../src/domain/_shared/ports.js'
import { assertCliBuilt, createPecotvRunner, isChromiumCached, lastEvent, createFixtureThemeSpec } from '../_helpers/pecotv-e2e-run.js'
import { parsePart } from '../_helpers/ooxml-parts.js'
import { expectConvertRouteFromEnvironment } from '../_helpers/single-pass-route.js'
import { readZipEntries } from '../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// 性能目標ではない。
// 並列で測定した（vitest.e2e.config.ts の maxWorkers 構成で全 24 ファイルを同時実行、3 run）。
// 結果、本 CUJ は 10.7s / 10.8s / 11.8s だった。
// 最悪 11.8s に他ファイルと同じ
// マージン倍率 4.4 倍（51.9s）を取り、55s へ切り上げる。
// 2 回目はキャッシュ全ヒットのはず。
// 何も知らせず全 miss になると 2 回目が 1 回目と同じ所要時間になるため、
// この上限は (e) の cache payload assert を所要時間の側からも支える。
const TWO_CONVERT_CEILING_MS = durationCeilingMs(55_000)

/**
presentationml 側の prefix。ooxml-parts の OOXML_NS は xlsx 用で p: を持たない。
*/
const PPTX_NS: Readonly<Record<string, string>> = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
}

const SECTION_SLIDE_PART = 'ppt/slides/slide2.xml'
const MIXED_SLIDE_PART = 'ppt/slides/slide3.xml'

/**
単一スライド pptx（staging）のスライドパーツ。merge 前は必ず 1 枚目だけを持つ。
*/
const SINGLE_SLIDE_PART = 'ppt/slides/slide1.xml'

/**
除去前の section スライドを読むための staging 出力。
ファイル名は `<slidePrefix><stepIndex>.pptx`。
stepIndex は v-click 無しのとき `slideNumber * 100`（step-index.ts）。
section はデッキ 2 枚目なので 200。
*/
const SECTION_STAGING_PPTX = path.join('pptx', 'slides', 'slide-200.pptx')

/**
デッキのステップ数（cover / section / 混在 / end の 4 枚、v-click 無し）。
*/
const STEP_COUNT = 4

/**
section.md に書く文言。除去後もテキスト図形が残ることの実データ。
*/
const SECTION_TITLE = 'はじめに'
const SECTION_DESCRIPTION = '背景と目的を共有します'
const SECTION_PAGE = `---\nlayout: section\nheading: ${SECTION_TITLE}\ndescription: ${SECTION_DESCRIPTION}\n---\n`

/**
混在ページの本文。`layout:` を省略して Slidev 組み込みの default レイアウトを使い、
明示指定 3 要素と装飾 1 要素を同居させる。

装飾側は fill-mode を指定しない CSS animation にする。
fixture テーマの section では、アクセント線の fill-mode が `forwards`、見出しと説明の fill-mode が `both`。
こちらは最終状態を保持しない素の装飾にする。
*/
const MIXED_PAGE_BODY = `
<div data-pptx-animation="zoom-in" data-pptx-animation-duration="600">明示クリック</div>

<div data-pptx-animation="zoom-in" data-pptx-animation-duration="600" class="animate-trigger-with">明示同時</div>

<div data-pptx-animation="fly-in" data-pptx-animation-duration="600" class="animate-trigger-after">明示連続</div>

<div class="decoration-only">装飾</div>

<style>
.decoration-only {
  animation: decoration-fade 0.6s ease;
}
@keyframes decoration-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
`

const temporaryRoot = useTemporaryDirectory('pecotv-animation-policy-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'animation-policy',
  // 本ファイルは全ステップが exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

/**
`slide create` が置いた slides.md を、本ファイルの 4 枚構成へ組み直す。

headmatter（theme / title）はそのまま残し、`src:` の指す先と後続のスライドだけを差し替える。
*/
function animationPolicyDeck(original: string): string {
  const lines = original.split('\n')
  const closingIndex = lines.indexOf('---', 1)
  if (closingIndex === -1 || lines[0] !== '---') {
    throw new Error(`slides.md の headmatter を特定できません:\n${original.slice(0, 200)}`)
  }
  const headmatter = lines
    .slice(0, closingIndex + 1)
    .map(line => (line.startsWith('src:') ? 'src: ./pages/cover.md' : line))
  return [
    ...headmatter,
    '',
    '---',
    'src: ./pages/section.md',
    '---',
    '',
    '---',
    'title: 明示と装飾の混在',
    '---',
    MIXED_PAGE_BODY,
    '---',
    'src: ./pages/end.md',
    '---',
    '',
  ].join('\n')
}

/**
`p:timing` に載った出現エフェクトを出現順に平坦化する。

3 段構造になっている。
mainSeq の直下の `p:par` が click group（クリック 1 回分）。
その配下の `p:par` が同時発火グループ。
さらにその配下の `p:cTn[@presetID]` が個々の効果。
`animate-trigger-with` は同時発火グループを共有する。
`animate-trigger-after` は遅延付きの新しい同時発火グループになる。
そのため両者の違いは index にしか出ない。
*/
interface EffectRow {
  readonly presetID: string
  readonly presetSubtype: string
  readonly nodeType: string
  /**
  何回目のクリックで動くか（mainSeq 直下の par の 0 始まり index）
  */
  readonly clickGroupIndex: number
  /**
  同時発火グループの通し番号（同じ値なら同時に動く）
  */
  readonly triggerGroupIndex: number
  /**
  click group の発火条件 `p:cond/@delay`
  */
  readonly clickDelay: string
  /**
  同時発火グループの `p:cond/@delay`（afterEffect では前段の尺が入る）
  */
  readonly triggerDelay: string
}

function effectRowsOf(slide: Readonly<XmlDocument>): readonly EffectRow[] {
  const clickGroups = slide.selectNodes(
    '/p:sld/p:timing//p:seq/p:cTn[@nodeType=\'mainSeq\']/p:childTnLst/p:par',
    PPTX_NS,
  )
  const rows: EffectRow[] = []
  let triggerGroupIndex = -1
  for (const [clickGroupIndex, clickGroup] of clickGroups.entries()) {
    const clickDelay = clickGroup
      .selectNodes('./p:cTn/p:stCondLst/p:cond', PPTX_NS)[0]?.getAttr('delay') ?? ''
    for (const triggerGroup of clickGroup.selectNodes('./p:cTn/p:childTnLst/p:par', PPTX_NS)) {
      triggerGroupIndex += 1
      const triggerDelay = triggerGroup
        .selectNodes('./p:cTn/p:stCondLst/p:cond', PPTX_NS)[0]?.getAttr('delay') ?? ''
      for (const effect of triggerGroup.selectNodes('./p:cTn/p:childTnLst/p:par/p:cTn', PPTX_NS)) {
        rows.push({
          presetID: effect.getAttr('presetID') ?? '',
          presetSubtype: effect.getAttr('presetSubtype') ?? '',
          nodeType: effect.getAttr('nodeType') ?? '',
          clickGroupIndex,
          triggerGroupIndex,
          clickDelay,
          triggerDelay,
        })
      }
    }
  }
  return rows
}

/**
混在ページで固定する 4 効果。
上から順に次のとおり。
zoom-in（クリック）。
zoom-in + animate-trigger-with（同時）。
fly-in + animate-trigger-after（前段の 600ms 後）。
装飾（別クリック）。

`presetID` / `presetSubtype` は dom-to-pptx 2.1.1 を実際に動かして得た値をそのまま pin したもの。
効果名から preset への対応は pecotv 側には無く、上流 `src/animations/xml-templates.js` の
`PRESETS` が唯一の定義元になる。
よってこの 2 値だけが失敗した場合は、pecotv の退行ではない。
原因は上流の効果マッピング変更の可能性が高い。
その場合は依存を上げたバージョンの `PRESETS` と比べて値を更新する。
pecotv の退行なら、効果の件数・順序・nodeType・delay 側も一緒に崩れる。
*/
const EXPECTED_MIXED_EFFECTS: readonly EffectRow[] = [
  {
    presetID: '23',
    presetSubtype: '16',
    nodeType: 'clickEffect',
    clickGroupIndex: 0,
    triggerGroupIndex: 0,
    clickDelay: 'indefinite',
    triggerDelay: '0',
  },
  {
    presetID: '23',
    presetSubtype: '16',
    nodeType: 'withEffect',
    clickGroupIndex: 0,
    // clickEffect と同じ同時発火グループ = 同一 inner par。
    triggerGroupIndex: 0,
    clickDelay: 'indefinite',
    triggerDelay: '0',
  },
  {
    presetID: '2',
    presetSubtype: '4',
    nodeType: 'afterEffect',
    clickGroupIndex: 0,
    // 新しい同時発火グループ。前段の duration ぶん遅れて動く。
    triggerGroupIndex: 1,
    clickDelay: 'indefinite',
    triggerDelay: '600',
  },
  {
    presetID: '10',
    presetSubtype: '0',
    nodeType: 'clickEffect',
    // 装飾は別 click group。混在スライドなので落とさずに残す。
    clickGroupIndex: 1,
    triggerGroupIndex: 2,
    clickDelay: 'indefinite',
    triggerDelay: '0',
  },
]

function timingCountOf(slide: Readonly<XmlDocument>): number {
  return slide.selectNodes('/p:sld/p:timing', PPTX_NS).length
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
deck を作って 2 回変換し（2 回目はキャッシュ全ヒット）、アニメーションの方針を確かめる。
`name` は作業ディレクトリと出力の名前。
`routeArguments` は両方の変換に渡す変換方式の引数。
`expectRoute` は 1 回目の done payload が示す変換方式の確認。
*/
async function runAnimationPolicyCuj(
  name: string,
  routeArguments: readonly string[],
  expectRoute: (done: ReturnType<typeof lastEvent>) => void,
): Promise<void> {
  const itT0 = performance.now()
  const projectDirectory = temporaryRoot(`${name}-deck`)
  const pptxOut = temporaryRoot(`${name}.pptx`)
  const pptxOutCached = temporaryRoot(`${name}-cached.pptx`)
  // 追跡下の fixture を書き換えないよう、mkdtemp 配下へ `slide create` する。
  // create が plugin-root の node_modules への symlink を張るので、tmp でも build が通る。
  const themeSpec = createFixtureThemeSpec(temporaryRoot(`${name}-theme`))
  expect(runPecotv(`create-${name}`, ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)
  // 文言に依存する assertion のために、section.md を本ファイルの文言で書き直す。
  writeFileSync(path.join(projectDirectory, 'pages', 'section.md'), SECTION_PAGE)

  const slidesMdPath = path.join(projectDirectory, 'slides.md')
  writeFileSync(slidesMdPath, animationPolicyDeck(readFileSync(slidesMdPath, 'utf8')))

  const convert = runPecotv(`convert-${name}`, [
    'slide', 'convert', projectDirectory, '--out', pptxOut, '--json', '--no-cache', ...routeArguments,
  ])
  expect(convert.status).toBe(0)
  // SIGTERM kill との区別。done event が出ていれば pipeline は最後まで実行されている。
  const convertDone = lastEvent(convert.stdout, 'slide.convert.done')
  expect(convertDone).toBeDefined()
  expectRoute(convertDone)

  const entries = await readZipEntries(pptxOut)

  // (a) 装飾のみの section スライドは p:timing を持たない。
  //
  // 陽性対照: 除去前（staging の単一スライド pptx）では同じスライドが p:timing を持つ。
  // これが無いと、fixture テーマの section から装飾 animation が外れた日に
  // 「除去を一度も通らないまま 0 件」でも green になる。同一 run の中間成果物なので
  // 追加の変換費用は無い。
  const sectionStagingPath = path.join(projectDirectory, SECTION_STAGING_PPTX)
  expect(existsSync(sectionStagingPath), `${sectionStagingPath} が無い`).toBe(true)
  const sectionBefore = parsePart(await readZipEntries(sectionStagingPath), SINGLE_SLIDE_PART)
  expect(timingCountOf(sectionBefore)).toBeGreaterThan(0)

  const section = parsePart(entries, SECTION_SLIDE_PART)
  expect(timingCountOf(section)).toBe(0)
  // アニメーション状態はすべて timing の内側にあるので、外側にも残らない。
  for (const xpath of ['//p:bldLst', '//p:animEffect', '//p:set', '//p:seq', '//*[@grpId]']) {
    expect(section.selectNodes(xpath, PPTX_NS), `${xpath} が timing の外に残っている`).toHaveLength(0)
  }

  // (b) 除去は図形に触らない。アクセント線の p:pic と、タイトル・説明文のテキストが残る。
  //
  // 機械で見るのはここまで（p:timing の件数・図形の a:ext が正・テキストの残存）で、
  // 「装飾要素がアニメーション開始状態のまま図形化されていないか」は確認範囲外。
  // 本方式は除去を pptx 後処理だけで行い DOM を一切書き換えないため、図形化の入力となる
  // 描画状態は変更前と同一になる。実デッキ（51 枚）の前後比較でも図形数と xfrm の差は 0 だった。
  // 見た目そのものの合否は目視に委ねる。
  const sectionPictureExtents = section
    .selectNodes('//p:pic//a:ext[@cx]', PPTX_NS)
    .map(node => ({
      cx: Math.trunc(Number(node.getAttr('cx') ?? '0')),
      cy: Math.trunc(Number(node.getAttr('cy') ?? '0')),
    }))
  expect(sectionPictureExtents.length).toBeGreaterThan(0)
  for (const extent of sectionPictureExtents) {
    expect(extent.cx).toBeGreaterThan(0)
    expect(extent.cy).toBeGreaterThan(0)
  }
  const sectionText = section.selectNodes('//a:t', PPTX_NS).map(node => node.text()).join('\n')
  expect(sectionText).toContain(SECTION_TITLE)
  expect(sectionText).toContain(SECTION_DESCRIPTION)

  // (c) 混在スライドは p:timing を 1 件だけ持ち、明示 3 効果 + 装飾 1 効果がこの順で載る。
  const mixed = parsePart(entries, MIXED_SLIDE_PART)
  expect(timingCountOf(mixed)).toBe(1)
  const rows = effectRowsOf(mixed)
  console.info(`[animation-policy:${name}] effects=${JSON.stringify(rows)}`)
  expect(rows).toStrictEqual(EXPECTED_MIXED_EFFECTS)

  // (d) transition の mc:AlternateContent は timing より前に出る。
  //     CT_Slide の sequence は cSld → clrMapOvr → transition → timing。
  const childNames = mixed.selectNodes('/p:sld/*', PPTX_NS).map(node => node.localName())
  const alternateContentIndex = childNames.indexOf('AlternateContent')
  const timingIndex = childNames.indexOf('timing')
  expect(alternateContentIndex).toBeGreaterThanOrEqual(0)
  expect(timingIndex).toBeGreaterThan(alternateContentIndex)

  // (e) キャッシュ経由でも判定が復元される。2 回目は phase 1 が全ヒットで Chromium を
  //     起動せず、明示指定の有無は manifest から読み戻される（載っていないと混在スライドの
  //     timing が何の警告もなく消える）。
  const cachedConvert = runPecotv(`convert-cached-${name}`, [
    'slide', 'convert', projectDirectory, '--out', pptxOutCached, '--json', ...routeArguments,
  ])
  expect(cachedConvert.status).toBe(0)
  const cachedDone = lastEvent(cachedConvert.stdout, 'slide.convert.done')
  expect(cachedDone).toBeDefined()
  // 変換方式ごとの assert: 全ヒットであること。
  // envHash 等の変更でキャッシュが何の警告もなく全 miss になると、この節は 1 回目の再演になり manifest 往復を検証しないまま pass する。
  expect(cachedDone?.cache).toMatchObject({ enabled: true, hits: STEP_COUNT, misses: 0 })

  const cachedEntries = await readZipEntries(pptxOutCached)
  const cachedMixed = parsePart(cachedEntries, MIXED_SLIDE_PART)
  expect(timingCountOf(cachedMixed)).toBe(1)
  expect(effectRowsOf(cachedMixed)).toStrictEqual(rows)
  expect(timingCountOf(parsePart(cachedEntries, SECTION_SLIDE_PART))).toBe(0)

  const totalMs = performance.now() - itT0
  console.info(`[animation-policy:${name}] CUJ 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(TWO_CONVERT_CEILING_MS / 1000)}s)`)
  expect(totalMs).toBeLessThan(TWO_CONVERT_CEILING_MS)
}

describe.skipIf(!isChromiumReady)('CUJ: 明示指定のアニメーションだけが pptx に残る', () => {
  it('装飾のみのスライドから p:timing が消え、混在スライドでは 4 効果が順序どおり残る', async () => {
    expect.hasAssertions()
    // 変換方式の assert（#1147）: 既定は 1 パス方式、PECOTV_SINGLE_PASS=0 なら現行の方式で変換している
    await runAnimationPolicyCuj('animation-policy', [], expectConvertRouteFromEnvironment)
  }, 660_000)

  it('--no-single-pass（現行の方式）でも装飾のみのスライドから p:timing が消え、混在スライドでは 4 効果が順序どおり残る (#1147)', async () => {
    expect.hasAssertions()
    await runAnimationPolicyCuj('animation-policy-per-step', ['--no-single-pass'], (done) => {
      expect(done?.timings).not.toHaveProperty('singlePass')
    })
  }, 660_000)
})
