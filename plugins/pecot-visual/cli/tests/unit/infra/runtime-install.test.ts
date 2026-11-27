// infra/_shared/runtime-install.ts の unit test。
//
// 実際の npm install は 600MB 級なので実行しない。ここで固定するのは
// 「何を install 対象にするか」と「install 先の package.json を必ず用意すること」。
// 実取得を伴う確認は #982 の CUJ 2 が持つ。CUJ 2 は単体配布の runtime_setup から slide_convert までを通す。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下と、リポジトリ内の追跡ファイルだけ */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { isRecord } from '../../../src/domain/_shared/json.js'
import { hasFlockCommand } from '../../../src/infra/_shared/flock.js'
import {
  installRuntimeDependencies,
  runtimeInstallLockPath,
  runtimeInstallPlan,
  runtimeInstallSpecs,
  runtimeInstallStamp,
  PATCH_PACKAGE_RANGE,
} from '../../../src/infra/_shared/runtime-install.js'
import { caretRangeViolation, compareVersionTriple, parseVersionTriple } from '../../_helpers/caret-range.js'
import { stubNoDataDirectory } from '../../_helpers/no-data-directory.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

// tests/unit/infra → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const RUNTIME_MANIFEST = path.join(PLUGIN_ROOT, 'assets', 'slidev', 'runtime', 'package.json')
const DOM_TO_PPTX_MANIFEST = path.join(REPO_ROOT, 'node_modules', 'dom-to-pptx', 'package.json')
const PPTXGENJS_MANIFEST = path.join(REPO_ROOT, 'node_modules', 'pptxgenjs', 'package.json')
const MONACO_EDITOR_MANIFEST = path.join(REPO_ROOT, 'node_modules', 'monaco-editor', 'package.json')
const MICROMARK_EXTENSION_MATH_MANIFEST = path.join(REPO_ROOT, 'node_modules', 'micromark-extension-math', 'package.json')
const WORKSPACE_YAML = path.join(REPO_ROOT, 'pnpm-workspace.yaml')
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

interface RuntimeManifest {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  overrides: Record<string, string>
}

/**
本体の runtime manifest を読む。
*/
function readRuntimeManifest(): RuntimeManifest {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  return JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8')) as RuntimeManifest
}

/**
manifest の `@slidev/cli` の版。中核パッケージの固定版の読み元。宣言が無ければ throw する。
*/
function readCoreVersion(): string {
  const version = readRuntimeManifest().dependencies['@slidev/cli']
  if (version === undefined) throw new Error('runtime manifest に @slidev/cli の宣言がありません')
  return version
}

const CORE_VERSION = readCoreVersion()

/**
知らせのテストの修正版 F。pnpm-workspace.yaml の overrides の値（`^x.y.z`）の下限から読む。
*/
function fixedVersionOf(overrideKey: string): string {
  const workspaceConfig: unknown = parseYaml(readFileSync(WORKSPACE_YAML, 'utf8'))
  const overrides = isRecord(workspaceConfig) && isRecord(workspaceConfig['overrides']) ? workspaceConfig['overrides'] : {}
  // eslint-disable-next-line security/detect-object-injection -- overrideKey はテスト内の定数
  const value = overrides[overrideKey]
  return caretLowerBound(value, `pnpm-workspace.yaml の overrides.${overrideKey}`)
}

/**
`^x.y.z` の下限 `x.y.z` を返す。その形でなければ throw する。
*/
function caretLowerBound(value: unknown, label: string): string {
  const match = typeof value === 'string' ? /^\^(\d+\.\d+\.\d+)$/.exec(value) : undefined
  if (match?.[1] === undefined) throw new Error(`${label} が ^x.y.z ではない: ${String(value)}`)
  return match[1]
}

/**
override が要らなくなったときだけ false を返す（落とす）。判定できない形は false にして人に見せる。
- 宣言なし: false
- 完全一致: F 未満のときだけ true
- `^L`: 範囲が F を含む、または L が F 以上なら false。それ以外は true
*/
function isOverrideStillNeeded(declared: string | undefined, fixed: string): boolean {
  if (declared === undefined) return false
  if (/^\d+\.\d+\.\d+$/.test(declared)) {
    return compareVersionTriple(parseVersionTriple(declared), parseVersionTriple(fixed)) < 0
  }
  if (/^\^\d+\.\d+\.\d+$/.test(declared)) {
    return caretRangeViolation(fixed, declared) !== undefined
      && compareVersionTriple(parseVersionTriple(declared.slice(1)), parseVersionTriple(fixed)) < 0
  }
  return false
}

/**
pnpm-workspace.yaml の packages 列を読む (末尾 `/*` は実ディレクトリへ展開する)。
*/
function workspacePackageDirectories(): readonly string[] {
  const config: unknown = parseYaml(readFileSync(WORKSPACE_YAML, 'utf8'))
  const declared = isRecord(config) && Array.isArray(config['packages']) ? config['packages'] : []
  const directories: string[] = []
  for (const entry of declared) {
    if (typeof entry !== 'string') continue
    if (entry.endsWith('/*')) {
      const parent = entry.slice(0, -2)
      const children = readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })
      for (const child of children) {
        if (child.isDirectory()) directories.push(path.posix.join(parent, child.name))
      }
      continue
    }
    directories.push(entry)
  }
  return directories
}

/**
レジストリ外へ出る specifier の判定。

`https:` の tarball 以外の指定も対象にする。
`git+https:` / `git+ssh:` / `github:` / `git:` / `ssh:` もレジストリを通らず外部ホストへ取りに行く。
そのため同じ網に入れる。
*/
const NON_REGISTRY_SPECIFIER = /^(?:https?|git|git\+[a-z]+|github|ssh):/

/**
依存 map を再帰的にたどり、レジストリ外の値を `<場所> = <値>` の列で返す (overrides の入れ子も見る)。
*/
function urlValuedEntries(value: unknown, trail: string): readonly string[] {
  if (!isRecord(value)) return []
  const found: string[] = []
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      if (NON_REGISTRY_SPECIFIER.test(entry)) found.push(`${trail}.${name} = ${entry}`)
      continue
    }
    found.push(...urlValuedEntries(entry, `${trail}.${name}`))
  }
  return found
}

const temporaryRoot = useTemporaryDirectory('pecotv-runtime-install-', { resolveRealPath: true })

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

/**
検証用の固定版。writeManifestWithCore が `@slidev/cli` に使う。
*/
const TEST_CORE = '99.0.0'

/**
dependencies に `@slidev/cli` を足した manifest を書く。
*/
function writeManifestWithCore(contents: Readonly<Record<string, unknown>>): string {
  const dependencies = isRecord(contents['dependencies']) ? contents['dependencies'] : {}
  return writeManifest({ ...contents, dependencies: { '@slidev/cli': TEST_CORE, ...dependencies } })
}

function writeManifest(contents: unknown): string {
  const directory = temporaryRoot('manifest')
  mkdirSync(directory, { recursive: true })
  const manifestPath = path.join(directory, 'package.json')
  writeFileSync(manifestPath, JSON.stringify(contents), 'utf8')
  return manifestPath
}

describe('runtimeInstallSpecs', () => {
  const coreSpecs = [`@slidev/cli@${TEST_CORE}`]
  const tail = [`@slidev/parser@${TEST_CORE}`, `patch-package@${PATCH_PACKAGE_RANGE}`]

  it('manifest の dependencies を、版の範囲を付けた指定の形で並べる', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`vue` と `echarts` を持つ `dependencies` を渡した場合に、`vue@^3.5.13` のような指定が順に並び、先頭が `@slidev/cli` になることを確認します。')
    const manifestPath = writeManifestWithCore({
      dependencies: { vue: '^3.5.13', echarts: '^5.5.0' },
    })

    expect(runtimeInstallSpecs(manifestPath)).toEqual([...coreSpecs, 'vue@^3.5.13', 'echarts@^5.5.0', ...tail])
  })

  it('workspace: などのローカル参照は、インストール対象から除く', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`workspace:*`・`link:`・`file:` で参照する依存を渡した場合に、それらを含まず、通常の範囲指定の依存だけを返すことを確認します。')
    // 配布ツリーではパッケージとして解決できない。eslint プラグインは dist を同梱し、
    // publish スクリプトが specifier を相対パスへ書き換えて供給する。
    const manifestPath = writeManifestWithCore({
      dependencies: {
        'vue': '^3.5.13',
        '@v-slidev/eslint-shared': 'workspace:*',
        'local-a': 'link:../a',
        'local-b': 'file:../b',
      },
    })

    expect(runtimeInstallSpecs(manifestPath)).toEqual([...coreSpecs, 'vue@^3.5.13', ...tail])
  })

  it('devDependencies からは、dom-to-pptx だけを対象にする', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`devDependencies` に `dom-to-pptx`・`eslint`・`prettier` がある場合に、`dom-to-pptx` だけを返し、ほかは含まないことを確認します。')
    // eslint / prettier は起動層 (配布 package.json の dependencies)
    // にあり、永続層へ二重に置かない。
    const manifestPath = writeManifestWithCore({
      dependencies: {},
      devDependencies: { 'dom-to-pptx': '1.1.10', 'eslint': '^9.17.0', 'prettier': '^3.4.2' },
    })

    expect(runtimeInstallSpecs(manifestPath)).toEqual([...coreSpecs, 'dom-to-pptx@1.1.10', ...tail])
  })

  it('manifest を読み取れない場合は、配布物の破損として例外を送出する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。存在しない `package.json` のパスを渡した場合に、`@slidev/cli` を含むメッセージで例外が発生することを確認します。')
    expect(() => runtimeInstallSpecs(temporaryRoot('no-such-package.json'))).toThrow('@slidev/cli')
  })

  it('@slidev/cli の宣言が存在しない場合は、@slidev/client だけがあっても例外を送出する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`@slidev/client` だけを宣言した `package.json` を渡した場合に、`@slidev/cli` を含むメッセージで例外が発生することを確認します。')
    const manifestPath = writeManifest({ dependencies: { '@slidev/client': '^52.14.1' } })

    expect(() => runtimeInstallSpecs(manifestPath)).toThrow('@slidev/cli')
  })

  it('@slidev/cli の宣言が空文字の場合は、例外を送出する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`@slidev/cli` の版が空文字の `package.json` を渡した場合に、`@slidev/cli` を含むメッセージで例外が発生することを確認します。')
    const manifestPath = writeManifest({ dependencies: { '@slidev/cli': '' } })

    expect(() => runtimeInstallSpecs(manifestPath)).toThrow('@slidev/cli')
  })

  it('依存のフィールドがオブジェクトでない場合は、例外を送出する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`dependencies` が文字列で `devDependencies` が数値の `package.json` を渡した場合に、`@slidev/cli` を含むメッセージで例外が発生することを確認します。')
    const manifestPath = writeManifest({ dependencies: 'nonsense', devDependencies: 42 })

    expect(() => runtimeInstallSpecs(manifestPath)).toThrow('@slidev/cli')
  })

  it('manifest 自体がオブジェクトでない場合は、@slidev/cli が存在しないという例外を送出する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。内容が配列・数値・文字列の `package.json` を渡した場合に、いずれも `@slidev/cli` を含むメッセージで例外が発生することを確認します。')
    // JSON としては読めるが object ではない形 (配列・スカラ)。
    for (const contents of [[], 42, 'nonsense']) {
      expect(() => runtimeInstallSpecs(writeManifest(contents))).toThrow('@slidev/cli')
    }
  })

  it('slidev の中核パッケージは、宣言された範囲ではなく、manifest の @slidev/cli の版に固定する', async () => {
    await explains('インストール対象を並べる `runtimeInstallSpecs` のテストです。`@slidev/client` の宣言が `@slidev/cli` と異なる場合に、`client` と `parser` の版が `@slidev/cli` と一致することを確認します。')
    const manifestPath = writeManifest({
      dependencies: { '@slidev/cli': '99.0.0', '@slidev/client': '^52.14.1', '@slidev/theme-default': '^0.25.0' },
    })

    expect(runtimeInstallSpecs(manifestPath)).toEqual([
      '@slidev/cli@99.0.0',
      '@slidev/client@99.0.0',
      '@slidev/theme-default@^0.25.0',
      '@slidev/parser@99.0.0',
      `patch-package@${PATCH_PACKAGE_RANGE}`,
    ])
  })
})

describe('runtimeInstallPlan: overrides', () => {
  it('manifest の overrides を、入れ子の値も含めてそのまま計画に写す', async () => {
    await explains('インストール計画を作る `runtimeInstallPlan` のテストです。入れ子の値を持つ `overrides` を渡した場合に、計画の `overrides` が同じ内容になることを確認します。')
    const overrides = { 'lodash-es': '^4.17.23', 'foo': { bar: '1.0.0' } }
    const manifestPath = writeManifestWithCore({ dependencies: {}, overrides })

    expect(runtimeInstallPlan(manifestPath).overrides).toEqual(overrides)
  })

  it('overrides が存在しない場合と、オブジェクトでない場合は、空にする', async () => {
    await explains('インストール計画を作る `runtimeInstallPlan` のテストです。`overrides` を持たない場合と、`overrides` が文字列の場合に、計画の `overrides` が空のオブジェクトになることを確認します。')
    expect(runtimeInstallPlan(writeManifestWithCore({ dependencies: {} })).overrides).toEqual({})
    expect(runtimeInstallPlan(writeManifestWithCore({ overrides: 'nonsense' })).overrides).toEqual({})
  })
})

describe('runtimeInstallStamp', () => {
  it('インストール対象が同じなら、同じ印になる', async () => {
    await explains('インストール対象の変更を検出する印を作る `runtimeInstallStamp` のテストです。同じ `package.json` に対して 2 回呼び出した場合に、同じ印を返すことを確認します。')
    const manifestPath = writeManifestWithCore({ dependencies: { vue: '^3.5.13' } })

    expect(runtimeInstallStamp(manifestPath)).toBe(runtimeInstallStamp(manifestPath))
  })

  it('依存が増えれば、印が変わる', async () => {
    await explains('インストール対象の変更を検出する印を作る `runtimeInstallStamp` のテストです。`vue` だけの `dependencies` と、`vue` に `echarts` を加えた `dependencies` を渡した場合に、版上げで依存が増えた状態を検出できるよう、印が異なることを確認します。')
    const before = runtimeInstallStamp(writeManifestWithCore({ dependencies: { vue: '^3.5.13' } }))
    const after = runtimeInstallStamp(writeManifestWithCore({ dependencies: { vue: '^3.5.13', echarts: '^5.5.0' } }))

    expect(after).not.toBe(before)
  })

  it('catalog: を含む manifest でも例外を送出せず、範囲指定の manifest とは異なる印にする', async () => {
    await explains('インストール対象の変更を検出する印を作る `runtimeInstallStamp` のテストです。`vite` を `catalog:` で宣言した場合に、例外が発生せず、64 桁の 16 進数の印を返し、`^8.3.6` で宣言した場合の印とは異なることを確認します。')
    const withCatalog = runtimeInstallStamp(writeManifestWithCore({ dependencies: { vite: 'catalog:' } }))
    const withRange = runtimeInstallStamp(writeManifestWithCore({ dependencies: { vite: '^8.3.6' } }))

    expect(withCatalog).toMatch(/^[0-9a-f]{64}$/u)
    expect(withCatalog).not.toBe(withRange)
  })

  it('overrides だけが変わった場合も、印が変わる', async () => {
    await explains('インストール対象の変更を検出する印を作る `runtimeInstallStamp` のテストです。`lodash-es` の `overrides` だけが `^4.17.23` と `^4.18.0` で異なる場合に、印が異なることを確認します。')
    const before = runtimeInstallStamp(writeManifestWithCore({ dependencies: {}, overrides: { 'lodash-es': '^4.17.23' } }))
    const after = runtimeInstallStamp(writeManifestWithCore({ dependencies: {}, overrides: { 'lodash-es': '^4.18.0' } }))

    expect(after).not.toBe(before)
  })
})

describe('caretLowerBound', () => {
  it('^x.y.z の形なら下限の版を返し、それ以外の形なら例外を送出する', async () => {
    await explains('キャレット範囲の下限を取り出す `caretLowerBound` のテストです。`^2.0.3` を渡した場合は `2.0.3` を返し、`~2.0.3` を渡した場合は `^x.y.z` ではないというメッセージで例外が発生することを確認します。')
    expect(caretLowerBound('^2.0.3', 'x')).toBe('2.0.3')
    expect(() => caretLowerBound('~2.0.3', 'x')).toThrow('x が ^x.y.z ではない: ~2.0.3')
  })
})

describe('isOverrideStillNeeded', () => {
  it('宣言が存在しなければ、override は不要と判定する', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。宣言が `undefined` の場合に、`false` を返すことを確認します。')
    expect(isOverrideStillNeeded(undefined, '3.4.17')).toBe(false)
  })

  it('完全一致の宣言は、修正版より古ければ必要、同じか新しければ不要と判定する', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。修正版が `3.4.17` のとき、`3.4.15` では `true`、`3.4.17` と `3.5.0` では `false` を返すことを確認します。')
    expect(isOverrideStillNeeded('3.4.15', '3.4.17')).toBe(true)
    expect(isOverrideStillNeeded('3.4.17', '3.4.17')).toBe(false)
    expect(isOverrideStillNeeded('3.5.0', '3.4.17')).toBe(false)
  })

  it('キャレット範囲の宣言は、修正版を範囲に含むか下限が修正版以上なら、不要と判定する', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。`^3.4.0` は修正版 `3.4.17` を含むので不要、`^1.2.1` は修正版 `2.0.3` を含まず下限も低いので必要、と判定することを確認します。')
    expect(isOverrideStillNeeded('^3.4.0', '3.4.17')).toBe(false)
    expect(isOverrideStillNeeded('^1.2.1', '2.0.3')).toBe(true)
    expect(isOverrideStillNeeded('^2.0.3', '2.0.3')).toBe(false)
    expect(isOverrideStillNeeded('^3.0.0', '2.0.3')).toBe(false)
  })

  it('0.x のキャレット範囲は、minor までを互換の単位として判定する', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。`^0.16.0` は修正版 `0.18.7` を含まないので `true`、`^0.18.0` と `^0.19.0` は `false` を返すことを確認します。')
    expect(isOverrideStillNeeded('^0.16.0', '0.18.7')).toBe(true)
    expect(isOverrideStillNeeded('^0.18.0', '0.18.7')).toBe(false)
    expect(isOverrideStillNeeded('^0.19.0', '0.18.7')).toBe(false)
  })

  it('0.0.x のキャレット範囲は、patch まで一致することを互換の単位として判定する', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。`^0.0.3` は修正版 `0.0.5` を含まないので `true`、`^0.0.5` は `false` を返すことを確認します。')
    expect(isOverrideStillNeeded('^0.0.3', '0.0.5')).toBe(true)
    expect(isOverrideStillNeeded('^0.0.5', '0.0.5')).toBe(false)
  })

  it('判定できない形の宣言は、不要として扱い、人が確認できるようにする', async () => {
    await explains('override が要るかを判定する `isOverrideStillNeeded` のテストです。`~3.4.0`・`>=3.0.0`・`*` など、判定できない形の宣言を渡した場合に、すべて `false` を返すことを確認します。')
    for (const declared of ['~3.4.0', '>=3.0.0', '^3.4.0 || ^4.0.0', '3.4.15-beta.1', '*']) {
      expect(isOverrideStillNeeded(declared, '3.4.17')).toBe(false)
    }
  })
})

describe('runtimeInstallLockPath', () => {
  // ロックは永続層の直下に置く (node_modules を作る側なので chromium 側とは場所が違う)。
  it('永続層の直下にある、固定名のパスを返す', async () => {
    await explains('インストールのロックファイルのパスを返す `runtimeInstallLockPath` のテストです。`CLAUDE_PLUGIN_DATA` を指定した場合に、`<データ置き場>/mcp-dist/.pecotv-runtime-install.lock` のパスを返すことを確認します。')
    const data = temporaryRoot('lock-data')
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    expect(runtimeInstallLockPath())
      .toBe(path.join(data, 'mcp-dist', '.pecotv-runtime-install.lock'))
  })

  it('データ置き場を決められない場合は、undefined を返す', async () => {
    await explains('インストールのロックファイルのパスを返す `runtimeInstallLockPath` のテストです。データ置き場を特定できない場合に、存在しない親を指すパスを組み立てず、`undefined` を返すことを確認します。')
    // flock(1) は親ディレクトリが無いとロックファイルを作れず exit 66 で終わる。
    stubNoDataDirectory()

    expect(runtimeInstallLockPath()).toBeUndefined()
  })
})

describe('本体の runtime manifest との整合', () => {
  it('manifest の runtime 依存は、すべてインストール対象に含まれる', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`dependencies` に宣言された各パッケージ（`workspace:` 参照を除く）が、すべてインストール対象の指定に含まれることを確認します。')
    // talk-dir は依存ルートの node_modules へ symlink を張る。
    // その状態で slidev build を回すため、
    // manifest が宣言している runtime 依存はすべて永続層に要る。
    const manifest = readRuntimeManifest()
    const specs = runtimeInstallSpecs(RUNTIME_MANIFEST)

    for (const [name, range] of Object.entries(manifest.dependencies)) {
      if (range.startsWith('workspace:')) continue
      // slidev 中核パッケージだけは宣言 range ではなく固定版で入る (下のセルを参照)。
      const expected = name !== '@slidev/theme-default' && name.startsWith('@slidev/')
        ? CORE_VERSION
        : range
      expect(specs, `${name} が install 対象から漏れている`).toContain(`${name}@${expected}`)
    }
  })

  it('manifest は、コードが追加する @slidev/parser と patch-package を宣言しない', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`@slidev/parser` と `patch-package` が依存に含まれず、`devDependencies` が `dom-to-pptx` だけであることを確認します。')
    // 宣言すると、コードが足す spec と二重になり、版の食い違いが起きうる。
    const manifest = readRuntimeManifest()
    const declared = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]

    expect(declared).not.toContain('@slidev/parser')
    expect(declared).not.toContain('patch-package')
    expect(Object.keys(manifest.devDependencies), 'devDependencies から取るのは dom-to-pptx だけ').toEqual(['dom-to-pptx'])
  })

  it('slidev の中核パッケージは、cli・client・parser が同じ固定の版でインストールされる', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`@slidev/cli`・`@slidev/client`・`@slidev/parser` が同じ固定の版になり、`@slidev/theme-default` は固定しないことを確認します。')
    // `--no-package-lock` の install では `^52.14.1` が時点の最新 52.x へ解決される。
    // cli だけが上位版へ動くと、nested に別バージョンの parser / client が入る。
    // すると pptx 差分キャッシュの slideHash を求める parser と、slidev build の parser が食い違う。
    const specs = runtimeInstallSpecs(RUNTIME_MANIFEST)

    for (const name of ['@slidev/cli', '@slidev/client', '@slidev/parser']) {
      expect(specs, `${name} が固定版で入っていない`).toContain(`${name}@${CORE_VERSION}`)
    }
    // 別の版系列 (0.25.x) なので固定の対象に含めない。
    expect(specs).toContain('@slidev/theme-default@^0.25.0')
  })

  it('manifest の @slidev/cli は完全一致の版で、@slidev/client と @slidev/types も同じ版にする', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`@slidev/cli` が `1.2.3` の形の版であり、`@slidev/client` と `@slidev/types` が同じ版であることを確認します。')
    const manifest = readRuntimeManifest()
    const core = manifest.dependencies['@slidev/cli']

    expect(core).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.dependencies['@slidev/client']).toBe(core)
    expect(manifest.dependencies['@slidev/types']).toBe(core)
  })

  it('cli/package.json の @slidev/parser の版は、manifest の @slidev/cli の版と一致する', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`cli/package.json` の `@slidev/parser` の版が、runtime の `package.json` の `@slidev/cli` の版と同じであることを確認します。')
    // ずれると、pptx 差分キャッシュの slideHash を求める parser がビルド時とずれる（slidev-parser-pin-reason）。
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const cliManifest = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(cliManifest.dependencies['@slidev/parser']).toBe(CORE_VERSION)
  })

  it('E2E の fixture の @slidev/cli の版は、manifest の @slidev/cli の版と一致する', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`hash-slidev` と `minimal-slidev` の fixture が宣言する `@slidev/cli` の版が、runtime の `package.json` と同じであることを確認します。')
    // fixture が `*` のままだと、無関係な lock 更新で配布物の slidev から静かに離れる。
    for (const fixture of ['hash-slidev', 'minimal-slidev']) {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const manifest = JSON.parse(
        readFileSync(path.join(CLI_ROOT, 'tests', 'fixtures', fixture, 'package.json'), 'utf8'),
      ) as { dependencies: Record<string, string> }

      expect(manifest.dependencies['@slidev/cli'], `${fixture} が manifest の版で宣言されていない`)
        .toBe(CORE_VERSION)
    }
  })

  it('zod の pnpm の override は、cli/package.json の宣言の下限と一致する', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`pnpm-workspace.yaml` の `zod` の override に `^` を付けた値が、`cli/package.json` の `zod` の宣言と同じであることを確認します。')
    // 配布 package.json の zod は、dist-manifest が cli の宣言を読んで決める。
    // override 値と cli の下限が離れると、ワークスペースと配布物が別の zod を掴む。
    // インスタンスが分かれると tools/list が TypeError で落ちる。
    // override の置き場所は pnpm-workspace.yaml。
    // package.json の pnpm.overrides は pnpm 10 以降で読まれず、警告が出る。
    const workspaceConfig: unknown = parseYaml(readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'))
    const overrides = isRecord(workspaceConfig) && isRecord(workspaceConfig['overrides'])
      ? workspaceConfig['overrides']
      : {}
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const cliManifest = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    const overridden = typeof overrides['zod'] === 'string' ? overrides['zod'] : ''
    expect(overridden, 'zod の override が宣言されていない').not.toBe('')
    expect(cliManifest.dependencies['zod']).toBe(`^${overridden}`)
  })

  it('manifest の overrides は、永続層のインストール計画へ引き継ぐ', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`runtimeInstallPlan` が返す `overrides` が、runtime の `package.json` の `overrides` と同じ内容であることを確認します。')
    // install 対象を manifest から導く設計なので、解決の pin だけ落とすと
    // 永続層とプラグインとして動く側で別の推移依存を掴む。
    const manifest = readRuntimeManifest()

    expect(runtimeInstallPlan(RUNTIME_MANIFEST).overrides).toEqual(manifest.overrides)
  })

  it('manifest の alias の override（npm: 接頭辞）は、値を変えずに引き継ぐ', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`puppeteer` の override が `npm:puppeteer-core@` で始まる alias の形であり、インストール計画にも同じ値で引き継がれることを確認します。')
    // puppeteer の Chrome 自動取得を止める override は、`npm:puppeteer-core@<version>` という alias 形式。
    // version だけを取り出す正規化を挟むと別名解決が失われる。
    // すると永続層の install が本物の puppeteer を入れ、postinstall で Chrome を取りに行く。
    const manifest = readRuntimeManifest()

    const declared = manifest.overrides['puppeteer'] ?? ''
    expect(declared, 'manifest が puppeteer の alias override を宣言していない')
      .toMatch(/^npm:puppeteer-core@/)
    expect(runtimeInstallPlan(RUNTIME_MANIFEST).overrides['puppeteer']).toBe(declared)
  })

  it('puppeteer の alias の override の版は、dom-to-pptx の宣言する範囲に収まる', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`puppeteer` の override の版が、`pnpm-workspace.yaml` と一致し、`dom-to-pptx` が宣言する `puppeteer` の範囲に収まることを確認します。')
    // alias override (`npm:puppeteer-core@<version>`) は、要求範囲が上がっても自動では追従しない。
    // dom-to-pptx が puppeteer の要求範囲を上げても、pnpm / npm はエラーを出さず古いバージョンのまま残る。
    // 範囲外の puppeteer-core を掴むと、node exporter が参照する API が欠ける。
    // そのため両立の確認はここに置く。
    const manifest = readRuntimeManifest()
    const declared = manifest.overrides['puppeteer'] ?? ''
    const overridden = declared.replace(/^npm:puppeteer-core@/, '')
    expect(overridden, `manifest の puppeteer override が版を持たない: ${declared}`)
      .toMatch(/^\d+\.\d+\.\d+$/)

    // 置き場所が 2 つ (workspace の pnpm 解決用と、talk-dir / 永続層の npm install 用) あるため、
    // 片方だけ更新した状態を弾く。
    const workspaceConfig: unknown = parseYaml(readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'))
    const workspaceOverrides = isRecord(workspaceConfig) && isRecord(workspaceConfig['overrides'])
      ? workspaceConfig['overrides']
      : {}
    expect(workspaceOverrides['puppeteer'], 'pnpm-workspace.yaml と manifest で override 値が食い違う')
      .toBe(declared)

    expect(existsSync(DOM_TO_PPTX_MANIFEST), `dom-to-pptx が未 install: ${DOM_TO_PPTX_MANIFEST}`).toBe(true)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const domToPptx = JSON.parse(readFileSync(DOM_TO_PPTX_MANIFEST, 'utf8')) as {
      dependencies: Record<string, string>
    }
    const range = domToPptx.dependencies['puppeteer'] ?? ''
    // semver を依存に足さず caret range 前提で判定する (range の形の固定と 0.x の扱いは
    // caretRangeViolation が持つ)。
    expect(
      caretRangeViolation(overridden, range),
      `puppeteer override ${overridden} が dom-to-pptx の宣言 ${range} と両立しない`,
    ).toBeUndefined()
  })

  it('image-size の override は、workspace と manifest で一致する', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`pnpm-workspace.yaml` の `image-size` の override が `^1.2.3` の形で、runtime の `package.json` の値と同じであることを確認します。')
    // 置き場所は 2 つ。
    // workspace の pnpm 解決用と、talk-dir / 永続層の npm install 用の manifest。
    // 一部だけ更新した状態を弾く。
    const workspaceConfig: unknown = parseYaml(readFileSync(WORKSPACE_YAML, 'utf8'))
    const workspaceOverrides = isRecord(workspaceConfig) && isRecord(workspaceConfig['overrides'])
      ? workspaceConfig['overrides']
      : {}
    const overridden = workspaceOverrides['image-size']
    expect(overridden, 'pnpm-workspace.yaml が image-size の override を宣言していない').toMatch(/^\^\d+\.\d+\.\d+$/)

    const manifest = readRuntimeManifest()
    expect(manifest.overrides['image-size'], `pnpm-workspace.yaml と ${RUNTIME_MANIFEST} で override 値が食い違う`)
      .toBe(overridden)
  })

  it('pptxgenjs の image-size の宣言は、override が必要な範囲のまま残っている', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`pptxgenjs` が宣言する `image-size` の範囲が、修正版を含まず、override がまだ必要と判定されることを確認します。')
    // override が要らなくなったとき（宣言が修正版を含む・依存から外れた等）だけ落とす。
    expect(existsSync(PPTXGENJS_MANIFEST), `pptxgenjs が未 install: ${PPTXGENJS_MANIFEST}`).toBe(true)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const pptxgenjs = JSON.parse(readFileSync(PPTXGENJS_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(
      isOverrideStillNeeded(pptxgenjs.dependencies?.['image-size'], fixedVersionOf('image-size')),
      'pptxgenjs の image-size 宣言が修正版を含むようになった（または依存から外れた）。pnpm-workspace.yaml・manifest の image-size override の撤去を判断する',
    ).toBe(true)
  })

  it('dompurify の override は、workspace と manifest で一致する', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`pnpm-workspace.yaml` の `dompurify` の override が `^1.2.3` の形で、runtime の `package.json` の値と同じであることを確認します。')
    // 置き場所は 2 つ。
    // workspace の pnpm 解決用と、talk-dir / 永続層の npm install 用の manifest。
    // 一部だけ更新した状態を弾く。
    const workspaceConfig: unknown = parseYaml(readFileSync(WORKSPACE_YAML, 'utf8'))
    const workspaceOverrides = isRecord(workspaceConfig) && isRecord(workspaceConfig['overrides'])
      ? workspaceConfig['overrides']
      : {}
    const overridden = workspaceOverrides['dompurify']
    expect(overridden, 'pnpm-workspace.yaml が dompurify の override を宣言していない').toMatch(/^\^\d+\.\d+\.\d+$/)

    const manifest = readRuntimeManifest()
    expect(manifest.overrides['dompurify'], `pnpm-workspace.yaml と ${RUNTIME_MANIFEST} で override 値が食い違う`)
      .toBe(overridden)
  })

  it('monaco-editor の dompurify の宣言は、override が必要な範囲のまま残っている', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`monaco-editor` が宣言する `dompurify` の範囲が、修正版を含まず、override がまだ必要と判定されることを確認します。')
    expect(existsSync(MONACO_EDITOR_MANIFEST), `monaco-editor が未 install: ${MONACO_EDITOR_MANIFEST}`).toBe(true)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const monaco = JSON.parse(readFileSync(MONACO_EDITOR_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(
      isOverrideStillNeeded(monaco.dependencies?.['dompurify'], fixedVersionOf('dompurify')),
      'monaco-editor の dompurify 宣言が修正版を含むようになった（または依存から外れた）。2 か所の dompurify override の撤去を判断する',
    ).toBe(true)
  })

  it('micromark-extension-math の katex の宣言は、override が必要な範囲のまま残っている', async () => {
    await explains('本体の runtime の `package.json` とインストール対象の整合のテストです。`micromark-extension-math` が宣言する `katex` の範囲が、修正版を含まず、override がまだ必要と判定されることを確認します。')
    expect(
      existsSync(MICROMARK_EXTENSION_MATH_MANIFEST),
      `micromark-extension-math が未 install: ${MICROMARK_EXTENSION_MATH_MANIFEST}`,
    ).toBe(true)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const math = JSON.parse(readFileSync(MICROMARK_EXTENSION_MATH_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(
      isOverrideStillNeeded(math.dependencies?.['katex'], fixedVersionOf('micromark-extension-math>katex')),
      'micromark-extension-math の katex 宣言が修正版を含むようになった（または依存から外れた）。micromark-extension-math>katex override の撤去を判断する',
    ).toBe(true)
  })

  it('ワークスペースの package.json は、URL を直接指定する依存を含まない', async () => {
    await explains('ワークスペースの各 `package.json` と `pnpm-workspace.yaml` の `overrides` のテストです。`https:` や `git+ssh:` など、レジストリを通らない指定の依存が 1 つも存在しないことを確認します。')
    // レジストリ以外へ出る依存が 1 つでも残ると、cdn へ届かない、レジストリにしか届かないネットワークで install が exit 1 になる。
    // 走査対象はファイル名を固定せず、pnpm-workspace.yaml の packages 列から導出する。
    // パッケージが増えても自動で網に入る。
    // pnpm が実際に読む overrides は pnpm-workspace.yaml にあるため、そちらも同じ網に入れる。
    // package.json 側の overrides は、talk-dir / 永続層の npm install 用の写し。
    const targets = workspacePackageDirectories()
    expect(targets.length, 'pnpm-workspace.yaml から走査対象を導出できていない')
      .toBeGreaterThan(0)

    const offenders: string[] = []
    for (const directory of targets) {
      const manifestPath = path.join(REPO_ROOT, directory, 'package.json')
      expect(existsSync(manifestPath), `走査対象に package.json が無い: ${manifestPath}`).toBe(true)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']) {
        // eslint-disable-next-line security/detect-object-injection -- field は上のリテラル配列の要素
        offenders.push(...urlValuedEntries(manifest[field], `${directory}/package.json ${field}`))
      }
    }

    const workspaceConfig: unknown = parseYaml(readFileSync(WORKSPACE_YAML, 'utf8'))
    const workspaceOverrides = isRecord(workspaceConfig) ? workspaceConfig['overrides'] : {}
    expect(isRecord(workspaceOverrides), 'pnpm-workspace.yaml に overrides が無い').toBe(true)
    offenders.push(...urlValuedEntries(workspaceOverrides, 'pnpm-workspace.yaml overrides'))

    expect(offenders, `URL 直指定の依存が残っている:\n${offenders.join('\n')}`).toEqual([])
  })

  it('pnpm-lock.yaml は、tarball を直接取得する解決を含まない', async () => {
    await explains('`pnpm-lock.yaml` のテストです。`tarball:` と `cdn.sheetjs.com` の記述がどちらも存在しないことを確認します。')
    // 宣言から URL を消しても、peer 宣言の写しや推移依存として lock に残ることがある。
    // 宣言だけを直して、lock に古い解決が残った状態を見分けるため、宣言の確認とは別に lock を見る。
    const lock = readFileSync(LOCKFILE, 'utf8')

    expect(lock.match(/tarball:/g) ?? [], 'lock に tarball 直取得の resolution が残っている')
      .toEqual([])
    expect(lock.match(/cdn\.sheetjs\.com/g) ?? [], 'lock に cdn.sheetjs.com への参照が残っている')
      .toEqual([])
  })

  it('PATCH_PACKAGE_RANGE は、plugins/pecot-visual/package.json の宣言と一致する', async () => {
    await explains('定数 `PATCH_PACKAGE_RANGE` のテストです。`plugins/pecot-visual/package.json` の `devDependencies` にある `patch-package` の範囲と同じ値であることを確認します。')
    // 永続層はワークスペースと同じ patch-package をテーマの置き場に供給する。片方だけ上げると、
    // ワークスペースで当たったテーマの patch が永続層では当たらない（またはその逆）状態になる。
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const pluginManifest = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }

    expect(PATCH_PACKAGE_RANGE).toBe(pluginManifest.devDependencies['patch-package'])
  })
})

/**
argv と受け取った NODE_EXTRA_CA_CERTS、起動時点の node_modules の並びを JSON で吐くだけの
npm 代役。実 install (600MB 級) は実行しない。

node_modules は、起動時点の並びを記録する。
*/
function writeStubNpm(temporaryDirectory: string): string {
  const stub = path.join(temporaryDirectory, 'stub-npm.cjs')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const nodePath = require('node:path')

const argv = process.argv.slice(2)
const prefix = argv[argv.indexOf('--prefix') + 1] ?? ''
const nodeModules = []
try {
  const root = nodePath.join(prefix, 'node_modules')
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const child of fs.readdirSync(nodePath.join(root, entry.name))) {
        nodeModules.push(entry.name + '/' + child)
      }
      continue
    }
    nodeModules.push(entry.name)
  }
  nodeModules.sort()
}
catch {}
process.stdout.write(JSON.stringify({
  argv,
  extraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null,
  nodeModules,
}))
`,
    { encoding: 'utf8', mode: 0o755 },
  )
  return stub
}

/**
stub npm が吐いた観測値。
*/
function readStubNpmOutput(stdout: string): { argv: string[], extraCaCerts: string | null, nodeModules: string[] } {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  return JSON.parse(stdout) as { argv: string[], extraCaCerts: string | null, nodeModules: string[] }
}

describe('installRuntimeDependencies', () => {
  it.each(['catalog:', 'catalog:named'])('dependencies に %s が残る manifest では、npm を起動せずに失敗を返す', async (range) => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。`vite` の版が `catalog:` のまま残っている場合に、npm を起動せず `package.json` も作成せず、終了コードが `null` で、標準エラーに `vite` が含まれることを確認します。')
    const data = temporaryRoot('data-catalog')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ dependencies: { vite: range, vue: '^3.5.13' } })

    const result = await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    // stub npm は起動すると argv を stdout に吐く。空なら起動していない。
    expect(result.stdout).toBe('')
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
    expect(result.exitCode).toBe(null)
    expect(result.failedStage).toBe('npm')
    expect(result.stderr).toMatch(/catalog: entries that should be replaced at distribution remain in .*: vite$/)
    expect(result.stderr).not.toContain('vue')
    expect(existsSync(runtimePackageJson(data))).toBe(false)
  })

  it('optionalDependencies に catalog: が残る場合も、npm を起動せずに失敗を返す', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。`optionalDependencies` の `fsevents` が `catalog:` の場合に、npm を起動せず、標準エラーに `fsevents` が含まれることを確認します。')
    const data = temporaryRoot('data-catalog-optional')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ optionalDependencies: { fsevents: 'catalog:' } })

    const result = await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    expect(result.stdout).toBe('')
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
    expect(result.exitCode).toBe(null)
    expect(result.stderr).toMatch(/catalog: entries that should be replaced at distribution remain in .*: fsevents$/)
    expect(existsSync(runtimePackageJson(data))).toBe(false)
  })

  it('永続層に package.json を置いてから、--prefix を付けてインストールする', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。正常な `package.json` を渡した場合に、`install --prefix <永続層>` の引数で npm を起動することを確認します。')
    // package.json が無いと npm は上位へ遡り、置き場の外など意図しない場所へ書き込む。
    const data = temporaryRoot('data')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ dependencies: { vue: '^3.5.13' } })

    const result = await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    expect(result.exitCode).toBe(0)
    const runtimeRoot = path.join(data, 'mcp-dist')
    const { argv } = readStubNpmOutput(result.stdout)
    expect(argv.slice(0, 3)).toEqual(['install', '--prefix', runtimeRoot])
    expect(argv).toContain('vue@^3.5.13')
    expect(argv).toContain(`@slidev/parser@${TEST_CORE}`)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const written = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')) as {
      name: string
      private: boolean
    }
    expect(written).toMatchObject({ name: 'pecotv-runtime', private: true })
  })

  it('2 回続けて呼び出しても、package.json を書き直して成功する', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。同じ `package.json` で 2 回続けて呼び出した場合に、2 回目も終了コードが `0` になることを確認します。')
    const data = temporaryRoot('home2')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ dependencies: {} })
    const npmCommand = writeStubNpm(temporaryRoot())

    await installRuntimeDependencies({ manifestPath, npmCommand })
    const second = await installRuntimeDependencies({ manifestPath, npmCommand })

    expect(second.exitCode).toBe(0)
  })

  it('データ置き場を決められなければ、取得先が決まらないので、起動の失敗として返す', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。データ置き場を特定できない場合に、終了コードが `null` で、標準エラーに `PLUGIN_DATA` が含まれる結果を返すことを確認します。')
    stubNoDataDirectory()

    const result = await installRuntimeDependencies({ manifestPath: writeManifestWithCore({}) })

    // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
    expect(result.exitCode).toBe(null)
    expect(result.stderr).toContain('PLUGIN_DATA')
  })

  it('manifest の overrides を、永続層の package.json へ書き込む', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。`lodash-es` と `dompurify` の `overrides` を渡した場合に、永続層の `package.json` に同じ `overrides` が書かれることを確認します。')
    // 推移依存の pin を落とすと、永続層とプラグインとして動く側で別の実体を掴む。
    const data = temporaryRoot('data-overrides')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({
      dependencies: {},
      overrides: { 'lodash-es': '^4.17.23', 'dompurify': '^3.3.3' },
    })

    await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const written = JSON.parse(readFileSync(runtimePackageJson(data), 'utf8')) as {
      overrides: Record<string, string>
    }
    expect(written.overrides).toEqual({ 'lodash-es': '^4.17.23', 'dompurify': '^3.3.3' })
  })

  it('インストールが成功した場合に、stamp を置く', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。インストールが成功した場合に、永続層の stamp ファイルに `runtimeInstallStamp` と同じ値が書かれることを確認します。')
    const data = temporaryRoot('data-stamp')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ dependencies: { vue: '^3.5.13' } })

    await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    expect(readFileSync(stampPath(data), 'utf8').trim()).toBe(runtimeInstallStamp(manifestPath))
  })

  it('インストールが失敗した場合は、stamp を削除したままにする', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。先に成功させて stamp を置き、次のインストールが終了コード `1` で失敗した場合に、途中で終了した残骸を取得済みとみなさないよう、stamp が存在しなくなることを確認します。')
    const data = temporaryRoot('data-stamp-fail')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const manifestPath = writeManifestWithCore({ dependencies: {} })
    // 先に成功させて stamp を置き、次の install を失敗させる。
    await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })
    expect(existsSync(stampPath(data))).toBe(true)

    const failing = temporaryRoot('failing-npm.cjs')
    writeFileSync(failing, '#!/usr/bin/env node\nprocess.exit(1)\n', { encoding: 'utf8', mode: 0o755 })
    const result = await installRuntimeDependencies({ manifestPath, npmCommand: failing })

    expect(result.exitCode).toBe(1)
    expect(existsSync(stampPath(data))).toBe(false)
  })

  it('manifest から計画を作成できない場合は、npm を起動せずに、起動の失敗として返す', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。`@slidev/cli` を宣言していない `package.json` を渡した場合に、終了コードが `null` で、失敗の段階が `npm` になることを確認します。')
    const data = temporaryRoot('data-broken')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)

    const result = await installRuntimeDependencies({
      manifestPath: writeManifest({ dependencies: {} }),
      npmCommand: writeStubNpm(temporaryRoot()),
    })

    // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
    expect(result.exitCode).toBe(null)
    expect(result.failedStage).toBe('npm')
    expect(result.stderr).toContain('@slidev/cli')
    expect(existsSync(runtimePackageJson(data))).toBe(false)
  })

  it('NODE_EXTRA_CA_CERTS が設定されていなければ、未設定のまま npm に渡す', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。環境変数 `NODE_EXTRA_CA_CERTS` が未設定の場合に、起動した npm にも `null`（未設定）として渡ることを確認します。')
    // pecot は証明書を足さない。空文字とも区別するため、npm 代役は未設定を null で返す。
    const data = temporaryRoot('data-ca')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    const manifestPath = writeManifestWithCore({ dependencies: {} })

    const result = await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    expect(readStubNpmOutput(result.stdout).extraCaCerts).toBeNull()
  })

  it('NODE_EXTRA_CA_CERTS が設定されていれば、その値のまま npm に渡す', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。環境変数 `NODE_EXTRA_CA_CERTS` に `/etc/ssl/corp.pem` を設定した場合に、起動した npm にも同じ値が渡ることを確認します。')
    // 単一ファイルしか渡せないため、上書きすると、利用者の用意した束が落ちる。
    const data = temporaryRoot('data-ca-preset')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem')
    const manifestPath = writeManifestWithCore({ dependencies: {} })

    const result = await installRuntimeDependencies({ manifestPath, npmCommand: writeStubNpm(temporaryRoot()) })

    expect(readStubNpmOutput(result.stdout).extraCaCerts).toBe('/etc/ssl/corp.pem')
  })

  // flock(1) が無い環境 (macOS 等) はロックなしで動く契約なので、このセルは成立しない。
  it.skipIf(!hasFlockCommand())('同じ永続層への同時のインストールは、flock で直列に実行される', async () => {
    await explains('永続層へ依存をインストールする `installRuntimeDependencies` のテストです。`flock` コマンドを使える環境で、同じ永続層に 2 つのインストールを同時に始めた場合に、実行が重ならず、どちらも終了コードが `0` になることを確認します。')
    // 単体配布は MCP クライアントごとに別プロセスが立つため、複数セッションからの
    // `runtime_setup` が同じ node_modules へ 2 本並走し得る。
    const data = temporaryRoot('data-concurrent')
    mkdirSync(data, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const marker = temporaryRoot('in-flight')
    vi.stubEnv('PECOTV_TEST_IN_FLIGHT', marker)
    const manifestPath = writeManifestWithCore({ dependencies: {} })
    const npmCommand = writeOverlapDetectingNpm(temporaryRoot())

    const results = await Promise.all([
      installRuntimeDependencies({ manifestPath, npmCommand }),
      installRuntimeDependencies({ manifestPath, npmCommand }),
    ])

    // 重なりを検出した側は exit 1 で終わる。両方 0 なら直列に動いている。
    expect(results.map(result => result.exitCode)).toEqual([0, 0])
  })
})

/**
永続層の package.json のパス。
*/
function runtimePackageJson(data: string): string {
  return path.join(data, 'mcp-dist', 'package.json')
}

/**
永続層の install stamp のパス。
*/
function stampPath(data: string): string {
  return path.join(data, 'mcp-dist', '.pecotv-runtime-stamp')
}

/**
実行が重なったら失敗する npm 代役。

排他できていれば 2 本とも exit 0、重なれば後発が marker の排他生成に失敗して exit 1。
*/
function writeOverlapDetectingNpm(temporaryDirectory: string): string {
  const stub = path.join(temporaryDirectory, 'overlap-npm.cjs')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const marker = process.env.PECOTV_TEST_IN_FLIGHT
try {
  fs.writeFileSync(marker, '', { flag: 'wx' })
}
catch {
  process.stderr.write('overlapped')
  process.exit(1)
}
setTimeout(() => {
  fs.rmSync(marker)
  process.exit(0)
}, 300)
`,
    { encoding: 'utf8', mode: 0o755 },
  )
  return stub
}
