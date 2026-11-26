import { describe, expect, it } from 'vitest'

import { isGenericFamily, webFontsFor } from '../web-fonts.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const BASE = 'https://fonts.googleapis.com/css2?'

describe('webFontsFor', () => {
  it('書体ごとに太さ 400 から 700 の family を指定し、preload を書体と太さの順に並べる', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。複数の書体を渡した場合に、書体ごとに太さ 400 から 700 までを指定したスタイルシートの URL を作成し、`preload` を書体と太さの順に並べることを確認します。')
    const fonts = webFontsFor(['Inter', 'Noto Sans JP'])
    expect(fonts.stylesheetUrl).toBe(
      `${BASE}family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap`,
    )
    expect(fonts.preload).toEqual([
      '400 16px "Inter"', '500 16px "Inter"', '600 16px "Inter"', '700 16px "Inter"',
      '400 16px "Noto Sans JP"', '500 16px "Noto Sans JP"', '600 16px "Noto Sans JP"', '700 16px "Noto Sans JP"',
    ])
  })

  it('総称の書体名は、スタイルシートの URL と preload から除外する', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。`sans-serif` や `Monospace` のような総称の書体名を渡した場合に、URL と `preload` から除外し、通常の書体名だけを残すことを確認します。')
    const fonts = webFontsFor(['Test Sans', 'sans-serif', 'Monospace'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=Test+Sans:wght@400;500;600;700&display=swap`)
    expect(fonts.preload).toHaveLength(4)
  })

  it('総称の書体名だけの場合は、スタイルシートの URL を作成せず、preload を空にする', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。総称の書体名だけを渡した場合と、空の配列を渡した場合に、URL が `undefined` で `preload` が空になることを確認します。')
    expect(webFontsFor(['sans-serif'])).toEqual({ stylesheetUrl: undefined, preload: [] })
    expect(webFontsFor([])).toEqual({ stylesheetUrl: undefined, preload: [] })
  })

  it('大文字と小文字の違いと前後の空白を除いて重複をなくし、最初に指定した綴りを残す', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。`Inter` と `inter` のように、大文字と小文字や前後の空白だけが異なる書体名と、空の書体名を渡した場合に、最初の綴りの 1 つだけを残すことを確認します。')
    const fonts = webFontsFor(['Inter', ' inter ', 'INTER', '', '  '])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=Inter:wght@400;500;600;700&display=swap`)
    expect(fonts.preload).toHaveLength(4)
  })

  it('書体名の空白は + に、アポストロフィは %27 に変換する', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。空白とアポストロフィを含む書体名を渡した場合に、URL の中で空白が `+`、アポストロフィが `%27` に変換されることを確認します。')
    const fonts = webFontsFor(['O\'Neil Sans'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=O%27Neil+Sans:wght@400;500;600;700&display=swap`)
    expect(fonts.stylesheetUrl).not.toContain('\'')
  })

  it('書体名に & や # が含まれる場合は、URL の区切りとして解釈されないように変換する', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。`A&B#C` のように URL の区切りと同じ文字を含む書体名を渡した場合に、`%26` と `%23` に変換されることを確認します。')
    const fonts = webFontsFor(['A&B#C'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=A%26B%23C:wght@400;500;600;700&display=swap`)
  })

  it('preload の書体名に含まれる二重引用符とバックスラッシュは、エスケープする', async () => {
    await explains('書体名から Web フォントの読み込み情報を作成する `webFontsFor` のテストです。書体名に二重引用符とバックスラッシュが含まれる場合に、`preload` の中でバックスラッシュを付けてエスケープすることを確認します。')
    const fonts = webFontsFor(['Say "Hi"', String.raw`Back\slash`])
    expect(fonts.preload[0]).toBe(String.raw`400 16px "Say \"Hi\""`)
    expect(fonts.preload[4]).toBe(String.raw`400 16px "Back\\slash"`)
  })
})

describe('isGenericFamily', () => {
  it('総称の書体名は、大文字と小文字や空白の違いを除いて true と判定し、通常の書体名は false と判定する', async () => {
    await explains('書体名が総称かどうかを判定する `isGenericFamily` のテストです。`Sans-Serif` や `cursive` のような総称の書体名に対して `true` を返し、`Inter` や空文字に対して `false` を返すことを確認します。')
    expect(isGenericFamily(' Sans-Serif ')).toBe(true)
    expect(isGenericFamily('cursive')).toBe(true)
    expect(isGenericFamily('Inter')).toBe(false)
    expect(isGenericFamily('')).toBe(false)
  })
})
