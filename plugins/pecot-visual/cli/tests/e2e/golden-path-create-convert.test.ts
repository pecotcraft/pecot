// Phase 2 受け入れ条件 (a): 黄金パス（slide create → convert）と中間ファイルの確認。
// `pnpm test:e2e` でのみ起動する重いテスト (実 npx slidev build / Playwright Chromium)。
//
// 同じ受け入れ条件の他 CUJ は、別ファイルで並列に実行される。
// - `--out` 省略時は、golden-path-default-out.test.ts が見る。
// - --force 再生成と hyperlink 包括は、golden-path-hyperlink.test.ts が見る。
// - エラーパスと Python フリーは、golden-path-errors.test.ts が見る。
//
// duration ceiling と timeout 階層 (#506) は次のとおり。
// - it(..., 660_000) は vitest.testTimeout 660_000 以上で、runPecotv spawnSync 600_000 より大きい。
// - spawnSync 600_000 は、cli 内部 SLIDEV_BUILD_TIMEOUT_MS (600_000) 以上。
// - pptx convert 側は、合計時間の上限を持たず「進捗なし 600_000」で打ち切る (#1097)。
// - spawnSync 600_000 が上限として意味を持つのは slidev build のみ。
// - テストデッキは、合計でも spawnSync 上限内に収まる規模である前提。
// - it の末尾で wall clock < DURATION_CEILING_MS を assert する。
// - Chromium cache 不在時は、describe ごと skip する。cold 再ダウンロードは別 path。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertCliBuilt,
  createPecotvRunner,
  isChromiumCached,
  lastEvent,
  createFixtureThemeSpec,
} from '../_helpers/pecotv-e2e-run.js'
import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

// 他 8 ファイルと同じく、runner は bin/pecotv の bootstrap を通さない。
// 本体ツリーの cli/dist を直接実行する。
// bootstrap はデータ置き場の実行用ミラーを作る処理で、その検証は cli/tests/bootstrap/ の CUJ が担う。
// 本 CUJ は、bootstrap 込みの計測から 45s の上限を引き継いでいる。
// 計測では最悪が 9.2s で、マージン倍率 4.4 倍は 40.4s。
// 性能目標ではなく、hang regression を SIGTERM kill (600s) より手前で落とすための上限。
const DURATION_CEILING_MS = 45_000

const temporaryRoot = useTemporaryDirectory('pecotv-e2e-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'golden-path/create-convert',
  isUnexpectedExit: status => status !== 0,
})

beforeAll(() => {
  assertCliBuilt()
  // cold 環境で Chromium を整える役割は本ファイルが持つ（分割後の他ファイルは install を
  // 試みない）。install 完了後も下の chromiumReady は解除されない — install 失敗時に
  // hang させないための意図的挙動で、恩恵は次回の warm run が受ける。
  if (!isChromiumCached()) {
    spawnSync('npx', ['playwright', 'install', 'chromium'], {
      stdio: 'inherit',
      timeout: 300_000,
    })
  }
}, 360_000)

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ 1: 黄金パス (slide create → convert)', () => {
  it('quickstart §2 の 3 ステップが 0 終了し、中間ファイルを作り、画像メディアを連番に rename する', async () => {
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj1')
    const pptxOut = temporaryRoot('cuj1.pptx')

    // 1. slide create（build できる fixture テーマを git+file:// で取得する）
    const create = runPecotv('create', ['slide', 'create', projectDirectory, '--theme', createFixtureThemeSpec(temporaryRoot('theme-cuj1')), '--json'])
    expect(create.status).toBe(0)

    // 2. 中間ファイルの確認
    expect(existsSync(path.join(projectDirectory, 'pages', 'cover.md'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'pages', 'section.md'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'pages', 'end.md'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'public', 'slides', 'images'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'public', 'slides', 'diagrams'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'public', 'slides', 'html'))).toBe(true)

    const packageJsonText = readFileSync(path.join(projectDirectory, 'package.json'), 'utf8')
    expect(packageJsonText).not.toMatch(/"eslint[-/]/)
    expect(packageJsonText).not.toMatch(/"prettier[-/]/)

    const slidesMdText = readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')
    expect(slidesMdText).toContain('src: ./pages/cover.md')

    // 2.5. 画像メディアを伴うページを 2 件追加 (section は画像 1 枚を描く)
    const slidesMdPath = path.join(projectDirectory, 'slides.md')
    for (const name of ['media-a', 'media-b']) {
      writeFileSync(
        path.join(projectDirectory, 'pages', `${name}.md`),
        `---\nlayout: section\nheading: 画像のページ ${name}\ndescription: 画像を 1 枚持つ\n---\n`,
      )
    }
    writeFileSync(
      slidesMdPath,
      readFileSync(slidesMdPath, 'utf8')
      + '\n---\nsrc: ./pages/media-a.md\n---\n'
      + '\n---\nsrc: ./pages/media-b.md\n---\n',
    )

    // 3. slide convert
    const convert = runPecotv('convert', ['slide', 'convert', projectDirectory, '--out', pptxOut, '--json'])
    expect(convert.status).toBe(0)
    expect(existsSync(pptxOut)).toBe(true)
    // SIGTERM kill 区別: stdout に slide.convert.done event が出力されていること
    expect(lastEvent(convert.stdout, 'slide.convert.done')).toBeDefined()

    // 4. 画像メディアが <stem>-s<N>.<ext> 形式で rename されていること + slide rels Target rewrite
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(pptxOut)
    try {
      const parts: { name: string, buffer: Buffer }[] = []
      for await (const entry of reader.entries()) {
        parts.push({ name: entry.part, buffer: await entry.read() })
      }
      const mediaEntries = parts
        .map(p => p.name)
        .filter(n => n.startsWith('ppt/media/') && n !== 'ppt/media/')
      const renamed = mediaEntries.filter(n => /\/[^/]+-s\d+\.[a-z0-9]+$/i.test(n))
      // (a) <stem>-s<N>.<ext> 形式が 2 件以上
      expect(renamed.length).toBeGreaterThanOrEqual(2)
      // (b) ppt/media/ 配下の全エントリが rename 済 (生 filename ゼロ)
      expect(renamed.length).toBe(mediaEntries.length)
      // (c) slide rels の Target が rename 後を指す
      const slideRels = parts.filter(p => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(p.name))
      const allRelsXml = slideRels.map(p => p.buffer.toString('utf8')).join('\n')
      expect(allRelsXml).toMatch(/Target="\.\.\/media\/[^"]+-s\d+\.[a-z0-9]+"/i)
    }
    finally {
      await reader.close()
    }
    expect(performance.now() - itT0).toBeLessThan(DURATION_CEILING_MS)
  }, 660_000)
})
