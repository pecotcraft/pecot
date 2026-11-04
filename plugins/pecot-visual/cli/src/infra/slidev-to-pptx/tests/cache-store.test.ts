// cache-store の実 FS テスト（モックなし）。一時ディレクトリ上に実際のデッキ構成と
// staging / cache ディレクトリを作り、キー算出・成果物の往復・原子性・prune を検証する。
// 失敗注入（rename / copyFile / writeFile）だけ deps 差し替えを使う。
//
// 対象モジュールと同じく、設計上の用語 envHash を使うため name-replacements を disable する。
/* eslint-disable unicorn/name-replacements */

import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCacheManifest, parseCacheManifest, type SlideCacheEntry } from '../../../domain/slidev-to-pptx/cache-manifest.js'
import { defaultExportToPptxOptions } from '../../../domain/slidev-to-pptx/config.js'
import {
  cacheDirectoryOf,
  clearOrphanedCacheArtifacts,
  computeDeckCacheKeys,
  materializeCacheEntry,
  pruneCache,
  readCacheManifest,
  saveSlideToCache,
  writeCacheManifest,
  type DeckCacheKeyOptions,
  type DeckCacheKeys,
} from '../cache-store.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'

const slidesMd = [
  '---',
  'theme: none',
  'title: テストデッキ',
  'canvasWidth: 960',
  'src: ./pages/cover.md',
  '---',
  '',
  '---',
  'src: ./pages/detail.md',
  '---',
  '',
  '---',
  'layout: default',
  '---',
  '',
  '# まとめ',
  '',
].join('\n')

const coverMd = [
  '---',
  'layout: cover',
  'title: 表紙',
  '---',
  '',
  '# 表紙',
  '',
].join('\n')

const detailMd = [
  '---',
  'layout: two-column',
  'title: 詳細',
  '---',
  '',
  '# 詳細ページ',
  '',
].join('\n')

const deckFiles: readonly (readonly [string, string])[] = [
  ['slides.md', slidesMd],
  ['pages/cover.md', coverMd],
  ['pages/detail.md', detailMd],
  ['layouts/cover.vue', '<template><div class="cover" /></template>\n'],
  ['layouts/nested/section.vue', '<template><div class="section" /></template>\n'],
  ['layouts/README.md', 'レイアウトの説明（vue ではないので材料に入らない）\n'],
  ['components/LCodeBlock.vue', '<script setup lang="ts"></script>\n'],
  ['composables/useDeck.ts', 'export const useDeck = () => 1\n'],
  ['utils/format.ts', 'export const format = (v: string) => v\n'],
  ['setup/main.ts', 'export default () => undefined\n'],
  ['styles/index.css', 'body { margin: 0 }\n'],
  ['patches/hy-vue-gantt.patch', 'diff --git a b\n'],
  ['vite.config.ts', 'export default {}\n'],
  ['package.json', '{"name":"deck","version":"0.0.0"}\n'],
]

// テストごとに中身を作り直し、終わったら消す。ディレクトリ自体はファイルで 1 つを使い回す。
const root = await mkdtemp(path.join(tmpdir(), 'pecotv-cache-store-'))
const deckDirectory = path.join(root, 'deck')
const bundlePath = path.join(root, 'lib', 'dom-to-pptx.bundle.js')
const outputDirectory = path.join(deckDirectory, 'pptx')
const cacheDirectory = cacheDirectoryOf(outputDirectory)
const slidesDirectory = path.join(outputDirectory, 'slides')

async function writeInto(base: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(base, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
}

async function buildDeck(
  target: string,
  files: readonly (readonly [string, string])[] = deckFiles,
): Promise<void> {
  for (const [relativePath, content] of files) {
    await writeInto(target, relativePath, content)
  }
}

function keyOptions(overrides: Partial<DeckCacheKeyOptions> = {}): DeckCacheKeyOptions {
  return {
    projectDirectory: deckDirectory,
    slidesPath: path.join(deckDirectory, 'slides.md'),
    domToPptxBundlePath: bundlePath,
    chromiumVersion: '141.0.7390.37',
    pluginVersion: '2.5.0',
    buildOptions: { theme: null },
    exportOptions: defaultExportToPptxOptions,
    route: 'single-pass',
    ...overrides,
  }
}

async function deckKeys(overrides: Partial<DeckCacheKeyOptions> = {}): Promise<DeckCacheKeys> {
  const result = await computeDeckCacheKeys(keyOptions(overrides))
  if (!result.ok) throw new Error(`キー算出に失敗しました: ${result.failure} ${result.message}`)
  return result.keys
}

async function envHashOf(overrides: Partial<DeckCacheKeyOptions> = {}): Promise<string> {
  const keys = await deckKeys(overrides)
  return keys.envHash
}

/**
ディレクトリ内容を名前順で読む（比較を決定論にする）。
*/
async function listDirectory(target: string): Promise<string[]> {
  const names = await readdir(target)
  return names.toSorted(compareStrings)
}

async function isExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  }
  catch {
    return false
  }
}

/**
n 回成功したあと失敗する copyFile 実装（複製途中の中断を作る）。
*/
function copyFailingAfter(successes: number): (source: string, destination: string) => Promise<void> {
  let remaining = successes
  return async (source: string, destination: string) => {
    if (remaining <= 0) throw new Error('copy failed')
    remaining -= 1
    await copyFile(source, destination)
  }
}

/**
slides/ 側に変換成果物（pptx + prerender）が出来ている状態を作る。
*/
async function stageSlideArtifacts(stepIndex: number, prerenderNames: readonly string[] = []): Promise<void> {
  await mkdir(slidesDirectory, { recursive: true })
  await writeFile(path.join(slidesDirectory, `slide-${String(stepIndex)}.pptx`), `pptx-${String(stepIndex)}`)
  for (const name of prerenderNames) {
    await writeFile(path.join(slidesDirectory, name), `data-${name}`)
  }
}

function saveOptions(
  stepIndex: number,
  slideNumber: number,
  clickStep: number | null,
  hasExplicitAnimation = false,
) {
  return {
    cacheDirectory,
    slidesDirectory,
    stepIndex,
    slidePrefix: 'slide-',
    slideHash: `hash-${String(stepIndex)}`,
    slideNumber,
    clickStep,
    letterSpacingMap: { タイトル: { letterSpacing: '-0.02em', fontSize: '32px' } },
    hrefMap: { リンク: 'https://example.com' },
    hasExplicitAnimation,
  }
}

beforeEach(async () => {
  await buildDeck(deckDirectory)
  await writeInto(root, path.join('lib', 'dom-to-pptx.bundle.js'), 'export const VERSION = "1.1.10"\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('@slidev/parser のバージョン固定', () => {
  it('完全固定した版と @slidev/cli が要求する版が一致し、同一実体に解決される', async () => {
    const requireFromHere = createRequire(import.meta.url)
    const ownPackageJson = JSON.parse(
      await readFile(path.join(import.meta.dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
    )
    const pinned = ownPackageJson.dependencies['@slidev/parser']
    const cliPackageJsonPath = requireFromHere.resolve('@slidev/cli/package.json')
    const cliPackageJson = requireFromHere('@slidev/cli/package.json')
    const cliRequires = cliPackageJson.dependencies['@slidev/parser']

    // コメントでしか担保していなかった「@slidev/cli と同じ parser を使う」を実際の解決結果で固定する。
    expect(pinned).toBe(cliRequires)
    expect(requireFromHere('@slidev/parser/package.json').version).toBe(pinned)
    // ビルド側（cli 側）と解析側（本 cli）で、別実体を掴んでいないこと。
    expect(createRequire(cliPackageJsonPath).resolve('@slidev/parser/package.json'))
      .toBe(requireFromHere.resolve('@slidev/parser/package.json'))
  })
})

describe('cacheDirectoryOf', () => {
  it('staging と同じ基準で <outDir>/cache を返す', () => {
    expect(cacheDirectoryOf('/tmp/deck/pptx')).toBe(path.join('/tmp/deck/pptx', 'cache'))
  })
})

describe('computeDeckCacheKeys', () => {
  it('envHash と全スライドの slideHash を返す', async () => {
    const keys = await deckKeys()
    expect(keys.envHash).toMatch(/^[\da-f]{64}$/)
    expect(keys.slideHashes.keys().toArray()).toStrictEqual([1, 2, 3])
  })

  it('同じファイル群なら作成順とディレクトリ位置が違っても同一 envHash になる', async () => {
    const first = await envHashOf()
    const otherDeck = path.join(root, 'deck-reordered')
    await buildDeck(otherDeck, deckFiles.toReversed())
    const second = await envHashOf({
      projectDirectory: otherDeck,
      slidesPath: path.join(otherDeck, 'slides.md'),
    })
    expect(second).toBe(first)
  })

  it('node_modules / dist / pptx 配下は材料に入らない', async () => {
    const before = await envHashOf()
    await writeInto(deckDirectory, 'components/node_modules/pkg/index.ts', 'export const x = 1\n')
    await writeInto(deckDirectory, 'components/dist/bundle.js', 'console.log(1)\n')
    await writeInto(deckDirectory, 'styles/pptx/cache/manifest.json', '{"schemaVersion":1}\n')
    await writeInto(deckDirectory, 'pptx/cache/manifest.json', '{"schemaVersion":1}\n')
    await writeInto(deckDirectory, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    expect(await envHashOf()).toBe(before)
  })

  it('symlink は追わない', async () => {
    const before = await envHashOf()
    const outside = path.join(root, 'outside')
    await writeInto(outside, 'huge.vue', '<template><div /></template>\n')
    await symlink(outside, path.join(deckDirectory, 'components', 'linked'), 'dir')
    await symlink(path.join(outside, 'huge.vue'), path.join(deckDirectory, 'layouts', 'linked.vue'), 'file')
    expect(await envHashOf()).toBe(before)
  })

  it('layouts 配下は *.vue のみ材料にする', async () => {
    const before = await envHashOf()
    await writeInto(deckDirectory, 'layouts/README.md', '説明を書き換えても影響しない\n')
    expect(await envHashOf()).toBe(before)

    await writeInto(deckDirectory, 'layouts/nested/section.vue', '<template><div class="v2" /></template>\n')
    expect(await envHashOf()).not.toBe(before)
  })

  it.each([
    ['components の変更', 'components/LCodeBlock.vue', '<script setup lang="ts">const a = 1</script>\n'],
    ['styles の変更', 'styles/index.css', 'body { margin: 8px }\n'],
    ['patches の変更', 'patches/hy-vue-gantt.patch', 'diff --git c d\n'],
    ['package.json の変更', 'package.json', '{"name":"deck","version":"0.0.1"}\n'],
    ['vite.config.ts の変更', 'vite.config.ts', 'export default { base: "/" }\n'],
    ['デッキ設定（canvasWidth）の変更', 'slides.md', slidesMd.replace('canvasWidth: 960', 'canvasWidth: 1280')],
  ])('%s で envHash が変わる', async (_name, relativePath, content) => {
    const before = await envHashOf()
    await writeInto(deckDirectory, relativePath, content)
    expect(await envHashOf()).not.toBe(before)
  })

  it('共有ファイルの追加で envHash が変わる', async () => {
    const before = await envHashOf()
    await writeInto(deckDirectory, 'components/LNew.vue', '<template><span /></template>\n')
    expect(await envHashOf()).not.toBe(before)
  })

  it('ロックファイル（pnpm-lock.yaml / package-lock.json）の変更で envHash が変わる（依存バージョンドリフト検知）', async () => {
    // package.json はキャレット範囲宣言のため据え置きのまま、ロックファイルの
    // 解決済みバージョンだけが変わるケース（`pnpm install` 相当）を再現する。
    await writeInto(deckDirectory, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\npackages:\n  foo@1.0.0: {}\n')
    const before = await envHashOf()

    await writeInto(deckDirectory, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\npackages:\n  foo@1.1.0: {}\n')
    expect(await envHashOf()).not.toBe(before)
  })

  it('ロックファイルが無くても失敗せず、材料 0 件として扱う', async () => {
    // 無いファイルは材料 0 件として扱う（sha256OfFile の undefined は読み飛ばす）。
    // 存在確認だけで失敗しない。
    const keys = await deckKeys()
    expect(keys.envHash).toMatch(/^[\da-f]{64}$/)
  })

  it('bundle 実体・Chromium バージョン・プラグインバージョンで envHash が変わる', async () => {
    const before = await envHashOf()
    expect(await envHashOf({ chromiumVersion: '142.0.0.1' })).not.toBe(before)
    expect(await envHashOf({ pluginVersion: '2.6.0' })).not.toBe(before)
    // 宣言バージョンは据え置きで実体だけ変える。
    await writeInto(root, path.join('lib', 'dom-to-pptx.bundle.js'), 'export const VERSION = "1.1.10"\nexport const patched = true\n')
    expect(await envHashOf()).not.toBe(before)
  })

  it('--theme の変更で envHash が変わり、同一テーマなら envHash が一致する', async () => {
    // --theme は、slides.md の headmatter と共有クロージャのどちらにも現れない。
    // buildOptions を材料に含めないと、テーマ切替後も旧描画のキャッシュがヒットしてしまう (F-01)。
    const withThemeA = await envHashOf({ buildOptions: { theme: 'theme-a' } })
    const withThemeAAgain = await envHashOf({ buildOptions: { theme: 'theme-a' } })
    const withThemeB = await envHashOf({ buildOptions: { theme: 'theme-b' } })
    const withoutTheme = await envHashOf({ buildOptions: { theme: null } })

    expect(withThemeAAgain).toBe(withThemeA)
    expect(withThemeB).not.toBe(withThemeA)
    expect(withoutTheme).not.toBe(withThemeA)
  })

  it('exportToPptx オプションの変更で envHash が変わり、同一設定なら envHash が一致する', async () => {
    // 疑似要素・フォント埋め込みの設定は、slides.md、共有クロージャ、bundle 実体のどれにも現れない。
    // 材料に含めないと、設定を変えても旧設定で作った pptx がヒットする。
    const base = defaultExportToPptxOptions
    const withDefaults = await envHashOf({ exportOptions: base })
    const withDefaultsAgain = await envHashOf({ exportOptions: { ...base } })
    const withoutPseudo = await envHashOf({ exportOptions: { ...base, includePseudoElements: false } })
    const withFont = await envHashOf({
      exportOptions: { ...base, fonts: [{ name: 'Display Sans', url: 'https://example.invalid/display.woff2' }] },
    })

    expect(withDefaultsAgain).toBe(withDefaults)
    expect(withoutPseudo).not.toBe(withDefaults)
    expect(withFont).not.toBe(withDefaults)
    expect(withFont).not.toBe(withoutPseudo)
  })

  it('変換方式（route）の変更で envHash が変わり、同じ方式なら envHash が一致する (#1147)', async () => {
    const singlePass = await envHashOf({ route: 'single-pass' })
    const singlePassAgain = await envHashOf({ route: 'single-pass' })
    const perStep = await envHashOf({ route: 'per-step' })

    expect(singlePassAgain).toBe(singlePass)
    expect(perStep).not.toBe(singlePass)
  })

  it('表紙の src 差し替えは全キャッシュを無効化せず、スライド 1 だけをミスにする', async () => {
    // headmatter はデッキ設定とスライド 1 の frontmatter を兼ねるため、src のような
    // スライド単位のキーを envHash に含めると表紙の差し替えだけで全変換になってしまう。
    const before = await deckKeys()
    await writeInto(deckDirectory, 'pages/cover2.md', coverMd.replace('# 表紙', '# 新しい表紙'))
    await writeInto(deckDirectory, 'slides.md', slidesMd.replace('src: ./pages/cover.md', 'src: ./pages/cover2.md'))
    const after = await deckKeys()

    expect(after.envHash).toBe(before.envHash)
    expect(after.slideHashes.get(1)).not.toBe(before.slideHashes.get(1))
    expect(after.slideHashes.get(2)).toBe(before.slideHashes.get(2))
    expect(after.slideHashes.get(3)).toBe(before.slideHashes.get(3))
  })

  it('headmatter のスライド単位キー（clicks 等）は envHash に影響しない', async () => {
    const before = await envHashOf()
    await writeInto(deckDirectory, 'slides.md', slidesMd.replace('src: ./pages/cover.md', 'src: ./pages/cover.md\nclicks: 3'))
    expect(await envHashOf()).toBe(before)
  })

  it('デッキ設定として意味を持つキー（テーマ独自キー含む）の変更は全無効化する', async () => {
    // テーマは $slidev.configs.<任意キー> で独自キーを全スライドから読めるため、
    // 未知のキーは材料に残す（allowlist にしない）。
    const before = await envHashOf()
    await writeInto(deckDirectory, 'slides.md', slidesMd.replace('theme: none', 'theme: none\nsensitivity: Example Internal'))
    expect(await envHashOf()).not.toBe(before)
  })

  it('src 分離スライドの本文編集は当該スライドの slideHash だけを変える', async () => {
    const before = await deckKeys()
    await writeInto(deckDirectory, 'pages/detail.md', detailMd.replace('# 詳細ページ', '# 詳細ページ（改訂）'))
    const after = await deckKeys()
    expect(after.envHash).toBe(before.envHash)
    expect(after.slideHashes.get(1)).toBe(before.slideHashes.get(1))
    expect(after.slideHashes.get(2)).not.toBe(before.slideHashes.get(2))
    expect(after.slideHashes.get(3)).toBe(before.slideHashes.get(3))
  })

  it('末尾へのスライド追加では既存スライドの slideHash が変わらない', async () => {
    const before = await deckKeys()
    await writeInto(deckDirectory, 'slides.md', `${slidesMd}\n---\nlayout: default\n---\n\n# 追加ページ\n`)
    const after = await deckKeys()
    expect(after.slideHashes.size).toBe(4)
    for (const slideNumber of [1, 2, 3]) {
      expect(after.slideHashes.get(slideNumber)).toBe(before.slideHashes.get(slideNumber))
    }
  })

  it('コードフェンス内の --- はスライド区切りにならず、編集は当該スライドだけを無効化する', async () => {
    const fenced = [
      slidesMd,
      '',
      '---',
      'layout: default',
      '---',
      '',
      '# コード例',
      '',
      '```md',
      '---',
      'layout: cover',
      '---',
      '',
      'フェンス内の区切り',
      '```',
      '',
    ].join('\n')
    await writeInto(deckDirectory, 'slides.md', fenced)
    const before = await deckKeys()
    expect(before.slideHashes.size).toBe(4)

    await writeInto(deckDirectory, 'slides.md', fenced.replace('フェンス内の区切り', 'フェンス内の区切り（編集）'))
    const after = await deckKeys()
    expect(after.slideHashes.size).toBe(4)
    expect(after.envHash).toBe(before.envHash)
    for (const slideNumber of [1, 2, 3]) {
      expect(after.slideHashes.get(slideNumber)).toBe(before.slideHashes.get(slideNumber))
    }
    expect(after.slideHashes.get(4)).not.toBe(before.slideHashes.get(4))
  })

  it('layouts / patches 等が無い最小構成でも成功する', async () => {
    const minimal = path.join(root, 'minimal')
    await buildDeck(minimal, [['slides.md', '---\ntheme: none\n---\n\n# 1 枚だけ\n']])
    const keys = await deckKeys({
      projectDirectory: minimal,
      slidesPath: path.join(minimal, 'slides.md'),
    })
    expect(keys.envHash).toMatch(/^[\da-f]{64}$/)
    expect(keys.slideHashes.size).toBe(1)
  })

  it('slides.md が読めなければ failure=slides-load-failed', async () => {
    const result = await computeDeckCacheKeys(keyOptions({
      slidesPath: path.join(deckDirectory, 'missing.md'),
    }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('slides-load-failed')
    expect(result.message).toContain('missing.md')
  })

  it('src 先が存在しない slides.md は failure=slides-has-errors', async () => {
    // load() は parse エラーを throw せず errors に積み、当該スライドを通知なしで落とす。
    await writeInto(deckDirectory, 'slides.md', `${slidesMd}\n---\nsrc: ./pages/nope.md\n---\n`)
    const result = await computeDeckCacheKeys(keyOptions())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('slides-has-errors')
    expect(result.message).toContain('nope.md')
  })

  it('デッキ外を src: で参照しても拒否されない（allowedRoots 省略の結果を固定する）', async () => {
    // load() に allowedRoots を渡すと、解決範囲がビルド側より狭くなるため省略している。
    // cache-store.ts の load() 呼び出し前のコメントを参照。
    // その結果として、projectDirectory の外の src: も errors に積まれず読めることを固定する。
    const outside = path.join(root, 'shared-pages')
    await writeInto(outside, 'appendix.md', '---\nlayout: default\ntitle: 付録\n---\n\n# 付録\n')
    await writeInto(deckDirectory, 'slides.md', `${slidesMd}\n---\nsrc: ../shared-pages/appendix.md\n---\n`)

    const result = await computeDeckCacheKeys(keyOptions())

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.keys.slideHashes.keys().toArray()).toStrictEqual([1, 2, 3, 4])
  })

  it('bundle 実体が読めなければ failure=bundle-unreadable', async () => {
    const result = await computeDeckCacheKeys(keyOptions({
      domToPptxBundlePath: path.join(root, 'lib', 'missing.bundle.js'),
    }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('bundle-unreadable')
  })

  it.each([
    ['chromiumVersion が空', { chromiumVersion: '' }],
    ['chromiumVersion が空白のみ', { chromiumVersion: '  ' }],
    ['pluginVersion が空', { pluginVersion: '' }],
  ])('%s なら failure=invalid-environment（材料が欠けたままキャッシュを使わない）', async (_name, overrides) => {
    const result = await computeDeckCacheKeys(keyOptions(overrides))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('invalid-environment')
  })
})

describe('manifest の読み書き', () => {
  const entry: SlideCacheEntry = {
    slideHash: 'h'.repeat(64),
    slideNumber: 1,
    clickStep: null,
    pptxFile: 'slide-100.pptx',
    prerenderFiles: [],
    letterSpacingMap: {},
    hrefMap: {},
    hasExplicitAnimation: false,
  }

  it('write → read で往復する', async () => {
    const manifest = createCacheManifest('e'.repeat(64), new Map([[100, entry]]))
    await writeCacheManifest(cacheDirectory, manifest)
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'ok', manifest })
  })

  it('manifest.json が無ければ status=missing', async () => {
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'missing' })
  })

  it('manifest.json が不正なら status=invalid（不在と区別する）', async () => {
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(path.join(cacheDirectory, 'manifest.json'), '{"schemaVersion":1,"envHash":')
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'invalid' })
  })

  it('rename 失敗時は旧 manifest が保たれ、最終パスに部分 JSON も残らない', async () => {
    const old = createCacheManifest('old'.repeat(20), new Map([[100, entry]]))
    await writeCacheManifest(cacheDirectory, old)
    const oldText = await readFile(path.join(cacheDirectory, 'manifest.json'), 'utf8')

    const next = createCacheManifest('new'.repeat(20), new Map([[200, { ...entry, slideNumber: 2, pptxFile: 'slide-200.pptx' }]]))
    await expect(writeCacheManifest(cacheDirectory, next, {
      renameImpl: async () => { throw new Error('rename failed') },
    })).rejects.toThrow('rename failed')

    // (a) 旧 manifest が旧内容のまま読める
    expect(await readFile(path.join(cacheDirectory, 'manifest.json'), 'utf8')).toBe(oldText)
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'ok', manifest: old })
    // (b) 最終パスに部分 JSON が残っていない
    expect(parseCacheManifest(oldText)?.envHash).toBe(old.envHash)
    // 一時ファイルは後始末される
    const remaining = await listDirectory(cacheDirectory)
    expect(remaining.filter(name => name.startsWith('manifest.json.tmp-'))).toStrictEqual([])
  })

  it('書き込み失敗時も一時ファイルを残さず、旧 manifest を壊さない', async () => {
    const old = createCacheManifest('old'.repeat(20), new Map([[100, entry]]))
    await writeCacheManifest(cacheDirectory, old)

    await expect(writeCacheManifest(cacheDirectory, old, {
      writeFileImpl: async (filePath: string) => {
        // 途中まで書けた状態で失敗するケースを再現する。
        await writeFile(filePath, '{"schemaVersion":1,"envHa')
        throw new Error('write failed')
      },
    })).rejects.toThrow('write failed')

    const remaining = await listDirectory(cacheDirectory)
    expect(remaining.filter(name => name.startsWith('manifest.json.tmp-'))).toStrictEqual([])
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'ok', manifest: old })
  })

  it('一時ファイルの残骸があっても次回の読み取りは成功する', async () => {
    const manifest = createCacheManifest('e'.repeat(64), new Map([[100, entry]]))
    await writeCacheManifest(cacheDirectory, manifest)
    await writeFile(path.join(cacheDirectory, 'manifest.json.tmp-leftover'), '{"schemaVersion":1,"envHash":')
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'ok', manifest })
  })
})

describe('saveSlideToCache / materializeCacheEntry', () => {
  it('明示指定アニメーションのフラグが save → materialize で往復する', async () => {
    // #1070: ヒットしたステップでも p:timing の除去判定に使うため、エントリに載って復元される。
    await stageSlideArtifacts(400, [])
    const entry = await saveSlideToCache(saveOptions(400, 4, null, true))
    expect(entry?.hasExplicitAnimation).toBe(true)

    await rm(slidesDirectory, { recursive: true, force: true })
    const materialized = await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 400, slidePrefix: 'slide-' },
      entry!,
    )
    expect(materialized?.hasExplicitAnimation).toBe(true)
  })

  it('PNG + meta の対を往復できる', async () => {
    await stageSlideArtifacts(100, ['prerender-slide100-0.png', 'prerender-slide100-0.meta.json'])
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    expect(entry?.pptxFile).toBe('slide-100.pptx')
    expect(entry?.prerenderFiles).toStrictEqual([
      'prerender-slide100-0.meta.json',
      'prerender-slide100-0.png',
    ])

    await rm(slidesDirectory, { recursive: true, force: true })
    const materialized = await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 100, slidePrefix: 'slide-' },
      entry!,
    )
    expect(materialized?.letterSpacingMap).toStrictEqual({ タイトル: { letterSpacing: '-0.02em', fontSize: '32px' } })
    expect(materialized?.hrefMap).toStrictEqual({ リンク: 'https://example.com' })
    expect(materialized?.hasExplicitAnimation).toBe(false)
    expect(await listDirectory(slidesDirectory)).toStrictEqual([
      'prerender-slide100-0.meta.json',
      'prerender-slide100-0.png',
      'slide-100.pptx',
    ])
  })

  it('PNG のみ（meta 無し）でも往復できる', async () => {
    // boundingBox が null の要素では PNG だけが書かれる。
    await stageSlideArtifacts(200, ['prerender-slide200-0.png'])
    const entry = await saveSlideToCache(saveOptions(200, 2, null))
    expect(entry?.prerenderFiles).toStrictEqual(['prerender-slide200-0.png'])

    await rm(slidesDirectory, { recursive: true, force: true })
    expect(await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 200, slidePrefix: 'slide-' },
      entry!,
    )).toBeDefined()
    expect(await listDirectory(slidesDirectory)).toStrictEqual([
      'prerender-slide200-0.png',
      'slide-200.pptx',
    ])
  })

  it('prerender 0 件でも往復できる', async () => {
    await stageSlideArtifacts(300)
    const entry = await saveSlideToCache(saveOptions(300, 3, null))
    expect(entry?.prerenderFiles).toStrictEqual([])

    await rm(slidesDirectory, { recursive: true, force: true })
    expect(await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 300, slidePrefix: 'slide-' },
      entry!,
    )).toBeDefined()
    expect(await listDirectory(slidesDirectory)).toStrictEqual(['slide-300.pptx'])
  })

  it('宛先ファイル名は当該実行の slidePrefix で決まる', async () => {
    await stageSlideArtifacts(100)
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    await rm(slidesDirectory, { recursive: true, force: true })
    await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 100, slidePrefix: 'page-' },
      entry!,
    )
    expect(await listDirectory(slidesDirectory)).toStrictEqual(['page-100.pptx'])
  })

  it('prerender の判定は区切りまで含めるので、スライド 5 と 50 を取り違えない', async () => {
    await stageSlideArtifacts(500, ['prerender-slide500-0.png'])
    await writeFile(path.join(slidesDirectory, 'slide-5000.pptx'), 'pptx-5000')
    await writeFile(path.join(slidesDirectory, 'prerender-slide5000-0.png'), 'data-5000')

    const entry500 = await saveSlideToCache(saveOptions(500, 5, 0))
    const entry5000 = await saveSlideToCache(saveOptions(5000, 50, 0))
    expect(entry500?.prerenderFiles).toStrictEqual(['prerender-slide500-0.png'])
    expect(entry5000?.prerenderFiles).toStrictEqual(['prerender-slide5000-0.png'])
  })

  it('slides/ に pptx が無ければ保存しない', async () => {
    await mkdir(slidesDirectory, { recursive: true })
    expect(await saveSlideToCache(saveOptions(100, 1, null))).toBeUndefined()
  })

  it('slides/ の pptx が 0 バイトなら保存しない', async () => {
    await mkdir(slidesDirectory, { recursive: true })
    await writeFile(path.join(slidesDirectory, 'slide-100.pptx'), '')
    expect(await saveSlideToCache(saveOptions(100, 1, null))).toBeUndefined()
  })

  it('保存が中断しても既存キャッシュは保たれ、書きかけも残らない', async () => {
    // 1 回目の保存を成功させ、2 回目（上書き）を rename 直前で失敗させる。
    await stageSlideArtifacts(100, ['prerender-slide100-0.png'])
    const first = await saveSlideToCache(saveOptions(100, 1, null))
    expect(first).toBeDefined()
    const cachedPptx = path.join(cacheDirectory, 'slide-100.pptx')
    const originalContent = await readFile(cachedPptx, 'utf8')

    await writeFile(path.join(slidesDirectory, 'slide-100.pptx'), 'pptx-100-updated-and-longer')
    const failed = await saveSlideToCache(saveOptions(100, 1, null), {
      renameImpl: async () => { throw new Error('rename failed') },
    })

    expect(failed).toBeUndefined()
    // 上書き対象は旧内容のまま（途中サイズのファイルが正規名に現れない）
    expect(await readFile(cachedPptx, 'utf8')).toBe(originalContent)
    expect(await listDirectory(cacheDirectory)).toStrictEqual([
      'prerender-slide100-0.png',
      'slide-100.pptx',
    ])
  })

  it('prerender 複製の途中で失敗した保存は、書いた分を撤去して undefined を返す', async () => {
    await stageSlideArtifacts(100, ['prerender-slide100-0.png', 'prerender-slide100-1.png'])
    // pptx の複製だけ成功させ、prerender の 1 枚目で失敗させる。
    const saved = await saveSlideToCache(saveOptions(100, 1, null), {
      copyFileImpl: copyFailingAfter(1),
    })
    expect(saved).toBeUndefined()
    expect(await listDirectory(cacheDirectory)).toStrictEqual([])
  })

  it.each([
    ['pptx のみ削除', 'slide-100.pptx'],
    ['PNG を 1 つ削除', 'prerender-slide100-1.png'],
    ['meta のみ削除', 'prerender-slide100-0.meta.json'],
  ])('キャッシュ実体の欠損（%s）はミス扱いにする', async (_name, removedName) => {
    await stageSlideArtifacts(100, [
      'prerender-slide100-0.png',
      'prerender-slide100-0.meta.json',
      'prerender-slide100-1.png',
    ])
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    await rm(path.join(cacheDirectory, removedName))
    await rm(slidesDirectory, { recursive: true, force: true })

    expect(await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 100, slidePrefix: 'slide-' },
      entry!,
    )).toBeUndefined()
    expect(await isExists(slidesDirectory)).toBe(false)
  })

  it('キャッシュ実体が 0 バイトでもミス扱いにする', async () => {
    await stageSlideArtifacts(100, ['prerender-slide100-0.png'])
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    await writeFile(path.join(cacheDirectory, 'prerender-slide100-0.png'), '')
    await rm(slidesDirectory, { recursive: true, force: true })

    expect(await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 100, slidePrefix: 'slide-' },
      entry!,
    )).toBeUndefined()
  })

  it('復元の途中で失敗したら部分復元を残さずミス扱いにする', async () => {
    // 部分復元を残すと、再変換で生成される枚数が少ない場合に、古い prerender が残る。
    // 古い prerender は findPrerenderImages の連番走査に拾われ、気づかれないまま取り込まれる。
    await stageSlideArtifacts(100, ['prerender-slide100-0.png', 'prerender-slide100-1.png'])
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    await rm(slidesDirectory, { recursive: true, force: true })

    const materialized = await materializeCacheEntry(
      { cacheDirectory, slidesDirectory, stepIndex: 100, slidePrefix: 'slide-' },
      entry!,
      { copyFileImpl: copyFailingAfter(2) },
    )
    expect(materialized).toBeUndefined()
    expect(await listDirectory(slidesDirectory)).toStrictEqual([])
  })

  it('並列 save の後に終端 1 回で書いた manifest へ全エントリが揃う', async () => {
    const steps = [100, 200, 300, 401]
    for (const stepIndex of steps) {
      await stageSlideArtifacts(stepIndex, [`prerender-slide${String(stepIndex)}-0.png`])
    }

    const saved = await Promise.all(steps.map(async stepIndex => ({
      stepIndex,
      entry: await saveSlideToCache(saveOptions(stepIndex, Math.floor(stepIndex / 100), stepIndex % 100)),
    })))
    const entries = new Map<number, SlideCacheEntry>()
    for (const { stepIndex, entry } of saved) {
      expect(entry).toBeDefined()
      entries.set(stepIndex, entry!)
    }
    await writeCacheManifest(cacheDirectory, createCacheManifest('e'.repeat(64), entries))

    const read = await readCacheManifest(cacheDirectory)
    const readEntries = read.status === 'ok' ? read.manifest.entries : {}
    expect(Object.keys(readEntries).toSorted(compareStrings)).toStrictEqual(['100', '200', '300', '401'])
    expect(await listDirectory(cacheDirectory)).toStrictEqual([
      'manifest.json',
      'prerender-slide100-0.png',
      'prerender-slide200-0.png',
      'prerender-slide300-0.png',
      'prerender-slide401-0.png',
      'slide-100.pptx',
      'slide-200.pptx',
      'slide-300.pptx',
      'slide-401.pptx',
    ])
  })
})

describe('clearOrphanedCacheArtifacts', () => {
  it('slide-*.pptx / prerender-slide*-* の既知パターンだけを消し、manifest.json と *.tmp-* は残す', async () => {
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(path.join(cacheDirectory, 'slide-100.pptx'), 'pptx-100')
    await writeFile(path.join(cacheDirectory, 'prerender-slide100-0.png'), 'png-100')
    await writeFile(path.join(cacheDirectory, 'prerender-slide100-0.meta.json'), '{}')
    await writeFile(path.join(cacheDirectory, 'manifest.json'), '{"schemaVersion":1,"envHash":')
    await writeFile(path.join(cacheDirectory, 'manifest.json.tmp-abc123'), '{"schemaVersion":1')
    await writeFile(path.join(cacheDirectory, 'prerender-slide200-0.png.tmp-def456'), 'partial')

    await clearOrphanedCacheArtifacts(cacheDirectory)

    expect(await listDirectory(cacheDirectory)).toStrictEqual([
      'manifest.json',
      'manifest.json.tmp-abc123',
      'prerender-slide200-0.png.tmp-def456',
    ])
  })

  it('cache/ が無くても失敗しない', async () => {
    await expect(clearOrphanedCacheArtifacts(cacheDirectory)).resolves.toBeUndefined()
  })
})

describe('pruneCache', () => {
  it('スキャン結果に無いエントリの成果物だけを消す', async () => {
    await stageSlideArtifacts(100, ['prerender-slide100-0.png'])
    await stageSlideArtifacts(200, ['prerender-slide200-0.png', 'prerender-slide200-0.meta.json'])
    const kept = await saveSlideToCache(saveOptions(100, 1, null))
    const removed = await saveSlideToCache(saveOptions(200, 2, null))
    const manifest = createCacheManifest('e'.repeat(64), new Map([[100, kept!], [200, removed!]]))
    await writeCacheManifest(cacheDirectory, manifest)

    const pruned = await pruneCache(cacheDirectory, manifest, { fullScan: true, stepIndexes: [100] })
    await writeCacheManifest(cacheDirectory, pruned)

    expect(Object.keys(pruned.entries)).toStrictEqual(['100'])
    expect(await listDirectory(cacheDirectory)).toStrictEqual([
      'manifest.json',
      'prerender-slide100-0.png',
      'slide-100.pptx',
    ])
    expect(await readCacheManifest(cacheDirectory)).toStrictEqual({ status: 'ok', manifest: pruned })
  })

  it('全 stepIndex が生存していれば何も消さない', async () => {
    await stageSlideArtifacts(100, ['prerender-slide100-0.png'])
    const entry = await saveSlideToCache(saveOptions(100, 1, null))
    const manifest = createCacheManifest('e'.repeat(64), new Map([[100, entry!]]))

    const pruned = await pruneCache(cacheDirectory, manifest, { fullScan: true, stepIndexes: [100] })
    expect(pruned).toStrictEqual(manifest)
    expect(await listDirectory(cacheDirectory)).toStrictEqual([
      'prerender-slide100-0.png',
      'slide-100.pptx',
    ])
  })

  it('渡した集合の差はすべて消える（部分スキャン結果を渡してはならない理由）', async () => {
    // これは仕様。
    // `--only` / `--onlySteps` の結果で呼ぶと、キャッシュがほぼ全消去される。
    // そのため呼び出し側には、型（FullScanSteps の fullScan: true）で全走査であることを明示させている。
    await stageSlideArtifacts(100, ['prerender-slide100-0.png'])
    await stageSlideArtifacts(200)
    const first = await saveSlideToCache(saveOptions(100, 1, null))
    const second = await saveSlideToCache(saveOptions(200, 2, null))
    const manifest = createCacheManifest('e'.repeat(64), new Map([[100, first!], [200, second!]]))

    const pruned = await pruneCache(cacheDirectory, manifest, { fullScan: true, stepIndexes: [200] })
    expect(Object.keys(pruned.entries)).toStrictEqual(['200'])
    expect(await listDirectory(cacheDirectory)).toStrictEqual(['slide-200.pptx'])
  })
})
