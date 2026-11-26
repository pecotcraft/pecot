// chromium 依存ツールの実行時ガード (src/mcp/tools/_shared.ts の ensureChromium) の単体テスト。
//
// 見たいのは 2 系統。
//   1. 標準 (PECOTV_AUTO_INSTALL_BROWSER なし) — 取得を試みず、`runtime_setup` ツールの呼び出しを案内する。
//   2. env オプトイン時 — その場で取得し、成功なら処理を続行、失敗なら理由と誘導を返す。
//
// 実取得は 120MB 級のダウンロードなので、deps を差し替えてルートだけを見る。
// 実ダウンロードを伴う確認は bootstrap CUJ (cli/tests/bootstrap/run.sh の CUJ 13) が持つ。
//
// ツール側への接続 (どのツールがどの条件でガードを通すか) は、既定 deps のまま
// Playwright の解決先を一時ディレクトリへ向けて未取得を作り、観測する。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpawnResult } from '../../../domain/_shared/spawn-result.js'
import {
  createChromiumCacheDirectory,
  removeChromiumCacheDirectory,
} from '../../../../tests/_helpers/chromium-cache.js'
import { LOCK_CONFLICT_EXIT_CODE } from '../../../infra/_shared/flock.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { snapshotTree } from './tree-snapshot.js'
import type { ToolCallContext } from '../../server.js'
import { drawioCreateTool as drawioCreateDefinition, drawioExportTool as drawioExportDefinition } from '../drawio.js'
import { withOutputCheck } from './_output.js'
import { ensureChromium, type ChromiumDependencies } from '../_shared.js'
import { slideConvertTool as slideConvertDefinition } from '../slide.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const drawioCreateTool = withOutputCheck(drawioCreateDefinition)
const drawioExportTool = withOutputCheck(drawioExportDefinition)

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const ICON_ROOT = path.join(PLUGIN_ROOT, 'assets', 'drawio-icons')
const MINIMAL_DRAWIO = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio')

const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredOf(result)
}

function sentenceOf(result: Readonly<Record<string, unknown>>): string {
  const content = result['content']
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
}

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    // eslint-disable-next-line unicorn/no-null -- SpawnResult の signal は null を取る契約
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

/**
ensureChromium に渡す差し替え deps。
installed は install() 呼び出しで書き換わる形にして「取得したから通った」を表現する。
*/
function fakeDependencies(options: Readonly<{
  installed: boolean
  autoInstall: boolean
  install?: () => Promise<SpawnResult>
}>): { deps: ChromiumDependencies, installCalls: () => number, installSignal: () => AbortSignal | undefined } {
  let isInstalled = options.installed
  let calls = 0
  let signal: AbortSignal | undefined
  const dependencies: ChromiumDependencies = {
    isInstalled: () => Promise.resolve(isInstalled),
    isAutoInstallEnabled: () => options.autoInstall,
    browsersRoot: () => '/fake/ms-playwright',
    // AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    install: async (received?: AbortSignal) => {
      calls += 1
      signal = received
      const result = await (options.install?.() ?? Promise.resolve(spawnResult()))
      if (result.exitCode === 0) isInstalled = true
      return result
    },
  }
  return { deps: dependencies, installCalls: () => calls, installSignal: () => signal }
}

const cacheDirectories: string[] = []

/**
既定 deps のまま「取得済み / 未取得」を作る。
*/
function stubChromium(): string {
  const directory = createChromiumCacheDirectory(false)
  cacheDirectories.push(directory)
  return directory
}

const workDirectories: string[] = []

/**
ツールの出力先。chromium キャッシュとは無関係なので素の一時ディレクトリを使う。
*/
function createWorkDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-chromium-guard-'))
  workDirectories.push(directory)
  return directory
}

beforeEach(() => {
  // ツール接続の観測に実ダウンロードを混ぜないよう、標準では opt-in を落としておく。
  vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of cacheDirectories.splice(0)) removeChromiumCacheDirectory(directory)
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ensureChromium: 既定は取得せず runtime_setup ツールを案内する', () => {
  it('Chromium を取得済みの場合は、undefined を返し、実際の処理を止めない', async () => {
    await explains('Chromium の実行時ガード `ensureChromium` の、既定の設定のテストです。Chromium を取得済みの場合に `undefined` を返し、取得の処理を呼び出さないことを確認します。')
    const { deps, installCalls } = fakeDependencies({ installed: true, autoInstall: false })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(0)
  })

  it('Chromium を取得していない場合は、取得を試みずに、失敗の結果を返す', async () => {
    await explains('Chromium を取得しておらず、自動取得も有効にしていない場合の `ensureChromium` のテストです。取得の処理を呼び出さず、`chromium-not-installed` の失敗の結果を返すことを確認します。')
    const { deps, installCalls } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(installCalls(), 'モデルから呼ばれたツールは通知なしに 120MB を取得してはいけない').toBe(0)
    expect(rejected).toMatchObject({
      ok: false,
      kind: 'chromium-not-installed',
      data: { event: 'chromium.unavailable', expectedAt: '/fake/ms-playwright' },
    })
    expect(rejected?.data).not.toHaveProperty('reason')
  })

  it('案内文に、不足しているもの、期待していた場所、実行すべき操作が含まれる', async () => {
    await explains('Chromium を取得していない場合の、案内文のテストです。Chromium が存在しないこと、期待していた場所、`runtime_setup` ツールの呼び出し、ダウンロードの量（`120MB`）、環境変数による自動取得の方法が含まれることを確認します。')
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.detail)

    expect(detail).toContain('Chromium')
    expect(detail).toContain('/fake/ms-playwright')
    expect(detail).toContain('call the `runtime_setup` tool')
    // 単体配布では存在しないため、setup.sh のパスを案内しない。
    expect(detail).not.toContain('setup.sh')
    // 許可判断ができるようダウンロード量を明記する。
    expect(detail).toContain('120MB')
    expect(detail).toContain('PECOTV_AUTO_INSTALL_BROWSER=1')
  })

  it('取得先を特定できない場合も、案内文を作成できる', async () => {
    await explains('Chromium の取得先を特定できない場合の `ensureChromium` のテストです。期待していた場所が既定の Playwright のディレクトリと案内され、案内文に `undefined` が含まれないことを確認します。')
    // PLAYWRIGHT_BROWSERS_PATH=0 や HOME 無しでは場所が決まらない。undefined を
    // そのまま文言へ埋めると「undefined に見つかりません」になり、誘導として読めない。
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    // eslint-disable-next-line unicorn/no-useless-undefined -- browsersRoot は場所を特定できないとき undefined を返す契約
    const rejected = await ensureChromium('drawio_export', { ...deps, browsersRoot: () => undefined })

    expect(rejected?.data['expectedAt']).toBe('the default Playwright browsers directory')
    expect(String(rejected?.detail)).not.toContain('undefined')
  })

  it('detail には、runtime_setup ツールの名前を含める', async () => {
    await explains('`slide_convert` のために `ensureChromium` を実行した場合のテストです。`detail` に、ツール名の `slide_convert` と、`runtime_setup` ツールの呼び出しの案内が含まれることを確認します。')
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('slide_convert', deps)
    const detail = rejected?.detail ?? ''

    expect(detail).toContain('slide_convert')
    expect(detail).toContain('call the `runtime_setup` tool')
  })
})

describe('ensureChromium: PECOTV_AUTO_INSTALL_BROWSER=1 で自動取得する', () => {
  it('Chromium を取得していない場合は取得し、成功すれば処理を続ける', async () => {
    await explains('自動取得を有効にして、Chromium を取得していない場合の `ensureChromium` のテストです。取得の処理を 1 回呼び出し、成功した場合に `undefined` を返すことを確認します。')
    const { deps, installCalls } = fakeDependencies({ installed: false, autoInstall: true })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(1)
  })

  it('取得済みの場合は、自動取得を有効にしていても、取得しない', async () => {
    await explains('自動取得を有効にして、Chromium を取得済みの場合の `ensureChromium` のテストです。取得の処理を呼び出さず、`undefined` を返すことを確認します。')
    const { deps, installCalls } = fakeDependencies({ installed: true, autoInstall: true })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(0)
  })

  it('取得が失敗した場合は、理由と復旧の手順を返す', async () => {
    await explains('自動取得が失敗する場合の `ensureChromium` のテストです。`chromium-install-failed` の失敗になり、プロキシの環境変数などの復旧手順が含まれ、`log` に標準出力と標準エラー出力が入ることを確認します。')
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stdout: 'Downloading Chromium 140.0 (playwright build v1217)',
        stderr: 'download failed',
      })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(rejected?.ok).toBe(false)
    expect(rejected?.kind).toBe('chromium-install-failed')
    const detail = String(rejected?.detail)
    expect(detail).toContain('HTTPS_PROXY')
    expect(detail).toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    // playwright install は失敗原因を stdout に書くこともあるため、両方が log に入る。
    expect(rejected?.data['log']).toBe('Downloading Chromium 140.0 (playwright build v1217)\ndownload failed')
  })

  it('TLS の証明書の検証で失敗した場合は、NODE_EXTRA_CA_CERTS の確認を案内する', async () => {
    await explains('取得が TLS の証明書の検証で失敗した場合の `ensureChromium` のテストです。これまでの案内に加えて、`NODE_EXTRA_CA_CERTS` を確認する案内が含まれ、同梱の証明書には触れないことを確認します。')
    // SSL を中継するプロキシの CA が無いと TLS で落ちる。
    // pecot は証明書を同梱しないので、runtime_setup ツール側と同じ判定・同じ文言で NODE_EXTRA_CA_CERTS を案内する。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stderr: 'Error: unable to get local issuer certificate',
      })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    const detail = String(rejected?.detail)

    expect(detail, '既存の誘導は残す').toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    expect(detail).toContain('TLS certificate verification failed')
    expect(detail).toContain('NODE_EXTRA_CA_CERTS')
    expect(detail, '同梱の証明書は無い').not.toContain('bundled')
  })

  it('取得のコマンドを起動できなかった場合は、exit null と書かずに、起動できなかったことを返す', async () => {
    await explains('取得のコマンドを起動できず、終了コードが `null` になる場合の `ensureChromium` のテストです。`exit null` とは書かず、`could not start the download command` と案内することを確認します。')
    // playwright を解決できない / node を起動できないケース。SpawnResult は exitCode: null で表す。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      // eslint-disable-next-line unicorn/no-null -- 起動失敗は exitCode / signal とも null
      install: () => Promise.resolve(spawnResult({ exitCode: null, signal: null, stderr: 'ENOENT' })),
    })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.detail)

    expect(detail).not.toContain('exit null')
    expect(detail).toContain('could not start the download command')
  })

  it('シグナルで終了した場合は、中断として返す', async () => {
    await explains('取得のコマンドが `SIGTERM` で終了した場合の `ensureChromium` のテストです。`exit null` とは書かず、`detail` にシグナルの名前が含まれることを確認します。')
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      // eslint-disable-next-line unicorn/no-null -- シグナル終了は exitCode が null
      install: () => Promise.resolve(spawnResult({ exitCode: null, signal: 'SIGTERM' })),
    })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.detail)

    expect(detail).not.toContain('exit null')
    expect(detail).toContain('SIGTERM')
  })

  it('ロックの待ち時間が上限を超えた場合は、別のプロセスが取得中であることを返す', async () => {
    await explains('取得のコマンドが、ロックの競合を示す終了コードで終了した場合の `ensureChromium` のテストです。別のプロセスがダウンロード中であることを示すメッセージが、`detail` に含まれることを確認します。')
    // flock(1) の -E で指定した exit code。取得コマンド自身の失敗と区別する。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({ exitCode: LOCK_CONFLICT_EXIT_CODE })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(String(rejected?.detail)).toContain('another process is downloading chromium')
  })

  it('呼び出し元の signal を、取得のコマンドへ渡す', async () => {
    await explains('`ensureChromium` に `signal` を渡して呼び出した場合のテストです。取得の処理が、渡した `signal` と同じものを受け取ることを確認します。')
    const { deps, installSignal } = fakeDependencies({ installed: false, autoInstall: true })
    const controller = new AbortController()

    await ensureChromium('drawio_export', deps, controller.signal)

    expect(installSignal()).toBe(controller.signal)
  })

  it('タイムアウトした場合は、タイムアウトしたことを理由として返す', async () => {
    await explains('取得のコマンドがタイムアウトした場合の `ensureChromium` のテストです。`detail` に、ダウンロードがタイムアウトしたことを示すメッセージが含まれることを確認します。')
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, timedOut: true })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(String(rejected?.detail)).toContain('download timed out')
  })

  it('終了コードが 0 でも、Chromium が配置されていない場合は、失敗として扱う', async () => {
    await explains('取得のコマンドは成功したが、Chromium が配置されていない場合の `ensureChromium` のテストです。`chromium-install-failed` の失敗になり、`detail` に期待していた場所が含まれることを確認します。')
    // 「取得コマンドは成功したが skip されただけ」を成功と取り違えないための分岐。
    const dependencies: ChromiumDependencies = {
      isInstalled: () => Promise.resolve(false),
      isAutoInstallEnabled: () => true,
      browsersRoot: () => '/fake/ms-playwright',
      install: () => Promise.resolve(spawnResult()),
    }

    const rejected = await ensureChromium('drawio_export', dependencies)

    expect(rejected?.kind).toBe('chromium-install-failed')
    expect(String(rejected?.detail)).toContain('/fake/ms-playwright')
  })
})

describe('chromium 未取得時のツール応答', () => {
  it('Chromium を取得していない場合は、drawio_export は実際の処理を呼び出さず、エラーを返す', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-07')
    await explains('Chromium を取得していない状態で、`drawio_export` を呼び出した場合のテストです。`isError` が `true` で、`kind` が `chromium-not-installed` になり、出力先に何も書き出されないことを確認します。')
    stubChromium()

    const workDirectory = createWorkDirectory()

    const result = await drawioExportTool.handler(
      { input_path: MINIMAL_DRAWIO, icons_dir: ICON_ROOT, out_path: path.join(workDirectory, 'out.svg') },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('chromium-not-installed')
    expect(sentenceOf(result)).toContain('call the `runtime_setup` tool')
    expect(snapshotTree(workDirectory)).toEqual(new Map())
  })

  it('Chromium を取得していなくても、print_hash を指定した drawio_export は成功する', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-03')
    await explains('Chromium を取得していない状態で、`print_hash` を指定して `drawio_export` を呼び出した場合のテストです。エラーにならず、`drawio.export.hash` のイベントが返ることを確認します。')
    stubChromium()

    const result = await drawioExportTool.handler(
      { input_path: MINIMAL_DRAWIO, icons_dir: ICON_ROOT, print_hash: true },
      CALL,
    )

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)['event']).toBe('drawio.export.hash')
  })

  it('Chromium を取得していない場合は、slide_convert は実際の処理を呼び出さず、エラーを返す', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-07')
    await explains('Chromium を取得していない状態で、`slide_convert` を呼び出した場合のテストです。`isError` が `true` で、`kind` が `chromium-not-installed` になり、`runtime_setup` ツールの呼び出しを案内することを確認します。')
    stubChromium()

    const result = await withOutputCheck(slideConvertDefinition()).handler(
      { project_dir: path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev') },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('chromium-not-installed')
    expect(sentenceOf(result)).toContain('call the `runtime_setup` tool')
  })

  it('Chromium を取得していない場合は、drawio_create は PNG を生成せず、表示用の HTML だけを書き出す', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-07')
    await explains('Chromium を取得していない状態で、PNG を生成する設定の `drawio_create` を呼び出した場合のテストです。エラーにならず、HTML を書き出し、`png` が `null` で `pngFailed` が `true` になり、警告と復旧手段を返すことを確認します。')
    // drawio_export / slide_convert と違い、chromium 無しでも表示用 HTML の生成は成立する。
    // CLI は PNG 失敗を警告に落として exit 3 を返すので、MCP もそこへ揃える (SC-002)。
    stubChromium()
    const workDirectory = createWorkDirectory()
    const outPath = path.join(workDirectory, 'out.drawio.html')

    const degraded = await drawioCreateTool.handler(
      { input_path: MINIMAL_DRAWIO, out_path: outPath, png: true },
      CALL,
    )

    expect(degraded.isError).toBeUndefined()
    const structured = structuredOf(degraded)
    expect(structured['file']).toBe(outPath)
    // eslint-disable-next-line unicorn/no-null -- PNG 失敗時に png: null を返すことが CLI との契約
    expect(dataOf(degraded)).toMatchObject({ png: null, pngFailed: true })
    expect(dataOf(degraded)['warnings']).toEqual([expect.stringContaining('PNG export failed')])
    // 復旧手段は文に載せる (ツールの項目は CLI の PNG 失敗時と同形に保つ)。
    expect(sentenceOf(degraded)).toContain('call the `runtime_setup` tool')
  })

  it('Chromium を取得していなくても、out_path を省略した drawio_create は URL を返す', async () => {
    await explains('Chromium を取得していない状態で、`out_path` を省略して `drawio_create` を呼び出した場合のテストです。エラーにならず、`drawio.url.done` のイベントが返ることを確認します。')
    stubChromium()

    const result = await drawioCreateTool.handler({ input_path: MINIMAL_DRAWIO }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)['event']).toBe('drawio.url.done')
  })

  it('Chromium を取得していなくても、png を false にした drawio_create は表示用の HTML を書き出す', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-04')
    await explains('Chromium を取得していない状態で、`png` を `false` にして `drawio_create` を呼び出した場合のテストです。エラーにならず、指定した出力先に HTML が書き出されることを確認します。')
    stubChromium()
    const workDirectory = createWorkDirectory()
    const outPath = path.join(workDirectory, 'out.drawio.html')

    const result = await drawioCreateTool.handler(
      { input_path: MINIMAL_DRAWIO, out_path: outPath, png: false },
      CALL,
    )

    expect(result.isError).toBeUndefined()
    expect(structuredOf(result)['file']).toBe(outPath)
  })
})
