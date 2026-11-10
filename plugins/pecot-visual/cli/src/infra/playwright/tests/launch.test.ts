// launchChromium (headless Chromium の起動と取得手順の案内) の単体テスト。
// playwright を mock し、実 Chromium は起動しない。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rejectionOf } from '../../../../tests/_helpers/rejection.js'

function mockLaunch(implementation: () => Promise<unknown>) {
  const launch = vi.fn(implementation)
  vi.doMock('playwright', () => ({ chromium: { launch } }))
  return launch
}

describe('launchChromium', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('playwright')
  })

  it('headless で起動したブラウザをそのまま返す', async () => {
    const browser = { close: vi.fn() }
    const launch = mockLaunch(() => Promise.resolve(browser))
    const { launchChromium } = await import('../launch.js')

    await expect(launchChromium()).resolves.toBe(browser)
    expect(launch).toHaveBeenCalledWith({ headless: true })
  })

  it('実行ファイルが無いときは取得コマンドを添えたエラーに包み直す', async () => {
    const original = new Error('browserType.launch: Executable doesn\'t exist at /x/chrome')
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain('Playwright Chromium cannot launch')
    expect(rejected.message).toContain('playwright install chromium')
    expect(rejected.cause).toBe(original)
  })

  it('OS のライブラリ不足は取得ではなく setup を案内するエラーに包み直す', async () => {
    // 実機 (ubuntu26.04 で libatk 等が無い環境) で Playwright が返した形
    const original = new Error(
      'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n'
      + '[pid=1][err] /x/chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory',
    )
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain('OS libraries are missing (libatk-1.0.so.0)')
    expect(rejected.message).toContain('setup')
    expect(rejected.message).not.toContain('playwright install chromium')
    expect(rejected.cause).toBe(original)
  })

  it('起動前の依存確認が枠付きで返すライブラリ不足も、setup を案内するエラーに包み直す', async () => {
    // playwright-core 1.64 の validateDependenciesLinux が投げる形
    const original = new Error([
      '',
      '╔══════════════════════════════════════════════════════╗',
      '║ Host system is missing dependencies to run browsers. ║',
      '║ Missing libraries:                                   ║',
      '║     libatk-1.0.so.0                                  ║',
      '╚══════════════════════════════════════════════════════╝',
    ].join('\n'))
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain('OS libraries are missing (libatk-1.0.so.0)')
    expect(rejected.message).not.toContain('playwright install chromium')
    expect(rejected.cause).toBe(original)
  })

  it('ライブラリ名を含まない枠付きの失敗も、名前なしで setup を案内する', async () => {
    const original = new Error('\n║ Host system is missing dependencies to run browsers. ║\n║ Please install them with the following command: ║')
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain('OS libraries are missing:')
    expect(rejected.message).toContain('setup')
  })

  it('起動と無関係のエラーはそのまま投げ直す', async () => {
    const original = new Error('EMFILE: too many open files')
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    await expect(launchChromium()).rejects.toBe(original)
  })

  it('Error 以外の throw も起動の失敗なら取得コマンドを添えたエラーに包み直す', async () => {
    const original = 'playwright-chromium missing'
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 非 Error の reject を検証する
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain(`Playwright Chromium cannot launch: ${original}`)
    expect(rejected.message).toContain('playwright install chromium')
    expect(rejected.cause).toBe(original)
  })
})
