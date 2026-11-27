// buildInitialPages / nameToTitle の挙動検証。
// テーマの参照 yaml はメモリ上の ThemeFiles（I/O 境界）で与える。

import { describe, expect, it } from 'vitest'

import type { ThemeFiles } from '../../slidev-theme/ports.js'
import type { LayoutReference } from '../../slidev-theme/references.js'
import { buildInitialPages, nameToTitle } from '../initial-pages.js'
import { explains } from '../../../../tests/_helpers/explains.js'

function memoryFiles(texts: Readonly<Record<string, string>>): ThemeFiles {
  const stored = new Map(Object.entries(texts))
  return {
    readText: path => Promise.resolve(stored.get(path)),
    listFiles: () => Promise.resolve([]),
  }
}

function reference(name: string, extension: 'yaml' | 'vue' = 'yaml'): LayoutReference {
  return {
    name,
    description: '',
    category: 'uncategorized',
    status: 'stable',
    file: `/theme/references/${name}.${extension}`,
  }
}

function referenceText(name: string, skeleton: string | undefined): string {
  const lines = [`layout: '${name}'`, 'description: sample']
  if (skeleton !== undefined) {
    lines.push(
      'examples:',
      '  - name: 基本',
      '    frontmatter: |',
      ...skeleton.split('\n').filter(line => line !== '').map(line => `      ${line}`),
    )
  }
  return `${lines.join('\n')}\n`
}

function skeletonOf(name: string, title: string): string {
  return `---\nlayout: ${name}\ntitle: ${title}\n---\n`
}

describe('buildInitialPages', () => {
  it('cover・agenda・section・end の順に、examples の 1 件目の雛形をそのまま書く', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。`cover`・`agenda`・`section`・`end` の 4 つの参照がある場合に、この順にページが作成され、各ページに `examples` の 1 件目の雛形がそのまま入ることを確認します。')
    const names = ['agenda', 'cover', 'end', 'section', 'zeta']
    const texts = Object.fromEntries(
      names.map(name => [`/theme/references/${name}.yaml`, referenceText(name, skeletonOf(name, `${name} 見出し`))]),
    )
    const result = await buildInitialPages(names.map(name => reference(name)), memoryFiles(texts))
    expect(result.warnings).toStrictEqual([])
    expect(result.pages).toStrictEqual([
      { filename: 'cover.md', content: skeletonOf('cover', 'cover 見出し') },
      { filename: 'agenda.md', content: skeletonOf('agenda', 'agenda 見出し') },
      { filename: 'section.md', content: skeletonOf('section', 'section 見出し') },
      { filename: 'end.md', content: skeletonOf('end', 'end 見出し') },
    ])
  })

  it('cover・agenda・section・end のうち、参照に宣言が存在しないものと examples が存在しないものは、ページを作成しない', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。`section` の参照に `examples` が存在せず、`agenda` の参照が存在しない場合に、`cover.md` と `end.md` だけが作成され、警告が出ないことを確認します。')
    const texts = {
      '/theme/references/cover.yaml': referenceText('cover', skeletonOf('cover', '表紙')),
      '/theme/references/section.yaml': referenceText('section', undefined),
      '/theme/references/end.yaml': referenceText('end', skeletonOf('end', '終わり')),
    }
    const result = await buildInitialPages(
      [reference('cover'), reference('section'), reference('end')],
      memoryFiles(texts),
    )
    expect(result.pages.map(page => page.filename)).toStrictEqual(['cover.md', 'end.md'])
    expect(result.warnings).toStrictEqual([])
  })

  it('cover・agenda・section・end がすべて存在しない場合は、examples を持つ名前順で最初のレイアウトを 1 ページだけ作成する', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。標準の 4 つの名前が存在しない場合に、`examples` を持つレイアウトのうち名前順で最初のもの（`panel`）だけが 1 ページ作成され、警告が出ないことを確認します。')
    const texts = {
      '/theme/references/marked.yaml': referenceText('marked', undefined),
      '/theme/references/panel.yaml': referenceText('panel', skeletonOf('panel', '図')),
      '/theme/references/plain.yaml': referenceText('plain', skeletonOf('plain', '本文')),
    }
    const result = await buildInitialPages(
      [reference('plain'), reference('marked'), reference('panel')],
      memoryFiles(texts),
    )
    expect(result.pages).toStrictEqual([{ filename: 'panel.md', content: skeletonOf('panel', '図') }])
    expect(result.warnings).toStrictEqual([])
  })

  it('どのレイアウトにも examples が存在しない場合は、先頭のレイアウトを layout だけで 1 ページ作成し、警告を返す', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。`examples` を持つレイアウトが 1 つも存在しない場合に、名前順で先頭の `panel` が `layout` だけのページになり、`examples` に触れた警告が 1 件返ることを確認します。')
    const texts = { '/theme/references/plain.yaml': referenceText('plain', undefined) }
    const result = await buildInitialPages([reference('plain'), reference('panel')], memoryFiles(texts))
    expect(result.pages).toStrictEqual([{ filename: 'panel.md', content: '---\nlayout: panel\n---\n' }])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('layout: panel')
    expect(result.warnings[0]).toContain('examples')
  })

  it('参照が vue だけで宣言の yaml が存在しないテーマでは、yaml を読まずに layout だけの 1 ページを作成し、警告を返す', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。参照のファイルが `.vue` だけの場合に、`layout: plain` だけのページが 1 つ作成され、警告が 1 件返ることを確認します。')
    const result = await buildInitialPages([reference('plain', 'vue')], memoryFiles({}))
    expect(result.pages).toStrictEqual([{ filename: 'plain.md', content: '---\nlayout: plain\n---\n' }])
    expect(result.warnings).toHaveLength(1)
  })

  it('参照の yaml を読み込めない場合は、examples が存在しないものとして扱う', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。`cover` の参照ファイルが存在せず読み込めない場合に、`layout: cover` だけのページが作成され、警告が 1 件返ることを確認します。')
    const result = await buildInitialPages([reference('cover')], memoryFiles({}))
    expect(result.pages).toStrictEqual([{ filename: 'cover.md', content: '---\nlayout: cover\n---\n' }])
    expect(result.warnings).toHaveLength(1)
  })

  it('レイアウトが 1 つも存在しない場合は、ページを作成せず警告を返す', async () => {
    await explains('テーマのレイアウト参照から、talk-dir の最初のページを作成する `buildInitialPages` のテストです。レイアウトの参照が空の場合に、ページは作成されず、`layouts/` に触れた警告が 1 件返ることを確認します。')
    const result = await buildInitialPages([], memoryFiles({}))
    expect(result.pages).toStrictEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('layouts/')
  })
})

describe('buildInitialPages (ページ名に使えないレイアウト名)', () => {
  it.each(['../escape', 'a/b', '.hidden', '', 'x y'])('ページ名に使えないレイアウト名 %j は、警告を出してページを作成しない', async (name) => {
    await explains(`ページ名に使えないレイアウト名を渡したときの、\`buildInitialPages\` のテストです。名前が \`${JSON.stringify(name)}\` のレイアウトと \`plain\` を渡した場合に、\`plain.md\` だけが作成され、警告が 1 件返ることを確認します。`)
    const texts = {
      [`/theme/references/${name}.yaml`]: referenceText(name, skeletonOf('cover', '表紙')),
      '/theme/references/plain.yaml': referenceText('plain', skeletonOf('plain', '本文')),
    }

    const result = await buildInitialPages([reference(name), reference('plain')], memoryFiles(texts))

    expect(result.pages.map(page => page.filename)).toStrictEqual(['plain.md'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(`: ${name}`)
  })

  it('使えない名前のレイアウトしか存在しない場合は、ページを作成せず、警告を 2 件返す', async () => {
    await explains('ページ名に使えないレイアウト名を渡したときの、`buildInitialPages` のテストです。`../escape` だけを渡した場合に、ページが作成されず、飛ばした分とレイアウトが存在しない分の警告が 2 件返ることを確認します。')
    const result = await buildInitialPages([reference('../escape')], memoryFiles({}))

    expect(result.pages).toStrictEqual([])
    expect(result.warnings).toHaveLength(2)
  })

  it('使えない名前を飛ばして、使える名前の layout だけのページを作成する場合は、飛ばした分の警告も返す', async () => {
    await explains('ページ名に使えないレイアウト名を渡したときの、`buildInitialPages` のテストです。`../escape` と `plain` を渡し、どちらの yaml も存在しない場合に、`plain.md` だけが作成され、警告が 2 件返ることを確認します。')
    const result = await buildInitialPages([reference('../escape'), reference('plain')], memoryFiles({}))

    expect(result.pages).toStrictEqual([{ filename: 'plain.md', content: '---\nlayout: plain\n---\n' }])
    expect(result.warnings).toHaveLength(2)
  })
})

describe('nameToTitle', () => {
  it('ハイフンをスペースに置換し各単語の先頭を大文字化する', async () => {
    await explains('talk-dir の名前から、スライドの題を作成する `nameToTitle` のテストです。`my-cool-talk` のようにハイフンを含む名前の場合に、ハイフンがスペースに変わり、各単語の先頭が大文字になった `My Cool Talk` を返すことを確認します。')
    expect(nameToTitle('my-cool-talk')).toBe('My Cool Talk')
  })

  it('既に大文字と小文字が併存していても各単語先頭を大文字にする', async () => {
    await explains('talk-dir の名前から、スライドの題を作成する `nameToTitle` のテストです。`quick-START` のように大文字と小文字が混在する名前の場合に、すでに大文字の部分を変えず、各単語の先頭が大文字の `Quick START` を返すことを確認します。')
    expect(nameToTitle('quick-START')).toBe('Quick START')
  })

  it('ハイフンを含まない 1 単語の名前は、先頭だけを大文字にする', async () => {
    await explains('talk-dir の名前から、スライドの題を作成する `nameToTitle` のテストです。ハイフンを含まない `hello` を渡した場合に、先頭だけが大文字の `Hello` を返すことを確認します。')
    expect(nameToTitle('hello')).toBe('Hello')
  })
})
