import { describe, expect, it } from 'vitest'

import { isGenericFamily, webFontsFor } from '../web-fonts.js'

const BASE = 'https://fonts.googleapis.com/css2?'

describe('webFontsFor', () => {
  it('書体ごとに 400〜700 の family を頼み、preload を書体×太さの順に並べる', () => {
    const fonts = webFontsFor(['Inter', 'Noto Sans JP'])
    expect(fonts.stylesheetUrl).toBe(
      `${BASE}family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap`,
    )
    expect(fonts.preload).toEqual([
      '400 16px "Inter"', '500 16px "Inter"', '600 16px "Inter"', '700 16px "Inter"',
      '400 16px "Noto Sans JP"', '500 16px "Noto Sans JP"', '600 16px "Noto Sans JP"', '700 16px "Noto Sans JP"',
    ])
  })

  it('総称の書体は除く', () => {
    const fonts = webFontsFor(['Test Sans', 'sans-serif', 'Monospace'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=Test+Sans:wght@400;500;600;700&display=swap`)
    expect(fonts.preload).toHaveLength(4)
  })

  it('総称だけなら URL を作らず preload も空', () => {
    expect(webFontsFor(['sans-serif'])).toEqual({ stylesheetUrl: undefined, preload: [] })
    expect(webFontsFor([])).toEqual({ stylesheetUrl: undefined, preload: [] })
  })

  it('大文字小文字・前後の空白を無視して重複を除き、最初の綴りを残す', () => {
    const fonts = webFontsFor(['Inter', ' inter ', 'INTER', '', '  '])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=Inter:wght@400;500;600;700&display=swap`)
    expect(fonts.preload).toHaveLength(4)
  })

  it('空白は + に、\' は %27 に替える', () => {
    const fonts = webFontsFor(['O\'Neil Sans'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=O%27Neil+Sans:wght@400;500;600;700&display=swap`)
    expect(fonts.stylesheetUrl).not.toContain('\'')
  })

  it('& や # を含む書体名は URL のパラメータ区切りにならない', () => {
    const fonts = webFontsFor(['A&B#C'])
    expect(fonts.stylesheetUrl).toBe(`${BASE}family=A%26B%23C:wght@400;500;600;700&display=swap`)
  })

  it('preload の書体名は二重引用符とバックスラッシュを escape する', () => {
    const fonts = webFontsFor(['Say "Hi"', String.raw`Back\slash`])
    expect(fonts.preload[0]).toBe(String.raw`400 16px "Say \"Hi\""`)
    expect(fonts.preload[4]).toBe(String.raw`400 16px "Back\\slash"`)
  })
})

describe('isGenericFamily', () => {
  it('総称は大文字小文字と空白を無視して true、通常の書体名は false', () => {
    expect(isGenericFamily(' Sans-Serif ')).toBe(true)
    expect(isGenericFamily('cursive')).toBe(true)
    expect(isGenericFamily('Inter')).toBe(false)
    expect(isGenericFamily('')).toBe(false)
  })
})
