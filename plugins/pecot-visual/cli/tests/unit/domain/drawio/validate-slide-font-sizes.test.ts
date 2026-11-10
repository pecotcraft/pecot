// domain/drawio/url.ts の validateSlideFontSizes に対するテスト。
// 図の文字サイズが、テーマの宣言の 5 段に収まっているかを押さえる。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

import { validateSlideFontSizes } from '../../../../src/domain/drawio/url.js'
import type { DrawioFinding, ThemeFontSizes } from '../../../../src/domain/drawio/url.js'
import { DEFAULT_THEME_DECLARATION } from '../../../../src/domain/slidev-theme/defaults.js'

// 主な宣言: 16/13/12/10/9px の 5 段。
const FIVE_STEPS: ThemeFontSizes = { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 }

function check(xml: string, sizes: ThemeFontSizes = FIVE_STEPS): readonly DrawioFinding[] {
  return validateSlideFontSizes(xml, sizes)
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

const TYPOGRAPHY_ENTRY = z.object({ fontSize: z.string() })
const DESIGN_FRONT_MATTER = z.object({ typography: z.record(z.string(), TYPOGRAPHY_ENTRY) })

describe('validateSlideFontSizes', () => {
  it.each([16, 13, 12, 10, 9])('規定内の %ipx → 警告 0', (size) => {
    const xml = wrap(`fontSize=${String(size)};`, 'Hello')
    expect(check(xml)).toEqual([])
  })

  it('14px → 警告 1（使える 5 サイズと対応を含む）', () => {
    const warnings = check(wrap('fontSize=14;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.severity).toBe('warning')
    expect(warnings[0]?.message).toContain('mxCell id=x')
    expect(warnings[0]?.message).toContain('14px')
    expect(warnings[0]?.message).toContain('16, 13, 12, 10, 9 px')
    expect(warnings[0]?.message).toContain('heading 16, subheading 13, body 12, caption 10, label 9')
    expect(warnings[0]?.message).toContain('is not a theme size')
  })

  it('fontSize 未指定 → 警告 1（draw.io 既定の 11px）', () => {
    const warnings = check(wrap('rounded=1;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('fontSize is not set')
  })

  it('HTML 内の font-size:15px → 警告 1', () => {
    const value = '&lt;span style=&quot;font-size:15px&quot;&gt;Big&lt;/span&gt;'
    const warnings = check(wrap('fontSize=12;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('15px')
    expect(warnings[0]?.message).toContain('"Big"')
  })

  it('HTML 内の font-size が規定内なら 0 件、外側の文字は cell の大きさで見る', () => {
    const value = 'Out &lt;span style=&quot;font-size:10px&quot;&gt;in&lt;/span&gt; tail'
    expect(check(wrap('fontSize=12;', value))).toEqual([])
    expect(check(wrap('fontSize=14;', value)).length).toBe(1)
  })

  it('<font size> は警告 1', () => {
    const value = '&lt;font size=&quot;5&quot;&gt;Big&lt;/font&gt;'
    const warnings = check(wrap('fontSize=12;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('<font size="5">')
  })

  it('文字の無いセルは対象外', () => {
    expect(check(wrap('rounded=1;', ''))).toEqual([])
    expect(check(wrap('rounded=1;', '&lt;br&gt;'))).toEqual([])
  })

  describe('object / UserObject に包まれたセル (F-04)', () => {
    it.each(['object', 'UserObject'])('<%s label> の文字と子 mxCell の style のサイズを確かめる', (tag) => {
      const xml = `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0"/>
        <${tag} label="Hello" id="obj1">
          <mxCell style="fontSize=14;" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>
        </${tag}>
      </root></mxGraphModel></diagram></mxfile>`
      const warnings = check(xml)
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('mxCell id=obj1')
      expect(warnings[0]?.message).toContain('14px')
    })
  })

  describe('px 以外の単位 (F-05)', () => {
    it.each(['1.2em', '150%', '12pt'])('style の fontSize=%s は NaN にせず指定文字列を出して px を案内する', (raw) => {
      const warnings = check(wrap(`fontSize=${raw};`, 'Hello'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain(raw)
      expect(warnings[0]?.message).not.toContain('NaN')
      expect(warnings[0]?.message).toContain('specify it in px')
    })

    it('HTML 内の font-size:1.2em も同様', () => {
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font-size:1.2em&quot;&gt;Big&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('1.2em')
      expect(warnings[0]?.message).not.toContain('NaN')
      expect(warnings[0]?.message).toContain('specify it in px')
    })
  })

  describe('CSS の font 一括指定 (F-06)', () => {
    it('font: 20px Fira Code のサイズを読んで警告する', () => {
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font: 20px Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('20px')
    })

    it('font: 12px/1.5 Inter は規定内で警告 0', () => {
      expect(check(wrap('fontSize=14;', '&lt;span style=&quot;font: 12px/1.5 Inter&quot;&gt;x&lt;/span&gt;'))).toEqual([])
    })
  })

  describe('直し方の案内 (F-07)', () => {
    it('value の HTML 由来は value 内の指定を消すよう案内する', () => {
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font-size:15px&quot;&gt;Big&lt;/span&gt;'))
      expect(warnings[0]?.message).toContain('remove font-size in value')
      expect(warnings[0]?.message).toContain('add fontSize=<size> to the cell style')
    })

    it('セル style 由来は style を直すよう案内する', () => {
      const warnings = check(wrap('fontSize=14;', 'Hello'))
      expect(warnings[0]?.message).toContain('add fontSize=<size> to style')
      expect(warnings[0]?.message).not.toContain('remove font-size in value')
    })
  })

  describe('<font size> の入れ子 (F-08)', () => {
    it('内側の </font> の後も外側の <font size> が続く', () => {
      const value = '&lt;font size=&quot;5&quot;&gt;A&lt;font size=&quot;2&quot;&gt;B&lt;/font&gt;C&lt;/font&gt;D'
      const warnings = check(wrap('fontSize=12;', value))
      expect(warnings.length).toBe(2)
      expect(warnings.some(w => w.message.includes('<font size="5">') && w.message.includes('"A"'))).toBe(true)
      expect(warnings.some(w => w.message.includes('<font size="2">') && w.message.includes('"B"'))).toBe(true)
      // 外側の <font size="5"> は "C" にも続くが、同じラベルは最初の 1 件だけ報告する
      expect(warnings.some(w => w.message.includes('"D"'))).toBe(false)
    })
  })

  describe('文字サイズの 5 段と DESIGN.md の同期 (F-15)', () => {
    const skillsRoot = fileURLToPath(new URL('../../../../../skills/v-drawio/references/infographic', import.meta.url))

    it.each(['ja', 'en'])('本体の既定値の fontSizes が infographic/%s/DESIGN.md の typography の fontSize と一致する', (language) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定ディレクトリ配下の DESIGN.md
      const text = readFileSync(path.join(skillsRoot, language, 'DESIGN.md'), 'utf8')
      const frontMatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1]
      expect(frontMatter).toBeDefined()
      const { typography } = DESIGN_FRONT_MATTER.parse(parse(frontMatter ?? ''))
      const sizes = Object.values(typography).map(entry => Number(entry.fontSize.replace('px', '')))
      const expected = Object.values(DEFAULT_THEME_DECLARATION.fontSizes).toSorted((a, b) => a - b)
      const actual = sizes.toSorted((a, b) => a - b)
      expect(actual).toEqual(expected)
    })
  })

  describe('宣言ごとの 5 段 (T051)', () => {
    const TEST_SANS_STEPS: ThemeFontSizes = { heading: 18, headingSm: 15, body: 14, bodySm: 11, label: 10 }

    it.each([18, 15, 14, 11, 10])('宣言の %ipx → 警告 0', (size) => {
      const xml = wrap(`fontSize=${String(size)};`, 'Hello')
      expect(check(xml, TEST_SANS_STEPS)).toEqual([])
    })

    it('別の宣言の段（16px）は外れとして、宣言の 5 段を案内する', () => {
      const warnings = check(wrap('fontSize=16;', 'Hello'), TEST_SANS_STEPS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('16px')
      expect(warnings[0]?.message).toContain('18, 15, 14, 11, 10 px')
      expect(warnings[0]?.message).toContain('heading 18, subheading 15, body 14, caption 11, label 10')
      expect(warnings[0]?.message).not.toContain('16, 13, 12, 10, 9 px')
    })

    it('同じ図でも宣言が違えば結果が変わる（14px は 5 段の宣言では外れ、18/15/14 の宣言では収まる）', () => {
      const xml = wrap('fontSize=14;', 'Hello')
      expect(check(xml)).toHaveLength(1)
      expect(check(xml, TEST_SANS_STEPS)).toEqual([])
    })

    it('未指定の 11px は、11px を持つ宣言なら収まる', () => {
      expect(check(wrap('rounded=1;', 'Hello'), TEST_SANS_STEPS)).toEqual([])
    })

    it('スライドと書かず、テーマの規定外と書く', () => {
      const warnings = check(wrap('fontSize=14;', 'Hello'))
      expect(warnings[0]?.message).not.toContain('slide size')
    })
  })
})
