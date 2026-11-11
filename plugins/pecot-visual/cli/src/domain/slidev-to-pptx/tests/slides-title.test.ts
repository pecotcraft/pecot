// parseSlidesTitle / sanitizeFilename の純粋関数検証。
// frontmatter 抽出 (CRLF / 閉じ欠落 / キー位置 / quote / 空値 / frontmatter 無し) を網羅する。
// あわせてファイル名正規化 (禁止文字 / trim / 空フォールバック / UTF-8 250 バイト切詰め) も網羅する。

import { describe, expect, it } from 'vitest'

import { parseSlidesTitle, sanitizeFilename } from '../slides-title.js'

describe('parseSlidesTitle', () => {
  it('frontmatter の title を取得する', () => {
    expect(parseSlidesTitle('---\ntitle: Hello World\n---\n\n# Hi')).toBe('Hello World')
  })

  it('CRLF 改行でも title を取得する', () => {
    expect(parseSlidesTitle('---\r\ntitle: CRLF Title\r\n---\r\n\r\n# Hi')).toBe('CRLF Title')
  })

  it('title が他キーの後に来ても取得する', () => {
    expect(parseSlidesTitle('---\ntheme: none\ntitle: After Theme\n---\n')).toBe('After Theme')
  })

  it('single quote で囲まれた title はクォートを取り除く', () => {
    expect(parseSlidesTitle('---\ntitle: \'Quoted Title\'\n---\n')).toBe('Quoted Title')
  })

  it('double quote で囲まれた title はクォートを取り除く', () => {
    expect(parseSlidesTitle('---\ntitle: "Quoted Title"\n---\n')).toBe('Quoted Title')
  })

  it('閉じ --- が無い場合は undefined', () => {
    expect(parseSlidesTitle('---\ntitle: No Close\n')).toBeUndefined()
  })

  it('閉じ --- が改行なしで EOF 終端でも title を取得する', () => {
    expect(parseSlidesTitle('---\ntitle: X\n---')).toBe('X')
  })

  it('title: の直後に空白が無くても値を取得する', () => {
    expect(parseSlidesTitle('---\ntitle:NoSpace\n---\n')).toBe('NoSpace')
  })

  it('title キーが無い場合は undefined', () => {
    expect(parseSlidesTitle('---\ntheme: default\n---\n# Hi')).toBeUndefined()
  })

  it('title の値が空の場合は undefined', () => {
    expect(parseSlidesTitle('---\ntitle:\n---\n')).toBeUndefined()
  })

  it('title の値が空白のみの場合は undefined', () => {
    expect(parseSlidesTitle('---\ntitle:    \n---\n')).toBeUndefined()
  })

  it('frontmatter が無ければ undefined', () => {
    expect(parseSlidesTitle('# No frontmatter\n')).toBeUndefined()
  })
})

describe('sanitizeFilename', () => {
  const cases: readonly (readonly [string, string | undefined, string])[] = [
    ['undefined は merged にフォールバック', undefined, 'merged'],
    ['空文字列は merged にフォールバック', '', 'merged'],
    ['空白のみは merged にフォールバック', ' '.repeat(3), 'merged'],
    ['通常タイトルはそのまま', 'My Slides', 'My Slides'],
    ['禁止文字 / は _ に置換', 'a/b', 'a_b'],
    ['複数の禁止文字を一括置換', String.raw`a/b\c<d>e:f"g|h?i*j`, 'a_b_c_d_e_f_g_h_i_j'],
    ['前後の空白は trim', '  hello  ', 'hello'],
  ]
  it.each(cases)('%s（入力 %j）のとき、%s を返す', (_label, input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected)
  })

  it('ASCII は 250 バイト (= 250 文字) で切り詰める', () => {
    const long = 'x'.repeat(300)
    const result = sanitizeFilename(long)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(250)
    expect(result).toHaveLength(250)
  })

  it('長大な日本語 title は UTF-8 で 250 バイト以内に切り詰める', () => {
    // 「あ」= 3 バイト。100 文字 = 300 バイトで上限超過。code point 境界で切るため
    // 250 / 3 = 83 文字 (249 バイト) に収まる。
    const long = 'あ'.repeat(100)
    const result = sanitizeFilename(long)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(250)
    expect(result).toBe('あ'.repeat(83))
  })

  it('境界のサロゲートペア (絵文字) を分断しない', () => {
    // 😀 = 4 バイト (サロゲートペア)。62 文字 = 248 バイトに 1 文字足すと 252 バイトで
    // 上限超過するが、UTF-16 code unit slice ではペアが割れて破損した文字になる。
    const long = '😀'.repeat(70)
    const result = sanitizeFilename(long)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(250)
    // 4 バイト × 62 = 248 バイト。63 文字目 (252 バイト) は入らない。
    expect(result).toBe('😀'.repeat(62))
    // サロゲートが割れていない (半端な code unit が末尾に残っていない)。
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code point 単位の分解がこの検証の意図
    expect([...result]).toHaveLength(62)
  })
})
