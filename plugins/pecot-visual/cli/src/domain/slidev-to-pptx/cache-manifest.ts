// pptx 差分キャッシュの索引 manifest（型・検証・決定論的シリアライズ・prune 計算）。
// 純粋関数のみで、ファイル入出力は infra/slidev-to-pptx/cache-store.ts が担当する。
//
// 設計基準（specs/009-pptx-diff-cache）の用語 envHash を、実装名にもそのまま使う。
// そのため unicorn/name-replacements を、本ファイルで disable する。
/* eslint-disable unicorn/name-replacements */

import { isRecord } from '../_shared/json.js'
import { compareStrings } from '../_shared/compare-strings.js'

/**
manifest スキーマ版。形式を変えたらここを上げる（不一致の manifest は全無効化）。
*/
export const CACHE_SCHEMA_VERSION = 2

/**
letter-spacing マップ 1 エントリ。slide-worker の SlideConvertResult と同形。
*/
export interface LetterSpacingEntry {
  readonly letterSpacing: string
  readonly fontSize: string
}

/**
スライドステップ 1 件分のキャッシュエントリ。ステップ変換の成功後にのみ作られる。
*/
export interface SlideCacheEntry {
  readonly slideHash: string
  /**
  診断用のスライド番号（キーは stepIndex なので同定には使わない）
  */
  readonly slideNumber: number
  readonly clickStep: number | null
  /**
  cache/ 内の単一スライド pptx ファイル名
  */
  readonly pptxFile: string
  /**
  cache/ 内の prerender PNG / meta.json のファイル名一覧（0 件可）
  */
  readonly prerenderFiles: readonly string[]
  readonly letterSpacingMap: Readonly<Record<string, LetterSpacingEntry>>
  readonly hrefMap: Readonly<Record<string, string>>
  /**
  当該ステップのスライドが明示指定のアニメーションを持つか（#1070）。
  ヒットしたステップでも pptx 後処理の除去判定に要るため、エントリに載せる。
  */
  readonly hasExplicitAnimation: boolean
}

/**
キャッシュストアの索引。キーは stepIndex（= slideNumber*100 + clickStep）の文字列。
*/
export interface CacheManifest {
  readonly schemaVersion: number
  readonly envHash: string
  readonly entries: Readonly<Record<string, SlideCacheEntry>>
}

/**
prune 対象（manifest から落とすキーと、削除する成果物ファイル名）。
*/
export interface PruneTargets {
  readonly stepKeys: readonly string[]
  readonly files: readonly string[]
}

// キー順は文字列比較で固定する。stepIndex は数値文字列だが、手編集された manifest に
// 非数値キーが混在しても順序が実装依存にならないよう数値比較は使わない。
function byKey([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number {
  return left < right ? -1 : 1
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const element of value) {
    if (typeof element !== 'string') return undefined
    result.push(element)
  }
  return result
}

function parseHrefMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const result: [string, string][] = []
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    result.push([key, item])
  }
  return Object.fromEntries(result)
}

function parseLetterSpacingMap(value: unknown): Readonly<Record<string, LetterSpacingEntry>> | undefined {
  if (!isRecord(value)) return undefined
  const result: [string, LetterSpacingEntry][] = []
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) return undefined
    const letterSpacing = item['letterSpacing']
    const fontSize = item['fontSize']
    if (typeof letterSpacing !== 'string' || typeof fontSize !== 'string') return undefined
    result.push([key, { letterSpacing, fontSize }])
  }
  return Object.fromEntries(result)
}

function parseEntry(value: unknown): SlideCacheEntry | undefined {
  if (!isRecord(value)) return undefined

  const slideHash = value['slideHash']
  const slideNumber = value['slideNumber']
  if (typeof slideHash !== 'string' || typeof slideNumber !== 'number') return undefined
  const clickStep = value['clickStep']
  if (typeof clickStep !== 'number' && clickStep !== null) return undefined
  const pptxFile = value['pptxFile']
  if (typeof pptxFile !== 'string') return undefined

  const hasExplicitAnimation = value['hasExplicitAnimation']
  if (typeof hasExplicitAnimation !== 'boolean') return undefined

  const prerenderFiles = parseStringArray(value['prerenderFiles'])
  const letterSpacingMap = parseLetterSpacingMap(value['letterSpacingMap'])
  const hrefMap = parseHrefMap(value['hrefMap'])
  if (prerenderFiles === undefined || letterSpacingMap === undefined || hrefMap === undefined) {
    return undefined
  }

  return {
    slideHash,
    slideNumber,
    clickStep,
    pptxFile,
    prerenderFiles,
    letterSpacingMap,
    hrefMap,
    hasExplicitAnimation,
  }
}

/**
manifest.json のテキストを検証付きで読む。JSON として不正・スキーマ版不一致・
必須フィールドの欠落 / 型不一致はすべて「manifest なし」と同義に undefined を返す（FR-006）。
*/
export function parseCacheManifest(text: string): CacheManifest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed) || (parsed['schemaVersion'] !== CACHE_SCHEMA_VERSION)) return undefined

  const envHash = parsed['envHash']
  if (typeof envHash !== 'string' || envHash === '') return undefined

  const rawEntries = parsed['entries']
  if (!isRecord(rawEntries)) return undefined

  const entries: [string, SlideCacheEntry][] = []
  for (const [key, value] of Object.entries(rawEntries)) {
    const entry = parseEntry(value)
    if (entry === undefined) return undefined
    entries.push([key, entry])
  }

  return { schemaVersion: CACHE_SCHEMA_VERSION, envHash, entries: Object.fromEntries(entries) }
}

/**
manifest テキストが宣言しているスキーマ版だけを取り出す。JSON として読めない場合と
`schemaVersion` が数値でない場合は undefined。

`parseCacheManifest` が undefined を返した manifest について、呼び出し側が区別するために使う。
区別する対象は、「版が違うだけ」と「破損している」の 2 つ。
版差はプラグイン更新後の初回で必ず起きるため、破損と同じ文言で報告すると利用者が原因を誤認する。
*/
export function readDeclaredSchemaVersion(text: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const version = parsed['schemaVersion']
  return typeof version === 'number' ? version : undefined
}

/**
stepIndex → エントリの Map から manifest を組み立てる（変換完了時の終端 1 回で使う）。
*/
export function createCacheManifest(
  envHash: string,
  entries: ReadonlyMap<number, SlideCacheEntry>,
): CacheManifest {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    envHash,
    entries: Object.fromEntries(
      [...entries].map(([stepIndex, entry]) => [stepIndex.toString(), entry]),
    ),
  }
}

/**
stepIndex に対応するエントリを取り出す。未掲載なら undefined。
*/
export function getCacheEntry(
  manifest: Readonly<CacheManifest>,
  stepIndex: number,
): SlideCacheEntry | undefined {
  const key = stepIndex.toString()
  // Object.hasOwn で自前プロパティに限定し、prototype 由来のキー（__proto__ 等）を弾く。
  // eslint-disable-next-line security/detect-object-injection -- 同じ式の Object.hasOwn で自前プロパティに限定済み
  return Object.hasOwn(manifest.entries, key) ? manifest.entries[key] : undefined
}

/**
manifest の JSON テキストを決定論的に作る。同じ内容なら、挿入順に関わらず同一文字列を返す。
キー順の揺れだけで manifest が書き換わったように見えるのを防ぐ。
*/
export function serializeCacheManifest(manifest: Readonly<CacheManifest>): string {
  const entries = Object.entries(manifest.entries)
    .toSorted(byKey)
    .map(([key, entry]): [string, unknown] => [key, {
      slideHash: entry.slideHash,
      slideNumber: entry.slideNumber,
      clickStep: entry.clickStep,
      pptxFile: entry.pptxFile,
      prerenderFiles: [...entry.prerenderFiles].toSorted(compareStrings),
      letterSpacingMap: Object.fromEntries(
        Object.entries(entry.letterSpacingMap)
          .toSorted(byKey)
          .map(([text, spacing]): [string, unknown] => [
            text,
            { letterSpacing: spacing.letterSpacing, fontSize: spacing.fontSize },
          ]),
      ),
      hrefMap: Object.fromEntries(Object.entries(entry.hrefMap).toSorted(byKey)),
      hasExplicitAnimation: entry.hasExplicitAnimation,
    }])

  const body = {
    schemaVersion: manifest.schemaVersion,
    envHash: manifest.envHash,
    entries: Object.fromEntries(entries),
  }
  return `${JSON.stringify(body, undefined, 2)}\n`
}

/**
今回のスキャン結果に無い stepIndex のエントリと、その成果物ファイル名を列挙する。

契約: `liveStepIndexes` はデッキ全体のスキャン結果であること。部分集合を渡した場合、
差集合がすべて削除対象として返るのは仕様（本関数は与えられた集合の差を計算するだけで、
全走査かどうかは判定できない）。実際にファイルを消す infra 側 `pruneCache` は、
この誤用を型で防ぐため `FullScanSteps`（`fullScan: true` の明示）を要求する。
*/
export function computePruneTargets(
  manifest: Readonly<CacheManifest>,
  liveStepIndexes: readonly number[],
): PruneTargets {
  const live = new Set(liveStepIndexes.map(stepIndex => stepIndex.toString()))
  const stepKeys: string[] = []
  const files: string[] = []
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (live.has(key)) continue
    stepKeys.push(key)
    files.push(entry.pptxFile, ...entry.prerenderFiles)
  }
  return { stepKeys: stepKeys.toSorted(compareStrings), files: files.toSorted(compareStrings) }
}

/**
指定キーのエントリを落とした manifest を返す（prune の反映）。
*/
export function removeEntries(
  manifest: Readonly<CacheManifest>,
  stepKeys: readonly string[],
): CacheManifest {
  const removed = new Set(stepKeys)
  return {
    schemaVersion: manifest.schemaVersion,
    envHash: manifest.envHash,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).filter(([key]) => !removed.has(key)),
    ),
  }
}
