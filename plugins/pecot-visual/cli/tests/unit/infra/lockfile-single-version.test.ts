// pnpm-lock.yaml の shiki / @shikijs/* / vite が各 1 版であることのチェック (#1233)。
//
// なぜ単一版を守るのか: テーマの LCodeBlock などが @shikijs/* を直接 import する。
// shiki 本体と兄弟パッケージの版が割れると、文法・テーマが二重に同梱され、利用者デッキで
// shiki 本体と langs / themes の版がずれる。vite も Slidev 本体と本体の実行時依存の manifest が別の版を引くと割れるため、同じ網に入れる。
// 永続層 (npm install) の単一版は実取得を伴うので、ここでは lock と宣言の範囲一致だけを見る。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはリポジトリ内の追跡ファイルと install 済み manifest のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { isRecord } from '../../../src/domain/_shared/json.js'

// tests/unit/infra → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const LOCKFILE = path.join(PLUGIN_ROOT, 'pnpm-lock.yaml')
// nodeLinker: hoisted なので workspace の依存は plugins/pecot-visual/node_modules 直下に並ぶ。
const SLIDEV_CLI_MANIFEST = path.join(PLUGIN_ROOT, 'node_modules', '@slidev', 'cli', 'package.json')
const RUNTIME_MANIFEST = path.join(PLUGIN_ROOT, 'assets', 'slidev', 'runtime', 'package.json')
const CLI_MANIFEST = path.join(CLI_ROOT, 'package.json')

/**
固定の対象。`vite` は完全一致で、`vite-plugin-*` / `vitefu` / `vitest` を巻き込まない。
`@shikijs/vscode-textmate` は shiki と系列が別だが、パッケージごとの単一版は同じく求める。
`@slidev/types` は theme-default 経由で別の版が残るため対象にしない。
*/
function isPinnedPackage(name: string): boolean {
  return name === 'shiki' || name === 'vite' || name.startsWith('@shikijs/')
}

/**
`packages` のキー (`name@version`) を名前と版に分ける。スコープ付き名の先頭 `@` を避けるため最後の `@` で切る。
*/
function splitPackageKey(key: string): { readonly name: string, readonly version: string } {
  const separator = key.lastIndexOf('@')
  return { name: key.slice(0, separator), version: key.slice(separator + 1) }
}

/**
lock の全文書の `packages` から、固定対象の名前ごとの版の集合を集める。
pnpm-lock.yaml は `---` 区切りの 2 文書なので `parse` ではなく `parseAllDocuments` で読む。
*/
function pinnedVersionsByPackage(): ReadonlyMap<string, ReadonlySet<string>> {
  const versions = new Map<string, Set<string>>()
  const documents = parseAllDocuments(readFileSync(LOCKFILE, 'utf8'))
  for (const document of documents) {
    const contents: unknown = document.toJS()
    const packages = isRecord(contents) ? contents['packages'] : undefined
    if (!isRecord(packages)) continue
    for (const key of Object.keys(packages)) {
      const { name, version } = splitPackageKey(key)
      if (!isPinnedPackage(name)) continue
      const known = versions.get(name) ?? new Set<string>()
      known.add(version)
      versions.set(name, known)
    }
  }
  return versions
}

/**
manifest の `field` (`dependencies` / `devDependencies`) を読む。ファイルが無い場合は未 install として明示的に失敗させる。
*/
function readManifestField(file: string, field: 'dependencies' | 'devDependencies'): ReadonlyMap<string, string> {
  expect(existsSync(file), `未 install または不在: ${file}`).toBe(true)
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<'dependencies' | 'devDependencies', Record<string, string>>
  const section = Object.entries(manifest).find(([key]) => key === field)
  return new Map(Object.entries(section?.[1] ?? {}))
}

/**
完全一致の版が caret range (`^x.y.z`) を満たさない理由を返す。満たすなら undefined。
semver を依存に足さないための最小判定で、major が 1 以上の範囲だけを扱う。
*/
function caretRangeViolation(version: string, range: string): string | undefined {
  const lower = /^\^(\d+)\.(\d+)\.(\d+)$/u.exec(range)
  if (lower === null) return `宣言が caret range ではない: ${range}`
  const actual = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (actual === null) return `版が完全一致指定ではない: ${version}`
  const [lowerMajor = 0, lowerMinor = 0, lowerPatch = 0] = lower.slice(1).map(Number)
  const [major = 0, minor = 0, patch = 0] = actual.slice(1).map(Number)
  if (major !== lowerMajor) return `${version} が ${range} と major 不一致`
  if (minor !== lowerMinor) return minor > lowerMinor ? undefined : `${version} が ${range} の下限未満`
  return patch >= lowerPatch ? undefined : `${version} が ${range} の下限未満`
}

describe('固定対象の単一版 (#1233)', () => {
  it('shiki / @shikijs/* / vite が lock でパッケージごとに 1 版', () => {
    const versions = pinnedVersionsByPackage()

    // チェックが空振りしていないこと (キーの切り方が破損すると全件 0 件で通ってしまう)
    expect(versions.keys().toArray()).toEqual(expect.arrayContaining(['shiki', 'vite', '@shikijs/core', '@shikijs/langs']))

    const split = versions.entries()
      .filter(([, known]) => known.size > 1)
      .map(([name, known]) => `${name}: ${known.values().toArray().toSorted(compareStrings).join(' / ')}`)
      .toArray()
    expect(split, `版が割れているパッケージ:\n${split.join('\n')}`).toEqual([])
  })

  it('固定した shiki 系の版が @slidev/cli の宣言範囲を満たし、vite の範囲は同じ文字列', () => {
    // 永続層は lock なしの npm install で、shiki と兄弟は互いを同版の完全一致で引く。
    // manifest はテーマの peer に合わせて完全一致で固定するため、Slidev の宣言範囲の外へ出ると版が割れる。
    // 期待側が未宣言なら不一致として扱い、undefined 同士の比較で通らないようにする。
    const slidev = readManifestField(SLIDEV_CLI_MANIFEST, 'dependencies')
    const runtime = readManifestField(RUNTIME_MANIFEST, 'dependencies')
    const shikiRange = slidev.get('shiki')
    const shikiNames = ['shiki', '@shikijs/langs', '@shikijs/themes']

    const mismatches = shikiNames
      .map(name => ({ name, pinned: runtime.get(name) }))
      .filter(({ pinned }) => shikiRange === undefined || pinned === undefined || caretRangeViolation(pinned, shikiRange) !== undefined)
      .map(({ name, pinned = '(宣言なし)' }) =>
        `${name}: manifest=${pinned} / @slidev/cli の shiki=${shikiRange ?? '(宣言なし)'}`)
    const viteExpected = slidev.get('vite')
    const viteActual = runtime.get('vite')
    if (viteExpected === undefined || viteActual !== viteExpected) {
      mismatches.push(`vite: manifest=${viteActual ?? '(宣言なし)'} / @slidev/cli の vite=${viteExpected ?? '(宣言なし)'}`)
    }
    expect(mismatches, `範囲が食い違っている:\n${mismatches.join('\n')}`).toEqual([])
  })
})

describe('cli の vite の追従 (#1234)', () => {
  it('pecot-visual cli の devDependencies の vite が @slidev/cli の宣言と同じ文字列', () => {
    // cli の vite は、Vitest の peer を満たすために明示する。
    // 同じ lock で Slidev の vite と並ぶため、Slidev 側が範囲を変えたとき、cli 側の追従抜けで割れる余地を残さない。
    // そのためのチェック。lock の分割そのものは 1 件目が検出する。
    // 期待側が未宣言なら不一致として扱う。
    const slidev = readManifestField(SLIDEV_CLI_MANIFEST, 'dependencies')
    const cli = readManifestField(CLI_MANIFEST, 'devDependencies')

    const expected = slidev.get('vite')
    const actual = cli.get('vite')
    expect(expected, '@slidev/cli が vite を宣言していない').toBeDefined()
    expect(actual, `cli の vite=${actual ?? '(宣言なし)'} / @slidev/cli の vite=${expected ?? '(宣言なし)'}`).toBe(expected)
  })
})
