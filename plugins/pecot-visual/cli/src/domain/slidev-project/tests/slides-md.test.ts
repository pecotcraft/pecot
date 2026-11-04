// slidesMdSource の検証。frontmatter（theme・title・src）、markdownlint の無効化、
// 2 ページ目以降の src の列、テンプレートの headmatter を書かないことを固定する。

import { describe, expect, it } from 'vitest'

import { setSlidesTheme, slidesMdSource } from '../slides-md.js'

describe('slidesMdSource', () => {
  it('theme・title・先頭ページの src を frontmatter に置き、残りを src の列にする', () => {
    const result = slidesMdSource({
      title: 'My Talk',
      theme: 'slidev-theme-sample',
      pages: ['cover', 'agenda', 'end'],
    })
    expect(result).toBe(
      '---\n'
      + 'theme: slidev-theme-sample\n'
      + 'title: My Talk\n'
      + 'src: ./pages/cover.md\n'
      + '---\n'
      + '<!-- markdownlint-disable -->\n'
      + '\n'
      + '---\nsrc: ./pages/agenda.md\n---\n'
      + '\n'
      + '---\nsrc: ./pages/end.md\n---\n',
    )
  })

  it('ページが 1 つなら src の列は付かない', () => {
    const result = slidesMdSource({ title: 'T', theme: '@scope/slidev-theme-x', pages: ['plain'] })
    expect(result).toBe(
      '---\n'
      + 'theme: "@scope/slidev-theme-x"\n'
      + 'title: T\n'
      + 'src: ./pages/plain.md\n'
      + '---\n'
      + '<!-- markdownlint-disable -->\n',
    )
  })

  it('ページが無ければ frontmatter に src を書かない', () => {
    const result = slidesMdSource({ title: 'T', theme: 'slidev-theme-x', pages: [] })
    expect(result).toBe(
      '---\ntheme: slidev-theme-x\ntitle: T\n---\n<!-- markdownlint-disable -->\n',
    )
  })

  it('テンプレートの headmatter（canvasWidth など）は書かない', () => {
    const result = slidesMdSource({ title: 'T', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).not.toMatch(/canvasWidth|aspectRatio|routerMode/)
  })

  it('YAML として曖昧な title は二重引用符で囲む', () => {
    const result = slidesMdSource({ title: 'A: B #1', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).toContain('title: "A: B #1"\n')
  })

  it.each(['2024', '1.5', '0x1F', 'true', 'False', 'null', 'yes', 'On', '2024-01-01', '1e3'])(
    'YAML が数値・真偽値・null・日付と読む title %s は引用する',
    (title) => {
      const result = slidesMdSource({ title, theme: 'slidev-theme-x', pages: ['cover'] })
      expect(result).toContain(`title: ${JSON.stringify(title)}\n`)
    },
  )

  it('数字を含んでも文字列と読まれる title は引用しない', () => {
    const result = slidesMdSource({ title: 'Talk 2024', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).toContain('title: Talk 2024\n')
  })
})

describe('setSlidesTheme', () => {
  it('frontmatter の theme: の値だけを書き換え、ほかの行と本文を変えない', () => {
    const source = '---\ntheme: none\ntitle: Demo\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n\n---\nsrc: ./pages/end.md\n---\n'
    expect(setSlidesTheme(source, 'slidev-theme-sample')).toBe(
      '---\ntheme: slidev-theme-sample\ntitle: Demo\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n\n---\nsrc: ./pages/end.md\n---\n',
    )
  })

  it('パス形式の値と行末のコメントも、値ごと置き換える', () => {
    expect(setSlidesTheme('---\ntheme: ./theme # old\ntitle: A\n---\n', '@org/theme-x'))
      .toBe('---\ntheme: "@org/theme-x"\ntitle: A\n---\n')
  })

  it('theme: の行が無ければ frontmatter の先頭に足す', () => {
    expect(setSlidesTheme('---\ntitle: A\n---\n# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\ntitle: A\n---\n# 表紙\n')
  })

  it('空の frontmatter にも足す', () => {
    expect(setSlidesTheme('---\n---\n# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\n---\n# 表紙\n')
  })

  it('frontmatter が無ければ作る', () => {
    expect(setSlidesTheme('# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\n---\n# 表紙\n')
  })

  it('CRLF の改行を保つ', () => {
    expect(setSlidesTheme('---\r\ntheme: none\r\ntitle: A\r\n---\r\n# 表紙\r\n', 'slidev-theme-sample'))
      .toBe('---\r\ntheme: slidev-theme-sample\r\ntitle: A\r\n---\r\n# 表紙\r\n')
    expect(setSlidesTheme('# 表紙\r\n', 'slidev-theme-sample'))
      .toBe('---\r\ntheme: slidev-theme-sample\r\n---\r\n# 表紙\r\n')
  })

  it('インデントされた theme: や本文中の theme: の行は触らない', () => {
    expect(setSlidesTheme('---\ntitle: A\nbox:\n  theme: keep\n---\ntheme: body\n', 'slidev-theme-x'))
      .toBe('---\ntheme: slidev-theme-x\ntitle: A\nbox:\n  theme: keep\n---\ntheme: body\n')
  })

  it('YAML が文字列と読まない名前は引用する', () => {
    expect(setSlidesTheme('---\ntheme: none\n---\n', '2024')).toBe('---\ntheme: "2024"\n---\n')
  })
})
