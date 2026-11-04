// slides.md を生成する。
// theme・title と、pages/ のページを並べる `src:` の列だけを書く。
// テンプレートの headmatter（canvasWidth など）は書かない。テーマが既定にしたい値は、テーマ側で持つ。

export interface SlidesMdInput {
  readonly title: string
  /**
  frontmatter の `theme:` に書く値。テーマのパッケージ名。
  */
  readonly theme: string
  /**
  `pages/<name>.md` の name を、スライドの順に並べる。
  */
  readonly pages: readonly string[]
}

// 英数字・空白・ハイフン・ドット・日本語の文字だけで、先頭が記号でない値は、そのまま YAML のスカラーになる。
const PLAIN_SCALAR = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u

// YAML が数値・真偽値・null・日付と読む値。無引用で書くと文字列にならない。
const NON_STRING_SCALARS: readonly RegExp[] = [
  /^[-+]?[\d._]+$/u,
  /^[-+]?[\d._]+e[-+]?\d+$/iu,
  /^0x[\da-f]+$/iu,
  /^0o[0-7]+$/iu,
  /^\d{4}-\d{2}-\d{2}/u,
  /^(?:true|false|null|yes|no|on|off|y|n)$/iu,
  /^~$/u,
]

function yamlScalar(value: string): string {
  const isPlain = PLAIN_SCALAR.test(value) && NON_STRING_SCALARS.every(pattern => !pattern.test(value))
  return isPlain ? value : JSON.stringify(value)
}

/**
slides.md の全文を返す。
先頭ページは frontmatter の `src:`、2 ページ目以降は `---\nsrc: ...\n---` の列にする。
*/
export function slidesMdSource(input: Readonly<SlidesMdInput>): string {
  const [first, ...rest] = input.pages
  const frontmatter = [
    '---',
    `theme: ${yamlScalar(input.theme)}`,
    `title: ${yamlScalar(input.title)}`,
    ...(first === undefined ? [] : [`src: ./pages/${first}.md`]),
    '---',
    '<!-- markdownlint-disable -->',
  ].join('\n')
  const body = rest.map(name => `\n---\nsrc: ./pages/${name}.md\n---`).join('\n')
  return `${frontmatter}\n${body === '' ? '' : `${body}\n`}`
}

/**
既存の slides.md の frontmatter の `theme:` の値だけを書き換える。
行が無ければ frontmatter の先頭に足し、frontmatter が無ければ作る。改行は元の slides.md に合わせる。
*/
export function setSlidesTheme(source: string, theme: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const themeLine = `theme: ${yamlScalar(theme)}`
  // 各行は、CRLF のとき末尾に `\r` を残したまま扱う。
  const lines = source.split('\n')
  const opening = lines.at(0) ?? ''
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  const hasFrontmatter = closing !== -1 && opening.trimEnd() === '---'
  if (!hasFrontmatter) return `---${eol}${themeLine}${eol}---${eol}${source}`

  const themeIndex = lines.findIndex((line, index) => index > 0 && index < closing && /^theme[ \t]*:/u.test(line))
  const entry = `${themeLine}${opening.endsWith('\r') ? '\r' : ''}`
  const updated = themeIndex === -1
    ? [opening, entry, ...lines.slice(1)]
    : lines.map((line, index) => (index === themeIndex ? entry : line))
  return updated.join('\n')
}
