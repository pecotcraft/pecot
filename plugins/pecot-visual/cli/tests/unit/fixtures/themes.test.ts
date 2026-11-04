// テスト用テーマ 2 つの構成を固定する。
// with-declaration は pecot 用の宣言を持ち、without-declaration は持たない。
// 後続のテストはこの 2 つを前提にするため、構成が崩れたらここで気づけるようにする。

/* eslint-disable security/detect-non-literal-fs-filename -- fixture ツリーの走査と読み込みのみ */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { extractSkeleton, isFrontmatterBlock } from '../../../src/domain/slidev-theme/skeleton.js'

// tests/unit/fixtures → tests/fixtures/themes
const THEMES_ROOT = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'themes')
const DECLARED = path.join(THEMES_ROOT, 'with-declaration')
const BARE = path.join(THEMES_ROOT, 'without-declaration')
const DEP = path.join(THEMES_ROOT, 'theme-only-dep')

interface PackageJson {
  readonly name?: string
  readonly version?: string
  readonly private?: boolean
  readonly type?: string
  readonly peerDependencies?: Record<string, string>
  readonly scripts?: unknown
  readonly engines?: Record<string, string>
  readonly dependencies?: Record<string, string>
}

interface ThemeDeclaration {
  readonly schema?: number
  readonly slide?: { width?: number, height?: number }
  readonly fonts?: { body?: string[], heading?: string[], eastAsian?: string }
  readonly fontSizes?: Record<string, number>
  readonly pptx?: { eastAsianFont?: string, linkColor?: string }
  readonly lint?: { rules?: Record<string, string> }
  readonly layouts?: { references?: string }
  readonly drawio?: {
    panels?: Record<string, { width: number, height: number }>
    markerLayouts?: string[]
  }
}

interface LayoutReference {
  readonly layout?: string
  readonly description?: string
  readonly category?: string
  readonly includes?: string[]
  readonly props?: Record<string, unknown>
  readonly text_constraints?: Record<string, unknown>
  readonly layout_categories?: { id: string }[]
}

function readPackage(file: string): PackageJson {
  // eslint-disable-next-line no-restricted-syntax -- fixture の JSON を test 用の型へ絞り込む
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson
}

function readDeclaration(file: string): ThemeDeclaration {
  // eslint-disable-next-line no-restricted-syntax -- fixture の JSON を test 用の型へ絞り込む
  return JSON.parse(readFileSync(file, 'utf8')) as ThemeDeclaration
}

function readYaml(file: string): LayoutReference {
  // eslint-disable-next-line no-restricted-syntax -- fixture の yaml を test 用の型へ絞り込む
  return parse(readFileSync(file, 'utf8')) as LayoutReference
}

function byName(left = '', right = ''): number {
  return left.localeCompare(right)
}

function listFiles(directory: string): readonly string[] {
  const entries = existsSync(directory)
    ? readdirSync(directory, { recursive: true, withFileTypes: true })
    : []
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .toSorted(byName)
}

function declaredLayoutNames(): readonly string[] {
  return listFiles(path.join(DECLARED, 'layouts'))
    .filter(file => file.endsWith('.vue'))
    .map(file => file.replace(/\.vue$/u, ''))
}

describe('テスト用テーマのファイル構成', () => {
  it('with-declaration は宣言・references・layouts・public を持つ', () => {
    expect(listFiles(DECLARED)).toEqual([
      'layouts/cover.vue',
      'layouts/end.vue',
      'layouts/legacy-panel.vue',
      'layouts/link.vue',
      'layouts/marked.vue',
      'layouts/panel.vue',
      'layouts/plain.vue',
      'layouts/scratch.vue',
      'layouts/section.vue',
      'package.json',
      'pecot-theme.json',
      'public/fonts/Inter-latin.woff2',
      'public/fonts/Inter-OFL.txt',
      'public/fonts/NotoSansJP-latin.woff2',
      'public/fonts/NotoSansJP-OFL.txt',
      'public/sample.png',
      'public/sample.svg',
      'references/_common.yaml',
      'references/cover.yaml',
      'references/end.yaml',
      'references/legacy-panel.yaml',
      'references/link.yaml',
      'references/marked.yaml',
      'references/panel.yaml',
      'references/plain.yaml',
      'references/scratch.yaml',
      'references/section.yaml',
      'styles/index.css',
    ])
  })

  it('without-declaration は layouts だけを持ち、宣言と references を持たない', () => {
    expect(listFiles(BARE)).toEqual([
      'layouts/one.vue',
      'layouts/two.vue',
      'package.json',
    ])
    expect(existsSync(path.join(BARE, 'pecot-theme.json'))).toBe(false)
    expect(existsSync(path.join(BARE, 'references'))).toBe(false)
  })
})

describe('package.json', () => {
  it.each([
    ['with-declaration', DECLARED, 'slidev-theme-pecotv-test-declared'],
    ['without-declaration', BARE, 'slidev-theme-pecotv-test-bare'],
  ])('%s は取得時に何も動かさない形で、vue を peerDependencies に持つ', (_label, root, name) => {
    const packageJson = readPackage(path.join(root, 'package.json'))
    expect(packageJson.name).toBe(name)
    expect(packageJson.version).toBe('0.0.0')
    expect(packageJson.private).toBe(true)
    expect(packageJson.type).toBe('module')
    expect(packageJson.peerDependencies).toHaveProperty('vue')
    expect(packageJson.peerDependencies).toHaveProperty('@slidev/client')
    expect(packageJson).not.toHaveProperty('scripts')
    expect(packageJson.engines).toHaveProperty('node')
    expect(packageJson.engines).not.toHaveProperty('slidev')
  })

  it('with-declaration の dependencies は、テーマだけが使う依存 1 つだけ', () => {
    const packageJson = readPackage(path.join(DECLARED, 'package.json'))
    expect(packageJson.dependencies).toEqual({ 'pecotv-test-theme-dep': 'file:../theme-only-dep' })
  })

  it('without-declaration は dependencies を持たない', () => {
    expect(readPackage(path.join(BARE, 'package.json'))).not.toHaveProperty('dependencies')
  })

  it('theme-only-dep は engines.node と vue の peer を固定し、ファイルは 2 つだけ', () => {
    const packageJson = readPackage(path.join(DEP, 'package.json'))
    expect(packageJson.name).toBe('pecotv-test-theme-dep')
    expect(packageJson.engines).toEqual({ node: '^24.22.1 || >=26.12.1' })
    expect(packageJson.peerDependencies).toEqual({ vue: '^3.5.44' })
    expect(packageJson).not.toHaveProperty('dependencies')
    expect(listFiles(DEP)).toEqual(['index.js', 'package.json'])
  })
})

describe('pecot-theme.json', () => {
  const declaration = readDeclaration(path.join(DECLARED, 'pecot-theme.json'))

  it('契約の項目が揃っている', () => {
    expect(declaration.schema).toBe(1)
    expect(declaration.slide).toEqual({ width: 960, height: 540 })
    expect(declaration.fonts).toEqual({
      body: ['Test Sans'],
      heading: ['Test Sans'],
      eastAsian: 'Test Sans JP',
    })
    expect(declaration.fontSizes).toEqual({ heading: 18, headingSm: 15, body: 14, bodySm: 11, label: 10 })
    expect(declaration.pptx).toEqual({ eastAsianFont: 'Test Sans JP', linkColor: '0A7F3F' })
    expect(declaration.lint?.rules).toEqual({
      'slidev-pages-lint/no-unknown-props': 'error',
      'slidev-pages-lint/no-missing-page': 'error',
      'text-constraints/max-chars': 'error',
    })
    expect(declaration.layouts).toEqual({ references: 'references' })
  })

  it('drawio の枠と印のレイアウトは layouts に存在する', () => {
    const names = declaredLayoutNames()
    expect(declaration.drawio?.panels).toEqual({ panel: { width: 400, height: 300 } })
    expect(declaration.drawio?.markerLayouts).toEqual(['marked'])
    const panelNames = Object.keys(declaration.drawio?.panels ?? {})
    const markerNames = declaration.drawio?.markerLayouts ?? []
    for (const name of panelNames) {
      expect(names).toContain(name)
    }
    for (const name of markerNames) {
      expect(names).toContain(name)
    }
  })
})

const DECLARED_LAYOUTS = ['cover', 'end', 'legacy-panel', 'link', 'marked', 'panel', 'plain', 'scratch', 'section']

describe('references', () => {
  const directory = path.join(DECLARED, 'references')
  const layoutFiles = listFiles(directory).filter(file => file !== '_common.yaml')

  it('_common.yaml は description と 2 つ以上の分類を持つ', () => {
    const common = readYaml(path.join(directory, '_common.yaml'))
    expect(common.description).toEqual(expect.any(String))
    expect(common.layout_categories?.length).toBeGreaterThanOrEqual(2)
  })

  it('layout: が layouts/*.vue のファイル名と 1 対 1 に対応する', () => {
    const declared = layoutFiles.map(file => readYaml(path.join(directory, file)).layout)
      .toSorted(byName)
    expect(declared).toEqual(declaredLayoutNames().toSorted(byName))
    expect(declared).toEqual(['cover', 'end', 'legacy-panel', 'link', 'marked', 'panel', 'plain', 'scratch', 'section'])
  })

  // hidden の scratch は一覧に出ないため、分類を持たない。
  it.each(DECLARED_LAYOUTS.filter(name => name !== 'scratch'))('%s は _template.yaml の項目を持ち、includes は _common だけ', (name) => {
    const reference = readYaml(path.join(directory, `${name}.yaml`))
    expect(reference.layout).toBe(name)
    expect(reference.description).toEqual(expect.any(String))
    expect(reference.includes).toEqual(['_common'])
    expect(reference.props).toBeTypeOf('object')
    expect(reference.text_constraints).toBeTypeOf('object')
    const common = readYaml(path.join(directory, '_common.yaml'))
    const categories = (common.layout_categories ?? []).map(category => category.id)
    expect(categories).toContain(reference.category)
  })

  it.each(DECLARED_LAYOUTS)('%s は examples に --- で囲んだ frontmatter を 1 件以上持つ', (name) => {
    const text = readFileSync(path.join(directory, `${name}.yaml`), 'utf8')
    expect(extractSkeleton(text), `${name}.yaml の examples`).toSatisfy(isFrontmatterBlock)
    expect(extractSkeleton(text)).toContain(`layout: ${name}\n`)
  })
})
