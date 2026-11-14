// infra/_shared/dependency-root.ts の unit test。
//
// 見たいのは 2 つの依存ルートの切り替えそのもの。
// 一時ディレクトリに 2 つの依存ルートを作り分ける。
// 1 つ目はプラグイン側 (`$CLAUDE_PLUGIN_ROOT/node_modules`)。
// 2 つ目は単体配布側 (`${データ置き場}/mcp-dist/node_modules`)。
// 優先順・fallback・どちらも無いときの挙動を固定する。
//
// 依存ルートかどうかの判定は、代表パッケージ (RUNTIME_DEPENDENCY_PROBES) がその node_modules 配下から引けるかで決まる。
// そのためテストの一時ツリーにも実体を置く (tests/_helpers/dependency-probes.ts)。
// 永続層は版を持たない固定パスなので、install stamp の比較も併せて固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  areRuntimeDependenciesInstalled,
  dataDirectory,
  dependencyRoots,
  existingDependencyNodeModules,
  isRuntimeLayerInstalled,
  pluginDependencyRoot,
  resolveDependency,
  resolveTalkDirectoryNodeModules,
  runtimeDependencyRoot,
  runtimeInstallStampPath,
  runningMirrorDirectory,
  themeStoreRoot,
  runtimeStateDirectory,
  stateFileDirectory,
} from '../../../src/infra/_shared/dependency-root.js'
import { resolvePluginRoot } from '../../../src/infra/_shared/plugin-root.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { stubNoDataDirectory } from '../../_helpers/no-data-directory.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const temporaryRoot = useTemporaryDirectory('pecotv-dependency-root-', { resolveRealPath: true })

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

/**
`<temporaryRoot()>/<name>` を依存ルート (probe 入りの node_modules 付き) として作る。
*/
function createRoot(name: string, packages: readonly string[] = []): string {
  const root = temporaryRoot(name)
  seedDependencyRoot(root, packages)
  return root
}

/**
node_modules は在るが probe が 1 つも引けないルート。
*/
function createEmptyRoot(name: string): string {
  const root = temporaryRoot(name)
  mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  return root
}

/**
永続層の実体 (`<データ置き場>/mcp-dist`) を作り、CLAUDE_PLUGIN_DATA を stub する。
*/
function createRuntimeRoot(packages: readonly string[] = []): string {
  const data = temporaryRoot('data')
  const runtime = path.join(data, 'mcp-dist')
  seedDependencyRoot(runtime, packages)
  vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
  return runtime
}

/**
永続層の実体を作り、必要なら stamp を置いたうえで判定する。
*/
function hasRuntimeLayer(stamp?: string): boolean {
  createRuntimeRoot()
  if (stamp !== undefined) writeStamp(stamp)
  return isRuntimeLayerInstalled('expected-stamp')
}

/**
永続層に install stamp を置く。
*/
function writeStamp(stamp: string): void {
  const stampPath = runtimeInstallStampPath()
  if (stampPath === undefined) throw new Error('データ置き場を stub してから呼ぶこと')
  writeFileSync(stampPath, `${stamp}\n`, 'utf8')
}

describe('ルートの解決', () => {
  it('永続層はデータ置き場の mcp-dist/、置き場を決められなければ undefined', () => {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(runtimeDependencyRoot()).toBe(path.join('/fake/data', 'mcp-dist'))

    stubNoDataDirectory()
    expect(runtimeDependencyRoot()).toBeUndefined()
  })

  it('永続層は作らずに値だけを返す', () => {
    const data = temporaryRoot('not-created', 'data')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(runtimeDependencyRoot()).toBe(path.join(data, 'mcp-dist'))
    expect(existsSync(data)).toBe(false)
  })

  it('プラグインルートは CLAUDE_PLUGIN_ROOT。空白のみは未設定と同じ', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')
    expect(pluginDependencyRoot()).toBe('/plugins/pecot-visual')

    vi.stubEnv('CLAUDE_PLUGIN_ROOT', ' '.repeat(3))
    expect(pluginDependencyRoot()).toBeUndefined()
  })

  it('探索順はプラグインのパス → 永続層', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')

    expect(dependencyRoots()).toEqual([
      '/plugins/pecot-visual',
      path.join('/fake/data', 'mcp-dist'),
    ])
  })

  it('決められないルートは列から落ちる', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    stubNoDataDirectory()

    expect(dependencyRoots()).toEqual([])
  })

  it('install stamp は永続層直下。場所が決まらなければ undefined', () => {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(runtimeInstallStampPath())
      .toBe(path.join('/fake/data', 'mcp-dist', '.pecotv-runtime-stamp'))

    stubNoDataDirectory()
    expect(runtimeInstallStampPath()).toBeUndefined()
  })
})

describe('themeStoreRoot', () => {
  it('CLAUDE_PLUGIN_DATA があると、その下の themes を返す', () => {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(themeStoreRoot()).toBe(path.join('/fake/data', 'themes'))
  })

  it('CLAUDE_PLUGIN_DATA が空で PLUGIN_DATA があると、その下の themes を返す', () => {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '')
    vi.stubEnv('PLUGIN_DATA', '/fake/standalone')
    expect(themeStoreRoot()).toBe(path.join('/fake/standalone', 'themes'))
  })

  it('どちらも無く置き場を決められなければ undefined', () => {
    stubNoDataDirectory()
    expect(themeStoreRoot()).toBeUndefined()
  })
})

describe('PECOTV_DEPENDENCY_ROOT (bin/pecotv がミラーの依存ルートを渡す場合)', () => {
  // ミラー方式では実行用の依存が ${データ置き場}/runtime/current 側にあり、同梱アセットは
  // CLAUDE_PLUGIN_ROOT 側にある。2 つを別の変数で受け、依存の解決だけを前者へ向ける。

  it('PECOTV_DEPENDENCY_ROOT があれば CLAUDE_PLUGIN_ROOT より優先する', () => {
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', '/data/runtime/current')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')

    expect(pluginDependencyRoot()).toBe('/data/runtime/current')
    expect(dependencyRoots()[0]).toBe('/data/runtime/current')
  })

  it('空白のみの PECOTV_DEPENDENCY_ROOT は未設定と同じで、従来の CLAUDE_PLUGIN_ROOT に降りる', () => {
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', ' '.repeat(2))
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')

    expect(pluginDependencyRoot()).toBe('/plugins/pecot-visual')
  })

  it('PECOTV_DEPENDENCY_ROOT 未設定の従来解決は変わらない', () => {
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', undefined)
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')

    expect(dependencyRoots()).toEqual([
      '/plugins/pecot-visual',
      path.join('/fake/data', 'mcp-dist'),
    ])
  })

  it('同梱アセットの起点 (resolvePluginRoot) は PECOTV_DEPENDENCY_ROOT に引きずられず CLAUDE_PLUGIN_ROOT を読む', () => {
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', '/data/runtime/current')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/pecot-visual')

    expect(resolvePluginRoot()).toBe('/plugins/pecot-visual')
  })

  it('CLAUDE_PLUGIN_ROOT が無いときの resolvePluginRoot は source 相対で、PECOTV_DEPENDENCY_ROOT は使わない', () => {
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', '/data/runtime/current')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')

    expect(resolvePluginRoot()).not.toBe('/data/runtime/current')
    expect(path.isAbsolute(resolvePluginRoot())).toBe(true)
  })
})

describe('runtimeStateDirectory (Chromium・host-deps の印とロックの置き場)', () => {
  // bin/pecotv と cli が同じ場所を見る。ハードリンクで複製した node_modules の中に置くと
  // inode を共有し、置き場が食い違うと確認が毎回実行される。求め方は PECOTV_RUNTIME_DIR の親。

  it('PECOTV_RUNTIME_DIR の親（runtime/）が実在すれば返す', () => {
    const runtime = temporaryRoot('data', 'runtime')
    mkdirSync(path.join(runtime, 'abc-def'), { recursive: true })
    vi.stubEnv('PECOTV_RUNTIME_DIR', path.join(runtime, 'abc-def'))

    expect(runtimeStateDirectory()).toBe(runtime)
  })

  it('親が実在しなければ undefined（実在しない親ではロックファイルを作れず exit 66 になる）', () => {
    vi.stubEnv('PECOTV_RUNTIME_DIR', temporaryRoot('data-without-runtime', 'runtime', 'abc-def'))

    expect(runtimeStateDirectory()).toBeUndefined()
  })

  it('データ置き場の変数だけでは決まらない（ミラーの変数だけを見る）', () => {
    const data = temporaryRoot('data')
    mkdirSync(path.join(data, 'runtime'), { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(runtimeStateDirectory()).toBeUndefined()
  })

  it('相対パス・空値・未設定は無効', () => {
    vi.stubEnv('PECOTV_RUNTIME_DIR', 'relative/dir')
    expect(runtimeStateDirectory()).toBeUndefined()

    vi.stubEnv('PECOTV_RUNTIME_DIR', '')
    expect(runtimeStateDirectory()).toBeUndefined()

    vi.stubEnv('PECOTV_RUNTIME_DIR', undefined)
    expect(runtimeStateDirectory()).toBeUndefined()
  })
})

describe('stateFileDirectory', () => {
  it('runtime/ が実在すればそこ、無ければ依存ルートの node_modules へ戻る', () => {
    const pluginRoot = createRoot('plugin')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))
    const runtime = temporaryRoot('data', 'runtime')
    vi.stubEnv('PECOTV_RUNTIME_DIR', path.join(runtime, 'abc-def'))
    expect(stateFileDirectory()).toBe(path.join(pluginRoot, 'node_modules'))

    mkdirSync(runtime, { recursive: true })
    expect(stateFileDirectory()).toBe(runtime)
  })
})

describe('runningMirrorDirectory', () => {
  it('PECOTV_RUNTIME_DIR を返す。空白のみ・未設定は undefined', () => {
    vi.stubEnv('PECOTV_RUNTIME_DIR', '/data/runtime/abc-def')
    expect(runningMirrorDirectory()).toBe('/data/runtime/abc-def')

    vi.stubEnv('PECOTV_RUNTIME_DIR', '  ')
    expect(runningMirrorDirectory()).toBeUndefined()
  })
})

describe('existingDependencyNodeModules', () => {
  // ここだけは「実在するか」で選ぶ。取得ロック (flock) の置き場所を決めるためで、
  // flock(1) は親ディレクトリが無いとロックファイルを作れない。

  it('プラグイン側の node_modules が実在すればそれを返す', () => {
    const pluginRoot = createRoot('plugin')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    createRuntimeRoot()

    expect(existingDependencyNodeModules()).toBe(path.join(pluginRoot, 'node_modules'))
  })

  it('プラグイン側に実体が無ければ永続層へ降りる', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', temporaryRoot('absent'))
    const runtime = createRuntimeRoot()

    expect(existingDependencyNodeModules()).toBe(path.join(runtime, 'node_modules'))
  })

  it('どちらも無ければ undefined', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', temporaryRoot('absent'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(existingDependencyNodeModules()).toBeUndefined()
  })
})

describe('resolveTalkDirectoryNodeModules', () => {
  // talk-dir の symlink 先。プラグインルートは env ではなく引数で受ける。
  // create / sync が deps 経由で受け取った値と食い違わせないため。
  it('引数のプラグインルートを優先し、env の値は見ない', () => {
    const pluginRoot = createRoot('plugin')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', temporaryRoot('other'))
    createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(pluginRoot)).toBe(path.join(pluginRoot, 'node_modules'))
  })

  it('プラグインルートに node_modules が無ければ永続層を返す (単体配布の構成)', () => {
    const runtime = createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(temporaryRoot('dist-pkg')))
      .toBe(path.join(runtime, 'node_modules'))
  })

  it('node_modules は在っても代表パッケージが引けなければ次のルートへ降りる', () => {
    // npm が版衝突で `<配布パッケージ>/node_modules` を掘った場合。存在だけで選ぶと
    // symlink が依存を含まないツリーを指し、runtime_setup が永続層へ install した実体と食い違う。
    const pluginRoot = createEmptyRoot('plugin-shallow')
    const runtime = createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(pluginRoot)).toBe(path.join(runtime, 'node_modules'))
  })

  it('どちらも代表パッケージを引けなければ undefined', () => {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveTalkDirectoryNodeModules(createEmptyRoot('plugin-empty'))).toBeUndefined()
  })

  it('データ置き場を決められなければ永続層を候補に入れず、プラグインルートだけを見る', () => {
    // 場所を決められない永続層を候補に混ぜると undefined を join して不正なパスを掘る。
    const pluginRoot = createRoot('plugin-only')
    stubNoDataDirectory()

    expect(resolveTalkDirectoryNodeModules(pluginRoot)).toBe(path.join(pluginRoot, 'node_modules'))
    expect(resolveTalkDirectoryNodeModules(createEmptyRoot('plugin-empty-no-home'))).toBeUndefined()
  })
})

/**
開発ツリーの形（<repository>/plugins/pecot-visual）を作る。依存は repository の node_modules にだけ置く。
*/
function createWorkspace(packages: readonly string[]): { repository: string, plugin: string } {
  const repository = createRoot('repository')
  writeFileSync(path.join(repository, 'pnpm-workspace.yaml'), `packages:\n${packages.map(entry => `  - '${entry}'`).join('\n')}\n`, 'utf8')
  const plugin = temporaryRoot('repository', 'plugins', 'pecot-visual')
  mkdirSync(plugin, { recursive: true })
  return { repository, plugin }
}

describe('開発ツリーの workspace root', () => {
  it('root を packages に含む上位の workspace は、その node_modules を返す', () => {
    const { repository, plugin } = createWorkspace(['libs/*', 'plugins/pecot-visual'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBe(path.join(repository, 'node_modules'))
  })

  it('glob の packages でも一致すれば採る', () => {
    const { repository, plugin } = createWorkspace(['plugins/*'])

    expect(resolveTalkDirectoryNodeModules(plugin)).toBe(path.join(repository, 'node_modules'))
  })

  it('root を含まない上位の workspace は採らず、root のまま返す', () => {
    const { plugin } = createWorkspace(['other/*'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBeUndefined()
  })

  it('除外された root は採らない', () => {
    const { plugin } = createWorkspace(['plugins/*', '!plugins/pecot-visual'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBeUndefined()
  })
})

describe('resolveDependency', () => {
  it('依存ルートに置かれたパッケージを解決する', () => {
    const pluginRoot = createRoot('plugin', ['pkg-a'])
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveDependency('pkg-a')).toBe(path.join(pluginRoot, 'node_modules', 'pkg-a', 'index.js'))
  })

  it('プラグイン側で見つからなければ永続層から解決する', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', createRoot('plugin'))
    const runtime = createRuntimeRoot(['pkg-b'])

    expect(resolveDependency('pkg-b')).toBe(path.join(runtime, 'node_modules', 'pkg-b', 'index.js'))
  })

  it('fromUrl を渡すとそちらを先に試す', () => {
    // プラグイン側と開発時の hoist 構成で、従来どおりの解決結果を保つための優先順。
    const runtime = createRuntimeRoot(['pkg-c'])
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', createRoot('plugin'))

    expect(resolveDependency('pkg-c', import.meta.url), 'テスト自身の位置には無いので永続層へ降りる')
      .toBe(path.join(runtime, 'node_modules', 'pkg-c', 'index.js'))
  })

  it('どこにも無ければ undefined (throw しない)', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', createRoot('plugin'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveDependency('@pecotv/definitely-not-installed')).toBeUndefined()
  })
})

describe('areRuntimeDependenciesInstalled', () => {
  it('本モジュール自身の位置から引けるプラグイン側では true', () => {
    // env を落としても、同梱の node_modules から引けるので「未取得」に倒れてはいけない
    // (倒れると `runtime_setup` が 600MB の npm install を始める)。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(areRuntimeDependenciesInstalled()).toBe(true)
    expect(areRuntimeDependenciesInstalled('どの stamp とも一致しない'), '同梱依存は stamp を見ない')
      .toBe(true)
  })
})

describe('isRuntimeLayerInstalled: 永続層の版判定', () => {
  // 単体配布側の判定。areRuntimeDependenciesInstalled は同梱依存を先に見て短絡する。
  // テスト実行環境は常にプラグイン側なので、永続層側だけをここで直接確かめる。
  // 永続層は版を持たない固定パスなので、解決可否だけでは前の版の残骸と区別できない。

  it('stamp が一致すれば取得済み', () => {
    expect(hasRuntimeLayer('expected-stamp')).toBe(true)
  })

  it('stamp が違えば未取得に倒す (前の版で取得したツリーの残骸)', () => {
    // ここを通すと、依存が増えた新版でも runtime_setup が skip し、slidev build が実行時に失敗する。
    expect(hasRuntimeLayer('old-stamp')).toBe(false)
  })

  it('stamp が無ければ未取得に倒す (stamp を置く前に取得した領域)', () => {
    expect(hasRuntimeLayer()).toBe(false)
  })

  it('stamp を要求しなければ解決可否だけで判定する', () => {
    createRuntimeRoot()

    expect(isRuntimeLayerInstalled()).toBe(true)
  })

  it('代表パッケージを引けない永続層は stamp があっても未取得', () => {
    const data = temporaryRoot('data-no-tree')
    mkdirSync(path.join(data, 'mcp-dist', 'node_modules'), { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    writeStamp('expected-stamp')

    expect(isRuntimeLayerInstalled('expected-stamp')).toBe(false)
  })

  it('データ置き場を決められなければ未取得', () => {
    stubNoDataDirectory()

    expect(isRuntimeLayerInstalled('expected-stamp')).toBe(false)
  })
})

describe('dataDirectory: bin/_lib.sh の plugin_data_dir_resolve と同じ結果', () => {
  // 解決が bash と TS の 2 実装になるため、同じ入力で同じ結果になることを固定する。
  // 比較の相手は実物の bin/_lib.sh（bash 3.2 でも通る書き方に限った関数）を source して呼ぶ。

  const LIB = path.join(import.meta.dirname, '..', '..', '..', '..', 'bin', '_lib.sh')
  const CALL_FUNCTION = path.join(import.meta.dirname, '..', '..', '_helpers', 'call-bash-function.sh')

  interface Environment {
    readonly CLAUDE_PLUGIN_DATA?: string
    readonly PLUGIN_DATA?: string
    readonly XDG_DATA_HOME?: string
    readonly HOME?: string
  }

  /**
  bash の plugin_data_dir_resolve を子プロセスで呼ぶ。解決できなければ undefined。
  PATH 以外はこの入力だけを渡す（実環境の XDG_DATA_HOME や HOME を混ぜない）。
  */
  function resolveWithBash(environment: Readonly<Environment>): string | undefined {
    try {
      const output = execFileSync(
        'bash',
        [CALL_FUNCTION, LIB, 'plugin_data_dir_resolve', 'pecot-visual'],
        { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...environment }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      return output.replace(/\n$/u, '')
    }
    catch {
      return undefined
    }
  }

  /**
  同じ入力で TS の dataDirectory を呼ぶ。入力に無いキーは未設定にする。
  */
  function resolveWithTypeScript(environment: Readonly<Environment>): string | undefined {
    vi.stubEnv('CLAUDE_PLUGIN_DATA', environment.CLAUDE_PLUGIN_DATA)
    vi.stubEnv('PLUGIN_DATA', environment.PLUGIN_DATA)
    vi.stubEnv('XDG_DATA_HOME', environment.XDG_DATA_HOME)
    vi.stubEnv('HOME', environment.HOME)
    return dataDirectory()
  }

  const cases: readonly { readonly name: string, readonly environment: Environment, readonly expected: string | undefined }[] = [
    { name: 'CLAUDE_PLUGIN_DATA が最優先（実在しなくてもそのまま）', environment: { CLAUDE_PLUGIN_DATA: '/client/data', PLUGIN_DATA: '/plugin/data', XDG_DATA_HOME: '/xdg', HOME: '/home/u' }, expected: '/client/data' },
    { name: 'CLAUDE_PLUGIN_DATA が無効なら PLUGIN_DATA', environment: { CLAUDE_PLUGIN_DATA: 'relative', PLUGIN_DATA: '/plugin/data', HOME: '/home/u' }, expected: '/plugin/data' },
    { name: '展開されなかった ${…} は無効', environment: { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: '${PLUGIN_DATA}', HOME: '/home/u' }, expected: '/home/u/.local/share/pecot/pecot-visual' },
    { name: '空値は無効', environment: { CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '', XDG_DATA_HOME: '', HOME: '/home/u' }, expected: '/home/u/.local/share/pecot/pecot-visual' },
    { name: '空白だけの値は絶対パスではないので無効', environment: { CLAUDE_PLUGIN_DATA: ' ', HOME: '/home/u' }, expected: '/home/u/.local/share/pecot/pecot-visual' },
    { name: '有効な XDG_DATA_HOME は HOME より優先', environment: { XDG_DATA_HOME: '/xdg/share', HOME: '/home/u' }, expected: '/xdg/share/pecot/pecot-visual' },
    { name: '相対パスの XDG_DATA_HOME は未設定として HOME へ', environment: { XDG_DATA_HOME: 'xdg/share', HOME: '/home/u' }, expected: '/home/u/.local/share/pecot/pecot-visual' },
    { name: '展開されなかった XDG_DATA_HOME（${...}）は未設定として HOME へ', environment: { XDG_DATA_HOME: '${XDG_DATA_HOME}', HOME: '/home/u' }, expected: '/home/u/.local/share/pecot/pecot-visual' },
    { name: 'XDG_DATA_HOME だけで HOME が無くても解決する', environment: { XDG_DATA_HOME: '/xdg/share' }, expected: '/xdg/share/pecot/pecot-visual' },
    { name: '末尾のスラッシュはそのまま連結する', environment: { XDG_DATA_HOME: '/xdg/share/', HOME: '/home/u/' }, expected: '/xdg/share//pecot/pecot-visual' },
    { name: 'HOME と有効な XDG_DATA_HOME のどちらも無ければ解決できない', environment: { XDG_DATA_HOME: 'relative' }, expected: undefined },
    { name: '相対パスの HOME は使わず、有効な XDG_DATA_HOME が無ければ解決できない', environment: { HOME: 'rel/home' }, expected: undefined },
    { name: '何も無ければ解決できない', environment: {}, expected: undefined },
  ]

  it.each(cases)('$name のとき、bash と TS がともに $expected を返す', ({ environment, expected }) => {
    expect(resolveWithBash(environment)).toBe(expected)
    expect(resolveWithTypeScript(environment)).toBe(expected)
  })

  it('末尾の改行・CR は落とす', () => {
    const environment: Environment = { CLAUDE_PLUGIN_DATA: '/client/data\r\n' }

    expect(resolveWithBash(environment)).toBe('/client/data')
    expect(resolveWithTypeScript(environment)).toBe('/client/data')
  })
})
