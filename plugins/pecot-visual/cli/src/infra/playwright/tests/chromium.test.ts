// Playwright Chromium の取得状態判定と取得コマンド組み立ての単体テスト。
//
// 判定は、Playwright 自身の解決 (chromium.executablePath()) で行う。
// 完了時に Playwright が置く INSTALLATION_COMPLETE マーカーも使う。
// 実行ホストの chromium の有無に結果が依存しないよう、`playwright` は一時ディレクトリを指す mock に差し替える。
// mock は tests/_helpers/chromium-cache.ts にある。
// 実 Chromium のダウンロードには到達しない。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createChromiumCacheDirectory,
  markChromiumInstalled,
  removeChromiumCacheDirectory,
  stubUnresolvableChromium,
} from '../../../../tests/_helpers/chromium-cache.js'
import {
  browsersRoot,
  installChromium,
  installLockPath,
  isAutoInstallEnabled,
  isChromiumInstalled,
  resolvePlaywrightCli,
} from '../chromium.js'

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
  for (const directory of temporaryDirectories.splice(0)) removeChromiumCacheDirectory(directory)
})

describe('browsersRoot', () => {
  it('PLAYWRIGHT_BROWSERS_PATH が立っていればそちらを返す', () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/elsewhere/ms-playwright')

    expect(browsersRoot()).toBe('/elsewhere/ms-playwright')
  })

  it('未設定なら HOME 配下の .cache/ms-playwright を返す', () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '')
    vi.stubEnv('HOME', '/home/someone')

    expect(browsersRoot()).toBe('/home/someone/.cache/ms-playwright')
  })

  it('PLAYWRIGHT_BROWSERS_PATH=0 は場所を特定できないため undefined を返す', () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0')

    expect(browsersRoot()).toBeUndefined()
  })

  it('HOME も未設定なら undefined を返す', () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '')
    vi.stubEnv('HOME', '')

    expect(browsersRoot()).toBeUndefined()
  })
})

describe('isChromiumInstalled', () => {
  it('取得完了マーカーがあれば取得済みと判定する', async () => {
    stubBrowsersRoot(true)

    expect(await isChromiumInstalled()).toBe(true)
  })

  it('ディレクトリはあってもマーカーが無ければ未取得と判定する', async () => {
    // Playwright は zip の展開先を先に作るため、ディレクトリの存在だけでは
    // ダウンロード途中の半端な状態を取得済みと誤判定する。
    const directory = stubBrowsersRoot(false)

    expect(await isChromiumInstalled()).toBe(false)

    markChromiumInstalled(directory)
    expect(await isChromiumInstalled()).toBe(true)
  })

  it('browsers root ごと無ければ未取得と判定する', async () => {
    const directory = stubBrowsersRoot(true)
    removeChromiumCacheDirectory(directory)

    expect(await isChromiumInstalled()).toBe(false)
  })

  it('別リビジョンの chromium が取得済みでも、必要なリビジョンが無ければ未取得と判定する', async () => {
    // playwright を上げた直後の状態。
    // `chromium-*` の前方一致だと取得済みと誤判定する。
    // すると、ガードが働かず、Playwright の生エラーだけが返る。
    const directory = stubBrowsersRoot(false)
    const otherRevision = path.join(directory, 'chromium-9999')
    mkdirSync(otherRevision)
    writeFileSync(path.join(otherRevision, 'INSTALLATION_COMPLETE'), '')

    expect(await isChromiumInstalled()).toBe(false)
  })

  it('Playwright 側で解決できないときは取得済み扱いで通す', async () => {
    // 誤検知で使える機能を止めるより、実際の起動失敗を各コマンドのエラーとして返す方が害は小さい。
    stubUnresolvableChromium()

    expect(await isChromiumInstalled()).toBe(true)
  })
})

describe('isAutoInstallEnabled', () => {
  it('PECOTV_AUTO_INSTALL_BROWSER=1 のときだけ true', () => {
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

  it('プラグインルート配下の node_modules が実在すればそこに置く', () => {
    const pluginRoot = createRootWithNodeModules()
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', createTemporaryDirectory())

    expect(installLockPath()).toBe(path.join(pluginRoot, 'node_modules', '.pecotv-chromium-install.lock'))
  })

  it('プラグインルートに無く永続層だけにあれば、永続層側へ置く (単体配布)', () => {
    const data = createTemporaryDirectory()
    mkdirSync(path.join(data, 'mcp-dist', 'node_modules'), { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', path.join(createTemporaryDirectory(), 'no-node-modules'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(installLockPath())
      .toBe(path.join(data, 'mcp-dist', 'node_modules', '.pecotv-chromium-install.lock'))
  })

  it('PECOTV_RUNTIME_DIR の親（runtime/）があればそこに置く (bin/pecotv と同じ場所。node_modules の中には置かない)', () => {
    // ミラーの node_modules はハードリンク複製で世代間に inode を共有するため、中に置くと食い違う。
    const pluginRoot = createRootWithNodeModules()
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    const data = createTemporaryDirectory()
    mkdirSync(path.join(data, 'runtime'))
    vi.stubEnv('PECOTV_RUNTIME_DIR', path.join(data, 'runtime', 'abc-def'))

    expect(installLockPath()).toBe(path.join(data, 'runtime', '.pecotv-chromium-install.lock'))
  })

  it('PECOTV_RUNTIME_DIR の親が無ければ、従来の node_modules を使う', () => {
    const pluginRoot = createRootWithNodeModules()
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    vi.stubEnv('PECOTV_RUNTIME_DIR', path.join(createTemporaryDirectory(), 'runtime', 'abc-def'))

    expect(installLockPath()).toBe(path.join(pluginRoot, 'node_modules', '.pecotv-chromium-install.lock'))
  })

  it('どの依存ルートにも node_modules が無ければ undefined (ロックなしで動く)', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', createTemporaryDirectory())

    expect(installLockPath()).toBeUndefined()
  })

  it('bin/pecotv がバックグラウンド取得に使うロックと同じパスを指す', () => {
    // 片側だけ動かすと、2 つの取得が別々のロックを取り、同じ chromium を二重にダウンロードする。
    // bash 側は $PLUGIN_ROOT からの相対で組み立てている。
    // そのため、その断片と一致するかを確かめる。
    // src/infra/playwright/tests → cli/ → plugins/pecot-visual
    const pluginRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    const data = createTemporaryDirectory()
    mkdirSync(path.join(data, 'runtime'))
    vi.stubEnv('PECOTV_RUNTIME_DIR', path.join(data, 'runtime', 'abc-def'))
    const fromBash = readBinPecotvLockPath(path.join(pluginRoot, 'bin', 'pecotv'))

    expect(installLockPath()).toBe(path.join(data, 'runtime', fromBash))
  })
})

/**
bin/pecotv の CHROMIUM_INSTALL_LOCK 定義から ${RUNTIME_BASE}（`${データ置き場}/runtime`）以降のファイル名を取り出す。
*/
function readBinPecotvLockPath(binPath: string): string {
  const source = readFileSync(binPath, 'utf8')
  const matched = /^\s*CHROMIUM_INSTALL_LOCK="\$RUNTIME_BASE\/(?<relative>[^"]+)"$/m.exec(source)
  const relative = matched?.groups?.['relative']
  if (relative === undefined) throw new Error('bin/pecotv に CHROMIUM_INSTALL_LOCK の定義が見つかりません')
  return relative
}

describe('resolvePlaywrightCli', () => {
  it('playwright パッケージ root 直下の cli.js を指す', () => {
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
flock(1) を通すためのロック置き場 (CLAUDE_PLUGIN_ROOT/node_modules)。
*/
function stubPluginRoot(): void {
  const root = createTemporaryDirectory()
  mkdirSync(path.join(root, 'node_modules'))
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', root)
}

describe('installChromium', () => {
  it('playwright を解決できないときは throw せず起動失敗の SpawnResult を返す', async () => {
    // ここで throw すると、MCP ハンドラの外へ例外が出る。
    // SDK は、structuredContent 無しのエラーに変えてしまう。
    // すると、reason と `runtime_setup` 誘導という ToolResult の契約が失われる。
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

  it('Error でない値が throw されても起動失敗の SpawnResult に落とす', async () => {
    // 解決口が文字列を throw する実装に差し替わっても、`String(error)` で理由を残す。
    // ここで潰れると stderr が空のまま exitCode: null だけが返り、原因が消える。
    const result = await installChromium({
      resolveCli: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error 例外の整形を見るテスト
        throw 'playwright is missing'
      },
    })

    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('playwright is missing')
  })

  it('取得コマンドを起動し、その stdout / exit code をそのまま返す', async () => {
    stubPluginRoot()
    const cliPath = writeFakeCli('process.stdout.write(process.argv.slice(2).join(" "))\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.exitCode).toBe(0)
    // 引数は `install chromium` 固定。flock を通しても、同じ引数で node が起動する。
    expect(result.stdout).toBe('install chromium')
  })

  it('取得コマンドの失敗をそのまま返す', async () => {
    stubPluginRoot()
    const cliPath = writeFakeCli('process.stderr.write("download failed\\n"); process.exit(1)\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('download failed')
  })

  it('NODE_EXTRA_CA_CERTS が未設定なら未設定のまま取得プロセスへ渡す', async () => {
    // pecot は証明書を足さない。空文字とも区別して、子が受け取った値そのものを見る。
    stubPluginRoot()
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    const cliPath = writeFakeCli('process.stdout.write(process.env.NODE_EXTRA_CA_CERTS ?? "<unset>")\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.stdout).toBe('<unset>')
  })

  it('NODE_EXTRA_CA_CERTS が設定済みならその値のまま渡す', async () => {
    // 利用者の値を pecot が書き換えないことを確かめる。
    stubPluginRoot()
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem')
    const cliPath = writeFakeCli('process.stdout.write(process.env.NODE_EXTRA_CA_CERTS ?? "<unset>")\n')

    const result = await installChromium({ resolveCli: () => cliPath })

    expect(result.stdout).toBe('/etc/ssl/corp.pem')
  })

  it('signal が abort されたら子プロセスを打ち切る', async () => {
    // 配線していないと、クライアントが諦めたあとも取得が続き、ロックを保持し続ける。
    stubPluginRoot()
    const cliPath = writeFakeCli('setTimeout(() => {}, 60_000)\n')
    const result = await installChromium({ resolveCli: () => cliPath, signal: AbortSignal.timeout(50) })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
  })

  it('abort 済みの signal を渡されたら起動直後に打ち切る', async () => {
    // abort 済みの signal に後からリスナを足しても発火しない。
    // 現在値を先に見ていないと、クライアントが既に諦めた要求で 120MB の取得が最後まで続く。
    stubPluginRoot()
    const cliPath = writeFakeCli('setTimeout(() => {}, 60_000)\n')

    const result = await installChromium({ resolveCli: () => cliPath, signal: AbortSignal.abort() })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
  })
})
