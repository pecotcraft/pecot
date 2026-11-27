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
import { explains } from '../../../_helpers/explains.js'

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
  it.each([16, 13, 12, 10, 9])('文字サイズが規定の 5 段に含まれる %ipx のときは、警告を返さない', async (size) => {
    await explains(`図の文字サイズを判定する \`validateSlideFontSizes\` のテストです。\`fontSize\` に ${String(size)}px を指定したセルを渡した場合に、警告を返さないことを確認します。`)
    const xml = wrap(`fontSize=${String(size)};`, 'Hello')
    expect(check(xml)).toEqual([])
  })

  it('文字サイズが規定の 5 段に含まれない 14px のときは、使えるサイズと用途を示す警告を 1 件返す', async () => {
    await explains('図の文字サイズを判定する `validateSlideFontSizes` のテストです。`fontSize=14` のセルを渡した場合に、警告が 1 件だけ返り、メッセージに対象のセル・14px・使える 5 つのサイズ・各サイズの用途が含まれることを確認します。')
    const warnings = check(wrap('fontSize=14;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.severity).toBe('warning')
    expect(warnings[0]?.message).toContain('mxCell id=x')
    expect(warnings[0]?.message).toContain('14px')
    expect(warnings[0]?.message).toContain('16, 13, 12, 10, 9 px')
    expect(warnings[0]?.message).toContain('heading 16, subheading 13, body 12, caption 10, label 9')
    expect(warnings[0]?.message).toContain('is not a theme size')
  })

  it('文字サイズを指定していないセルは、draw.io の既定の 11px として扱い、警告を 1 件返す', async () => {
    await explains('図の文字サイズを判定する `validateSlideFontSizes` のテストです。style に `fontSize` が存在しないセルを渡した場合に、警告が 1 件だけ返り、`fontSize is not set` を含むことを確認します。')
    const warnings = check(wrap('rounded=1;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('fontSize is not set')
  })

  it('value の HTML に規定外の font-size:15px があると、警告を 1 件返す', async () => {
    await explains('セルの `value` に含まれる HTML の `font-size` を判定するテストです。`<span>` に `font-size:15px` を指定した場合に、警告が 1 件だけ返り、メッセージに 15px と対象の文字列 `Big` が含まれることを確認します。')
    const value = '&lt;span style=&quot;font-size:15px&quot;&gt;Big&lt;/span&gt;'
    const warnings = check(wrap('fontSize=12;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('15px')
    expect(warnings[0]?.message).toContain('"Big"')
  })

  it('value の HTML の font-size が規定内なら警告を返さず、外側の文字は cell の fontSize で判定する', async () => {
    await explains('`value` の一部の文字に、規定内の `font-size:10px` を指定した場合のテストです。cell の `fontSize` が 12 のときは警告を返さず、14 のときは外側の文字に対する警告を 1 件返すことを確認します。')
    const value = 'Out &lt;span style=&quot;font-size:10px&quot;&gt;in&lt;/span&gt; tail'
    expect(check(wrap('fontSize=12;', value))).toEqual([])
    expect(check(wrap('fontSize=14;', value)).length).toBe(1)
  })

  it('value の HTML に font タグの size 指定があると、警告を 1 件返す', async () => {
    await explains('`value` に `<font size="5">` を含むセルを渡した場合のテストです。警告が 1 件だけ返り、メッセージに `<font size="5">` が含まれることを確認します。')
    const value = '&lt;font size=&quot;5&quot;&gt;Big&lt;/font&gt;'
    const warnings = check(wrap('fontSize=12;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('<font size="5">')
  })

  it('表示する文字が存在しないセルは、警告の対象にしない', async () => {
    await explains('`value` が空のセルと、`<br>` だけのセルを渡した場合のテストです。どちらの場合も警告を返さないことを確認します。')
    expect(check(wrap('rounded=1;', ''))).toEqual([])
    expect(check(wrap('rounded=1;', '&lt;br&gt;'))).toEqual([])
  })

  describe('object / UserObject に包まれたセル (F-04)', () => {
    it.each(['object', 'UserObject'])('%s で包んだセルでも、子の mxCell の style の文字サイズを判定する', async (tag) => {
      await explains(`\`<${tag}>\` タグで包んだセルの文字サイズのテストです。子の \`mxCell\` に規定外の \`fontSize=14\` がある場合に、警告を 1 件だけ返し、メッセージに包んだタグの id と 14px が含まれることを確認します。`)
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
    it.each(['1.2em', '150%', '12pt'])('style の fontSize に px 以外の単位（%s）を指定すると、指定した値を表示し、px で指定するよう案内する', async (raw) => {
      await explains('style の `fontSize` に px 以外の単位を指定した場合のテストです。警告が 1 件だけ返り、メッセージに指定した値が含まれて `NaN` は含まれず、`specify it in px` と案内することを確認します。')
      const warnings = check(wrap(`fontSize=${raw};`, 'Hello'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain(raw)
      expect(warnings[0]?.message).not.toContain('NaN')
      expect(warnings[0]?.message).toContain('specify it in px')
    })

    it('value の HTML の font-size に em を指定した場合も、指定した値を表示し、px で指定するよう案内する', async () => {
      await explains('`value` の HTML に `font-size:1.2em` を指定した場合のテストです。警告が 1 件だけ返り、メッセージに `1.2em` が含まれて `NaN` は含まれず、`specify it in px` と案内することを確認します。')
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font-size:1.2em&quot;&gt;Big&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('1.2em')
      expect(warnings[0]?.message).not.toContain('NaN')
      expect(warnings[0]?.message).toContain('specify it in px')
    })
  })

  describe('CSS の font 一括指定 (F-06)', () => {
    it('CSS の font の一括指定に規定外のサイズ（20px）があると、そのサイズを読み取って警告を返す', async () => {
      await explains('`value` の HTML に `font: 20px Fira Code` と書いた場合のテストです。一括指定の中のサイズを読み取り、20px について警告が 1 件だけ返ることを確認します。')
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font: 20px Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('20px')
    })

    it('CSS の font の一括指定が規定内のサイズ（12px）なら、行の高さを含んでいても警告を返さない', async () => {
      await explains('`value` の HTML に `font: 12px/1.5 Inter` と書いた場合のテストです。cell の `fontSize` が規定外の 14 でも、文字には 12px が優先して適用されるため、警告を返さないことを確認します。')
      expect(check(wrap('fontSize=14;', '&lt;span style=&quot;font: 12px/1.5 Inter&quot;&gt;x&lt;/span&gt;'))).toEqual([])
    })
  })

  describe('直し方の案内 (F-07)', () => {
    it('規定外のサイズが value の HTML に由来する場合は、value 内の指定を削除するよう案内する', async () => {
      await explains('`value` の HTML の `font-size:15px` が原因の警告のテストです。メッセージが、`value` の `font-size` を削除する方法と、セルの style に `fontSize` を追加する方法を案内することを確認します。')
      const warnings = check(wrap('fontSize=12;', '&lt;span style=&quot;font-size:15px&quot;&gt;Big&lt;/span&gt;'))
      expect(warnings[0]?.message).toContain('remove font-size in value')
      expect(warnings[0]?.message).toContain('add fontSize=<size> to the cell style')
    })

    it('規定外のサイズがセルの style に由来する場合は、style に fontSize を追加するよう案内する', async () => {
      await explains('セルの style の `fontSize=14` が原因の警告のテストです。メッセージが style への `fontSize` の追加を案内し、`value` の `font-size` の削除は案内しないことを確認します。')
      const warnings = check(wrap('fontSize=14;', 'Hello'))
      expect(warnings[0]?.message).toContain('add fontSize=<size> to style')
      expect(warnings[0]?.message).not.toContain('remove font-size in value')
    })
  })

  describe('<font size> の入れ子 (F-08)', () => {
    it('font タグが入れ子の場合は、内側の終了タグより後ろも外側の size を適用して判定する', async () => {
      await explains('`<font size="5">` の中に `<font size="2">` を入れた `value` を渡した場合のテストです。外側の指定の `A` と内側の指定の `B` について警告を 1 件ずつ返し、タグの外にある `D` は報告しないことを確認します。')
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

    it.each(['ja', 'en'])('本体の既定の fontSizes が、infographic の %s 版の DESIGN.md にある文字サイズと一致する', async (language) => {
      await explains(`本体の既定の \`fontSizes\` と、\`infographic/${language}/DESIGN.md\` の \`typography\` を比較するテストです。両方の文字サイズが順序を除いて一致することを確認します。`)
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

    it.each([18, 15, 14, 11, 10])('テーマの宣言にある 5 段のサイズ（%ipx）を指定したときは、警告を返さない', async (size) => {
      await explains(`別のテーマの宣言（18・15・14・11・10px）を渡した場合のテストです。\`fontSize\` に ${String(size)}px を指定したセルについて、警告を返さないことを確認します。`)
      const xml = wrap(`fontSize=${String(size)};`, 'Hello')
      expect(check(xml, TEST_SANS_STEPS)).toEqual([])
    })

    it('渡した宣言に含まれない 16px は規定外とし、その宣言の 5 段を案内する', async () => {
      await explains('別のテーマの宣言（18・15・14・11・10px）を渡し、主な宣言の `fontSize=16` を指定した場合のテストです。警告が 1 件だけ返り、渡した宣言のサイズと用途が案内され、主な宣言のサイズは含まれないことを確認します。')
      const warnings = check(wrap('fontSize=16;', 'Hello'), TEST_SANS_STEPS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('16px')
      expect(warnings[0]?.message).toContain('18, 15, 14, 11, 10 px')
      expect(warnings[0]?.message).toContain('heading 18, subheading 15, body 14, caption 11, label 10')
      expect(warnings[0]?.message).not.toContain('16, 13, 12, 10, 9 px')
    })

    it('同じ図でも、渡した宣言が違えば判定の結果が変わる', async () => {
      await explains('`fontSize=14` のセルを 2 つの宣言で判定するテストです。主な宣言（16・13・12・10・9px）では警告が 1 件返り、別の宣言（18・15・14・11・10px）では警告を返さないことを確認します。')
      const xml = wrap('fontSize=14;', 'Hello')
      expect(check(xml)).toHaveLength(1)
      expect(check(xml, TEST_SANS_STEPS)).toEqual([])
    })

    it('文字サイズを指定していないセルは、11px を含む宣言であれば警告を返さない', async () => {
      await explains('`fontSize` を指定していないセルを、11px を含む宣言（18・15・14・11・10px）で判定するテストです。draw.io の既定の 11px が宣言に含まれるため、警告を返さないことを確認します。')
      expect(check(wrap('rounded=1;', 'Hello'), TEST_SANS_STEPS)).toEqual([])
    })

    it('警告のメッセージは、スライドの規定外ではなく、テーマの規定外と表現する', async () => {
      await explains('規定外の `fontSize=14` に対する警告のテストです。メッセージに `slide size` という表現が含まれないことを確認します。')
      const warnings = check(wrap('fontSize=14;', 'Hello'))
      expect(warnings[0]?.message).not.toContain('slide size')
    })
  })
})
