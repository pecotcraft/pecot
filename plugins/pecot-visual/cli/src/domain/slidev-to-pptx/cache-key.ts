// pptx 差分キャッシュの 2 段ハッシュ（デッキ環境ハッシュ / スライド単位ハッシュ）を計算する
// 純粋関数群。I/O は一切持たない。
//
// 設計基準（specs/009-pptx-diff-cache）の用語 envHash を、実装名にもそのまま使う。
// そのため unicorn/name-replacements を、本ファイルで disable する。
/* eslint-disable unicorn/name-replacements */
//
// slides.md の分解は、@slidev/parser の `/fs` `load()`（実ファイル読み取りを伴う）で行う。
// そのため infra/slidev-to-pptx/cache-store.ts の責務とする。
// 本モジュールは、分解済みの値と、収集済みのファイル内容ハッシュを値渡しで受け取る。
// 分解済みの値は、headmatter・自スライドブロックの raw・本文の raw。

import { createHash } from 'node:crypto'

import { isRecord } from '../_shared/json.js'
import { compareStrings } from '../_shared/compare-strings.js'

/**
共有クロージャ 1 ファイル分の (デッキルート相対パス, 内容ハッシュ)。
*/
export interface SharedFileDigest {
  readonly path: string
  readonly hash: string
}

/**
デッキ環境ハッシュ（envHash）の材料。1 つでも変われば全キャッシュが無効になる。
*/
export interface EnvHashInput {
  /**
  slides.md のルート frontmatter。スライドブロック列は含めない（構成変更で全無効化しないため）
  */
  readonly headmatter: Readonly<Record<string, unknown>>
  /**
  layouts / components / styles 等、全スライドの描画に影響し得る共有入力の一覧
  */
  readonly sharedFiles: readonly SharedFileDigest[]
  /**
  解決済み dom-to-pptx.bundle.js の実体ハッシュ（宣言バージョンでは実体乖離を検知できない）
  */
  readonly bundleHash: string
  /**
  描画エンジンのバージョン文字列
  */
  readonly chromiumVersion: string
  /**
  prerender 設定・timeout・ビューポート等、出力を変える変換定数一式
  */
  readonly conversionConstants: Readonly<Record<string, unknown>>
  /**
  `slidev build` / 変換に渡すビルドオプション（`--theme` 等）。
  値が変わると出力が変わり得るが、slides.md や共有クロージャには現れない。
  そのため別材料として明示的に持つ。
  例えば `--theme` を変えても headmatter の `theme:` キーは書き換わらず、
  テーマ切替後も旧描画のキャッシュが通知なしでヒットしてしまう。
  */
  readonly buildOptions: Readonly<Record<string, unknown>>
  readonly pluginVersion: string
  /**
  キャッシュ形式のバージョン。manifest の schemaVersion フィールドにも入り二重に働く。
  ただし、形式変更時に成果物ごと無効化できる envHash 側を正とする。
  manifest 側は、破損 manifest を読んだ場合の早期判定用。
  */
  readonly schemaVersion: number
}

/**
スライド単位ハッシュ（slideHash）の材料。一致すればそのステップはキャッシュヒット。
*/
export interface SlideHashInput {
  /**
  デッキ内位置（1 始まり）。ページ番号が描画内容に含まれるため、キーに入れる
  */
  readonly slideNumber: number
  /**
  slides.md 内の自スライドブロック raw（inline スライドでは本文もここに含まれる）
  */
  readonly blockRaw: string
  /**
  src 分離時の本文ファイル（pages/<name>.md）該当スライドの raw。inline では undefined
  */
  readonly bodyRaw?: string | undefined
}

/**
材料を長さ前置で framing する。素朴な連結だと材料の境界がずれた組み合わせ
（例: block 末尾の 1 文字が body 先頭へ移動）で同一ハッシュになり得るため。
*/
function frame(label: string, value: string): string {
  return `${label}:${value.length.toString()}:${value}`
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/**
キー順に依存しない決定論的な JSON 文字列を作る。JSON.stringify は挿入順を保つため、
同じ内容でもキー順が違えば別文字列になる（= 無関係な全変換を招く）。
*/
function canonicalJson(value: unknown): string {
  if (isArray(value)) {
    return `[${value.map(element => canonicalJson(element)).join(',')}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  // null / undefined / JSON 表現を持たない値（関数等）は区別せず null にまとめる。
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? JSON.stringify(value) : 'null'
}

/**
末尾の空白・改行を落とす。

@slidev/parser の raw は、区切り行 `---` の直前の改行 1 個を含まない一方、末尾スライドだけは
slides.md の終端（最終改行があればそれも）をそのまま持つ（計測）。このため同一内容のスライドでも
「末尾にあるか」「後続ブロックとの間に空行があるか」で raw の末尾改行が 1 個ずれる。
正規化しないと、末尾に 1 枚追加しただけで直前のスライドがミス扱いになり、R2 の
「末尾追加では既存スライドは全ヒット」が成立しない。末尾空白は描画結果に影響しない。
*/
function normalizeRaw(raw: string): string {
  return raw.trimEnd()
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
デッキ環境ハッシュを計算する。共有ファイル一覧は入力順に依存しないよう相対パスでソートする。
*/
export function computeEnvHash(input: Readonly<EnvHashInput>): string {
  const sharedFileLines = input.sharedFiles
    .map(file => `${file.path}\0${file.hash}`)
    .toSorted(compareStrings)

  return sha256Hex([
    frame('schemaVersion', input.schemaVersion.toString()),
    frame('pluginVersion', input.pluginVersion),
    frame('headmatter', canonicalJson(input.headmatter)),
    frame('sharedFiles', canonicalJson(sharedFileLines)),
    frame('bundle', input.bundleHash),
    frame('chromium', input.chromiumVersion),
    frame('constants', canonicalJson(input.conversionConstants)),
    frame('buildOptions', canonicalJson(input.buildOptions)),
  ].join('\n'))
}

/**
スライド単位ハッシュを計算する。末尾へのスライド追加では既存スライドの値は変わらず、
中間挿入・削除・並べ替えでは位置がシフトしたスライドだけが変わる。
*/
export function computeSlideHash(input: Readonly<SlideHashInput>): string {
  return sha256Hex([
    frame('slideNumber', input.slideNumber.toString()),
    frame('block', normalizeRaw(input.blockRaw)),
    input.bodyRaw === undefined ? 'body:inline' : frame('body', normalizeRaw(input.bodyRaw)),
  ].join('\n'))
}
