// domain/drawio/url.ts の validateSlideFonts に対するテスト。
// 図の文字が、テーマの宣言の書体（fonts.body と eastAsian）で組まれているかを押さえる。

import { describe, expect, it } from 'vitest'

import { validateSlideFonts } from '../../../../src/domain/drawio/url.js'
import type { DrawioFinding, ThemeFonts } from '../../../../src/domain/drawio/url.js'

// 主な宣言: 本文が 2 書体で、和文の書体も宣言したテーマ。
const TWO_FONTS: ThemeFonts = { body: ['Inter', 'Noto Sans JP'], eastAsian: 'Noto Sans JP' }

function check(xml: string, fonts: ThemeFonts = TWO_FONTS, themeName?: string): readonly DrawioFinding[] {
  return validateSlideFonts(xml, fonts, themeName)
}

function wrap(style: string, value: string): string {
  return `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="x" vertex="1" style="${style}" value="${value}">
      <mxGeometry x="0" y="0" width="100" height="40" as="geometry"/>
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`
}

function wrapped(tag: string, style: string, label: string): string {
  return `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/>
    <${tag} label="${label}" id="obj1">
      <mxCell style="${style}" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>
    </${tag}>
  </root></mxGraphModel></diagram></mxfile>`
}

describe('validateSlideFonts', () => {
  it('Fira Code → 警告 1（理由と直し方を含む）', () => {
    const warnings = check(wrap('rounded=1;fontFamily=Fira Code;', 'node --version'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.severity).toBe('warning')
    expect(warnings[0]?.message).toContain('mxCell id=x')
    expect(warnings[0]?.message).toContain('「fira code」')
    expect(warnings[0]?.message).toContain('fontFamily=Inter, Noto Sans JP')
    expect(warnings[0]?.message).toContain('Inter, Noto Sans JP')
    expect(warnings[0]?.message).toContain('node --version')
  })

  it('Inter 単独 + 和文 → Noto Sans JP 欠落の警告 1', () => {
    const warnings = check(wrap('fontFamily=Inter;', '道筋 1'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('Noto Sans JP がありません')
    expect(warnings[0]?.message).toContain('道筋 1')
  })

  it('Inter 単独 + 英数のみ → 警告 0', () => {
    expect(check(wrap('fontFamily=Inter;', 'v24.22.1'))).toEqual([])
  })

  it('書体指定なし → Helvetica の警告 1（和文なら欠落の警告も加わり 2）', () => {
    const latin = check(wrap('rounded=1;', 'Hello'))
    expect(latin.length).toBe(1)
    expect(latin[0]?.message).toContain('Helvetica')
    expect(check(wrap('rounded=1;', '道筋')).length).toBe(2)
  })

  it('Helvetica 明示 → 警告 1', () => {
    const warnings = check(wrap('fontFamily=Helvetica;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('helvetica')
  })

  it('文字を持たないセル（空 value・タグだけ）は警告 0', () => {
    expect(check(wrap('rounded=1;', ''))).toEqual([])
    expect(check(wrap('rounded=1;', '&lt;br&gt;&nbsp;'))).toEqual([])
  })

  it('Inter, Noto Sans JP + 和文 → 警告 0', () => {
    expect(check(wrap('fontFamily=Inter, Noto Sans JP;', '道筋 1'))).toEqual([])
  })

  it('Display Extended 先頭の見出し → 書体の警告 1 件', () => {
    const warnings = check(wrap('fontFamily=Display Extended, Inter, Noto Sans JP;', '見出し 01'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('先頭書体「display extended」')
    expect(warnings[0]?.message).not.toContain('見出しは')
  })

  it('value 内 div の style font-family が Fira Code → 警告 1', () => {
    const value = '&lt;div style=&quot;font-family: &amp;quot;Fira Code&amp;quot;&quot;&gt;0ed4268&lt;/div&gt;'
    const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('0ed4268')
  })

  it('入れ子の font face が内側だけ上書きし、閉じた後は外側の書体に戻る', () => {
    const value = '日本語&lt;font face=&quot;Fira Code&quot;&gt;code&lt;/font&gt;のあと'
    const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('"code"')
  })

  it('外側が Fira Code でも内側の font face が正しければ内側の文字は警告 0', () => {
    const value = '&lt;font face=&quot;Inter, Noto Sans JP&quot;&gt;道筋&lt;/font&gt;'
    expect(check(wrap('fontFamily=Fira Code;html=1;', value))).toEqual([])
  })

  it('不正 XML は警告 0 で確認を省くする', () => {
    expect(check('<mxfile>')).toEqual([])
  })

  describe('object / UserObject に包まれたセル (F-04)', () => {
    it.each(['object', 'UserObject'])('<%s label> の文字と子 mxCell の style の書体を確かめる', (tag) => {
      const warnings = check(wrapped(tag, 'fontFamily=Fira Code;fontSize=14;', 'node --version'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('mxCell id=obj1')
      expect(warnings[0]?.message).toContain('「fira code」')
      expect(warnings[0]?.message).toContain('node --version')
    })

    it('規定の書体なら警告 0', () => {
      expect(check(wrapped('object', 'fontFamily=Inter;', 'v24'))).toEqual([])
    })
  })

  describe('CSS の font 一括指定 (F-06)', () => {
    it('font: 20px Fira Code の書体を読んで警告する', () => {
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font: 20px Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('「fira code」')
    })

    it('font: 12px/1.5 Inter, Noto Sans JP は警告 0', () => {
      const value = '&lt;span style=&quot;font: bold 12px/1.5 Inter, &#39;Noto Sans JP&#39;&quot;&gt;道筋&lt;/span&gt;'
      expect(check(wrap('fontFamily=Inter, Noto Sans JP;', value))).toEqual([])
    })

    it('読めない一括指定は使わないよう警告する', () => {
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font: inherit&quot;&gt;x&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('font: inherit')
      expect(warnings[0]?.message).toContain('font 一括指定')
      expect(warnings[0]?.message).toContain('font-family と font-size を個別に指定')
    })
  })

  describe('直し方の案内 (F-07)', () => {
    it('value の HTML 由来の規定外書体は value 内の指定を消すよう案内する', () => {
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font-family:Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('value 内の font-family')
      expect(warnings[0]?.message).toContain('消し')
    })

    it('value の HTML 由来の Noto Sans JP 欠落も value 内の指定を案内する', () => {
      const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;', '&lt;font face=&quot;Inter&quot;&gt;道筋&lt;/font&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('value 内の font-family')
    })

    it('セル style 由来の規定外書体は style を直すよう案内する', () => {
      const warnings = check(wrap('fontFamily=Fira Code;', 'code'))
      expect(warnings[0]?.message).toContain('style に fontFamily=Inter, Noto Sans JP, sans-serif を付けてください')
      expect(warnings[0]?.message).not.toContain('value 内の font-family')
    })
  })

  describe('宣言ごとの許す書体 (T051)', () => {
    const TEST_SANS: ThemeFonts = { body: ['Test Sans'], eastAsian: 'Test Sans JP' }

    it('宣言の書体なら警告 0、宣言に無い書体は外れとして警告する', () => {
      expect(check(wrap('fontFamily=Test Sans;', 'Hello'), TEST_SANS)).toEqual([])
      const warnings = check(wrap('fontFamily=Inter;', 'Hello'), TEST_SANS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('先頭書体「inter」')
    })

    it('許す先頭書体は fonts.body と eastAsian の和集合（eastAsian の書体が先頭でもよい）', () => {
      expect(check(wrap('fontFamily=Test Sans JP;', 'Hello'), TEST_SANS)).toEqual([])
      expect(check(wrap('fontFamily=Noto Sans JP, Inter;', 'Hello'))).toEqual([])
    })

    it('直し方は body と eastAsian の重複を除いて組む', () => {
      const warnings = check(wrap('fontFamily=Fira Code;', 'code'), TEST_SANS)
      expect(warnings[0]?.message).toContain('fontFamily=Test Sans, Test Sans JP, sans-serif を付けて')
      const same = check(wrap('fontFamily=Fira Code;', 'code'))
      expect(same[0]?.message).toContain('fontFamily=Inter, Noto Sans JP, sans-serif を付けて')
      expect(same[0]?.message).not.toContain('Noto Sans JP, Noto Sans JP')
    })

    it('直し方の末尾に総称の書体を足す。宣言が総称で終わるなら足さない', () => {
      const cell = check(wrap('fontFamily=Fira Code;', 'code'), TEST_SANS)[0]?.message
      expect(cell).toContain('fontFamily=Test Sans, Test Sans JP, sans-serif を付けて')
      const html = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font-family:Fira Code&quot;&gt;x&lt;/span&gt;'), TEST_SANS)[0]?.message
      expect(html).toContain('fontFamily=Test Sans, Test Sans JP, sans-serif に任せます')
      const generic = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['Caveat', 'cursive'] })[0]?.message
      expect(generic).toContain('fontFamily=Caveat, cursive を付けて')
      const fallback = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['sans-serif'] })[0]?.message
      expect(fallback).toContain('fontFamily=sans-serif を付けて')
    })

    it('末尾に sans-serif を足した並びは、先頭書体と和文の確認を通る', () => {
      expect(check(wrap('fontFamily=Test Sans, Test Sans JP, sans-serif;', '道筋 Hello'), TEST_SANS)).toEqual([])
    })

    it('書体名は大文字小文字と引用符を無視して照らす', () => {
      expect(check(wrap('fontFamily=\'TEST SANS\';', 'Hello'), TEST_SANS)).toEqual([])
    })

    it('和文は eastAsian が並びに無ければ警告し、案内に eastAsian の書体を含める', () => {
      const warnings = check(wrap('fontFamily=Test Sans;', '道筋'), TEST_SANS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('Test Sans JP がありません')
      expect(check(wrap('fontFamily=Test Sans, Test Sans JP;', '道筋'), TEST_SANS)).toEqual([])
    })

    it('eastAsian を宣言していないテーマは、和文の確認をしない', () => {
      expect(check(wrap('fontFamily=Caveat;', '道筋'), { body: ['Caveat'] })).toEqual([])
      expect(check(wrap('fontFamily=Inter;', '道筋'), { body: ['Caveat'] })).toHaveLength(1)
    })

    it('既定の宣言（sans-serif だけ）では sans-serif を許し、Inter は外れる', () => {
      const fallback: ThemeFonts = { body: ['sans-serif'] }
      expect(check(wrap('fontFamily=sans-serif;', '道筋 Hello'), fallback)).toEqual([])
      expect(check(wrap('fontFamily=Inter;', 'Hello'), fallback)).toHaveLength(1)
    })
  })

  describe('等幅の並び', () => {
    it('monospace を含む並びは書体の確認を飛ばす', () => {
      expect(check(wrap('fontFamily=\'Noto Sans Mono\', monospace;', 'node --version'))).toEqual([])
      expect(check(wrap('fontFamily=Fira Code, MONOSPACE;', '道筋'))).toEqual([])
    })

    it('value の HTML 内の等幅の並びも飛ばし、外側の書体は確かめ続ける', () => {
      const value = '日本語&lt;span style=&quot;font-family: Fira Code, monospace&quot;&gt;code&lt;/span&gt;'
      expect(check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))).toEqual([])
      expect(check(wrap('fontFamily=Fira Code;html=1;', value)).length).toBeGreaterThan(0)
    })

    it('monospace を含まない等幅の書体名は飛ばさない', () => {
      expect(check(wrap('fontFamily=Fira Code;', 'code'))).toHaveLength(1)
    })
  })

  describe('文言のテーマ名', () => {
    it('テーマ名を渡すと「テーマの書体（名前）」、渡さないと「既定の書体」と書く', () => {
      const named = check(wrap('fontFamily=Fira Code;', 'code'), TWO_FONTS, 'my-theme')
      expect(named[0]?.message).toContain('テーマの書体（my-theme）')
      expect(named[0]?.message).not.toContain('スライドの書体')
      const fallback = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['sans-serif'] })
      expect(fallback[0]?.message).toContain('既定の書体')
      expect(fallback[0]?.message).not.toContain('スライドの書体')
    })
  })
})
