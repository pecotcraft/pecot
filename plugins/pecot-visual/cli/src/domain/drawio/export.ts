// draw.io の embed export で得た SVG を、静的公開物として使える形へ整える純粋関数群。
// fs / process には触れない（憲法 II）。
//
// 公開ビルドの `<img>` 経由描画では、SVG が自前で持つ 2 つの性質が問題になる。
//   1. editor が付ける `color-scheme: light dark` は `<img>` 内で OS のダークモードに
//      反応し、色が反転する。iframe 経由の従来方式では顕在化しなかった新規リグレッション。
//   2. 生成元 XML との対応が SVG 単体からは判定できず、陳腐化を検知できない。
// 前者を `light` 固定で、後者を合成ハッシュ（computeSourceHash）を埋める属性で解決する。

import { createHash } from 'node:crypto'
import path from 'node:path'

import type { IconResolver } from './types.js'
import { resolveIconsInStyle } from './url.js'
import { compareStrings } from '../_shared/compare-strings.js'

/**
陳腐化検知のために SVG ルート要素へ埋め込む、生成元の合成 SHA-256 属性名。
*/
export const SOURCE_HASH_ATTRIBUTE = 'data-pecotv-src-sha256'

/**
合成ハッシュの入力仕様バージョン。bake 結果を左右する加工（icon 解決規則・
color-scheme 固定・export 呼び出し条件）を変えたらこの値を上げる。上げた時点で
既存 SVG のハッシュが総入れ替えになり、公開物が旧 exporter の出力のまま残らない。
*/
export const SOURCE_HASH_FORMAT_VERSION = '1'

const ROOT_SVG_TAG_REGEX = /<svg\b[^>]*>/
// 色サフィックスは省略可だが、`%` と `#` は `[\w./-]` に含まれず、パス側と食い合わない。
// linter は先読みできず unsafe-regex 判定になるので、個別に抑止する。
// eslint-disable-next-line security/detect-unsafe-regex -- backtracking しない
const ICON_REFERENCE_REGEX = /icon:\/\/[\w./-]+(?:(?:%23|#)[\dA-Fa-f]{3,8})?/g
// eslint-disable-next-line security/detect-unsafe-regex -- 同上（こちらは分解用に anchored）
const ICON_REFERENCE_PARTS_REGEX = /^icon:\/\/(?<path>[\w./-]+)(?:(?:%23|#)(?<color>[\dA-Fa-f]{3,8}))?$/
const STYLE_ATTRIBUTE_REGEX = /\sstyle="(?<value>[^"]*)"/
// mxCell の style 属性値。`resolveIconsInStyle` の置換対象と同じ範囲を切り出す。
const STYLE_ATTRIBUTE_VALUES_REGEX = /style="(?<value>[^"]*)"/g
const COLOR_SCHEME_REGEX = /color-scheme\s*:[^;"]*/
// SOURCE_HASH_ATTRIBUTE と字面が重複する。
// 書き込み側（embedSourceHash）は定数を、読み出し側（readSourceHash）はこのリテラルを使う。
// そのため、往復テストがドリフトを捕まえる。
const SOURCE_HASH_ATTRIBUTE_REGEX = /\sdata-pecotv-src-sha256="(?<sha>[\dA-Fa-f]{64})"/
const SOURCE_HASH_STRIP_REGEX = /\sdata-pecotv-src-sha256="[^"]*"/
// SVG ルート要素の寸法属性。単位の無い値は user unit (= px) とみなす。数値の形式
// (`1.2.3` 等) は Number() の NaN で弾く。
const WIDTH_ATTRIBUTE_REGEX = /\swidth="(?<value>[^"]*)"/
const HEIGHT_ATTRIBUTE_REGEX = /\sheight="(?<value>[^"]*)"/
const PIXEL_LENGTH_REGEX = /^(?<number>[\d.]+)(?:px)?$/
// ハッシュ入力の項目区切り。XML と icon データ URI の双方に現れない制御文字を使う。
const HASH_FIELD_SEPARATOR = '\0'

/**
XML の style 属性値に現れる `icon://` 参照を出現順で返す（重複も保持する）。

描画に働くのは style 属性内の参照だけで、ラベル文言（value 属性）に書式説明として
書かれた `icon://` の字面は解決対象ではない。全文走査すると、そうした字面まで
未解決 icon として export を止めてしまう。
*/
export function collectIconReferences(xml: string): readonly string[] {
  const references: string[] = []
  for (const style of xml.matchAll(STYLE_ATTRIBUTE_VALUES_REGEX)) {
    references.push(...(style.groups?.['value']?.match(ICON_REFERENCE_REGEX) ?? []))
  }
  return references
}

/**
`resolveIconsInStyle` を通したうえで、静的 SVG に持ち込めない参照を元の表記で返す。
未解決 icon はそのまま欠落描画になるため、呼び出し側は空配列を要求する。

判定は元 XML の参照ごとに 2 条件で行う。
  - resolver が解決できない。
    `resolveIconsInStyle` のフォールバックは色指定を落とした `icon://<path>` を残すため、
    残存文字列からは元の表記を復元できない。
  - 解決できたはずが、置換後の style にまだ同じ参照が残っている。
    resolver と置換側の regex がずれた場合の防御網。
    部分一致だと `icon://a/b` が `icon://a/bc` に誤ヒットするため、置換後の参照集合との完全一致で見る。
*/
export function resolveIconsForExport(
  xml: string,
  resolveIcon: IconResolver,
): { readonly xml: string, readonly unresolved: readonly string[] } {
  const resolved = resolveIconsInStyle(xml, resolveIcon)
  const remaining = new Set(collectIconReferences(resolved))
  const unresolved = new Set<string>()
  const uniqueReferences = new Set(collectIconReferences(xml))
  for (const reference of uniqueReferences) {
    const parts = ICON_REFERENCE_PARTS_REGEX.exec(reference)
    /* c8 ignore next -- collectIconReferences と同一の字面を分解するため必ず一致する */
    const iconPath = parts?.groups?.['path'] ?? reference
    if (resolveIcon(iconPath, parts?.groups?.['color']) === undefined || remaining.has(reference)) {
      unresolved.add(reference)
    }
  }
  return { xml: resolved, unresolved: [...unresolved] }
}

/**
陳腐化検知の基準となる合成ハッシュを返す。

生 XML だけを hash すると、XML 不変のまま icon カタログの SVG が差し替わった場合に
古い図を流用し続ける。参照 icon の解決結果（＝ icon の内容そのもの）と、加工規則の
バージョンを同じ入力に含めることで、いずれが変わっても再 export に倒れる。
*/
export function computeSourceHash(xml: string, resolveIcon: IconResolver): string {
  const fields = [`version=${SOURCE_HASH_FORMAT_VERSION}`, `xml=${xml}`]
  // 参照の出現順は編集で容易に入れ替わるため、内容が同じなら同じハッシュになるよう整列する。
  for (const reference of [...new Set(collectIconReferences(xml))].toSorted(compareStrings)) {
    const parts = ICON_REFERENCE_PARTS_REGEX.exec(reference)
    /* c8 ignore next -- collectIconReferences と同一の字面を分解するため必ず一致する */
    const iconPath = parts?.groups?.['path'] ?? reference
    const resolved = resolveIcon(iconPath, parts?.groups?.['color'])
    fields.push(`icon=${reference}`, `data=${resolved ?? ''}`)
  }
  return createHash('sha256').update(fields.join(HASH_FIELD_SEPARATOR), 'utf8').digest('hex')
}

/**
SVG ルート要素の `color-scheme` を `light` に固定する。
style 属性そのものが無い場合も含め、常に `color-scheme: light` が立つ状態にする。
*/
export function forceLightColorScheme(svg: string): string {
  return replaceRootSvgTag(svg, (tag) => {
    const styleMatch = STYLE_ATTRIBUTE_REGEX.exec(tag)
    if (styleMatch?.groups?.['value'] === undefined) {
      return appendAttribute(tag, 'style="color-scheme: light;"')
    }
    const style = styleMatch.groups['value']
    const nextStyle = COLOR_SCHEME_REGEX.test(style)
      ? style.replace(COLOR_SCHEME_REGEX, 'color-scheme: light')
      : `${style.trimEnd().replace(/;$/, '')}; color-scheme: light;`
    return tag.replace(styleMatch[0], () => ` style="${nextStyle}"`)
  })
}

/**
SVG ルート要素へ生成元の合成 SHA-256 を埋め込む（既存の同名属性は置き換える）。
*/
export function embedSourceHash(svg: string, sha256: string): string {
  return replaceRootSvgTag(svg, (tag) => {
    const stripped = tag.replace(SOURCE_HASH_STRIP_REGEX, '')
    return appendAttribute(stripped, `${SOURCE_HASH_ATTRIBUTE}="${sha256}"`)
  })
}

// 開始タグへ属性を 1 つ足す。`<svg .../>` の自己終了形でも `/>` を保つ
// （`>` だけを削ると、以降の要素がルート要素の子として解釈される破損した SVG になる）。
function appendAttribute(tag: string, attribute: string): string {
  const isSelfClosing = tag.endsWith('/>')
  const body = tag.slice(0, isSelfClosing ? -2 : -1).trimEnd()
  return `${body} ${attribute}${isSelfClosing ? '/>' : '>'}`
}

/**
SVG ルート要素の幅・高さ (px)。
*/
export interface SvgPixelSize {
  readonly width: number
  readonly height: number
}

/**
SVG ルート要素の `width` / `height` 属性を px の数値で返す。

PDF の用紙寸法に使う。属性が無い・px 以外の単位 (%, pt, mm 等) のときは、既定の用紙
(A4) を使わず、エラーにする。単位の無い値は SVG の user unit (= px) として扱う。
*/
export function readSvgPixelSize(svg: string): SvgPixelSize {
  const match = ROOT_SVG_TAG_REGEX.exec(svg)
  if (match === null) {
    throw new Error('export された内容に SVG ルート要素がありません')
  }
  return {
    width: readPixelAttribute(match[0], 'width'),
    height: readPixelAttribute(match[0], 'height'),
  }
}

function readPixelAttribute(tag: string, name: 'width' | 'height'): number {
  const attribute = (name === 'width' ? WIDTH_ATTRIBUTE_REGEX : HEIGHT_ATTRIBUTE_REGEX).exec(tag)
  const raw = attribute?.groups?.['value']
  if (raw === undefined) {
    throw new Error(`SVG ルート要素に ${name} 属性がありません`)
  }
  const pixel = PIXEL_LENGTH_REGEX.exec(raw.trim())?.groups?.['number']
  const value = pixel === undefined ? NaN : Number(pixel)
  if (!(value > 0)) {
    throw new Error(`SVG ルート要素の ${name} が px の正の値ではありません: ${raw}`)
  }
  return value
}

/**
出力ファイルの最後の拡張子を `extension` に置換した兄弟ファイルのパスを返す。

`path.parse` は最後の拡張子だけを分離するため、多重拡張子でも置換されるのは末尾だけになる
（例: `diagram.drawio.svg` → `diagram.drawio.pdf`）。`.svg` のような拡張子だけのファイル名は
隠しファイルとして name 全体が `.svg`・ext が空と解釈され、置換ではなく付加になる
（例: `.svg` → `.svg.pdf`）。
*/
export function siblingPath(outputFile: string, extension: string): string {
  const parsed = path.parse(outputFile)
  return path.join(parsed.dir, `${parsed.name}${extension}`)
}

/**
SVG ルート要素に埋め込まれた SHA-256 を読み出す。属性が無ければ undefined。
*/
export function readSourceHash(svg: string): string | undefined {
  return SOURCE_HASH_ATTRIBUTE_REGEX.exec(svg)?.groups?.['sha']
}

function replaceRootSvgTag(svg: string, transform: (tag: string) => string): string {
  const match = ROOT_SVG_TAG_REGEX.exec(svg)
  if (match === null) {
    throw new Error('export された内容に SVG ルート要素がありません')
  }
  // replacement は data URI や style 値をそのまま含むため、`$&` 等の展開が起きない
  // 関数形式で渡す。
  const replacement = transform(match[0])
  return svg.replace(ROOT_SVG_TAG_REGEX, () => replacement)
}
