/* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリ配下のみ */
// host-deps (Chromium の起動に要る OS ライブラリの確認と導入) の単体テスト。
// 起動の確認 (probe) と子プロセス (run) は差し替え、実 Chromium と apt-get は起動しない。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetPluginRoot, stubPluginRoot } from '../../../../tests/_helpers/plugin-root-stub.js'
import type { SpawnResult } from '../../../domain/_shared/spawn-result.js'
import {
  aptInstallCommand,
  chromiumRevision,
  ensureChromiumHostDependencies,
  HOST_DEPS_STAMP,
  hostPackagesFromDryRun,
  isMissingHostDependencies,
  missingSharedLibraries,
  recordHostDependenciesResult,
  type HostDependencies,
  type HostDependenciesStampStatus,
} from '../host-dependencies.js'
import { explains } from '../../../../tests/_helpers/explains.js'

vi.mock('../../_shared/plugin-root.js', async (importOriginal) => {
  const { pluginRootMock } = await import('../../../../tests/_helpers/plugin-root-stub.js')
  return await pluginRootMock(importOriginal)
})

const LIBATK_FAILURE = 'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n'
  + '[pid=1][err] /x/chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory\n'
  + '[pid=1][err] /x/chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory'

// playwright-core 1.64 の validateDependenciesLinux が投げる、起動前の依存確認の失敗 (ライブラリ名が並ぶ形)。
// 枠は wrapInASCIIBox (padding 1) の出力。
const BOXED_MISSING_LIBRARIES = [
  '',
  '╔═══════════════════════════════════════════════════╗',
  '║ Host system is missing dependencies to run browsers. ║',
  '║ Missing libraries:                                ║',
  '║     libatk-1.0.so.0                               ║',
  '║     libasound.so.2                                ║',
  '╚═══════════════════════════════════════════════════╝',
].join('\n')

// 同じ確認の、パッケージ名を案内する形 (ライブラリ名の列を含まない)
const BOXED_INSTALL_HINT = [
  '',
  '╔══════════════════════════════════════════════════════╗',
  '║ Host system is missing dependencies to run browsers. ║',
  '║ Please install them with the following command:      ║',
  '║     sudo npx playwright install-deps                 ║',
  '╚══════════════════════════════════════════════════════╝',
].join('\n')

// playwright 1.63.0 の `install-deps --dry-run chromium` を ubuntu26.04 で実行した出力の抜粋。
// 1.64.1 でも同じ形式であることを確認済み。
const DRY_RUN_OUTPUT = [
  'Missing system dependencies (8):',
  '  at-spi2-common',
  '  fonts-wqy-zenhei',
  '  libatk1.0-0t64',
  '  libpango-1.0-0',
  '  xfonts-scalable',
  '  xserver-common',
  '  xvfb',
  '  libxdamage1',
  '',
].join('\n')

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal 無しを null で表す
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

interface FakeOptions {
  readonly platform?: NodeJS.Platform
  readonly isRoot?: boolean
  readonly probes?: readonly (string | undefined)[]
  readonly results?: Readonly<Record<string, SpawnResult>>
  /**
  先頭から順に dry-run の結果として返す (尽きたら results / 既定)。
  */
  readonly dryRuns?: SpawnResult[]
}

/**
呼ばれたコマンドを `command args...` の 1 行で記録し、先頭語 + 主要語で結果を引く。
*/
function fakeDependencies(options: FakeOptions = {}): {
  deps: HostDependencies
  calls: string[]
  notices: string[]
  records: HostDependenciesStampStatus[]
  signals: (AbortSignal | undefined)[]
} {
  const calls: string[] = []
  const notices: string[] = []
  const records: HostDependenciesStampStatus[] = []
  const signals: (AbortSignal | undefined)[] = []
  const probes = [...(options.probes ?? [undefined])]
  const dependencies: HostDependencies = {
    platform: options.platform ?? 'linux',
    isRoot: options.isRoot ?? false,
    probe: () => Promise.resolve(probes.length > 1 ? probes.shift() : probes[0]),
    run: (command, arguments_, _timeoutMs, signal) => {
      signals.push(signal)
      const line = [command, ...arguments_].join(' ')
      calls.push(line)
      const result = Object.entries(options.results ?? {}).find(([pattern]) => line.includes(pattern))?.[1]
      if (line.includes('--dry-run')) {
        const queued = options.dryRuns?.shift()
        return Promise.resolve(queued ?? result ?? spawnResult({ stdout: DRY_RUN_OUTPUT }))
      }
      return Promise.resolve(result ?? spawnResult())
    },
    playwrightCli: () => '/pw/cli.js',
    nodePath: '/node',
    record: (status) => {
      records.push(status)
    },
    notify: (message) => {
      notices.push(message)
    },
  }
  return { deps: dependencies, calls, notices, records, signals }
}

describe('missingSharedLibraries', () => {
  it('読み込めなかったライブラリ名を重複なく取り出す', async () => {
    await explains('起動失敗の出力から不足したライブラリを取り出す `missingSharedLibraries` のテストです。`libatk-1.0.so.0` が 2 回出る出力を渡した場合に、重複を除いた `libatk-1.0.so.0` と `libasound.so.2` を返すことを確認します。')
    expect(missingSharedLibraries(`${LIBATK_FAILURE}\n... error while loading shared libraries: libasound.so.2: cannot open`))
      .toEqual(['libatk-1.0.so.0', 'libasound.so.2'])
  })

  it('ライブラリの不足ではない失敗からは、ライブラリ名を取り出さない', async () => {
    await explains('起動失敗の出力から不足したライブラリを取り出す `missingSharedLibraries` のテストです。`Executable doesn\'t exist` のようにライブラリと無関係な出力を渡した場合に、空の配列を返すことを確認します。')
    expect(missingSharedLibraries('browserType.launch: Executable doesn\'t exist at /x/chrome')).toEqual([])
  })

  it('起動前の依存確認が枠付きで並べるライブラリ名も、取り出す', async () => {
    await explains('起動失敗の出力から不足したライブラリを取り出す `missingSharedLibraries` のテストです。枠で囲んでライブラリ名を並べる形式の出力を渡した場合に、`libatk-1.0.so.0` と `libasound.so.2` を返すことを確認します。')
    expect(missingSharedLibraries(BOXED_MISSING_LIBRARIES)).toEqual(['libatk-1.0.so.0', 'libasound.so.2'])
  })
})

describe('isMissingHostDependencies', () => {
  it('ライブラリ名を取り出せる失敗と、パッケージの案内だけの枠付きの失敗は、どちらも依存の不足と判定する', async () => {
    await explains('依存の不足かどうかを判定する `isMissingHostDependencies` のテストです。ライブラリ名を含む 2 種類の出力と、インストールの案内だけの出力のすべてで、`true` を返すことを確認します。')
    expect(isMissingHostDependencies(LIBATK_FAILURE)).toBe(true)
    expect(isMissingHostDependencies(BOXED_MISSING_LIBRARIES)).toBe(true)
    expect(isMissingHostDependencies(BOXED_INSTALL_HINT)).toBe(true)
  })

  it('依存の不足と無関係な失敗は、不足と判定しない', async () => {
    await explains('依存の不足かどうかを判定する `isMissingHostDependencies` のテストです。`Executable doesn\'t exist` のように無関係な出力を渡した場合に、`false` を返すことを確認します。')
    expect(isMissingHostDependencies('browserType.launch: Executable doesn\'t exist at /x/chrome')).toBe(false)
  })
})

describe('hostPackagesFromDryRun', () => {
  it('フォントと X サーバのパッケージを除き、共有ライブラリのパッケージだけを返す', async () => {
    await explains('`install-deps` の出力から入れるパッケージを取り出す `hostPackagesFromDryRun` のテストです。フォントと X サーバを含む出力を渡した場合に、`libatk1.0-0t64` などの共有ライブラリ 4 件だけを返すことを確認します。')
    expect(hostPackagesFromDryRun(DRY_RUN_OUTPUT)).toEqual(['at-spi2-common', 'libatk1.0-0t64', 'libpango-1.0-0', 'libxdamage1'])
  })

  it('不足パッケージの見出しが存在しない出力では、空の配列を返す', async () => {
    await explains('`install-deps` の出力から入れるパッケージを取り出す `hostPackagesFromDryRun` のテストです。`ERROR: Unsupported OS` のように見出しが存在しない出力を渡した場合に、空の配列を返すことを確認します。')
    expect(hostPackagesFromDryRun('ERROR: Unsupported OS')).toEqual([])
  })
})

const PACKAGES = 'at-spi2-common libatk1.0-0t64 libpango-1.0-0 libxdamage1'
const APT = 'env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120'

describe('ensureChromiumHostDependencies', () => {
  it('Linux 以外の OS では、起動の確認もせずに ok を返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`darwin` の場合に、結果が `ok` で、コマンドが 1 つも実行されないことを確認します。')
    const { deps, calls } = fakeDependencies({ platform: 'darwin', probes: [LIBATK_FAILURE] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'ok' })
    expect(calls).toEqual([])
  })

  it('Chromium を起動できた場合は、何も導入せずに ok を返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。起動の確認が成功した場合に、結果が `ok` で、コマンドが 1 つも実行されないことを確認します。')
    const { deps, calls } = fakeDependencies()
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'ok' })
    expect(calls).toEqual([])
  })

  it('ライブラリの不足以外の起動失敗は、launch-failed として返し、何も導入しない', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`Executable doesn\'t exist` の失敗の場合に、状態が `launch-failed` で、コマンドが 1 つも実行されないことを確認します。')
    const { deps, calls } = fakeDependencies({ probes: ['browserType.launch: Executable doesn\'t exist at /x/chrome'] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'launch-failed' })
    expect(calls).toEqual([])
  })

  it('sudo を使える場合は、権限を確認し、フォントと X サーバを除いて apt-get で導入し、起動を再確認する', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。不足がある環境で `sudo` を使える場合に、権限の確認・不足の判定・`apt-get update`・`install` の順に実行され、通知が 1 件出ることを確認します。')
    const { deps, calls, notices } = fakeDependencies({ probes: [LIBATK_FAILURE, undefined] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'installed', packages: PACKAGES.split(' ') })
    expect(calls).toEqual([
      'sudo -n true',
      '/node /pw/cli.js install-deps --dry-run chromium',
      `sudo -n ${APT} update`,
      `sudo -n ${APT} install -y --no-install-recommends ${PACKAGES}`,
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('apt-get')
  })

  it('root の場合は、sudo を使わずに導入する', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。root で実行している場合に、`sudo` を確認せず、`apt-get update` と `install` が直接実行されることを確認します。')
    const { deps, calls } = fakeDependencies({ isRoot: true, probes: [LIBATK_FAILURE, undefined] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
    expect(calls.slice(1)).toEqual([
      `${APT} update`,
      `${APT} install -y --no-install-recommends ${PACKAGES}`,
    ])
  })

  it('実行する子プロセスのすべてに、signal を渡す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`AbortController` の `signal` を渡した場合に、実行した 4 つの子プロセスのすべてに同じ `signal` が渡ることを確認します。')
    const { deps, signals } = fakeDependencies({ probes: [LIBATK_FAILURE, undefined] })
    const controller = new AbortController()
    await ensureChromiumHostDependencies(deps, controller.signal)
    expect(signals).toHaveLength(4)
    expect(signals.every(signal => signal === controller.signal)).toBe(true)
  })

  it('apt のパッケージ一覧が空で dry-run が失敗する環境では、update してから不足パッケージを調べ直す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。最初の `--dry-run` が失敗する場合に、`apt-get update` の後でもう一度 `--dry-run` を実行し、導入まで進むことを確認します。')
    const { deps, calls } = fakeDependencies({
      probes: [LIBATK_FAILURE, undefined],
      dryRuns: [spawnResult({ exitCode: 1, stderr: '\'apt-get install -s\' exited with code 100' })],
    })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed', packages: PACKAGES.split(' ') })
    expect(calls).toEqual([
      'sudo -n true',
      '/node /pw/cli.js install-deps --dry-run chromium',
      `sudo -n ${APT} update`,
      '/node /pw/cli.js install-deps --dry-run chromium',
      `sudo -n ${APT} install -y --no-install-recommends ${PACKAGES}`,
    ])
  })

  it('sudo を使えない場合は、導入せず、不足しているライブラリと導入のコマンドを案内する', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`sudo -n true` が失敗する場合に、状態が `missing` で、`detail` に導入のコマンドが含まれ、`apt-get` が実行されないことを確認します。')
    const { deps, calls } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { 'sudo -n true': spawnResult({ exitCode: 1 }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', libraries: ['libatk-1.0.so.0'] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain(aptInstallCommand(PACKAGES.split(' ')))
    expect(calls.some(line => line.includes('apt-get'))).toBe(false)
  })

  it('不足パッケージを調べられない OS では、不足しているライブラリを示して返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`--dry-run` が `Unsupported OS` で失敗する場合に、状態が `missing` で、`detail` にライブラリ名と `Unsupported OS` が含まれることを確認します。')
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { '--dry-run': spawnResult({ exitCode: 1, stderr: 'ERROR: Unsupported OS' }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', packages: [] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('libatk-1.0.so.0')
    expect(outcome.detail).toContain('Unsupported OS')
  })

  it('apt-get update が失敗しても install まで進み、install が成功した場合は、導入済みとして扱う', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`update` が終了コード 100 で失敗する場合でも、`install` が実行され、状態が `installed` になることを確認します。')
    const { deps, calls } = fakeDependencies({ probes: [LIBATK_FAILURE, undefined], results: { 'apt-get -o DPkg::Lock::Timeout=120 update': spawnResult({ exitCode: 100, stderr: 'NO_PUBKEY' }) } })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
    expect(calls.some(line => line.includes('apt-get -o DPkg::Lock::Timeout=120 install'))).toBe(true)
  })

  it('update と install の両方が失敗した場合は、両方の理由と導入のコマンドを添えて返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`update` と `install` がどちらも失敗する場合に、状態が `missing` で、`detail` に両方のエラーと導入のコマンドが含まれることを確認します。')
    const { deps } = fakeDependencies({
      probes: [LIBATK_FAILURE],
      results: {
        'Timeout=120 update': spawnResult({ exitCode: 100, stderr: 'Temporary failure resolving' }),
        'Timeout=120 install': spawnResult({ exitCode: 100, stderr: 'E: Unable to locate package' }),
      },
    })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing' })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('Unable to locate package')
    expect(outcome.detail).toContain('apt-get update failed: Temporary failure resolving')
    expect(outcome.detail).toContain(aptInstallCommand(PACKAGES.split(' ')))
  })

  it('apt-get install がタイムアウトした場合は、その旨を添えて返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。`install` がタイムアウトした場合に、状態が `missing` で、`detail` に `did not finish in time` が含まれることを確認します。')
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { 'Timeout=120 install': spawnResult({ exitCode: 100, timedOut: true, stderr: 'dpkg lock' }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing' })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('did not finish in time')
  })

  it('導入した後もライブラリが不足している場合は、missing を返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。導入した後の起動の確認が、再びライブラリの不足で失敗する場合に、状態が `missing` になることを確認します。')
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE, LIBATK_FAILURE] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'missing' })
  })

  it('導入した後の失敗がライブラリの不足でない場合は、launch-failed を返す', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。導入した後の起動の確認が `browserType.launch: crashed` で失敗する場合に、状態が `launch-failed` で、その出力が `detail` に入ることを確認します。')
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE, 'browserType.launch: crashed'] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'launch-failed', detail: 'browserType.launch: crashed' })
  })

  it('起動前の依存確認が枠付きで返すライブラリの不足も、不足として導入する', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。起動前の確認が枠付きでライブラリの不足を返す場合に、導入が行われ、状態が `installed` になることを確認します。')
    const { deps } = fakeDependencies({ probes: [BOXED_MISSING_LIBRARIES, undefined] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
  })

  it('ライブラリ名を含まない枠付きの失敗でも、ライブラリ名なしの不足として案内する', async () => {
    await explains('Chromium の依存を整える `ensureChromiumHostDependencies` のテストです。インストールの案内だけの枠付きの出力で `sudo` を使えない場合に、状態が `missing` で、`libraries` が空になり、`detail` に不足の説明が含まれることを確認します。')
    const { deps } = fakeDependencies({ probes: [BOXED_INSTALL_HINT], results: { 'sudo -n true': spawnResult({ exitCode: 1 }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', libraries: [] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('OS libraries required to launch Chromium are missing; ')
  })
})

describe('recordHostDependenciesResult', () => {
  const directories: string[] = []

  afterEach(() => {
    resetPluginRoot()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function pluginRootWithNodeModules(hasNodeModules: boolean): string {
    const root = mkdtempSync(path.join(tmpdir(), 'pecotv-host-deps-'))
    directories.push(root)
    if (hasNodeModules) mkdirSync(path.join(root, 'node_modules'))
    stubPluginRoot(root)
    return root
  }

  it('リビジョン・結果・epoch 秒を 1 行にして、依存ルートの node_modules に書き込む', async () => {
    await explains('確認結果を記録する `recordHostDependenciesResult` のテストです。`missing` と時刻を渡した場合に、リビジョン・結果・秒単位の時刻が 1 行で書き込まれることを確認します。')
    const root = pluginRootWithNodeModules(true)
    const revision = chromiumRevision()
    expect(revision).toMatch(/^\d+$/)

    recordHostDependenciesResult('missing', 1_700_000_000_999)

    expect(readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toBe(`${revision ?? ''} missing 1700000000\n`)
  })

  it('結果の値を書き分け、記録し直した場合は上書きする', async () => {
    await explains('確認結果を記録する `recordHostDependenciesResult` のテストです。`launch-failed` の後に `ok` を記録した場合に、ファイルの内容が後の `ok` と時刻で上書きされることを確認します。')
    const root = pluginRootWithNodeModules(true)
    recordHostDependenciesResult('launch-failed', 1_000_000)
    recordHostDependenciesResult('ok', 2_000_000)
    expect(readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toBe(`${chromiumRevision() ?? ''} ok 2000\n`)
  })

  it('依存ルートに node_modules が存在しない場合は、記録せず、エラーにもしない', async () => {
    await explains('確認結果を記録する `recordHostDependenciesResult` のテストです。`node_modules` が存在しない場合に、例外が発生せず、記録のファイルも作成されないことを確認します。')
    const root = pluginRootWithNodeModules(false)
    const home = process.env['HOME']
    process.env['HOME'] = root
    try {
      expect(() => {
        recordHostDependenciesResult('ok')
      }).not.toThrow()
    }
    finally {
      if (home === undefined) delete process.env['HOME']
      else process.env['HOME'] = home
    }
    expect(() => readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toThrow()
  })
})
