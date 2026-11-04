// テーマの宣言の書体から、PNG 撮影のページが読み込む Web フォントを組む純粋関数。
// Google Fonts の css2 の URL と、描く前に読み込みを済ませる書体（preload）の並びを返す。
// 総称の書体（sans-serif など）は Web フォントではないので除く。

const WEIGHTS: readonly number[] = [400, 500, 600, 700]
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])
const CSS2_BASE_URL = 'https://fonts.googleapis.com/css2?'

export interface WebFonts {
  /**
  読み込む css2 の URL。読み込む書体が残らなければ undefined。
  */
  readonly stylesheetUrl: string | undefined
  /**
  `document.fonts.load` に渡す指定。書体ごとに、太さの順で並べる。
  */
  readonly preload: readonly string[]
}

/**
総称の書体（sans-serif など）か。大文字小文字と前後の空白を無視する。
*/
export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase())
}

/**
重複と総称を除いた、読み込む書体名。大文字小文字と前後の空白を無視して重複を判定し、最初の綴りを残す。
*/
function loadableFamilies(names: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const families: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    const key = name.toLowerCase()
    if (name === '' || isGenericFamily(name) || seen.has(key)) continue
    seen.add(key)
    families.push(name)
  }
  return families
}

/**
css2 の family の値。空白は `+`、`'` は `%27` にする。
`'` を残すと、@import url('...') の引用符を壊す。
*/
function familyParameter(name: string): string {
  const encoded = encodeURIComponent(name).replaceAll('%20', '+').replaceAll('\'', '%27')
  return `family=${encoded}:wght@${WEIGHTS.join(';')}`
}

/**
preload の指定に書く書体名。CSS の引用符付き文字列として `"` と `\` を escape する。
*/
function quotedFamily(name: string): string {
  return `"${name.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
宣言の書体名の並びから、Web フォントの URL と preload を組む。
*/
export function webFontsFor(names: readonly string[]): WebFonts {
  const families = loadableFamilies(names)
  if (families.length === 0) return { stylesheetUrl: undefined, preload: [] }
  return {
    stylesheetUrl: `${CSS2_BASE_URL}${families.map(name => familyParameter(name)).join('&')}&display=swap`,
    preload: families.flatMap(name => WEIGHTS.map(weight => `${String(weight)} 16px ${quotedFamily(name)}`)),
  }
}
