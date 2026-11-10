// lock の shiki / @shikijs/* / vite が各 1 版であること (#1233) を見る。
// vite の範囲が catalog の 1 か所にあり、@slidev/cli の範囲の中にあること (#170) も見る。
// 永続層 (npm install) の単一版は実取得を伴うので、ここでは lock と宣言の範囲一致だけを見る。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはリポジトリ内の追跡ファイルと install 済み manifest のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse, parseAllDocuments } from 'yaml'

import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { isRecord } from '../../../src/domain/_shared/json.js'
import { caretRangeOutside, caretRangeViolation } from '../../_helpers/caret-range.js'

// tests/unit/infra → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
// 依存と lock は repo root の 1 つの pnpm workspace が持つ (#113)。
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')
// nodeLinker: hoisted なので workspace の依存は repo root の node_modules 直下に並ぶ。
const SLIDEV_CLI_MANIFEST = path.join(REPO_ROOT, 'node_modules', '@slidev', 'cli', 'package.json')
const RUNTIME_MANIFEST = path.join(PLUGIN_ROOT, 'assets', 'slidev', 'runtime', 'package.json')
const WORKSPACE = path.join(REPO_ROOT, 'pnpm-workspace.yaml')

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

type ManifestField = 'dependencies' | 'devDependencies' | 'optionalDependencies'

/**
manifest の `field`（`ManifestField`）の欄を読む。ファイルが無い場合は未 install として明示的に失敗させる。
*/
function readManifestField(file: string, field: ManifestField): ReadonlyMap<string, string> {
  expect(existsSync(file), `未 install または不在: ${file}`).toBe(true)
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<ManifestField, Record<string, string>>>
  const section = Object.entries(manifest).find(([key]) => key === field)
  return new Map(Object.entries(section?.[1] ?? {}))
}

// 引数は (catalog.vite, @slidev/cli の宣言)。順を取り違えると判定が逆になる。
function catalogViteOutside(catalogVite: string, slidevVite: string): string | undefined {
  return caretRangeOutside(catalogVite, slidevVite)
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

  it('固定した shiki 系の版が @slidev/cli の宣言範囲を満たす', () => {
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
    expect(mismatches, `範囲が食い違っている:\n${mismatches.join('\n')}`).toEqual([])
  })
})

/**
pnpm-workspace.yaml を読み、`packages` と `catalog.vite` を生の値で返す。検証は呼び出し側の it で行う。
*/
function readWorkspace(): { readonly packages: unknown, readonly catalogVite: unknown } {
  const workspace: unknown = parse(readFileSync(WORKSPACE, 'utf8'))
  const catalog = isRecord(workspace) ? workspace['catalog'] : undefined
  return {
    packages: isRecord(workspace) ? workspace['packages'] : undefined,
    catalogVite: isRecord(catalog) ? catalog['vite'] : undefined,
  }
}

describe('vite の範囲の一元化 (#170)', () => {
  it('workspace の全メンバーで vite は catalog: 参照', () => {
    const { packages } = readWorkspace()
    expect(Array.isArray(packages), 'pnpm-workspace.yaml に packages がない').toBe(true)
    const members = Array.isArray(packages) ? packages : []
    const nonStrings = members.filter(entry => typeof entry !== 'string')
    expect(nonStrings, 'pnpm-workspace.yaml の packages に文字列以外がある').toEqual([])
    const sections: readonly ManifestField[] = ['dependencies', 'devDependencies', 'optionalDependencies']
    const violations: string[] = []
    for (const member of ['.', ...members.filter((entry): entry is string => typeof entry === 'string')]) {
      const file = path.join(REPO_ROOT, member, 'package.json')
      if (!existsSync(file)) continue
      for (const section of sections) {
        const range = readManifestField(file, section).get('vite')
        if (range !== undefined && range !== 'catalog:') violations.push(`${member} の ${section}: vite=${range}`)
      }
    }
    expect(violations, `vite の範囲は pnpm-workspace.yaml の catalog.vite に置き、ここは catalog: とする:\n${violations.join('\n')}`).toEqual([])
  })

  it('catalog.vite が @slidev/cli の vite の範囲の中', () => {
    // 期待側が未宣言、または catalog.vite が文字列でないときは落とす。
    const expected = readManifestField(SLIDEV_CLI_MANIFEST, 'dependencies').get('vite')
    const { catalogVite } = readWorkspace()
    expect(expected, '@slidev/cli が vite を宣言していない').toBeDefined()
    expect(typeof catalogVite, 'pnpm-workspace.yaml の catalog.vite が文字列ではない').toBe('string')
    const reason = typeof catalogVite === 'string' && expected !== undefined ? catalogViteOutside(catalogVite, expected) : undefined
    expect(
      reason,
      `pnpm-workspace.yaml の catalog.vite=${String(catalogVite)} が @slidev/cli の vite=${expected ?? '(宣言なし)'} の範囲の外: ${reason ?? ''}`,
    ).toBeUndefined()
  })
})

describe('catalogViteOutside', () => {
  it('catalog.vite の下限が @slidev/cli の範囲以上なら中', () => {
    expect(catalogViteOutside('^8.3.7', '^8.3.6')).toBeUndefined()
  })

  it('下限が同じなら中', () => {
    expect(catalogViteOutside('^8.3.6', '^8.3.6')).toBeUndefined()
  })

  it('catalog.vite の下限が @slidev/cli より低いと外', () => {
    expect(catalogViteOutside('^8.3.5', '^8.3.6')).toBeDefined()
  })

  it('引数を逆にすると外になる', () => {
    expect(catalogViteOutside('^8.3.6', '^8.3.7')).toBeDefined()
  })
})
