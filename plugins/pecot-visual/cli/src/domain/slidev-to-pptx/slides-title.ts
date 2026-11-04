// slides.md の frontmatter から title を抽出し、ファイル名として安全な文字列へ整える純粋関数。
// convert コマンドの既定の出力名の決定と、pipeline の debug ログ (infra/dom-converter の
// readSlidesTitle 経由) の双方から再利用する。

// frontmatter 抽出は、domain/slidev-project/slides-md.ts と同じ、文字列分割の方式を用いる。
// 方式は `'---\n'` デリミタ + indexOf。
// `[\s\S]*?` 系の regex への移設は、regexp/no-super-linear-backtracking に抵触するため行わない。
// CRLF は先に LF へ正規化する。
const FRONTMATTER_DELIMITER = '---\n'
// title 行のみを抽出する。
// 空白と値を別々の量指定子で受けると (`[ \t]+(.+)`) 文字を交換でき、regexp/no-super-linear-backtracking に触れる。
// そのため値は `(.*)` 一括で取り、trim 側で整形する。
const TITLE_KEY_REGEX = /^title:(.*)$/m
const QUOTE_TRIM_REGEX = /^['"]|['"]$/g
const FILENAME_FORBIDDEN_REGEX = /[/\\<>:"|?*]/g
// 多くの filesystem の NAME_MAX は 255 バイト。呼び出し側が末尾に `.pptx` (5 バイト) を付ける
// ため、その分を差し引いた 250 バイトを stem 上限とする (合計で 255 バイト以内に収める)。
const FILENAME_MAX_BYTES = 250

/**
slides.md 全体テキストの frontmatter から title を抽出する。
次のいずれかの場合は undefined を返す。
frontmatter が無い、閉じ `---` が無い、title キーが無い、値が空 (空白のみを含む)。
`unicorn/no-null` が error のため、null は使わない。
*/
export function parseSlidesTitle(content: string): string | undefined {
  const normalized = content.replaceAll('\r\n', '\n')
  if (!normalized.startsWith(FRONTMATTER_DELIMITER)) return undefined

  const remainder = normalized.slice(FRONTMATTER_DELIMITER.length)
  // 閉じフェンスは `\n---\n`。末尾に番兵 `\n` を足すことで、末尾が改行無しの `---` で
  // 終わる frontmatter も検出できる (開きはあるが閉じが無い場合は -1 → undefined)。
  const closeIndex = `${remainder}\n`.indexOf(`\n${FRONTMATTER_DELIMITER}`)
  if (closeIndex === -1) return undefined

  const frontmatter = remainder.slice(0, closeIndex)
  const titleMatch = TITLE_KEY_REGEX.exec(frontmatter)
  if (titleMatch?.[1] === undefined) return undefined

  const title = titleMatch[1].trim().replaceAll(QUOTE_TRIM_REGEX, '')
  return title.length > 0 ? title : undefined
}

/**
文字列を UTF-8 バイト長基準で maxBytes 以内に切り詰める。
`for...of` は code point 単位で反復するため、サロゲートペア (絵文字等) を分断しない。
UTF-16 code unit 数の `slice` では日本語 title が NAME_MAX (255 バイト) を超え得るため、
バイト長で数える。
*/
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (bytes + charBytes > maxBytes) break
    result += char
    bytes += charBytes
  }
  return result
}

/**
title を、ファイル名として安全な文字列へ変換する。
禁止文字 `[/\\<>:"|?*]` を `_` に置換し、前後空白を trim し、UTF-8 で {@link FILENAME_MAX_BYTES} バイトに切り詰める。
切り詰めでは code point 境界を跨がない。
空 / undefined と、整形後に空文字列となるものは、`'merged'` へフォールバックする。
*/
export function sanitizeFilename(title: string | undefined): string {
  if (title === undefined || title.length === 0) return 'merged'
  const sanitized = title.replaceAll(FILENAME_FORBIDDEN_REGEX, '_').trim()
  return sanitized.length > 0 ? truncateToBytes(sanitized, FILENAME_MAX_BYTES) : 'merged'
}
