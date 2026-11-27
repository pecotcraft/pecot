// slidesMdSource の検証。frontmatter（theme・title・src）、markdownlint の無効化、
// 2 ページ目以降の src の列、テンプレートの headmatter を書かないことを固定する。

import { describe, expect, it } from 'vitest'

import { setSlidesTheme, slidesMdSource } from '../slides-md.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('slidesMdSource', () => {
  it('theme・title・先頭ページの src を frontmatter に置き、残りを src の列にする', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。3 ページを渡した場合に、`theme`・`title`・先頭ページの `src` が frontmatter に入り、残りの 2 ページが `src` を持つ区切りとして続くことを確認します。')
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

  it('ページが 1 つの場合は、2 ページ目以降の src の区切りを作成しない', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。ページが 1 つの場合に、frontmatter の `src` だけが入り、後ろに続く `src` の区切りが存在しないことを確認します。')
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

  it('ページが存在しない場合は、frontmatter に src を作成しない', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。ページの一覧が空の場合に、`theme` と `title` だけの frontmatter になることを確認します。')
    const result = slidesMdSource({ title: 'T', theme: 'slidev-theme-x', pages: [] })
    expect(result).toBe(
      '---\ntheme: slidev-theme-x\ntitle: T\n---\n<!-- markdownlint-disable -->\n',
    )
  })

  it('テンプレートの headmatter（canvasWidth など）は、slides.md に含めない', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。ページを 1 つ渡した場合に、出力に `canvasWidth`・`aspectRatio`・`routerMode` のいずれも含まれないことを確認します。')
    const result = slidesMdSource({ title: 'T', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).not.toMatch(/canvasWidth|aspectRatio|routerMode/)
  })

  it('YAML として曖昧な title は二重引用符で囲む', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。`A: B #1` のように YAML として曖昧になる題を渡した場合に、`title` の値が二重引用符で囲まれることを確認します。')
    const result = slidesMdSource({ title: 'A: B #1', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).toContain('title: "A: B #1"\n')
  })

  it.each(['2024', '1.5', '0x1F', 'true', 'False', 'null', 'yes', 'On', '2024-01-01', '1e3'])(
    'YAML が数値・真偽値・null・日付として読む title %s は、引用符で囲む',
    async (title) => {
      await explains(`talk-dir の \`slides.md\` を作成する \`slidesMdSource\` のテストです。\`${title}\` のように YAML が数値・真偽値・null・日付として読む題を渡した場合に、\`title\` の値が二重引用符で囲まれることを確認します。`)
      const result = slidesMdSource({ title, theme: 'slidev-theme-x', pages: ['cover'] })
      expect(result).toContain(`title: ${JSON.stringify(title)}\n`)
    },
  )

  it('数字を含んでいても文字列として読まれる title は、引用符で囲まない', async () => {
    await explains('talk-dir の `slides.md` を作成する `slidesMdSource` のテストです。`Talk 2024` のように数字を含むが文字列として読まれる題を渡した場合に、`title` の値が引用符なしで出力されることを確認します。')
    const result = slidesMdSource({ title: 'Talk 2024', theme: 'slidev-theme-x', pages: ['cover'] })
    expect(result).toContain('title: Talk 2024\n')
  })
})

describe('setSlidesTheme', () => {
  it('frontmatter の theme: の値だけを書き換え、ほかの行と本文を変えない', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。frontmatter に `theme: none` がある場合に、その値だけが指定したテーマ名に変わり、ほかの行と本文が変更されないことを確認します。')
    const source = '---\ntheme: none\ntitle: Demo\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n\n---\nsrc: ./pages/end.md\n---\n'
    expect(setSlidesTheme(source, 'slidev-theme-sample')).toBe(
      '---\ntheme: slidev-theme-sample\ntitle: Demo\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n\n---\nsrc: ./pages/end.md\n---\n',
    )
  })

  it('パス形式の値と行末のコメントも、値ごと置き換える', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。`theme: ./theme # old` のようにパス形式の値と行末のコメントがある場合に、コメントを含めて新しいテーマ名に置き換わることを確認します。')
    expect(setSlidesTheme('---\ntheme: ./theme # old\ntitle: A\n---\n', '@org/theme-x'))
      .toBe('---\ntheme: "@org/theme-x"\ntitle: A\n---\n')
  })

  it('theme: の行が存在しない場合は、frontmatter の先頭に追加する', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。frontmatter に `theme:` の行が存在しない場合に、先頭に `theme:` の行が追加され、ほかの行と本文が変更されないことを確認します。')
    expect(setSlidesTheme('---\ntitle: A\n---\n# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\ntitle: A\n---\n# 表紙\n')
  })

  it('空の frontmatter にも、theme: の行を追加する', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。frontmatter が空の場合に、`theme:` の行だけが追加されることを確認します。')
    expect(setSlidesTheme('---\n---\n# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\n---\n# 表紙\n')
  })

  it('frontmatter が存在しない場合は、新しく作成する', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。ファイルの先頭に frontmatter が存在しない場合は、`theme:` だけの frontmatter が作成され、本文が変更されないことを確認します。')
    expect(setSlidesTheme('# 表紙\n', 'slidev-theme-sample'))
      .toBe('---\ntheme: slidev-theme-sample\n---\n# 表紙\n')
  })

  it('改行が CRLF の場合は、追加する行も含めて CRLF を維持する', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。改行が CRLF のファイルで、frontmatter がある場合と存在しない場合のどちらでも、出力の改行がすべて CRLF のままであることを確認します。')
    expect(setSlidesTheme('---\r\ntheme: none\r\ntitle: A\r\n---\r\n# 表紙\r\n', 'slidev-theme-sample'))
      .toBe('---\r\ntheme: slidev-theme-sample\r\ntitle: A\r\n---\r\n# 表紙\r\n')
    expect(setSlidesTheme('# 表紙\r\n', 'slidev-theme-sample'))
      .toBe('---\r\ntheme: slidev-theme-sample\r\n---\r\n# 表紙\r\n')
  })

  it('字下げされた theme: の行と、本文中の theme: の行は、書き換えない', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。字下げされた `theme:` と本文中の `theme:` の行がある場合に、どちらも変更されず、frontmatter の先頭に新しい `theme:` の行が追加されることを確認します。')
    expect(setSlidesTheme('---\ntitle: A\nbox:\n  theme: keep\n---\ntheme: body\n', 'slidev-theme-x'))
      .toBe('---\ntheme: slidev-theme-x\ntitle: A\nbox:\n  theme: keep\n---\ntheme: body\n')
  })

  it('YAML が文字列として読まないテーマ名は、引用符で囲んで書き込む', async () => {
    await explains('既存の `slides.md` のテーマを書き換える `setSlidesTheme` のテストです。`2024` のように数値として読まれるテーマ名を渡した場合に、値が二重引用符で囲まれることを確認します。')
    expect(setSlidesTheme('---\ntheme: none\n---\n', '2024')).toBe('---\ntheme: "2024"\n---\n')
  })
})
