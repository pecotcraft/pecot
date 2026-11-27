// domain/drawio/url.ts の validateSlideFonts に対するテスト。
// 図の文字が、テーマの宣言の書体（fonts.body と eastAsian）で組まれているかを押さえる。

import { describe, expect, it } from 'vitest'

import { validateSlideFonts } from '../../../../src/domain/drawio/url.js'
import type { DrawioFinding, ThemeFonts } from '../../../../src/domain/drawio/url.js'
import { explains } from '../../../_helpers/explains.js'

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
  it('宣言にない書体（Fira Code）を指定したセルには、理由と直し方を示す警告を 1 件返す', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Fira Code` のセルを渡した場合に、警告が 1 件だけ返り、メッセージに対象のセルと修正方法が含まれることを確認します。')
    const warnings = check(wrap('rounded=1;fontFamily=Fira Code;', 'node --version'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.severity).toBe('warning')
    expect(warnings[0]?.message).toContain('mxCell id=x')
    expect(warnings[0]?.message).toContain('first font fira code')
    expect(warnings[0]?.message).toContain('fontFamily=Inter, Noto Sans JP')
    expect(warnings[0]?.message).toContain('Inter, Noto Sans JP')
    expect(warnings[0]?.message).toContain('node --version')
  })

  it('書体が Inter だけで和文を含むセルには、Noto Sans JP が不足している警告を 1 件返す', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Inter` のセルに和文の文字列を入れた場合に、警告が 1 件だけ返り、メッセージに `has no Noto Sans JP` とセルの文字列が含まれることを確認します。')
    const warnings = check(wrap('fontFamily=Inter;', '道筋 1'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('has no Noto Sans JP')
    expect(warnings[0]?.message).toContain('道筋 1')
  })

  it('書体が Inter だけで英数字だけのセルには、警告を返さない', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Inter` のセルに英数字だけの文字列を入れた場合に、和文用の書体が不要なため警告を返さないことを確認します。')
    expect(check(wrap('fontFamily=Inter;', 'v24.22.1'))).toEqual([])
  })

  it('書体を指定していないセルは Helvetica として扱って警告を 1 件返し、和文を含む場合は書体不足の警告を加えて 2 件にする', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。style に `fontFamily` が存在しないセルを渡した場合に、英数字だけなら警告が 1 件、和文を含むなら和文用の書体が不足している警告が加わって 2 件になることを確認します。')
    const latin = check(wrap('rounded=1;', 'Hello'))
    expect(latin.length).toBe(1)
    expect(latin[0]?.message).toContain('Helvetica')
    expect(check(wrap('rounded=1;', '道筋')).length).toBe(2)
  })

  it('書体に Helvetica を明示したセルには、警告を 1 件返す', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Helvetica` のセルを渡した場合に、警告が 1 件だけ返り、メッセージに `helvetica` が含まれることを確認します。')
    const warnings = check(wrap('fontFamily=Helvetica;', 'Hello'))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('helvetica')
  })

  it('表示する文字が存在しないセルは、警告を返さない', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` が空のセルと、`<br>` と `&nbsp;` だけのセルを渡した場合に、どちらも警告を返さないことを確認します。')
    expect(check(wrap('rounded=1;', ''))).toEqual([])
    expect(check(wrap('rounded=1;', '&lt;br&gt;&nbsp;'))).toEqual([])
  })

  it('書体が Inter と Noto Sans JP で和文を含むセルには、警告を返さない', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Inter, Noto Sans JP` のセルに和文の文字列を入れた場合に、宣言どおりの書体なので警告を返さないことを確認します。')
    expect(check(wrap('fontFamily=Inter, Noto Sans JP;', '道筋 1'))).toEqual([])
  })

  it('先頭の書体が Display Extended の見出しには、書体の警告を 1 件だけ返す', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。先頭を `Display Extended` にしたセルを渡した場合に、警告を 1 件だけ返し、`first font display extended` を含めることを確認します。')
    const warnings = check(wrap('fontFamily=Display Extended, Inter, Noto Sans JP;', '見出し 01'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('first font display extended')
    expect(warnings[0]?.message).not.toContain('heading')
  })

  it('value の HTML にある div の style が Fira Code を指定していると、警告を 1 件返す', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。セル本体は宣言どおりで、`<div>` の style にだけ `font-family` で Fira Code を指定した場合に、警告が 1 件だけ返ることを確認します。')
    const value = '&lt;div style=&quot;font-family: &amp;quot;Fira Code&amp;quot;&quot;&gt;0ed4268&lt;/div&gt;'
    const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('0ed4268')
  })

  it('入れ子の font タグの face は内側の文字にだけ適用し、閉じた後の文字は外側の書体で判定する', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の途中に `<font face="Fira Code">` を入れた場合に、警告が 1 件だけ返り、メッセージの対象が `code` だけになることを確認します。')
    const value = '日本語&lt;font face=&quot;Fira Code&quot;&gt;code&lt;/font&gt;のあと'
    const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('"code"')
  })

  it('セルの書体が Fira Code でも、内側の font タグの face が宣言どおりなら、内側の文字には警告を返さない', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。セルが `fontFamily=Fira Code` で、`value` 全体を宣言どおりの書体の `<font face>` で囲んだ場合に、警告を返さないことを確認します。')
    const value = '&lt;font face=&quot;Inter, Noto Sans JP&quot;&gt;道筋&lt;/font&gt;'
    expect(check(wrap('fontFamily=Fira Code;html=1;', value))).toEqual([])
  })

  it('XML として正しくない文字列を渡した場合は、判定を省略して警告を返さない', async () => {
    await explains('図の書体を判定する `validateSlideFonts` のテストです。`<mxfile>` のように閉じていない XML を渡した場合に、例外を発生させず、警告を返さないことを確認します。')
    expect(check('<mxfile>')).toEqual([])
  })

  describe('object / UserObject に包まれたセル (F-04)', () => {
    it.each(['object', 'UserObject'])('%s で包んだセルでも、子の mxCell の style の書体を判定する', async (tag) => {
      await explains(`\`<${tag}>\` タグで包んだセルの書体のテストです。子の \`mxCell\` に \`fontFamily=Fira Code\` がある場合に、警告を 1 件だけ返し、メッセージに包んだタグの id と書体と文字列が含まれることを確認します。`)
      const warnings = check(wrapped(tag, 'fontFamily=Fira Code;fontSize=14;', 'node --version'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('mxCell id=obj1')
      expect(warnings[0]?.message).toContain('first font fira code')
      expect(warnings[0]?.message).toContain('node --version')
    })

    it('object で包んだセルの書体が宣言どおりなら、警告を返さない', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`<object>` で包んだセルの `fontFamily` が `Inter` で、文字列が英数字だけの場合に、警告を返さないことを確認します。')
      expect(check(wrapped('object', 'fontFamily=Inter;', 'v24'))).toEqual([])
    })
  })

  describe('CSS の font 一括指定 (F-06)', () => {
    it('CSS の font の一括指定が宣言にない書体（Fira Code）を含む場合は、その書体について警告を返す', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の HTML に `font: 20px Fira Code` と書いた場合に、警告が 1 件だけ返り、メッセージに `first font fira code` が含まれることを確認します。')
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font: 20px Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('first font fira code')
    })

    it('CSS の font の一括指定が宣言どおりの書体なら、警告を返さない', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の HTML に `font: bold 12px/1.5 Inter, \'Noto Sans JP\'` と書いた場合に、宣言どおりの書体として扱い、警告を返さないことを確認します。')
      const value = '&lt;span style=&quot;font: bold 12px/1.5 Inter, &#39;Noto Sans JP&#39;&quot;&gt;道筋&lt;/span&gt;'
      expect(check(wrap('fontFamily=Inter, Noto Sans JP;', value))).toEqual([])
    })

    it('CSS の font の一括指定が読み取れない場合は、font-family と font-size を分けて指定するよう警告する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の HTML に `font: inherit` と書いた場合に、警告が 1 件だけ返り、メッセージに `CSS font shorthand` が含まれることを確認します。')
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font: inherit&quot;&gt;x&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('font: inherit')
      expect(warnings[0]?.message).toContain('CSS font shorthand')
      expect(warnings[0]?.message).toContain('specify font-family and font-size separately')
    })
  })

  describe('直し方の案内 (F-07)', () => {
    it('value の HTML に由来する規定外の書体には、value 内の指定を削除するよう案内する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の HTML に `font-family:Fira Code` を書いた場合に、警告が 1 件だけ返り、`font-family` の削除を案内することを確認します。')
      const warnings = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font-family:Fira Code&quot;&gt;code&lt;/span&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('remove font-family in value')
      expect(warnings[0]?.message).toContain('leave the font to fontFamily=')
    })

    it('value の HTML の font タグが和文用の書体を含まない場合も、value 内の指定を削除するよう案内する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の `<font face="Inter">` に和文を入れた場合に、警告が 1 件だけ返り、`remove font-family in value` で案内することを確認します。')
      const warnings = check(wrap('fontFamily=Inter, Noto Sans JP;', '&lt;font face=&quot;Inter&quot;&gt;道筋&lt;/font&gt;'))
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.message).toContain('remove font-family in value')
    })

    it('セルの style に由来する規定外の書体には、style に宣言どおりの fontFamily を追加するよう案内する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`Fira Code` のセルについて、style への書体の追加を案内し、`value` の指定の削除は案内しないことを確認します。')
      const warnings = check(wrap('fontFamily=Fira Code;', 'code'))
      expect(warnings[0]?.message).toContain('add fontFamily=Inter, Noto Sans JP, sans-serif to style')
      expect(warnings[0]?.message).not.toContain('remove font-family in value')
    })
  })

  describe('宣言ごとの許す書体 (T051)', () => {
    const TEST_SANS: ThemeFonts = { body: ['Test Sans'], eastAsian: 'Test Sans JP' }

    it('宣言にある書体には警告を返さず、宣言にない書体には警告を返す', async () => {
      await explains('宣言の本文の書体が `Test Sans` の場合のテストです。`fontFamily=Test Sans` のセルには警告を返さず、`fontFamily=Inter` のセルには警告を 1 件返して `first font inter` を含めることを確認します。')
      expect(check(wrap('fontFamily=Test Sans;', 'Hello'), TEST_SANS)).toEqual([])
      const warnings = check(wrap('fontFamily=Inter;', 'Hello'), TEST_SANS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('first font inter')
    })

    it('先頭に使える書体は、宣言の本文の書体と和文の書体の両方にする', async () => {
      await explains('テーマの宣言の `fonts.body` と `eastAsian` を合わせた書体が、先頭に使えるかのテストです。`Test Sans JP` を先頭にしたセルと、`Noto Sans JP` を先頭にしたセルのどちらにも、警告を返さないことを確認します。')
      expect(check(wrap('fontFamily=Test Sans JP;', 'Hello'), TEST_SANS)).toEqual([])
      expect(check(wrap('fontFamily=Noto Sans JP, Inter;', 'Hello'))).toEqual([])
    })

    it('直し方に示す書体の並びは、本文の書体と和文の書体で重複するものを除いて組み立てる', async () => {
      await explains('規定外の書体に対する警告の、直し方のテストです。宣言が `Test Sans` と `Test Sans JP` の場合は、その 2 つに `sans-serif` を加えて案内し、主な宣言では `Noto Sans JP` を重複させないことを確認します。')
      const warnings = check(wrap('fontFamily=Fira Code;', 'code'), TEST_SANS)
      expect(warnings[0]?.message).toContain('add fontFamily=Test Sans, Test Sans JP, sans-serif to style')
      const same = check(wrap('fontFamily=Fira Code;', 'code'))
      expect(same[0]?.message).toContain('add fontFamily=Inter, Noto Sans JP, sans-serif to style')
      expect(same[0]?.message).not.toContain('Noto Sans JP, Noto Sans JP')
    })

    it('直し方の並びは sans-serif で終え、宣言がすでに総称の書体で終わる場合は追加しない', async () => {
      await explains('規定外の書体に対する警告の、直し方のテストです。宣言が総称の書体を含まないときは末尾に `sans-serif` を追加し、`cursive` や `sans-serif` で終わる宣言では追加しないことを確認します。')
      const cell = check(wrap('fontFamily=Fira Code;', 'code'), TEST_SANS)[0]?.message
      expect(cell).toContain('add fontFamily=Test Sans, Test Sans JP, sans-serif to style')
      const html = check(wrap('fontFamily=Inter;', '&lt;span style=&quot;font-family:Fira Code&quot;&gt;x&lt;/span&gt;'), TEST_SANS)[0]?.message
      expect(html).toContain('leave the font to fontFamily=Test Sans, Test Sans JP, sans-serif')
      const generic = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['Caveat', 'cursive'] })[0]?.message
      expect(generic).toContain('add fontFamily=Caveat, cursive to style')
      const fallback = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['sans-serif'] })[0]?.message
      expect(fallback).toContain('add fontFamily=sans-serif to style')
    })

    it('末尾に sans-serif を加えた書体の並びは、先頭の書体と和文用の書体の確認を満たす', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Test Sans, Test Sans JP, sans-serif` のセルに和文を入れた場合に、警告を返さないことを確認します。')
      expect(check(wrap('fontFamily=Test Sans, Test Sans JP, sans-serif;', '道筋 Hello'), TEST_SANS)).toEqual([])
    })

    it('書体名は、大文字と小文字の違いや引用符の有無にかかわらず、宣言の書体と一致するものとして扱う', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=\'TEST SANS\'` のように、大文字で引用符付きの書体名を渡した場合に、宣言の `Test Sans` と一致するものとして警告を返さないことを確認します。')
      expect(check(wrap('fontFamily=\'TEST SANS\';', 'Hello'), TEST_SANS)).toEqual([])
    })

    it('和文を含むセルの書体の並びに和文用の書体がなければ、警告を返し、案内にその書体を含める', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。宣言の `eastAsian` が `Test Sans JP` で、セルの書体が `Test Sans` だけの場合に、`has no Test Sans JP` を含む警告が 1 件返ることを確認します。')
      const warnings = check(wrap('fontFamily=Test Sans;', '道筋'), TEST_SANS)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('has no Test Sans JP')
      expect(check(wrap('fontFamily=Test Sans, Test Sans JP;', '道筋'), TEST_SANS)).toEqual([])
    })

    it('宣言に和文用の書体がない場合は、和文を含むセルでも和文用の書体を確認しない', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`eastAsian` を宣言していないテーマで、和文を含むセルを渡した場合に、宣言にある書体のセルは警告を返さず、宣言にない `Inter` のセルは書体の警告を 1 件返すことを確認します。')
      expect(check(wrap('fontFamily=Caveat;', '道筋'), { body: ['Caveat'] })).toEqual([])
      expect(check(wrap('fontFamily=Inter;', '道筋'), { body: ['Caveat'] })).toHaveLength(1)
    })

    it('既定の宣言（sans-serif だけ）では sans-serif を許可し、Inter は規定外として警告を返す', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。本文の書体が `sans-serif` だけの宣言で、`fontFamily=sans-serif` のセルには警告を返さず、`fontFamily=Inter` のセルには警告を 1 件返すことを確認します。')
      const fallback: ThemeFonts = { body: ['sans-serif'] }
      expect(check(wrap('fontFamily=sans-serif;', '道筋 Hello'), fallback)).toEqual([])
      expect(check(wrap('fontFamily=Inter;', 'Hello'), fallback)).toHaveLength(1)
    })
  })

  describe('等幅の並び', () => {
    it('書体の並びに monospace を含むセルは、書体の判定を省略する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`\'Noto Sans Mono\', monospace` のように、`monospace` を含む並びのセルを渡した場合に、大文字小文字を区別せず、警告を返さないことを確認します。')
      expect(check(wrap('fontFamily=\'Noto Sans Mono\', monospace;', 'node --version'))).toEqual([])
      expect(check(wrap('fontFamily=Fira Code, MONOSPACE;', '道筋'))).toEqual([])
    })

    it('value の HTML に monospace を含む並びがあれば判定を省略するが、外側の書体は引き続き判定する', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`value` の HTML の一部に `font-family: Fira Code, monospace` を指定した場合に、外側が宣言どおりなら警告を返さないことを確認します。')
      const value = '日本語&lt;span style=&quot;font-family: Fira Code, monospace&quot;&gt;code&lt;/span&gt;'
      expect(check(wrap('fontFamily=Inter, Noto Sans JP;html=1;', value))).toEqual([])
      expect(check(wrap('fontFamily=Fira Code;html=1;', value)).length).toBeGreaterThan(0)
    })

    it('monospace を含まない等幅の書体名（Fira Code）は、判定を省略しない', async () => {
      await explains('図の書体を判定する `validateSlideFonts` のテストです。`fontFamily=Fira Code` のセルを渡した場合に、書体の名前が等幅でも `monospace` が並びにないため、警告を 1 件返すことを確認します。')
      expect(check(wrap('fontFamily=Fira Code;', 'code'))).toHaveLength(1)
    })
  })

  describe('文言のテーマ名', () => {
    it('警告のメッセージは、テーマ名を渡すとテーマの書体、渡さなければ既定の書体として表現する', async () => {
      await explains('警告のメッセージの文言のテストです。テーマ名 `my-theme` を渡すと `the theme font (my-theme)` と表現し、渡さない場合は `the default font` と表現することを確認します。')
      const named = check(wrap('fontFamily=Fira Code;', 'code'), TWO_FONTS, 'my-theme')
      expect(named[0]?.message).toContain('the theme font (my-theme)')
      expect(named[0]?.message).not.toContain('the default font')
      const fallback = check(wrap('fontFamily=Fira Code;', 'code'), { body: ['sans-serif'] })
      expect(fallback[0]?.message).toContain('the default font')
      expect(fallback[0]?.message).not.toContain('the theme font')
    })
  })
})
