/* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリ配下のみ */
// host-deps (Chromium の起動に要る OS ライブラリの確認と導入) の単体テスト。
// 起動の確認 (probe) と子プロセス (run) は差し替え、実 Chromium と apt-get は起動しない。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
  it('読み込めなかったライブラリ名を重複なく取り出す', () => {
    expect(missingSharedLibraries(`${LIBATK_FAILURE}\n... error while loading shared libraries: libasound.so.2: cannot open`))
      .toEqual(['libatk-1.0.so.0', 'libasound.so.2'])
  })

  it('ライブラリ不足でない失敗からは何も取り出さない', () => {
    expect(missingSharedLibraries('browserType.launch: Executable doesn\'t exist at /x/chrome')).toEqual([])
  })

  it('起動前の依存確認が枠付きで並べるライブラリ名も取り出す', () => {
    expect(missingSharedLibraries(BOXED_MISSING_LIBRARIES)).toEqual(['libatk-1.0.so.0', 'libasound.so.2'])
  })
})

describe('isMissingHostDependencies', () => {
  it('ライブラリ名を取り出せる失敗と、パッケージ名だけを案内する枠付きの失敗をどちらも不足とみなす', () => {
    expect(isMissingHostDependencies(LIBATK_FAILURE)).toBe(true)
    expect(isMissingHostDependencies(BOXED_MISSING_LIBRARIES)).toBe(true)
    expect(isMissingHostDependencies(BOXED_INSTALL_HINT)).toBe(true)
  })

  it('無関係な失敗は不足とみなさない', () => {
    expect(isMissingHostDependencies('browserType.launch: Executable doesn\'t exist at /x/chrome')).toBe(false)
  })
})

describe('hostPackagesFromDryRun', () => {
  it('フォントと X サーバを除いた共有ライブラリのパッケージだけを返す', () => {
    expect(hostPackagesFromDryRun(DRY_RUN_OUTPUT)).toEqual(['at-spi2-common', 'libatk1.0-0t64', 'libpango-1.0-0', 'libxdamage1'])
  })

  it('見出しが無ければ空を返す', () => {
    expect(hostPackagesFromDryRun('ERROR: Unsupported OS')).toEqual([])
  })
})

const PACKAGES = 'at-spi2-common libatk1.0-0t64 libpango-1.0-0 libxdamage1'
const APT = 'env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120'

describe('ensureChromiumHostDependencies', () => {
  it('Linux 以外は起動も確かめずに ok を返す', async () => {
    const { deps, calls } = fakeDependencies({ platform: 'darwin', probes: [LIBATK_FAILURE] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'ok' })
    expect(calls).toEqual([])
  })

  it('起動できれば何も入れずに ok を返す', async () => {
    const { deps, calls } = fakeDependencies()
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'ok' })
    expect(calls).toEqual([])
  })

  it('ライブラリ不足以外の起動失敗は launch-failed として返し、何も入れない', async () => {
    const { deps, calls } = fakeDependencies({ probes: ['browserType.launch: Executable doesn\'t exist at /x/chrome'] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'launch-failed' })
    expect(calls).toEqual([])
  })

  it('sudo を使えれば権限を確かめ、フォントと X サーバを除いて apt-get で入れ、起動を確かめ直す', async () => {
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

  it('root なら sudo を介さずに入れる', async () => {
    const { deps, calls } = fakeDependencies({ isRoot: true, probes: [LIBATK_FAILURE, undefined] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
    expect(calls.slice(1)).toEqual([
      `${APT} update`,
      `${APT} install -y --no-install-recommends ${PACKAGES}`,
    ])
  })

  it('子プロセスへ signal を渡す', async () => {
    const { deps, signals } = fakeDependencies({ probes: [LIBATK_FAILURE, undefined] })
    const controller = new AbortController()
    await ensureChromiumHostDependencies(deps, controller.signal)
    expect(signals).toHaveLength(4)
    expect(signals.every(signal => signal === controller.signal)).toBe(true)
  })

  it('apt の一覧が空で dry-run が失敗する環境では、update してから割り出し直す', async () => {
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

  it('sudo を使えなければ入れずに、足りないライブラリと入れるコマンドを案内する', async () => {
    const { deps, calls } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { 'sudo -n true': spawnResult({ exitCode: 1 }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', libraries: ['libatk-1.0.so.0'] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain(aptInstallCommand(PACKAGES.split(' ')))
    expect(calls.some(line => line.includes('apt-get'))).toBe(false)
  })

  it('不足パッケージを割り出せない OS では、足りないライブラリを示して返す', async () => {
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { '--dry-run': spawnResult({ exitCode: 1, stderr: 'ERROR: Unsupported OS' }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', packages: [] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('libatk-1.0.so.0')
    expect(outcome.detail).toContain('Unsupported OS')
  })

  it('apt-get update が失敗しても install まで進み、install が通れば入れたことにする', async () => {
    const { deps, calls } = fakeDependencies({ probes: [LIBATK_FAILURE, undefined], results: { 'apt-get -o DPkg::Lock::Timeout=120 update': spawnResult({ exitCode: 100, stderr: 'NO_PUBKEY' }) } })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
    expect(calls.some(line => line.includes('apt-get -o DPkg::Lock::Timeout=120 install'))).toBe(true)
  })

  it('update と install の両方が失敗したら、両方の理由と入れるコマンドを添えて返す', async () => {
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

  it('apt-get install がタイムアウトしたら、その旨を添えて返す', async () => {
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE], results: { 'Timeout=120 install': spawnResult({ exitCode: 100, timedOut: true, stderr: 'dpkg lock' }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing' })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('did not finish in time')
  })

  it('入れてもまだライブラリが足りなければ missing を返す', async () => {
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE, LIBATK_FAILURE] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'missing' })
  })

  it('入れたあとの失敗がライブラリ不足でなければ launch-failed を返す', async () => {
    const { deps } = fakeDependencies({ probes: [LIBATK_FAILURE, 'browserType.launch: crashed'] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toEqual({ status: 'launch-failed', detail: 'browserType.launch: crashed' })
  })

  it('起動前の依存確認が枠付きで返すライブラリ不足も、不足として入れる', async () => {
    const { deps } = fakeDependencies({ probes: [BOXED_MISSING_LIBRARIES, undefined] })
    await expect(ensureChromiumHostDependencies(deps)).resolves.toMatchObject({ status: 'installed' })
  })

  it('ライブラリ名を含まない枠付きの失敗でも、名前なしの不足として案内する', async () => {
    const { deps } = fakeDependencies({ probes: [BOXED_INSTALL_HINT], results: { 'sudo -n true': spawnResult({ exitCode: 1 }) } })
    const outcome = await ensureChromiumHostDependencies(deps)
    expect(outcome).toMatchObject({ status: 'missing', libraries: [] })
    if (outcome.status !== 'missing') return
    expect(outcome.detail).toContain('OS libraries required to launch Chromium are missing; ')
  })
})

describe('recordHostDependenciesResult', () => {
  const originalPluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
  const directories: string[] = []

  afterEach(() => {
    if (originalPluginRoot === undefined) delete process.env['CLAUDE_PLUGIN_ROOT']
    else process.env['CLAUDE_PLUGIN_ROOT'] = originalPluginRoot
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function pluginRootWithNodeModules(hasNodeModules: boolean): string {
    const root = mkdtempSync(path.join(tmpdir(), 'pecotv-host-deps-'))
    directories.push(root)
    if (hasNodeModules) mkdirSync(path.join(root, 'node_modules'))
    process.env['CLAUDE_PLUGIN_ROOT'] = root
    return root
  }

  it('リビジョン・結果・epoch 秒を 1 行で依存ルートの node_modules に書く', () => {
    const root = pluginRootWithNodeModules(true)
    const revision = chromiumRevision()
    expect(revision).toMatch(/^\d+$/)

    recordHostDependenciesResult('missing', 1_700_000_000_999)

    expect(readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toBe(`${revision ?? ''} missing 1700000000\n`)
  })

  it('結果ごとに値を書き分け、記録し直すと上書きする', () => {
    const root = pluginRootWithNodeModules(true)
    recordHostDependenciesResult('launch-failed', 1_000_000)
    recordHostDependenciesResult('ok', 2_000_000)
    expect(readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toBe(`${chromiumRevision() ?? ''} ok 2000\n`)
  })

  it('PECOTV_RUNTIME_DIR の親（runtime/）があればその直下に書く (bin/pecotv と同じ場所。node_modules の中には書かない)', () => {
    const root = pluginRootWithNodeModules(true)
    const data = mkdtempSync(path.join(tmpdir(), 'pecotv-host-deps-data-'))
    directories.push(data)
    mkdirSync(path.join(data, 'runtime'))
    process.env['PECOTV_RUNTIME_DIR'] = path.join(data, 'runtime', 'abc-def')
    try {
      recordHostDependenciesResult('ok', 3_000_000)
    }
    finally {
      delete process.env['PECOTV_RUNTIME_DIR']
    }

    expect(readFileSync(path.join(data, 'runtime', HOST_DEPS_STAMP), 'utf8')).toBe(`${chromiumRevision() ?? ''} ok 3000\n`)
    expect(() => readFileSync(path.join(root, 'node_modules', HOST_DEPS_STAMP), 'utf8')).toThrow()
  })

  it('依存ルートの node_modules が無ければ記録せず、失敗にもしない', () => {
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
