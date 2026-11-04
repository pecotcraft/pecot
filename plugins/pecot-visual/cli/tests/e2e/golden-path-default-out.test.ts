// Phase 2 受け入れ条件 (a) のうち、`--out` を省略した場合。
// 既定の出力パスが slides.md の title 由来で決まることを、実 slidev build / Playwright Chromium を通した変換で見る。
//
// 同じ受け入れ条件の他 CUJ は、別ファイルで並列に実行される。
// 対象は golden-path-create-convert.test.ts、golden-path-hyperlink.test.ts、golden-path-errors.test.ts。
//
// timeout 階層の根拠は、vitest.e2e.config.ts のコメントにある。
// it 引数は testTimeout 660_000 で、runPecotv spawnSync 600_000 より大きい。
// spawnSync 600_000 は、cli 内部の SLIDEV_BUILD_TIMEOUT_MS と同じ。
// Chromium cache 不在時は、describe ごと skip する。
// install は golden-path-create-convert が担う。

/* eslint-disable security/detect-non-literal-fs-filename */
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
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

// vitest.e2e.config.ts の maxWorkers 構成で、並列に計測した。N=6 の 7 run 全体から最悪を取る。
// 本 CUJ の最悪は 8.9s。マージン倍率 4.4 倍（39.2s）を取り、40s へ切り上げる。
// 性能目標ではなく、hang regression を spawnSync の SIGTERM kill (600s) より手前で落とすための上限。
const DURATION_CEILING_MS = 40_000

const temporaryRoot = useTemporaryDirectory('pecotv-e2e-default-out-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'golden-path/default-out',
  isUnexpectedExit: status => status !== 0,
})

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ 1b: --out 省略時', () => {
  it('--out 省略時は slides.md の title 由来の既定パスが生成される', () => {
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj1b')
    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme-cuj1b'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)

    // slide create は frontmatter の title を basename で上書きするため、title 由来と basename
    // 由来の既定名が一致してしまう。title 由来命名が basename fallback を置き換えることを
    // 区別して検証するため、title を basename と異なる値へ書き換えてから変換する。
    const slidesMdPath = path.join(projectDirectory, 'slides.md')
    const expectedTitle = 'E2E タイトル 2026'
    writeFileSync(
      slidesMdPath,
      readFileSync(slidesMdPath, 'utf8').replace(/^title:.*$/m, () => `title: ${expectedTitle}`),
    )

    const convert = runPecotv('convert', ['slide', 'convert', projectDirectory, '--json'])
    expect(convert.status).toBe(0)

    const expectedOut = path.join(projectDirectory, 'pptx', `${expectedTitle}.pptx`)
    expect(existsSync(expectedOut)).toBe(true)
    // done イベントの output も title 由来パスを指す
    expect(lastEvent(convert.stdout, 'slide.convert.done')?.output).toBe(expectedOut)
    // basename 由来の旧既定パスは生成されない
    const legacyOut = path.join(projectDirectory, 'pptx', `${path.basename(projectDirectory)}.pptx`)
    expect(existsSync(legacyOut)).toBe(false)
    expect(performance.now() - itT0).toBeLessThan(DURATION_CEILING_MS)
  }, 660_000)
})
