// parseSlidesTitle / sanitizeFilename の純粋関数検証。
// frontmatter 抽出 (CRLF / 閉じ欠落 / キー位置 / quote / 空値 / frontmatter 無し) を網羅する。
// あわせてファイル名正規化 (禁止文字 / trim / 空フォールバック / UTF-8 250 バイト切詰め) も網羅する。

import { describe, expect, it } from 'vitest'

import { parseSlidesTitle, sanitizeFilename } from '../slides-title.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('parseSlidesTitle', () => {
  it('frontmatter の title を取得する', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。frontmatter に `title: Hello World` がある場合に、`Hello World` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle: Hello World\n---\n\n# Hi')).toBe('Hello World')
  })

  it('改行が CRLF の場合も、title を取得する', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。改行が CRLF の frontmatter を渡した場合に、`CRLF Title` を返すことを確認します。')
    expect(parseSlidesTitle('---\r\ntitle: CRLF Title\r\n---\r\n\r\n# Hi')).toBe('CRLF Title')
  })

  it('title が ほかのキーの後ろにある場合も、取得する', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`theme` の次の行に `title` がある場合に、`After Theme` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntheme: none\ntitle: After Theme\n---\n')).toBe('After Theme')
  })

  it('単一引用符で囲まれた title は、引用符を取り除いて返す', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`title: \'Quoted Title\'` の場合に、引用符を除いた `Quoted Title` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle: \'Quoted Title\'\n---\n')).toBe('Quoted Title')
  })

  it('二重引用符で囲まれた title は、引用符を取り除いて返す', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`title: "Quoted Title"` の場合に、引用符を除いた `Quoted Title` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle: "Quoted Title"\n---\n')).toBe('Quoted Title')
  })

  it('閉じる --- が存在しない場合は、undefined を返す', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。frontmatter を閉じる `---` が存在しない場合に、`undefined` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle: No Close\n')).toBeUndefined()
  })

  it('閉じる --- の直後に改行がなく、そこでファイルが終わる場合も、title を取得する', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。末尾の `---` の後ろに改行がない場合でも、`X` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle: X\n---')).toBe('X')
  })

  it('title: の直後に空白が存在しない場合も、値を取得する', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`title:NoSpace` のように空白がない場合でも、`NoSpace` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle:NoSpace\n---\n')).toBe('NoSpace')
  })

  it('title のキーが存在しない場合は、undefined を返す', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。frontmatter に `title` が存在しない場合は、`undefined` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntheme: default\n---\n# Hi')).toBeUndefined()
  })

  it('title の値が空の場合は undefined', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`title:` の値が空の場合に、`undefined` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle:\n---\n')).toBeUndefined()
  })

  it('title の値が空白のみの場合は undefined', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。`title:` の値が空白だけの場合に、`undefined` を返すことを確認します。')
    expect(parseSlidesTitle('---\ntitle:    \n---\n')).toBeUndefined()
  })

  it('frontmatter が存在しない場合は、undefined を返す', async () => {
    await explains('`slides.md` から題を取り出す `parseSlidesTitle` のテストです。ファイルに frontmatter が存在しない場合は、`undefined` を返すことを確認します。')
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
  it.each(cases)('%s（入力 %j）の場合は、ファイル名として使える文字列を返す', async (_label, input, expected) => {
    await explains(`ファイル名を整える \`sanitizeFilename\` のテストです。「${_label}」の場合に、\`${expected}\` が返ることを確認します。`)
    expect(sanitizeFilename(input)).toBe(expected)
  })

  it('ASCII の文字は、250 バイト（250 文字）で切り詰める', async () => {
    await explains('ファイル名を整える `sanitizeFilename` のテストです。300 文字の ASCII を渡した場合に、250 バイト（250 文字）になるまで切り詰められることを確認します。')
    const long = 'x'.repeat(300)
    const result = sanitizeFilename(long)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(250)
    expect(result).toHaveLength(250)
  })

  it('長い日本語の title は、UTF-8 で 250 バイト以内になるよう切り詰める', async () => {
    await explains('ファイル名を整える `sanitizeFilename` のテストです。「あ」を 100 文字渡した場合に、250 バイト以内に収まる 83 文字へ切り詰められることを確認します。')
    // 「あ」= 3 バイト。100 文字 = 300 バイトで上限超過。code point 境界で切るため
    // 250 / 3 = 83 文字 (249 バイト) に収まる。
    const long = 'あ'.repeat(100)
    const result = sanitizeFilename(long)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(250)
    expect(result).toBe('あ'.repeat(83))
  })

  it('切り詰める位置がサロゲートペア（絵文字）の途中になる場合も、ペアを分断しない', async () => {
    await explains('ファイル名を整える `sanitizeFilename` のテストです。4 バイトの絵文字を 70 個渡した場合に、250 バイト以内の 62 個で切り詰められ、文字の途中で分断されないことを確認します。')
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
