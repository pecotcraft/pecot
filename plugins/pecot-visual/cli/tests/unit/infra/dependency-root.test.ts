// infra/_shared/dependency-root.ts の unit test。同梱と永続層（`${データ置き場}/mcp-dist`）の 2 つの依存ルートの切り替えを固定する。
// 依存ルートの判定は代表パッケージが引けるかで決まるので、一時ツリーにも実体を置く（tests/_helpers/dependency-probes.ts）。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  themeStoreRoot,
  stateFileDirectory,
} from '../../../src/infra/_shared/dependency-root.js'
import type * as PluginRoot from '../../../src/infra/_shared/plugin-root.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { stubNoDataDirectory } from '../../_helpers/no-data-directory.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const pluginRootOverride: { value?: string } = vi.hoisted(() => ({}))

vi.mock('../../../src/infra/_shared/plugin-root.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PluginRoot>()
  return { resolvePluginRoot: () => pluginRootOverride.value ?? actual.resolvePluginRoot() }
})

/**
プラグインルート（resolvePluginRoot）を、このテストの間だけ差し替える。
*/
function stubPluginRoot(root: string): void {
  pluginRootOverride.value = root
}

const temporaryRoot = useTemporaryDirectory('pecotv-dependency-root-', { resolveRealPath: true })

afterEach(() => {
  vi.unstubAllEnvs()
  delete pluginRootOverride.value
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
  it('永続層はデータ置き場の mcp-dist として返し、データ置き場を決められなければ undefined を返す', async () => {
    await explains('永続層（単体配布の依存を置く場所）のルートを返す `runtimeDependencyRoot` のテストです。`CLAUDE_PLUGIN_DATA` を指定すると、その下の `mcp-dist` を返し、データ置き場を決められない場合は `undefined` を返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(runtimeDependencyRoot()).toBe(path.join('/fake/data', 'mcp-dist'))

    stubNoDataDirectory()
    expect(runtimeDependencyRoot()).toBeUndefined()
  })

  it('永続層のルートは、ディレクトリを作成せずに、パスだけを返す', async () => {
    await explains('`runtimeDependencyRoot` のテストです。存在しないデータ置き場を指定した場合に、`mcp-dist` のパスを返し、データ置き場のディレクトリは作成しないことを確認します。')
    const data = temporaryRoot('not-created', 'data')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(runtimeDependencyRoot()).toBe(path.join(data, 'mcp-dist'))
    expect(existsSync(data)).toBe(false)
  })

  it('同梱の依存ルートは、プラグインルートと同じ場所を返す', async () => {
    await explains('`pluginDependencyRoot` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` を指定した場合に、同梱の依存ルートとしてプラグインルートと同じパスを返すことを確認します。')
    stubPluginRoot('/plugins/pecot-visual')
    expect(pluginDependencyRoot()).toBe('/plugins/pecot-visual')
  })

  it('依存ルートを探す順序は、プラグイン側、永続層の順にする', async () => {
    await explains('依存ルートの候補を返す `dependencyRoots` のテストです。`CLAUDE_PLUGIN_ROOT` と `CLAUDE_PLUGIN_DATA` を指定した場合に、プラグインのパス、永続層の `mcp-dist` の順に並べて返すことを確認します。')
    stubPluginRoot('/plugins/pecot-visual')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')

    expect(dependencyRoots()).toEqual([
      '/plugins/pecot-visual',
      path.join('/fake/data', 'mcp-dist'),
    ])
  })

  it('永続層を決められなければ、プラグインのパスだけを返す', async () => {
    await explains('`dependencyRoots` のテストです。永続層のデータ置き場を決められない場合に、プラグインのパスだけを返すことを確認します。')
    stubPluginRoot('/plugins/pecot-visual')
    stubNoDataDirectory()

    expect(dependencyRoots()).toEqual(['/plugins/pecot-visual'])
  })

  it('インストール済みの印（install stamp）は永続層の直下に置き、場所を決められなければ undefined を返す', async () => {
    await explains('インストール済みの印のパスを返す `runtimeInstallStampPath` のテストです。永続層の直下の `.pecotv-runtime-stamp` を返し、データ置き場を決められない場合は `undefined` を返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(runtimeInstallStampPath())
      .toBe(path.join('/fake/data', 'mcp-dist', '.pecotv-runtime-stamp'))

    stubNoDataDirectory()
    expect(runtimeInstallStampPath()).toBeUndefined()
  })
})

describe('themeStoreRoot', () => {
  it('CLAUDE_PLUGIN_DATA が指定されていれば、その下の themes をテーマの置き場として返す', async () => {
    await explains('テーマの置き場を返す `themeStoreRoot` のテストです。`CLAUDE_PLUGIN_DATA` を指定した場合に、その下の `themes` を返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '/fake/data')
    expect(themeStoreRoot()).toBe(path.join('/fake/data', 'themes'))
  })

  it('CLAUDE_PLUGIN_DATA が空で PLUGIN_DATA が指定されていれば、その下の themes を返す', async () => {
    await explains('`themeStoreRoot` のテストです。`CLAUDE_PLUGIN_DATA` が空で、`PLUGIN_DATA` を指定した場合に、`PLUGIN_DATA` の下の `themes` を返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '')
    vi.stubEnv('PLUGIN_DATA', '/fake/standalone')
    expect(themeStoreRoot()).toBe(path.join('/fake/standalone', 'themes'))
  })

  it('どちらの環境変数も指定されず、置き場を決められなければ undefined を返す', async () => {
    await explains('`themeStoreRoot` のテストです。データ置き場を決められない場合に、`undefined` を返すことを確認します。')
    stubNoDataDirectory()
    expect(themeStoreRoot()).toBeUndefined()
  })
})
describe('resolvePluginRoot', () => {
  it('CLAUDE_PLUGIN_ROOT があっても読まず、自身の置き場所から求める', async () => {
    await explains('`resolvePluginRoot` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` を指定していても、その値は使わず、自身の置き場所から求めたパスを返すことを確認します。')
    const actual = await vi.importActual<typeof PluginRoot>('../../../src/infra/_shared/plugin-root.js')
    stubPluginRoot('/plugins/installed/pecot-visual')

    const testDirectory = path.dirname(fileURLToPath(import.meta.url))

    expect(actual.resolvePluginRoot()).toBe(path.resolve(testDirectory, '../../../..'))
  })
})

describe('stateFileDirectory', () => {
  it('プラグインルートの node_modules が実在すればそこを返す', async () => {
    await explains('`stateFileDirectory` のテストです。プラグインルートの `node_modules` が存在する場合に、そのパスを返すことを確認します。')
    const pluginRoot = createRoot('plugin')
    stubPluginRoot(pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(stateFileDirectory()).toBe(path.join(pluginRoot, 'node_modules'))
  })
})

describe('existingDependencyNodeModules', () => {
  // ここだけは「実在するか」で選ぶ。取得ロック (flock) の置き場所を決めるためで、
  // flock(1) は親ディレクトリが無いとロックファイルを作れない。

  it('プラグイン側の node_modules が存在すれば、それを返す', async () => {
    await explains('存在する依存の `node_modules` を返す `existingDependencyNodeModules` のテストです。プラグイン側と永続層の両方に依存があるときに、プラグイン側の `node_modules` を返すことを確認します。')
    const pluginRoot = createRoot('plugin')
    stubPluginRoot(pluginRoot)
    createRuntimeRoot()

    expect(existingDependencyNodeModules()).toBe(path.join(pluginRoot, 'node_modules'))
  })

  it('プラグイン側に依存が存在しなければ、永続層の node_modules を返す', async () => {
    await explains('`existingDependencyNodeModules` のテストです。プラグイン側にパッケージがなく、永続層だけにある場合は、永続層の `node_modules` を返すことを確認します。')
    stubPluginRoot(temporaryRoot('absent'))
    const runtime = createRuntimeRoot()

    expect(existingDependencyNodeModules()).toBe(path.join(runtime, 'node_modules'))
  })

  it('どちらにも依存が存在しなければ、undefined を返す', async () => {
    await explains('`existingDependencyNodeModules` のテストです。プラグイン側と永続層のどちらにも依存が存在しない場合は、`undefined` を返すことを確認します。')
    stubPluginRoot(temporaryRoot('absent'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(existingDependencyNodeModules()).toBeUndefined()
  })
})

describe('resolveTalkDirectoryNodeModules', () => {
  // talk-dir の symlink 先。create / sync が deps で受けた依存ルートと食い違わせないため、引数で受ける。
  // create / sync が deps 経由で受け取った値と食い違わせないため。
  it('引数の依存ルートを優先し、プラグインルートは見ない', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。依存ルートを引数で渡した場合に、プラグインルートは参照せず、引数の依存ルートの `node_modules` を返すことを確認します。')
    const pluginRoot = createRoot('plugin')
    stubPluginRoot(temporaryRoot('other'))
    createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(pluginRoot)).toBe(path.join(pluginRoot, 'node_modules'))
  })

  it('プラグインルートに node_modules が存在しなければ、永続層の node_modules を返す', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。単体配布のようにプラグインルートに依存がなく、永続層だけにある場合は、永続層の `node_modules` を返すことを確認します。')
    const runtime = createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(temporaryRoot('dist-pkg')))
      .toBe(path.join(runtime, 'node_modules'))
  })

  it('node_modules が存在しても代表のパッケージを解決できなければ、次の候補のルートを使う', async () => {
    // npm が版衝突で `<配布パッケージ>/node_modules` を掘った場合。存在だけで選ぶと
    // symlink が依存を含まないツリーを指し、runtime_setup が永続層へ install した実体と食い違う。
    await explains('`resolveTalkDirectoryNodeModules` のテストです。プラグインルートの `node_modules` が空で、永続層に依存がある場合に、存在だけで選ばず、永続層の `node_modules` を返すことを確認します。')
    const pluginRoot = createEmptyRoot('plugin-shallow')
    const runtime = createRuntimeRoot()

    expect(resolveTalkDirectoryNodeModules(pluginRoot)).toBe(path.join(runtime, 'node_modules'))
  })

  it('どの候補でも代表のパッケージを解決できなければ、undefined を返す', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。プラグインルートの `node_modules` が空で、永続層も存在しない場合に、`undefined` を返すことを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveTalkDirectoryNodeModules(createEmptyRoot('plugin-empty'))).toBeUndefined()
  })

  it('データ置き場を決められなければ、永続層を候補に入れず、プラグインルートだけを使う', async () => {
    // 場所を決められない永続層を候補に混ぜると undefined を join して不正なパスを掘る。
    await explains('`resolveTalkDirectoryNodeModules` のテストです。データ置き場を決められない場合に、プラグインルートに依存があればその `node_modules` を返し、なければ `undefined` を返すことを確認します。')
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
  it('上位の workspace が対象のルートを packages に含む場合は、その workspace の node_modules を返す', async () => {
    await explains('開発ツリーの workspace root を使う場合の `resolveTalkDirectoryNodeModules` のテストです。上位の `packages` が `plugins/pecot-visual` を含むと、その上位の `node_modules` を返すことを確認します。')
    const { repository, plugin } = createWorkspace(['libs/*', 'plugins/pecot-visual'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBe(path.join(repository, 'node_modules'))
  })

  it('packages に glob を指定した場合も、対象のルートに一致すれば、その workspace を使う', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。上位の `packages` が `plugins/*` のような glob で、対象のルートと一致すると、その上位の `node_modules` を返すことを確認します。')
    const { repository, plugin } = createWorkspace(['plugins/*'])

    expect(resolveTalkDirectoryNodeModules(plugin)).toBe(path.join(repository, 'node_modules'))
  })

  it('対象のルートを含まない上位の workspace は使わず、undefined を返す', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。上位の `packages` が `other/*` で対象のルートを含まない場合は、その `node_modules` を使わず `undefined` を返すことを確認します。')
    const { plugin } = createWorkspace(['other/*'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBeUndefined()
  })

  it('packages から除外されたルートは、その workspace を使わず、undefined を返す', async () => {
    await explains('`resolveTalkDirectoryNodeModules` のテストです。上位の `packages` に `!plugins/pecot-visual` のような除外の指定がある場合に、その `node_modules` を使わず `undefined` を返すことを確認します。')
    const { plugin } = createWorkspace(['plugins/*', '!plugins/pecot-visual'])
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('no-data'))

    expect(resolveTalkDirectoryNodeModules(plugin)).toBeUndefined()
  })
})

describe('resolveDependency', () => {
  it('依存ルートに置いたパッケージを解決する', async () => {
    await explains('パッケージのパスを求める `resolveDependency` のテストです。プラグイン側の依存ルートに `pkg-a` がある場合に、その `node_modules/pkg-a/index.js` のパスを返すことを確認します。')
    const pluginRoot = createRoot('plugin', ['pkg-a'])
    stubPluginRoot(pluginRoot)
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveDependency('pkg-a')).toBe(path.join(pluginRoot, 'node_modules', 'pkg-a', 'index.js'))
  })

  it('プラグイン側にパッケージが存在しなければ、永続層から解決する', async () => {
    await explains('`resolveDependency` のテストです。プラグイン側に `pkg-b` がなく、永続層だけにある場合は、永続層の `node_modules/pkg-b/index.js` のパスを返すことを確認します。')
    stubPluginRoot(createRoot('plugin'))
    const runtime = createRuntimeRoot(['pkg-b'])

    expect(resolveDependency('pkg-b')).toBe(path.join(runtime, 'node_modules', 'pkg-b', 'index.js'))
  })

  it('fromUrl を渡した場合は、その位置からの解決を先に試す', async () => {
    // プラグイン側と開発時の hoist 構成で、従来どおりの解決結果を保つための優先順。
    await explains('`resolveDependency` のテストです。テストファイル自身の位置を `fromUrl` に渡しても、その位置に `pkg-c` がないため、永続層の `node_modules/pkg-c/index.js` のパスを返すことを確認します。')
    const runtime = createRuntimeRoot(['pkg-c'])
    stubPluginRoot(createRoot('plugin'))

    expect(resolveDependency('pkg-c', import.meta.url), 'テスト自身の位置には無いので永続層へ降りる')
      .toBe(path.join(runtime, 'node_modules', 'pkg-c', 'index.js'))
  })

  it('どこにもパッケージが存在しなければ、例外を発生させず undefined を返す', async () => {
    await explains('`resolveDependency` のテストです。インストールされていないパッケージ名を渡した場合に、例外を発生させず、`undefined` を返すことを確認します。')
    stubPluginRoot(createRoot('plugin'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(resolveDependency('@pecotv/definitely-not-installed')).toBeUndefined()
  })
})

describe('areRuntimeDependenciesInstalled', () => {
  it('同梱の依存が本体の位置から解決できるなら、true を返す', async () => {
    // 「未取得」に倒れると、`runtime_setup` が 600MB の npm install を始める。
    await explains('依存がインストール済みかを返す `areRuntimeDependenciesInstalled` のテストです。環境変数を空にしても、同梱の依存を解決できるため `true` を返し、インストール済みの印が違っても `true` のままであることを確認します。')
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

  it('インストール済みの印が一致すれば、インストール済みとして扱う', async () => {
    await explains('永続層の版を判定する `isRuntimeLayerInstalled` のテストです。置いてある印が期待する印と一致する場合に、`true` を返すことを確認します。')
    expect(hasRuntimeLayer('expected-stamp')).toBe(true)
  })

  it('インストール済みの印が違えば、未インストールとして扱う', async () => {
    // ここを通すと、依存が増えた新版でも runtime_setup が skip し、slidev build が実行時に失敗する。
    await explains('`isRuntimeLayerInstalled` のテストです。前の版で置かれた印のように、期待する印と異なる場合に、`false` を返すことを確認します。')
    expect(hasRuntimeLayer('old-stamp')).toBe(false)
  })

  it('インストール済みの印が存在しなければ、未インストールとして扱う', async () => {
    await explains('`isRuntimeLayerInstalled` のテストです。永続層に印のファイルが存在しない場合に、`false` を返すことを確認します。')
    expect(hasRuntimeLayer()).toBe(false)
  })

  it('印を指定しない場合は、依存を解決できるかだけで判定する', async () => {
    await explains('`isRuntimeLayerInstalled` のテストです。印を渡さず呼び出した場合は、永続層の依存を解決できれば `true` を返すことを確認します。')
    createRuntimeRoot()

    expect(isRuntimeLayerInstalled()).toBe(true)
  })

  it('代表のパッケージを解決できない永続層は、印があっても未インストールとして扱う', async () => {
    await explains('`isRuntimeLayerInstalled` のテストです。永続層の `node_modules` が空で、印が一致していても、`false` を返すことを確認します。')
    const data = temporaryRoot('data-no-tree')
    mkdirSync(path.join(data, 'mcp-dist', 'node_modules'), { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    writeStamp('expected-stamp')

    expect(isRuntimeLayerInstalled('expected-stamp')).toBe(false)
  })

  it('データ置き場を決められなければ、未インストールとして扱う', async () => {
    await explains('`isRuntimeLayerInstalled` のテストです。データ置き場を決められない場合に、`false` を返すことを確認します。')
    stubNoDataDirectory()

    expect(isRuntimeLayerInstalled('expected-stamp')).toBe(false)
  })
})

describe('dataDirectory の解決順', () => {
  interface Environment {
    readonly CLAUDE_PLUGIN_DATA?: string
    readonly PLUGIN_DATA?: string
    readonly XDG_DATA_HOME?: string
    readonly HOME?: string
  }

  /**
  入力に無いキーは未設定にして dataDirectory を呼ぶ。
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

  it.each(cases)('$name のとき、$expected を返す', async ({ environment, expected }) => {
    await explains('`dataDirectory` の解決順のテストです。環境変数 `CLAUDE_PLUGIN_DATA` などの組み合わせを渡した場合は、表の期待値を返し、解決できなければ `undefined` を返すことを確認します。')
    expect(resolveWithTypeScript(environment)).toBe(expected)
  })

  it('データ置き場の値の末尾にある改行と CR は、取り除く', async () => {
    await explains('bash の `plugin_data_dir_resolve` と TypeScript の `dataDirectory` のテストです。`CLAUDE_PLUGIN_DATA` の値の末尾に CRLF がある場合に、どちらも `/client/data` を返すことを確認します。')
    const environment: Environment = { CLAUDE_PLUGIN_DATA: '/client/data\r\n' }

    expect(resolveWithTypeScript(environment)).toBe('/client/data')
  })
})
