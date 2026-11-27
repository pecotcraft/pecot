// Playwright Chromium の取得状態判定と取得コマンド組み立ての単体テスト。
//
// 判定は、Playwright 自身の解決 (chromium.executablePath()) で行う。
// 完了時に Playwright が置く INSTALLATION_COMPLETE マーカーも使う。
// 実行ホストの chromium の有無に結果が依存しないよう、`playwright` は一時ディレクトリを指す mock に差し替える。
// mock は tests/_helpers/chromium-cache.ts にある。
// 実 Chromium のダウンロードには到達しない。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createChromiumCacheDirectory,
  markChromiumInstalled,
  removeChromiumCacheDirectory,
  stubUnresolvableChromium,
} from '../../../../tests/_helpers/chromium-cache.js'
import { resetPluginRoot, stubPluginRoot } from '../../../../tests/_helpers/plugin-root-stub.js'
import {
  browsersRoot,
  installChromium,
  installLockPath,
  isAutoInstallEnabled,
  isChromiumInstalled,
  resolvePlaywrightCli,
} from '../chromium.js'
import { explains } from '../../../../tests/_helpers/explains.js'

vi.mock('../../_shared/plugin-root.js', async (importOriginal) => {
  const { pluginRootMock } = await import('../../../../tests/_helpers/plugin-root-stub.js')
  return await pluginRootMock(importOriginal)
})

const temporaryDirectories: string[] = []

function stubBrowsersRoot(isInstalled: boolean): string {
  const directory = createChromiumCacheDirectory(isInstalled)
  temporaryDirectories.push(directory)
  return directory
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-chromium-unit-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetPluginRoot()
  for (const directory of temporaryDirectories.splice(0)) removeChromiumCacheDirectory(directory)
})

describe('browsersRoot', () => {
  it('PLAYWRIGHT_BROWSERS_PATH が設定されている場合は、その値を返す', async () => {
    await explains('ブラウザの置き場を求める `browsersRoot` のテストです。環境変数 `PLAYWRIGHT_BROWSERS_PATH` に `/elsewhere/ms-playwright` を設定した場合に、その値が返ることを確認します。')
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/elsewhere/ms-playwright')

    expect(browsersRoot()).toBe('/elsewhere/ms-playwright')
  })

  it('PLAYWRIGHT_BROWSERS_PATH が未設定の場合は、HOME 配下の .cache/ms-playwright を返す', async () => {
    await explains('ブラウザの置き場を求める `browsersRoot` のテストです。`HOME` が `/home/someone` の場合に、`/home/someone/.cache/ms-playwright` が返ることを確認します。')
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '')
    vi.stubEnv('HOME', '/home/someone')

    expect(browsersRoot()).toBe('/home/someone/.cache/ms-playwright')
  })

  it('PLAYWRIGHT_BROWSERS_PATH が 0 の場合は、場所を特定できないため undefined を返す', async () => {
    await explains('ブラウザの置き場を求める `browsersRoot` のテストです。`PLAYWRIGHT_BROWSERS_PATH` が `0` の場合は、`undefined` が返ることを確認します。')
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0')

    expect(browsersRoot()).toBeUndefined()
  })

  it('PLAYWRIGHT_BROWSERS_PATH と HOME のどちらも未設定の場合は、undefined を返す', async () => {
    await explains('ブラウザの置き場を求める `browsersRoot` のテストです。`PLAYWRIGHT_BROWSERS_PATH` と `HOME` がどちらも空の場合に、`undefined` が返ることを確認します。')
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '')
    vi.stubEnv('HOME', '')

    expect(browsersRoot()).toBeUndefined()
  })
})

describe('isChromiumInstalled', () => {
  it('取得完了のマーカーが存在する場合は、取得済みと判定する', async () => {
    await explains('Chromium の取得状態を判定する `isChromiumInstalled` のテストです。ブラウザの置き場に取得完了のマーカーがある場合に、`true` を返すことを確認します。')
    stubBrowsersRoot(true)

    expect(await isChromiumInstalled()).toBe(true)
  })

  it('ディレクトリが存在しても、取得完了のマーカーが存在しない場合は、未取得と判定する', async () => {
    // Playwright は zip の展開先を先に作るため、ディレクトリの存在だけでは
    // ダウンロード途中の半端な状態を取得済みと誤判定する。
    await explains('Chromium の取得状態を判定する `isChromiumInstalled` のテストです。ディレクトリだけがあり、マーカーが存在しない場合に `false` を返し、マーカーを置くと `true` になることを確認します。')
    const directory = stubBrowsersRoot(false)

    expect(await isChromiumInstalled()).toBe(false)

    markChromiumInstalled(directory)
    expect(await isChromiumInstalled()).toBe(true)
  })

  it('ブラウザの置き場そのものが存在しない場合は、未取得と判定する', async () => {
    await explains('Chromium の取得状態を判定する `isChromiumInstalled` のテストです。ブラウザの置き場のディレクトリを削除した場合に、`false` を返すことを確認します。')
    const directory = stubBrowsersRoot(true)
    removeChromiumCacheDirectory(directory)

    expect(await isChromiumInstalled()).toBe(false)
  })

  it('別のリビジョンの chromium が取得済みでも、必要なリビジョンが存在しない場合は、未取得と判定する', async () => {
    // playwright を上げた直後の状態。
    // `chromium-*` の前方一致だと取得済みと誤判定する。
    // すると、ガードが働かず、Playwright の生エラーだけが返る。
    await explains('Chromium の取得状態を判定する `isChromiumInstalled` のテストです。`chromium-9999` だけが取得済みで、必要なリビジョンが存在しない場合に、`false` を返すことを確認します。')
    const directory = stubBrowsersRoot(false)
    const otherRevision = path.join(directory, 'chromium-9999')
    mkdirSync(otherRevision)
    writeFileSync(path.join(otherRevision, 'INSTALLATION_COMPLETE'), '')

    expect(await isChromiumInstalled()).toBe(false)
  })

  it('Playwright が Chromium の場所を解決できない場合は、取得済みとして扱う', async () => {
    // 誤検知で使える機能を止めるより、実際の起動失敗を各コマンドのエラーとして返す方が害は小さい。
    await explains('Chromium の取得状態を判定する `isChromiumInstalled` のテストです。Playwright が実行ファイルの場所を解決できない場合に、`true` を返し、実際の起動の失敗は各コマンドに任せることを確認します。')
    stubUnresolvableChromium()

    expect(await isChromiumInstalled()).toBe(true)
  })
})

describe('isAutoInstallEnabled', () => {
  it('PECOTV_AUTO_INSTALL_BROWSER が 1 の場合だけ、自動取得を有効と判定する', async () => {
    await explains('自動取得の設定を判定する `isAutoInstallEnabled` のテストです。`PECOTV_AUTO_INSTALL_BROWSER` が `1` の場合だけ `true` になり、`true` や空文字では `false` になることを確認します。')
    vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', '1')
    expect(isAutoInstallEnabled()).toBe(true)

    vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', 'true')
    expect(isAutoInstallEnabled()).toBe(false)

    vi.stubEnv('PECOTV_AUTO_INSTALL_BROWSER', '')
    expect(isAutoInstallEnabled()).toBe(false)
  })
})

/**
node_modules を持つ依存ルートを一時ディレクトリに作る。
*/
function createRootWithNodeModules(): string {
  const root = createTemporaryDirectory()
  mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  return root
}

describe('installLockPath', () => {
  // ロックは依存ルートの node_modules に置く。
  // プラグイン配布と単体配布で場所が違うので、両方を見る。
  // 実在しない親ディレクトリを返してはいけない。
  // flock(1) はロックファイルを作れず exit 66 で終わり、chromium 取得そのものが必ず失敗する。
  // これは #982 で確認した。

  it('プラグインルート配下に node_modules が存在する場合は、そこにロックを置く', async () => {
    await explains('取得時のロックファイルの場所を求める `installLockPath` のテストです。`CLAUDE_PLUGIN_ROOT` の配下に `node_modules` が存在する場合は、その中の `.pecotv-chromium-install.lock` が返ることを確認します。')
    const pluginRoot = createRootWithNodeModules()
    stubPluginRoot(pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', createTemporaryDirectory())

    expect(installLockPath()).toBe(path.join(pluginRoot, 'node_modules', '.pecotv-chromium-install.lock'))
  })

  it('プラグインルートに存在せず永続層だけにある場合は、永続層の node_modules にロックを置く（単体配布）', async () => {
    await explains('取得時のロックファイルの場所を求める `installLockPath` のテストです。`CLAUDE_PLUGIN_DATA` の `mcp-dist/node_modules` だけが存在する場合に、そこにロックのパスが返ることを確認します。')
    const data = createTemporaryDirectory()
    mkdirSync(path.join(data, 'mcp-dist', 'node_modules'), { recursive: true })
    stubPluginRoot(path.join(createTemporaryDirectory(), 'no-node-modules'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(installLockPath())
      .toBe(path.join(data, 'mcp-dist', 'node_modules', '.pecotv-chromium-install.lock'))
  })

  it('どの依存ルートにも node_modules が存在しない場合は、undefined を返す（ロックなしで動く）', async () => {
    await explains('取得時のロックファイルの場所を求める `installLockPath` のテストです。どこにも `node_modules` が存在しない場合に、`undefined` が返ることを確認します。')
    stubPluginRoot(createTemporaryDirectory())
    vi.stubEnv('CLAUDE_PLUGIN_DATA', createTemporaryDirectory())

    expect(installLockPath()).toBeUndefined()
  })

  it('playwright パッケージの root 直下にある cli.js を指す', async () => {
    await explains('Playwright の CLI の場所を求める `resolvePlaywrightCli` のテストです。返るパスが、`playwright` パッケージの直下の `cli.js` を指すことを確認します。')
    expect(resolvePlaywrightCli()).toMatch(/[/\\]playwright[/\\]cli\.js$/)
  })
})

/**
playwright CLI の代わりに起動する最小スクリプトを置く。
*/
function writeFakeCli(body: string): string {
  const directory = createTemporaryDirectory()
  const cliPath = path.join(directory, 'fake-cli.cjs')
  writeFileSync(cliPath, body)
  return cliPath
}

/**
flock(1) を通すためのロック置き場（プラグインルートの node_modules）。
*/
function stubLockRoot(): void {
  stubPluginRoot(createRootWithNodeModules())
}

describe('installChromium', () => {
  it('playwright を解決できない場合は、例外を投げず、起動失敗を表す SpawnResult を返す', async () => {
    // ここで throw すると、MCP ハンドラの外へ例外が出る。
    // SDK は、structuredContent 無しのエラーに変えてしまう。
    // すると、reason と `runtime_setup` 誘導という ToolResult の契約が失われる。
    await explains('Chromium を取得する `installChromium` のテストです。`playwright` を解決できず例外が発生する場合に、終了コードが `null` で、`stderr` に `playwright` を含む結果が返ることを確認します。')
    const result = await installChromium({
      resolveCli: () => {
        throw new Error('Cannot find module playwright/package.json')
      },
    })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain('playwright')
    expect(result.stdout).toBe('')
  })

  it('Error でない値が例外として投げられた場合も、起動失敗を表す SpawnResult を返す', async () => {
    // 解決口が文字列を throw する実装に差し替わっても、`String(error)` で理由を残す。
    // ここで潰れると stderr が空のまま exitCode: null だけが返り、原因が消える。
    await explains('Chromium を取得する `installChromium` のテストです。解決の処理が文字列を投げた場合に、終了コードは `null` になり、`stderr` にその文字列を含む結果が返ることを確認します。')
    const result = await installChromium({
      resolveCli: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error 例外の整形を見るテスト
        throw 'playwright is missing'
      },
    })

    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('playwright is missing')
  })

  it('取得のコマンドを起動し、標準出力と終了コードをそのまま返す', async () => {
    await explains('Chromium を取得する `installChromium` のテストです。代わりの CLI を渡した場合に、終了コードが 0 で、標準出力が引数の `install chromium` になることを確認します。')
    stubLockRoot()
    const cliPath = writeFakeCli('process.stdout.write(process.argv.slice(2).join(" "))\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.exitCode).toBe(0)
    // 引数は `install chromium` 固定。flock を通しても、同じ引数で node が起動する。
    expect(result.stdout).toBe('install chromium')
  })

  it('取得のコマンドが失敗した場合は、終了コードと標準エラー出力をそのまま返す', async () => {
    await explains('Chromium を取得する `installChromium` のテストです。代わりの CLI が終了コード 1 で終わる場合に、その終了コードと標準エラー出力が返ることを確認します。')
    stubLockRoot()
    const cliPath = writeFakeCli('process.stderr.write("download failed\\n"); process.exit(1)\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('download failed')
  })

  it('NODE_EXTRA_CA_CERTS が未設定の場合は、未設定のまま取得のプロセスへ渡す', async () => {
    // pecot は証明書を足さない。空文字とも区別して、子が受け取った値そのものを見る。
    await explains('Chromium を取得する `installChromium` のテストです。`NODE_EXTRA_CA_CERTS` が未設定の場合に、起動したプロセスでも未設定のまま（`<unset>`）になることを確認します。')
    stubLockRoot()
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    const cliPath = writeFakeCli('process.stdout.write(process.env.NODE_EXTRA_CA_CERTS ?? "<unset>")\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.stdout).toBe('<unset>')
  })

  it('NODE_EXTRA_CA_CERTS が設定されている場合は、その値のまま取得のプロセスへ渡す', async () => {
    // 利用者の値を pecot が書き換えないことを確かめる。
    await explains('Chromium を取得する `installChromium` のテストです。`NODE_EXTRA_CA_CERTS` に `/etc/ssl/corp.pem` を設定した場合に、起動したプロセスにも同じ値が渡ることを確認します。')
    stubLockRoot()
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem')
    const cliPath = writeFakeCli('process.stdout.write(process.env.NODE_EXTRA_CA_CERTS ?? "<unset>")\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.stdout).toBe('/etc/ssl/corp.pem')
  })

  it('signal が中断された場合は、子プロセスを終了させる', async () => {
    // 配線していないと、クライアントが諦めたあとも取得が続き、ロックを保持し続ける。
    await explains('Chromium を取得する `installChromium` のテストです。実行中の `signal` が中断された場合は、終了コードが `null` で、シグナルが `SIGTERM` の結果が返ることを確認します。')
    stubLockRoot()
    const cliPath = writeFakeCli('setTimeout(() => {}, 60_000)\n')
    const result = await installChromium({ resolveCli: () => cliPath, signal: AbortSignal.timeout(50) })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
  })

  it('中断済みの signal を渡した場合は、起動の直後に子プロセスを終了させる', async () => {
    // abort 済みの signal に後からリスナを足しても発火しない。
    // 現在値を先に見ていないと、クライアントが既に諦めた要求で 120MB の取得が最後まで続く。
    await explains('Chromium を取得する `installChromium` のテストです。すでに中断された `signal` を渡した場合に、終了コードが `null` で、シグナルが `SIGTERM` の結果が返ることを確認します。')
    stubLockRoot()
    const cliPath = writeFakeCli('setTimeout(() => {}, 60_000)\n')

    const result = await installChromium({ resolveCli: () => cliPath, signal: AbortSignal.abort() })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
  })
})
