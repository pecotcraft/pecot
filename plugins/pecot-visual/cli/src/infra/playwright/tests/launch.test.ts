// launchChromium (headless Chromium の起動と取得手順の案内) の単体テスト。
// playwright を mock し、実 Chromium は起動しない。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rejectionOf } from '../../../../tests/_helpers/rejection.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
    await explains('Chromium を起動する `launchChromium` のテストです。起動が成功した場合に、`headless: true` で起動され、返ったブラウザがそのまま返されることを確認します。')
    const browser = { close: vi.fn() }
    const launch = mockLaunch(() => Promise.resolve(browser))
    const { launchChromium } = await import('../launch.js')

    await expect(launchChromium()).resolves.toBe(browser)
    expect(launch).toHaveBeenCalledWith({ headless: true })
  })

  it('実行ファイルが存在しない場合は、取得のコマンドを添えたエラーに包み直す', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。`Executable doesn\'t exist` で失敗する場合に、メッセージに `playwright install chromium` が含まれ、元のエラーが `cause` に入ることを確認します。')
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

  it('OS のライブラリが不足している場合は、取得ではなく runtime_setup を案内するエラーに包み直す', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。`libatk-1.0.so.0` を読み込めない失敗の場合に、メッセージに不足したライブラリと `setup` の案内が含まれ、取得のコマンドは含まれないことを確認します。')
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

  it('起動前の依存確認が枠付きで返すライブラリの不足も、runtime_setup を案内するエラーに包み直す', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。枠付きでライブラリの不足を返す失敗の場合に、メッセージに `libatk-1.0.so.0` が含まれ、取得のコマンドは含まれないことを確認します。')
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

  it('ライブラリ名を含まない枠付きの失敗も、ライブラリ名なしで runtime_setup を案内する', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。インストールの案内だけの枠付きの失敗の場合に、メッセージに `OS libraries are missing:` と `setup` の案内が含まれることを確認します。')
    const original = new Error('\n║ Host system is missing dependencies to run browsers. ║\n║ Please install them with the following command: ║')
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    const rejected = await rejectionOf(launchChromium())

    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.message).toContain('OS libraries are missing:')
    expect(rejected.message).toContain('setup')
  })

  it('起動と無関係のエラーは、包み直さずにそのまま投げる', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。`EMFILE: too many open files` のように起動と無関係な失敗の場合に、同じエラーがそのまま発生することを確認します。')
    const original = new Error('EMFILE: too many open files')
    mockLaunch(() => Promise.reject(original))
    const { launchChromium } = await import('../launch.js')

    await expect(launchChromium()).rejects.toBe(original)
  })

  it('Error 以外の値が投げられた場合も、取得のコマンドを添えたエラーに包み直す', async () => {
    await explains('Chromium を起動する `launchChromium` のテストです。起動が文字列で失敗する場合に、メッセージにその文字列と `playwright install chromium` が含まれ、元の値が `cause` に入ることを確認します。')
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
