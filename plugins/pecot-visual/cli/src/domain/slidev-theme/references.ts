// レイアウトの宣言（references/*.yaml）を集める。
// テーマの `<themeRoot>/<referencesDirectory>/` と talk-dir の `<talkDirectory>/references/` を合わせる。
// 同名のレイアウトは talk-dir が勝つ。
// 宣言の無いテーマ（references/ が無い）は、`<themeRoot>/layouts/*.vue` の名前だけを一覧にする。

import path from 'node:path'

import { parse } from 'yaml'

import { isRecord } from '../_shared/json.js'
import type { ThemeFiles } from './ports.js'

export const UNCATEGORIZED = 'uncategorized'
const TALK_REFERENCES_DIRECTORY = 'references'
const COMMON_FILE_NAME = '_common.yaml'

/**
分類を読めなかったときの復旧導線。テーマ側の宣言を直す案内を、分類まわりの警告に必ず添える。
*/
const CATEGORY_SYNC_HINT = 'check layout_categories in references/_common.yaml of the theme'

export type LayoutStatus = 'stable' | 'deprecated' | 'hidden'

export interface LayoutReference {
  readonly name: string
  readonly description: string
  readonly category: string
  // 宣言に `category` が無い（vue 由来を含む）。明示の `category: uncategorized` とは区別する
  readonly categoryMissing?: true
  // 宣言の `status`。未指定・未知の値は stable
  readonly status: LayoutStatus
  // 宣言の元になったファイル（yaml。宣言の無いテーマでは vue）
  readonly file: string
}

export interface LayoutReferences {
  // 名前順。同名は talk-dir 側
  readonly entries: readonly LayoutReference[]
  // 宣言を探したディレクトリ。talk-dir 側が先
  readonly directories: readonly string[]
  // 宣言を読んで気付いた警告（未知の status など）
  readonly warnings: readonly string[]
}

export interface ResolveLayoutReferencesOptions {
  readonly themeRoot: string
  readonly talkDirectory: string
  readonly referencesDirectory: string
}

function isDeclarationFile(fileName: string, extension: string): boolean {
  return fileName.endsWith(extension) && !fileName.startsWith('_')
}

interface DirectoryReferences {
  readonly entries: readonly LayoutReference[]
  readonly warnings: readonly string[]
}

function toStatus(
  value: unknown,
  fileName: string,
  // 警告の蓄積先。呼び出し元の配列へ積む。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  warnings: string[],
): LayoutStatus {
  switch (value) {
    case 'stable':
    case 'deprecated':
    case 'hidden': {
      return value
    }
    default: {
      if (typeof value === 'string' && value !== '') {
        warnings.push(`unknown status in ${fileName}: ${value}; treating it as stable`)
      }
      return 'stable'
    }
  }
}

async function readDirectory(files: ThemeFiles, directory: string): Promise<DirectoryReferences> {
  const warnings: string[] = []
  const listed = await files.listFiles(directory)
  const names = listed.filter(name => isDeclarationFile(name, '.yaml'))
  const entries: LayoutReference[] = []
  for (const fileName of names) {
    const file = path.join(directory, fileName)
    const text = await files.readText(file)
    if (text === undefined) continue
    const document: unknown = parse(text)
    const record = isRecord(document) ? document : {}
    entries.push({
      name: stringOr(record['layout'], path.basename(fileName, '.yaml')),
      description: stringOr(record['description'], ''),
      category: stringOr(record['category'], UNCATEGORIZED),
      ...(stringOr(record['category'], '') === '' && { categoryMissing: true }),
      status: toStatus(record['status'], fileName, warnings),
      file,
    })
  }
  return { entries, warnings }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

async function readLayoutNames(files: ThemeFiles, themeRoot: string): Promise<readonly LayoutReference[]> {
  const directory = path.join(themeRoot, 'layouts')
  const listed = await files.listFiles(directory)
  const names = listed.filter(name => isDeclarationFile(name, '.vue'))
  return names.map(fileName => ({
    name: path.basename(fileName, '.vue'),
    description: '',
    category: UNCATEGORIZED,
    categoryMissing: true,
    status: 'stable',
    file: path.join(directory, fileName),
  }))
}

export async function resolveLayoutReferences(
  files: ThemeFiles,
  options: ResolveLayoutReferencesOptions,
): Promise<LayoutReferences> {
  const themeDirectory = path.join(options.themeRoot, options.referencesDirectory)
  const talkReferences = path.join(options.talkDirectory, TALK_REFERENCES_DIRECTORY)

  const themeDeclared = await readDirectory(files, themeDirectory)
  const themeEntries = themeDeclared.entries.length > 0 ? themeDeclared.entries : await readLayoutNames(files, options.themeRoot)
  const talkDeclared = await readDirectory(files, talkReferences)

  const merged = new Map<string, LayoutReference>()
  for (const entry of themeEntries) merged.set(entry.name, entry)
  for (const entry of talkDeclared.entries) merged.set(entry.name, entry)

  return {
    entries: merged.values().toArray().toSorted((a, b) => a.name.localeCompare(b.name)),
    directories: [...new Set([talkReferences, themeDirectory])],
    warnings: [...themeDeclared.warnings, ...talkDeclared.warnings],
  }
}

/**
見せ方の分類 1 件。基準は `_common.yaml` の `layout_categories`。

コード側に辞書を持たない。#353 で、yaml に裏付けのない分類辞書を撤去した経緯がある。
*/
export interface LayoutCategory {
  readonly id: string
  readonly label: string
  readonly question: string
}

/**
選択可能なレイアウト 1 件。`status: hidden` は組み立て時点で落ちるため現れない。
`slide_create` / `slide_sync` / `slide_theme` の `data.layouts` にそのまま載る。
*/
export interface LayoutCatalogEntry {
  readonly layout: string
  readonly description: string
  /**
  見せ方の分類 id。`categories[].id` のいずれかと必ず一致する。
  宣言の `category` が未設定・未知語彙なら `uncategorized` になる。
  */
  readonly category: string
  /**
  `status: deprecated`。品質が水準に達しておらず、選ばない対象（候補に数えない）。
  */
  readonly deprecated: boolean
  /**
  抽出元のファイル名。`layout` は宣言の `layout:` の値で、ファイル名とは別物。
  */
  readonly filename: string
}

export interface LayoutCatalog {
  readonly categories: readonly LayoutCategory[]
  readonly layouts: readonly LayoutCatalogEntry[]
  readonly warnings: readonly string[]
}

export interface LayoutCategories {
  readonly categories: readonly LayoutCategory[]
  readonly warnings: readonly string[]
}

/**
`uncategorized` の layout が 1 件でもあるときだけ `categories` 末尾に足す合成分類。

`layouts[].category` が常に `categories[].id` のいずれかと join できる状態を成立させるためのもの。
`_common.yaml` には書かない（語彙の基準は yaml 側のみ）。
*/
const UNCATEGORIZED_CATEGORY: LayoutCategory = {
  id: UNCATEGORIZED,
  label: 'Uncategorized',
  question: `layouts whose category is unset or unknown (${CATEGORY_SYNC_HINT})`,
}

/**
`layout_categories` の 1 要素を `LayoutCategory` へ写す。`id` / `label` / `question` が
揃わない要素は捨てる（`undefined` を返す）。

件数の集計と警告は呼び出し元（`readLayoutCategories`）が持つ。要素ごとに書くと
破損した `_common.yaml` で行数が要素数に比例して増え、1 行警告の粒度が崩れるため。
*/
function toLayoutCategory(value: unknown): LayoutCategory | undefined {
  if (!isRecord(value)) return undefined
  const { id, label, question } = value
  return typeof id === 'string' && typeof label === 'string' && typeof question === 'string' ? { id, label, question } : undefined
}

/**
分類語彙を 1 件も取れなかったときの 1 行警告。読み取り失敗と全滅の双方がここに合流する。
*/
function categoriesUnusable(commonPath: string, reason: string): LayoutCategories {
  return {
    categories: [],
    warnings: [`cannot read the layout categories (${commonPath}: ${reason}); continuing without categories (fix: ${CATEGORY_SYNC_HINT})`],
  }
}

async function findCommonFile(files: ThemeFiles, directories: readonly string[]): Promise<{ readonly path: string, readonly text: string } | undefined> {
  for (const directory of directories) {
    const commonPath = path.join(directory, COMMON_FILE_NAME)
    const text = await files.readText(commonPath)
    if (text !== undefined) return { path: commonPath, text }
  }
  return undefined
}

/**
`_common.yaml` の `layout_categories` を `directories` の順に探して読む。最初に見つかったファイルを使う。

`layout_categories` は入れ子構造なので、yaml パーサを通す。
読み取り・parse・形の失敗はすべてここで畳み、警告を 1 行返して空にする
（分類が無いだけで `slide_page` や `slide_sync` を丸ごと失敗させない）。

要素単位で落としたもの（`id` / `label` / `question` 不揃い・予約語 id）も
件数を束ねて 1 行ずつ報告する。無警告で捨てると、利用者には全レイアウトが
`uncategorized` に沈んだ二次的な結果だけが見えて原因に辿り着けない。
*/
export async function readLayoutCategories(files: ThemeFiles, directories: readonly string[]): Promise<LayoutCategories> {
  const found = await findCommonFile(files, directories)
  const lastDirectory = directories.at(-1) ?? ''
  if (found === undefined) {
    return categoriesUnusable(path.join(lastDirectory, COMMON_FILE_NAME), 'file not found')
  }

  let items: readonly unknown[]
  try {
    const parsed: unknown = parse(found.text)
    const raw: unknown = isRecord(parsed) ? parsed['layout_categories'] : undefined
    if (!Array.isArray(raw)) throw new TypeError('layout_categories is not found as an array')
    items = raw
  }
  catch (error: unknown) {
    return categoriesUnusable(found.path, error instanceof Error ? error.message : String(error))
  }

  const categories: LayoutCategory[] = []
  let malformed = 0
  let reserved = 0
  for (const item of items) {
    const category = toLayoutCategory(item)
    if (category === undefined) {
      malformed += 1
      continue
    }
    // `uncategorized` は未解決レイアウトの退避先としてコード側が合成する予約語。
    // yaml 側が同じ id を宣言すると同一 id が categories に 2 件並ぶため、ここで落とす。
    if (category.id === UNCATEGORIZED) {
      reserved += 1
      continue
    }
    categories.push(category)
  }

  if (categories.length === 0) {
    // 全滅は「分類が読めなかった」のと利用者から見て区別がつかないので、同じ 1 行に合流させる。
    return categoriesUnusable(found.path, `layout_categories has no usable item (0 of ${String(items.length)})`)
  }
  const warnings: string[] = []
  if (reserved > 0) {
    warnings.push(`ignoring reserved layout_categories id ${UNCATEGORIZED} (${String(reserved)} item(s)); ${CATEGORY_SYNC_HINT}`)
  }
  if (malformed > 0) {
    warnings.push(
      `skipped part of layout_categories (id, label or question missing: ${String(malformed)} item(s)); ${CATEGORY_SYNC_HINT}`,
    )
  }
  return { categories, warnings }
}

/**
宣言の `category` を既知語彙へ解決する。未設定・未知語彙は catalog から
落とさず `uncategorized` に倒し、警告を積む。

語彙自体が空（`_common.yaml` を読めていない）ときはファイル単位の警告を重ねない。
原因は `readLayoutCategories` が既に 1 行で報告しており、レイアウト件数分の
同じ警告で埋めても復旧導線が増えないため。
*/
function resolveCategory(
  rawCategory: string,
  isMissing: boolean,
  fileName: string,
  knownIds: ReadonlySet<string>,
  // 警告の蓄積先。呼び出し元の配列へ積む。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  warnings: string[],
): string {
  if (knownIds.has(rawCategory)) return rawCategory
  // 明示の `category: uncategorized` は意図した未分類なので、警告しない。
  if (rawCategory === UNCATEGORIZED && !isMissing) return UNCATEGORIZED
  if (knownIds.size > 0) {
    warnings.push(
      isMissing
        ? `missing category in ${fileName}, treated as uncategorized (${CATEGORY_SYNC_HINT})`
        : `unknown category '${rawCategory}' in ${fileName}, treated as uncategorized (${CATEGORY_SYNC_HINT})`,
    )
  }
  return UNCATEGORIZED
}

/**
`resolveLayoutReferences` の結果と分類語彙から、選択可能なレイアウトの一覧を組む。

除外規則は 1 つで、`status: hidden` を落とす（`_` 始まりのファイルは読み取り時点で除外済み）。
並びは `categories` の宣言順 → 同分類内は stable → deprecated → ファイル名順で、
`uncategorized` は末尾に来る。警告は呼び出し元が出力先を決める。
*/
export function buildLayoutCatalog(
  references: LayoutReferences,
  categories: readonly LayoutCategory[],
): LayoutCatalog {
  const knownIds = new Set(categories.map(category => category.id))
  const warnings: string[] = [...references.warnings]

  const collected: LayoutCatalogEntry[] = []
  for (const entry of references.entries) {
    if (entry.status === 'hidden') continue
    const filename = path.basename(entry.file)
    collected.push({
      layout: entry.name,
      description: entry.description,
      category: resolveCategory(entry.category, entry.categoryMissing === true, filename, knownIds, warnings),
      deprecated: entry.status === 'deprecated',
      filename,
    })
  }

  const rankOf = new Map(categories.map((category, index) => [category.id, index]))
  const rank = (entry: Readonly<LayoutCatalogEntry>): number => rankOf.get(entry.category) ?? categories.length
  const layouts = collected.toSorted((a, b) =>
    rank(a) - rank(b)
    || Number(a.deprecated) - Number(b.deprecated)
    || a.filename.localeCompare(b.filename),
  )

  const hasUncategorized = layouts.some(entry => entry.category === UNCATEGORIZED)
  return {
    categories: hasUncategorized ? [...categories, UNCATEGORIZED_CATEGORY] : categories,
    layouts,
    warnings,
  }
}
