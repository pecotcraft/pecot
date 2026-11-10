// chromium 依存ツールの実行時ガード (src/mcp/tools/_shared.ts の ensureChromium) の単体テスト。
//
// 見たいのは 2 系統。
//   1. 標準 (PECOTV_AUTO_INSTALL_BROWSER なし) — 取得を試みず、`setup` ツールの呼び出しを案内する。
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
import type { ToolCallContext } from '../../server.js'
import { drawioExportTool, drawioCreateTool } from '../drawio.js'
import { ensureChromium, type ChromiumDependencies } from '../_shared.js'
import { slideConvertTool } from '../slide.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
// cli/ → plugins/pecot-visual (既定 deps ファクトリが要求する CLAUDE_PLUGIN_ROOT)
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
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
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
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
  // ツール接続の観測に実ダウンロードを混ぜないよう、標準では opt-in を落としておく。
  vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of cacheDirectories.splice(0)) removeChromiumCacheDirectory(directory)
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ensureChromium: 既定は取得せず setup ツールを案内する', () => {
  it('取得済みなら undefined を返し、実処理を止めない', async () => {
    const { deps, installCalls } = fakeDependencies({ installed: true, autoInstall: false })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(0)
  })

  it('未取得なら取得を試みずに失敗結果を返す', async () => {
    const { deps, installCalls } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(installCalls(), 'モデルから呼ばれたツールは通知なしに 120MB を取得してはいけない').toBe(0)
    expect(rejected?.ok).toBe(false)
    expect(rejected?.exitCode).toBe(1)
    expect(rejected?.artifacts).toEqual([])
    expect(rejected?.data).toMatchObject({
      event: 'chromium.unavailable',
      reason: 'chromium-not-installed',
      expectedAt: '/fake/ms-playwright',
    })
  })

  it('案内文が「何が無いか / どこに期待していたか / 何を実行すべきか」を含む', async () => {
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.data['detail'])

    expect(detail).toContain('Chromium')
    expect(detail).toContain('/fake/ms-playwright')
    expect(detail).toContain('call the `setup` tool')
    // 単体配布では存在しないため、setup.sh のパスを案内しない。
    expect(detail).not.toContain('setup.sh')
    // 許可判断ができるようダウンロード量を明記する。
    expect(detail).toContain('120MB')
    expect(detail).toContain('PECOTV_AUTO_INSTALL_BROWSER=1')
  })

  it('取得先を特定できないときも案内文を組み立てられる', async () => {
    // PLAYWRIGHT_BROWSERS_PATH=0 や HOME 無しでは場所が決まらない。undefined を
    // そのまま文言へ埋めると「undefined に見つかりません」になり、誘導として読めない。
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    // eslint-disable-next-line unicorn/no-useless-undefined -- browsersRoot は場所を特定できないとき undefined を返す契約
    const rejected = await ensureChromium('drawio_export', { ...deps, browsersRoot: () => undefined })

    expect(rejected?.data['expectedAt']).toBe('the default Playwright browsers directory')
    expect(String(rejected?.data['detail'])).not.toContain('undefined')
  })

  it('message は 1 行で setup ツールを名指しする', async () => {
    const { deps } = fakeDependencies({ installed: false, autoInstall: false })

    const rejected = await ensureChromium('slide_convert', deps)
    const message = rejected?.message ?? ''

    expect(message).toContain('slide_convert')
    expect(message).toContain('call the `setup` tool')
  })
})

describe('ensureChromium: PECOTV_AUTO_INSTALL_BROWSER=1 で自動取得する', () => {
  it('未取得なら取得し、成功したら処理を続行させる', async () => {
    const { deps, installCalls } = fakeDependencies({ installed: false, autoInstall: true })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(1)
  })

  it('取得済みなら opt-in でも取得しない', async () => {
    const { deps, installCalls } = fakeDependencies({ installed: true, autoInstall: true })

    expect(await ensureChromium('drawio_export', deps)).toBeUndefined()
    expect(installCalls()).toBe(0)
  })

  it('取得が失敗したら理由と復旧手順を返す', async () => {
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
    expect(rejected?.data).toMatchObject({ reason: 'chromium-install-failed' })
    // bin/pecotv の fatal メッセージと同じ誘導内容に揃える。
    const detail = String(rejected?.data['detail'])
    expect(detail).toContain('HTTPS_PROXY')
    expect(detail).toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    // 失敗原因が stdout 側に出ることもある (playwright install は進捗・取得先を stdout へ書く)。
    expect(rejected?.stdout).toBe('Downloading Chromium 140.0 (playwright build v1217)')
    expect(rejected?.stderr).toBe('download failed')
  })

  it('TLS の証明書検証で落ちた場合は NODE_EXTRA_CA_CERTS の確認を促す', async () => {
    // SSL を中継するプロキシの CA が無いと TLS で落ちる。
    // pecot は証明書を同梱しないので、setup ツール側と同じ判定・同じ文言で NODE_EXTRA_CA_CERTS を案内する。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stderr: 'Error: unable to get local issuer certificate',
      })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    const detail = String(rejected?.data['detail'])

    expect(detail, '既存の誘導は残す').toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    expect(detail).toContain('TLS certificate verification failed')
    expect(detail).toContain('NODE_EXTRA_CA_CERTS')
    expect(detail, '同梱の証明書は無い').not.toContain('bundled')
  })

  it('起動失敗 (exitCode null) を「exit null」と書かずに返す', async () => {
    // playwright を解決できない / node を起動できないケース。SpawnResult は exitCode: null で表す。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      // eslint-disable-next-line unicorn/no-null -- 起動失敗は exitCode / signal とも null
      install: () => Promise.resolve(spawnResult({ exitCode: null, signal: null, stderr: 'ENOENT' })),
    })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.data['detail'])

    expect(detail).not.toContain('exit null')
    expect(detail).toContain('could not start the download command')
  })

  it('シグナル終了 (exitCode null + signal) は中断として返す', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      // eslint-disable-next-line unicorn/no-null -- シグナル終了は exitCode が null
      install: () => Promise.resolve(spawnResult({ exitCode: null, signal: 'SIGTERM' })),
    })

    const rejected = await ensureChromium('drawio_export', deps)
    const detail = String(rejected?.data['detail'])

    expect(detail).not.toContain('exit null')
    expect(detail).toContain('SIGTERM')
  })

  it('ロック待ちの上限超過は「別プロセスが取得中」として返す', async () => {
    // flock(1) の -E で指定した exit code。取得コマンド自身の失敗と区別する。
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({ exitCode: LOCK_CONFLICT_EXIT_CODE })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(String(rejected?.data['detail'])).toContain('another process is downloading chromium')
  })

  it('呼び出し元の signal を取得コマンドへ渡す', async () => {
    const { deps, installSignal } = fakeDependencies({ installed: false, autoInstall: true })
    const controller = new AbortController()

    await ensureChromium('drawio_export', deps, controller.signal)

    expect(installSignal()).toBe(controller.signal)
  })

  it('タイムアウトはタイムアウトとして理由に出す', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      autoInstall: true,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, timedOut: true })),
    })

    const rejected = await ensureChromium('drawio_export', deps)

    expect(String(rejected?.data['detail'])).toContain('download timed out')
  })

  it('exit 0 でも実体が置かれていなければ失敗として扱う', async () => {
    // 「取得コマンドは成功したが skip されただけ」を成功と取り違えないための分岐。
    const dependencies: ChromiumDependencies = {
      isInstalled: () => Promise.resolve(false),
      isAutoInstallEnabled: () => true,
      browsersRoot: () => '/fake/ms-playwright',
      install: () => Promise.resolve(spawnResult()),
    }

    const rejected = await ensureChromium('drawio_export', dependencies)

    expect(rejected?.data).toMatchObject({ reason: 'chromium-install-failed' })
    expect(String(rejected?.data['detail'])).toContain('/fake/ms-playwright')
  })
})

describe('chromium 未取得時のツール応答', () => {
  it('drawio_export は実処理を呼ばず isError で返す', async () => {
    stubChromium()

    const result = await drawioExportTool.handler(
      { input_path: MINIMAL_DRAWIO, icons_dir: ICON_ROOT },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('chromium-not-installed')
  })

  it('drawio_export は print_hash なら chromium 未取得でも成功する', async () => {
    stubChromium()

    const result = await drawioExportTool.handler(
      { input_path: MINIMAL_DRAWIO, icons_dir: ICON_ROOT, print_hash: true },
      CALL,
    )

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)['event']).toBe('drawio.export.hash')
  })

  it('slide_convert は実処理を呼ばず isError で返す', async () => {
    stubChromium()

    const result = await slideConvertTool().handler(
      { project_dir: path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev') },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('chromium-not-installed')
  })

  it('drawio_create は PNG を諦めて表示用 HTML は書く (CLI の degrade と同じ)', async () => {
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
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(3)
    expect(structured['artifacts']).toEqual([outPath])
    // eslint-disable-next-line unicorn/no-null -- PNG 失敗時に png: null を返すことが CLI との契約
    expect(dataOf(degraded)).toMatchObject({ png: null, pngFailed: true, warnings: 1 })
    // 復旧手段は message に載せる (data は CLI の PNG 失敗時と同形に保つ)。
    expect(String(structured['message'])).toContain('call the `setup` tool')
  })

  it('drawio_create は out_path 省略なら chromium 未取得でも URL を返す', async () => {
    stubChromium()

    const result = await drawioCreateTool.handler({ input_path: MINIMAL_DRAWIO }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)['event']).toBe('drawio.url.done')
  })

  it('drawio_create は png: false なら chromium 未取得でも表示用 HTML を書く', async () => {
    stubChromium()
    const workDirectory = createWorkDirectory()
    const outPath = path.join(workDirectory, 'out.drawio.html')

    const result = await drawioCreateTool.handler(
      { input_path: MINIMAL_DRAWIO, out_path: outPath, png: false },
      CALL,
    )

    expect(result.isError).toBeUndefined()
    expect(structuredOf(result)['artifacts']).toEqual([outPath])
  })
})
